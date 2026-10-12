/**
 * @adminigloo/scheduling/comms — the emails a visit deserves, delivered
 * through @adminigloo/comms (an OPTIONAL peer: only this entry imports it, so
 * an app that sends its own mail imports the barrel and never needs comms).
 *
 *   const schedulingComms = createSchedulingCommsListener({ db, senders, manageUrl, bookUrl, adminUrl });
 *   createSchedulingHandlers({ …, onEvent: schedulingComms.onEvent });
 *   // the comms cron:
 *   try {
 *     await runDueMessages(db, senders, { beforeSend: (row) => schedulingComms.beforeSend(row) ?? "send" });
 *   } finally {
 *     await schedulingComms.redactSent();
 *   }
 *
 * WHAT GOES OUT, per event (section 6.1 of the contract): an acknowledgement
 * when a customer asks, a confirmation with a manage link when the visit is
 * accepted (or auto-confirmed), a note when it is declined, moved, given to
 * another crew, cancelled or released unanswered, a notice to the office when
 * a customer asks, moves or cancels or a request lapses, and a reminder
 * before the visit.
 *
 * THE COMMS TENANT IS THE SCHEDULING TENANT: templates, sends and the queue
 * all use `event.tenantId`.
 *
 * NO KEY SITS IN A TABLE. A manage link is a key to the customer's visit.
 *   - An email sent now gets a freshly minted token; right after the send,
 *     that one `comms_messages` row is rewritten with the token replaced by
 *     ":token". The plaintext sits in the delivery log only between the
 *     insert and that update.
 *   - The reminder is QUEUED without a link (it sits in `comms_scheduled` for
 *     a day). At send time `beforeSend` mints a token and injects the link,
 *     and `redactSent()` — run right after `runDueMessages`, in a `finally` —
 *     scrubs it from the delivery log. It also sweeps the recent log for any
 *     token a crashed run, a killed function or a timed-out send left behind,
 *     so the scrub never depends on this process's memory surviving.
 */

import {
  cancelScheduled,
  commsMessages,
  commsScheduled,
  commsTemplates,
  enqueueMessage,
  sendNow,
  type BeforeSendResult,
  type CommsSenders,
  type ScheduledRow,
} from "@adminigloo/comms";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { resourceNames, type SchedulingEvent, type SchedulingEventListener } from "./events.js";
import { instantsOf } from "./instants.js";
import { getBookingRow } from "./internal.js";
import type { ReminderRuns } from "./notices.js";
import { getSchedulingSettings, type SchedulingSettings } from "./settings.js";
import { toVisitSnapshot } from "./snapshot.js";
import { forEmail, greetingName } from "./text.js";
import type { SchedulingDb } from "./types.js";
import { insertManageToken, issueManageToken } from "./visit-tokens.js";

export type { ReminderRuns } from "./notices.js";

/** The comms `refType` every queued visit message is tagged with (with `refId` = the visit id). */
export const SCHEDULING_COMMS_REF_TYPE = "scheduling_visit";

export type SchedulingTemplateKey =
  | "visit_requested"
  | "visit_confirmed"
  | "visit_declined"
  | "visit_rescheduled"
  | "visit_reassigned"
  | "visit_cancelled"
  | "visit_expired"
  | "visit_reminder"
  | "visit_staff_notice";

/**
 * The default emails, plain text with `{{variables}}`. They speak as the
 * business and promise nothing the package can't see happen. Inserted once
 * per tenant if absent (`ensureTemplates`), so an owner's edits in the comms
 * admin are never overwritten. A line that is only a variable may render
 * empty (no reason given, no booking link); the HTML part folds the blank
 * paragraph away.
 *
 * NO ARTICLE BEFORE A SERVICE NAME. "your request for a Aeration" went to
 * every customer of a lawn business: the service name is the owner's, and no
 * template can know whether it takes "a", "an" or nothing. Every sentence is
 * written so the name stands on its own ("your Aeration request").
 */
export const SCHEDULING_EMAIL_TEMPLATES: ReadonlyArray<{
  key: SchedulingTemplateKey;
  audience: "customer" | "staff";
  subject: string;
  body: string;
}> = Object.freeze([
  {
    key: "visit_requested",
    audience: "customer",
    subject: "We got your request: {{serviceName}}, {{shortWhen}}",
    body: [
      "Hi {{firstName}},",
      "",
      "Thanks, your {{serviceName}} request is in. We'll confirm it soon and email you when we do.",
      "",
      "Requested time: {{when}}",
      "Where: {{address}}{{addressNote}}",
      "",
      "{{manageLine}}",
      "",
      "{{contactLine}}",
      "",
      "{{businessName}}",
    ].join("\n"),
  },
  {
    key: "visit_confirmed",
    audience: "customer",
    subject: "Confirmed: {{serviceName}}, {{shortWhen}}",
    body: [
      "Hi {{firstName}},",
      "",
      "{{confirmLine}}",
      "",
      "When: {{when}}",
      "Where: {{address}}",
      "",
      "{{manageLine}}",
      "",
      "{{contactLine}}",
      "",
      "{{businessName}}",
    ].join("\n"),
  },
  {
    key: "visit_declined",
    audience: "customer",
    subject: "We can't make {{shortWhen}}",
    body: [
      "Hi {{firstName}},",
      "",
      "Sorry, we can't do your {{serviceName}} at {{when}}.",
      "{{reasonLine}}",
      "",
      "{{bookLine}}",
      "",
      "{{contactLine}}",
      "",
      "{{businessName}}",
    ].join("\n"),
  },
  {
    key: "visit_rescheduled",
    audience: "customer",
    subject: "New time: {{serviceName}}, {{shortWhen}}",
    body: [
      "Hi {{firstName}},",
      "",
      "{{rescheduleLine}}",
      "",
      "New time: {{when}}",
      "Was: {{previousWhen}}",
      "Where: {{address}}",
      "",
      "{{manageLine}}",
      "",
      "{{contactLine}}",
      "",
      "{{businessName}}",
    ].join("\n"),
  },
  {
    key: "visit_reassigned",
    audience: "customer",
    subject: "Update to your {{serviceName}}, {{shortWhen}}",
    body: [
      "Hi {{firstName}},",
      "",
      "{{crewName}} from our team will now be doing your {{serviceName}}. The time hasn't changed.",
      "",
      "When: {{when}}",
      "Where: {{address}}",
      "",
      "{{manageLine}}",
      "",
      "{{businessName}}",
    ].join("\n"),
  },
  {
    key: "visit_cancelled",
    audience: "customer",
    subject: "Cancelled: {{serviceName}}, {{shortWhen}}",
    body: [
      "Hi {{firstName}},",
      "",
      "{{cancelLine}}",
      "{{reasonLine}}",
      "",
      "{{bookLine}}",
      "",
      "{{contactLine}}",
      "",
      "{{businessName}}",
    ].join("\n"),
  },
  {
    key: "visit_expired",
    audience: "customer",
    subject: "We couldn't confirm {{shortWhen}} in time",
    body: [
      "Hi {{firstName}},",
      "",
      "Sorry, we weren't able to confirm your {{serviceName}} request for {{when}} in time, so we've released it.",
      "",
      "{{bookLine}}",
      "",
      "{{contactLine}}",
      "",
      "{{businessName}}",
    ].join("\n"),
  },
  {
    key: "visit_reminder",
    audience: "customer",
    subject: "Reminder: {{serviceName}}, {{shortWhen}}",
    body: [
      "Hi {{firstName}},",
      "",
      "A reminder of your {{serviceName}}.",
      "",
      "When: {{when}}",
      "Where: {{address}}",
      "",
      "{{manageLine}}",
      "",
      "{{contactLine}}",
      "",
      "{{businessName}}",
    ].join("\n"),
  },
  {
    key: "visit_staff_notice",
    audience: "staff",
    subject: "{{subjectTag}}: {{customerName}}, {{shortWhen}}",
    body: [
      "{{headline}}",
      "",
      "When: {{when}}",
      "{{previousLine}}",
      "Service: {{serviceName}}",
      "Crew: {{crewName}}",
      "",
      "Who: {{customerName}}",
      "Email: {{customerEmail}}",
      "Phone: {{customerPhone}}",
      "Where: {{address}}{{addressNote}}",
      "Notes: {{notes}}",
      "",
      "Your schedule: {{adminUrl}}",
    ].join("\n"),
  },
]);

// --- Variables -----------------------------------------------------------------

export interface SchedulingEmailVarsOptions {
  /** The customer's manage link for THIS message, or null (a queued reminder, a staff notice). */
  manageUrl: string | null;
  /** "Pick another time" link (the booking page). Without it, `bookLine` is empty. */
  bookUrl?: string | undefined;
  /** The staff calendar, for staff notices. */
  adminUrl?: string | undefined;
  /** Default "en-US". */
  locale?: string | undefined;
  /**
   * Who reads it. An unknown value renders as "—" in a staff notice (so the
   * office sees a field was empty) and as nothing in a customer email.
   * Default "customer". CONTRACT: an addition to the contract's options, so
   * one function serves both audiences.
   */
  audience?: "customer" | "staff";
  /**
   * The send's clock. Past the visit's change deadline (start − the cutoff)
   * the manage line stops offering to reschedule or cancel — the server
   * would refuse — and gives the business's phone instead. Default: no
   * deadline check (the line follows `manageUrl`).
   */
  now?: Date | undefined;
}

const LINK_FREE_MANAGE_LINE = "Need to change it? Use the link in your confirmation email.";

function cutoffText(hours: number): string {
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/** "Please call us at (801) 555-0143." / "Please email us at …" / "Please get in touch with us." */
function callUs(settings: Pick<SchedulingSettings, "contactPhone" | "contactEmail">): string {
  const phone = settings.contactPhone?.trim();
  const email = settings.contactEmail?.trim();
  if (phone) return `Please call us at ${phone}.`;
  if (email) return `Please email us at ${email}.`;
  return "Please get in touch with us.";
}

/** The manage-link line. CONTRACT: with no cutoff (0) it reads "up to the start of the visit". */
function manageLineFor(manageUrl: string | null, cutoffHours: number): string {
  if (!manageUrl) return LINK_FREE_MANAGE_LINE;
  const until = cutoffHours > 0 ? `up to ${cutoffText(cutoffHours)} before the visit` : "up to the start of the visit";
  return `Need to change it? Reschedule or cancel here, no account needed (${until}):\n${manageUrl}`;
}

/** The manage line once the change deadline has passed: no offer the server would refuse, the phone instead. */
function lateManageLine(settings: Pick<SchedulingSettings, "contactPhone" | "contactEmail" | "cancelCutoffHours">): string {
  const window =
    settings.cancelCutoffHours > 0
      ? `It's within ${cutoffText(settings.cancelCutoffHours)} of the visit, so it can't be changed online any more.`
      : "It can't be changed online any more.";
  return `Need to change it? ${window} ${callUs(settings)}`;
}

function formatWhen(startsAt: Date, endsAt: Date, timeZone: string, locale: string): string {
  const format = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  });
  return format.formatRange(startsAt, endsAt);
}

function formatShort(instant: Date, timeZone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  }).format(instant);
}

function contactLineFor(settings: Pick<SchedulingSettings, "contactPhone" | "contactEmail">): string {
  const phone = settings.contactPhone?.trim();
  const email = settings.contactEmail?.trim();
  if (phone && email) return `Questions? Call ${phone} or email ${email}.`;
  if (phone) return `Questions? Call ${phone}.`;
  if (email) return `Questions? Email ${email}.`;
  return "";
}

type StaffNoticeKind = "New request" | "New booking" | "Visit moved" | "Visit cancelled" | "Request expired";

/**
 * The staff notice an event warrants, or null. Never for a change staff made
 * themselves. A request that lapses unanswered is one: it is a lost sale, and
 * before, the office never found out it happened.
 */
function staffNoticeKind(event: SchedulingEvent): StaffNoticeKind | null {
  if (event.type === "visit.expired") return "Request expired";
  if (event.actor.type === "staff") return null;
  if (event.type === "visit.requested") return event.data.visit.status === "confirmed" ? "New booking" : "New request";
  if (event.type === "visit.rescheduled" && event.actor.type === "customer") return "Visit moved";
  if (event.type === "visit.cancelled" && event.actor.type === "customer") return "Visit cancelled";
  return null;
}

/**
 * Every template variable for one event, as strings (pure). Exported for
 * tests and for a host that sends through its own mailer.
 *
 * Every variable any template uses is present (possibly empty), so a send
 * records no missing variables. Times are in the business's zone:
 * `when` is "Monday, November 2, 2026, 9:00 – 10:00 AM MST", `shortWhen`
 * "Mon, Nov 2, 9:00 AM MST".
 *
 * WHAT A CUSTOMER TYPED IS NEVER A LINK. The name and address come from an
 * anonymous form and go back out to an address nobody verified, from the
 * business's domain. Every customer-typed value is one line here, and in a
 * customer email any link-shaped text is broken (`forEmail`); the greeting
 * uses the first name only when it looks like one ("there" otherwise).
 */
export function schedulingEmailVars(
  event: SchedulingEvent,
  settings: SchedulingSettings,
  options: SchedulingEmailVarsOptions,
): Record<string, string> {
  const locale = options.locale ?? "en-US";
  const audience = options.audience === "staff" ? "staff" : "customer";
  const staff = audience === "staff";
  const unknown = staff ? "—" : "";
  const typed = (value: string | null | undefined): string => forEmail(value ?? "", audience);
  const visit = event.data.visit;
  const zone = visit.timeZone || settings.timeZone;
  const startsAt = new Date(visit.startsAt);
  const endsAt = new Date(visit.endsAt);
  const when = formatWhen(startsAt, endsAt, zone, locale);
  const shortWhen = formatShort(startsAt, zone, locale);
  const previous = event.data.previous;
  const previousWhen = previous ? formatWhen(new Date(previous.startsAt), new Date(previous.endsAt), zone, locale) : "";
  const serviceName = forEmail(visit.serviceName, "staff");
  const customerName = typed(visit.customerName);
  const firstName = greetingName(visit.customerName);
  const actor = event.actor.type;
  const reason = event.data.reason?.trim();

  const confirmLine =
    event.data.via === "auto"
      ? `You're booked. Your ${serviceName} is on our schedule.`
      : event.data.via === "accept"
        ? `Good news: we've confirmed your ${serviceName}.`
        : event.data.via === "restore"
          ? `Your ${serviceName} is back on our schedule.`
          : event.data.via === "contact"
            ? `Here are the details of your ${serviceName}. We've updated the email address we have for you, so this is where we'll write from now on.`
            : `We've booked your ${serviceName}.`;
  const rescheduleLine =
    event.data.via === "time_zone"
      ? `We had the wrong time zone for your ${serviceName}. The time below is the right one. Sorry for the mix-up.`
      : actor === "customer"
        ? `Your ${serviceName} has moved, as you asked.`
        : `We had to move your ${serviceName}. Sorry for the change.`;
  const cancelLine =
    actor === "customer"
      ? `Your ${serviceName} on ${when} is cancelled, as you asked.`
      : `We had to cancel your ${serviceName} on ${when}. Sorry for the change.`;

  const kind = staffNoticeKind(event);
  const who = customerName || "A customer";
  const expiresWhen = visit.pendingExpiresAt ? formatShort(new Date(visit.pendingExpiresAt), zone, locale) : "";
  const headline =
    kind === "New request"
      ? `New request from ${who}: ${serviceName}. Accept or decline it in your schedule.` +
        (expiresWhen ? ` If nobody answers by ${expiresWhen}, the request is released and they're told.` : "")
      : kind === "New booking"
        ? `New online booking from ${who}: ${serviceName}.`
        : kind === "Visit moved"
          ? `${who} moved their ${serviceName}.`
          : kind === "Visit cancelled"
            ? `${who} cancelled their ${serviceName}.`
            : kind === "Request expired"
              ? `Nobody answered ${who}'s ${serviceName} request in time, so it was released and they were told. Call them if you'd still like the work.`
              : `${who}'s ${serviceName} has changed.`;

  const startsMs = startsAt.getTime();
  const pastDeadline =
    options.now !== undefined && options.now.getTime() >= startsMs - settings.cancelCutoffHours * 3_600_000;
  // Inline after "Where: …", so a visit the map found reads as before.
  const addressNote = event.data.addressUnverified
    ? staff
      ? " (the map couldn't find this address: check it with the customer before the visit)"
      : " (we couldn't find this address on the map, so we may call to check it)"
    : "";

  return {
    firstName,
    customerName: customerName || unknown,
    businessName: settings.businessName.trim() || unknown,
    serviceName,
    crewName: visit.resourceName?.trim() || "our team",
    when,
    shortWhen,
    previousWhen,
    previousLine: previous ? `Was: ${previousWhen}` : "",
    address: typed(visit.address) || unknown,
    addressNote,
    notes: (staff ? (visit.notes ?? "").trim() : typed(visit.notes)) || unknown,
    customerEmail: visit.customerEmail?.trim() || unknown,
    customerPhone: typed(visit.customerPhone) || unknown,
    contactLine: contactLineFor(settings),
    manageUrl: pastDeadline ? "" : (options.manageUrl ?? ""),
    manageLine: pastDeadline ? lateManageLine(settings) : manageLineFor(options.manageUrl, settings.cancelCutoffHours),
    bookLine: options.bookUrl ? `If you'd like another time, pick one here: ${options.bookUrl}` : "",
    confirmLine,
    rescheduleLine,
    cancelLine,
    reasonLine: reason && actor === "staff" ? `Note from us: "${forEmail(reason, "staff")}"` : "",
    subjectTag: kind ?? "Visit update",
    headline,
    expiresWhen: expiresWhen || unknown,
    // CONTRACT: the staff template's line is "Your schedule: {{adminUrl}}";
    // without an adminUrl it reads "—", the staff notice's unknown-value mark.
    adminUrl: options.adminUrl?.trim() || unknown,
  };
}

// --- When reminders can actually go out -----------------------------------------

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The last run of the comms cron at or before `instant`. A reminder queued
 * for 16:00Z on a cron that runs at 14:00Z daily goes out at the next run —
 * 14:00Z the NEXT day, the morning of the visit, past the change cutoff. Sent
 * on the run before instead, it arrives a little early (more than the lead,
 * never less), with the reschedule-and-cancel offer still good.
 */
export function lastRunAtOrBefore(instant: Date, runs: ReminderRuns): Date {
  if ("everyMinutes" in runs) {
    const step = Math.max(1, Math.trunc(runs.everyMinutes)) * MINUTE_MS;
    return new Date(Math.floor(instant.getTime() / step) * step);
  }
  const match = /^(\d{1,2}):(\d{2})$/.exec(runs.dailyAtUtc.trim());
  if (!match) return instant;
  const sameDay = Date.UTC(
    instant.getUTCFullYear(),
    instant.getUTCMonth(),
    instant.getUTCDate(),
    Number(match[1]),
    Number(match[2]),
  );
  return new Date(sameDay <= instant.getTime() ? sameDay : sameDay - DAY_MS);
}

/**
 * When a visit's reminder should go out:
 *
 *   1. `startsAt − reminderLeadHours`;
 *   2. but a reminder meant to arrive before the change cutoff (a lead at
 *      least as long as the cutoff — the defaults are 24 and 24) arrives at
 *      least an HOUR before it, so its reschedule-or-cancel link still works
 *      when the customer reads it. Sent exactly at the cutoff it was already
 *      too late, and the email offered what the server refused;
 *   3. then on the last cron run at or before that (`reminderRuns`), so a
 *      once-a-day cron sends it a little early rather than a day late.
 *
 * A lead shorter than the cutoff ("the crew is on its way tomorrow") is a
 * heads-up, not a chance to change: it goes at its own time, and its manage
 * line gives the phone (see `schedulingEmailVars`' `now`).
 */
export function reminderSendAt(
  startsAt: Date,
  settings: Pick<SchedulingSettings, "reminderLeadHours" | "cancelCutoffHours">,
  runs?: ReminderRuns,
): Date {
  const ideal = startsAt.getTime() - settings.reminderLeadHours * HOUR_MS;
  const beforeCutoff = startsAt.getTime() - settings.cancelCutoffHours * HOUR_MS - HOUR_MS;
  const target = new Date(settings.reminderLeadHours >= settings.cancelCutoffHours ? Math.min(ideal, beforeCutoff) : ideal);
  return runs ? lastRunAtOrBefore(target, runs) : target;
}

// --- The listener ----------------------------------------------------------------

export interface SchedulingCommsOptions {
  /** The comms tables live in the same database as the visits. */
  db: SchedulingDb;
  senders: CommsSenders;
  /** The customer's manage page for a token. */
  manageUrl: (token: string, tenantId: string) => string;
  /** "Pick another time" link in declined, cancelled and expired emails. Default: no line. */
  bookUrl?: string;
  /** The staff calendar, in staff notices. */
  adminUrl?: string;
  /** Who gets staff notices when the business saved no `staffNotifyEmails`. */
  staffEmails?: readonly string[];
  /** Default "en-US". */
  locale?: string;
  /** Queue a reminder before each confirmed visit. Default true (and `reminderLeadHours` > 0). */
  reminders?: boolean;
  /**
   * When the comms cron runs — `{ dailyAtUtc: "14:00" }` for Vercel Hobby's
   * once a day, `{ everyMinutes: 15 }` for a tighter scheduler. Each reminder
   * is queued for the last run at or before `startsAt − reminderLeadHours`, so
   * it arrives at least the lead ahead. Default: the exact instant, which only
   * a frequent cron honours — on a daily one a reminder due at 9:00 went out at
   * the NEXT run, the morning of the visit, already past the change cutoff (or,
   * for an early visit, never).
   */
  reminderRuns?: ReminderRuns;
  /**
   * Longest a single send may hold up the request that caused it, in ms.
   * Default 10000; 0 waits for ever. A mail server that accepts the connection
   * and never answers (an SMTP relay down at the wrong moment) used to keep the
   * customer's booking request open for minutes. Past the limit the send is
   * reported through `onError` and left to finish in the background; any link
   * it carried is scrubbed from the log by the next `redactSent()`.
   */
  sendTimeoutMs?: number;
  now?: () => Date;
  /**
   * Told about each step that failed. The listener itself never throws.
   * Default: `console.error` — a missing comms table or a rejected API key
   * must never fail SILENTLY, which is what an omitted reporter used to mean.
   */
  onError?: (error: unknown, context: { visitId: string; eventId?: string; step: string }) => void;
}

export interface SchedulingCommsListener {
  /** Hand to the handlers' (or any writer's) `onEvent`. Never throws. */
  onEvent: SchedulingEventListener;
  /** For `runDueMessages`' `beforeSend`: null → not a scheduling row (decide it yourself, usually "send"). */
  beforeSend(row: ScheduledRow): Promise<BeforeSendResult | null>;
  /** Run right after `runDueMessages`, in a `finally`: scrubs every manage link from the delivery log. */
  redactSent(): Promise<number>;
  /** Insert the nine templates for a tenant if absent; returns how many were added. */
  ensureTemplates(tenantId: string): Promise<number>;
  /**
   * Check the comms tables are there, at startup or in a health check. Throws
   * a plain sentence naming the migration to run; resolves when all three
   * answer.
   */
  verify(): Promise<void>;
}

/** What a host sees when the comms migration never ran. */
export const COMMS_TABLES_MISSING =
  "The @adminigloo/comms tables (comms_templates, comms_messages, comms_scheduled) aren't in this database, so no visit email can be sent. Generate and run the comms migration beside the scheduling one (see the scheduling README, \"Schema and migration\").";

function isMissingTable(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : String(error);
  return /comms_(templates|messages|scheduled)/.test(text) && /does not exist|no such table|undefined table/i.test(text);
}

/** A manage token as it appears in a link: 43 base64url characters, alone. */
const TOKEN_IN_TEXT = "(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])";
/** How far back `redactSent` sweeps the delivery log for a link a crashed run left behind. */
const SWEEP_DAYS = 14;

/**
 * The comms wiring for scheduling events: which email goes to whom, the
 * reminder queue, and the key-free delivery log. See the module comment.
 *
 * Each step — the withdrawal, each send, the queueing — runs in its own
 * try/catch and reports through `onError`, so one failure doesn't stop the
 * others and `onEvent` never rejects. The reminder is WITHDRAWN FIRST, before
 * any send, so a failed send can never leave a stale reminder behind.
 */
export function createSchedulingCommsListener(options: SchedulingCommsOptions): SchedulingCommsListener {
  const { db } = options;
  const ensured = new Set<string>();
  const minted: Array<{ tenantId: string; scheduledId: string; token: string }> = [];
  const clock = () => options.now?.() ?? new Date();
  const timeoutMs = options.sendTimeoutMs ?? 10_000;

  const report = (error: unknown, context: { visitId: string; eventId?: string; step: string }) => {
    try {
      if (options.onError) options.onError(error, context);
      else console.error("[@adminigloo/scheduling/comms] an email step failed", context, error);
    } catch {
      /* a broken reporter must not break the listener */
    }
  };
  const step = async (name: string, visitId: string, eventId: string | undefined, work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (error) {
      report(error, { visitId, ...(eventId ? { eventId } : {}), step: name });
    }
  };
  /** A send that may take no longer than `timeoutMs`; a late one finishes in the background. */
  const bounded = <T>(work: Promise<T>, label: string): Promise<T> => {
    if (!(timeoutMs > 0)) return work;
    // A send that fails after we stopped waiting is logged by comms itself;
    // it must not surface as an unhandled rejection.
    work.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} took longer than ${timeoutMs} ms; left to finish in the background`)),
        timeoutMs,
      );
    });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  };

  async function ensureTemplates(tenantId: string): Promise<number> {
    let added: Array<{ id: string }>;
    try {
      added = (await db
        .insert(commsTemplates)
        .values(
          SCHEDULING_EMAIL_TEMPLATES.map((template) => ({
            tenantId,
            key: template.key,
            channel: "email",
            subject: template.subject,
            body: template.body,
          })),
        )
        .onConflictDoNothing({ target: [commsTemplates.tenantId, commsTemplates.key] })
        .returning({ id: commsTemplates.id })) as Array<{ id: string }>;
    } catch (error) {
      if (isMissingTable(error)) throw new Error(COMMS_TABLES_MISSING, { cause: error });
      throw error;
    }
    ensured.add(tenantId);
    return added.length;
  }

  async function verify(): Promise<void> {
    try {
      await db.select({ id: commsTemplates.id }).from(commsTemplates).limit(1);
      await db.select({ id: commsMessages.id }).from(commsMessages).limit(1);
      await db.select({ id: commsScheduled.id }).from(commsScheduled).limit(1);
    } catch (error) {
      throw new Error(isMissingTable(error) ? COMMS_TABLES_MISSING : `The comms tables couldn't be read: ${String(error)}`, {
        cause: error,
      });
    }
  }

  /** Replace the exact token with ":token" in one delivery-log row. */
  async function redactMessage(tenantId: string, messageId: string, token: string): Promise<void> {
    await db
      .update(commsMessages)
      .set({
        subject: sql`replace(${commsMessages.subject}, ${token}, ':token')`,
        body: sql`replace(${commsMessages.body}, ${token}, ':token')`,
      })
      .where(and(eq(commsMessages.tenantId, tenantId), eq(commsMessages.id, messageId)));
  }

  async function sendCustomer(event: SchedulingEvent, settings: SchedulingSettings, templateKey: SchedulingTemplateKey, withLink: boolean) {
    const visit = event.data.visit;
    if (!event.data.notify || !visit.customerEmail) return;
    await step(`send:${templateKey}`, visit.id, event.id, async () => {
      let token: string | null = null;
      if (withLink) token = await issueManageToken(db, event.tenantId, visit.id);
      const vars = schedulingEmailVars(event, settings, {
        manageUrl: token ? options.manageUrl(token, event.tenantId) : null,
        bookUrl: options.bookUrl,
        adminUrl: options.adminUrl,
        locale: options.locale,
      });
      const message = await bounded(
        sendNow(
          db,
          {
            tenantId: event.tenantId,
            to: visit.customerEmail as string,
            templateKey,
            vars,
            idempotencyKey: `visit:${visit.id}:${event.id}:customer`,
          },
          options.senders,
        ),
        `the ${templateKey} email`,
      );
      if (token && message?.id) await redactMessage(event.tenantId, message.id, token);
    });
  }

  async function sendStaff(event: SchedulingEvent, settings: SchedulingSettings) {
    const kind = staffNoticeKind(event);
    if (!kind) return;
    const recipients = settings.staffNotifyEmails.length > 0 ? settings.staffNotifyEmails : [...(options.staffEmails ?? [])];
    if (recipients.length === 0) return;
    const vars = schedulingEmailVars(event, settings, {
      manageUrl: null,
      bookUrl: options.bookUrl,
      adminUrl: options.adminUrl,
      locale: options.locale,
      audience: "staff",
    });
    // Side by side, not one after another: five office addresses behind a slow
    // mail server must not add up to minutes on the customer's request.
    await Promise.all(
      recipients.map((to, index) =>
        step("send:visit_staff_notice", event.visitId, event.id, () =>
          bounded(
            sendNow(
              db,
              {
                tenantId: event.tenantId,
                to,
                templateKey: "visit_staff_notice",
                vars,
                idempotencyKey: `visit:${event.visitId}:${event.id}:staff:${index}`,
              },
              options.senders,
            ),
            "the office notice",
          ),
        ),
      ),
    );
  }

  async function withdrawReminder(event: SchedulingEvent) {
    await step("withdraw", event.visitId, event.id, () =>
      cancelScheduled(db, { tenantId: event.tenantId, refType: SCHEDULING_COMMS_REF_TYPE, refId: event.visitId }),
    );
  }

  /**
   * Queue the reminder for a CONFIRMED visit, at `reminderSendAt`, when that is still
   * more than an hour away — a reminder minutes after the confirmation is
   * noise. Built from the link-free variables: this row sits in a table for a
   * day, and `beforeSend` renders it again from the visit as it is then. The
   * dedupe key carries the visit's sequence, which `beforeSend` checks.
   */
  async function queueReminder(event: SchedulingEvent, settings: SchedulingSettings) {
    const visit = event.data.visit;
    if (options.reminders === false || settings.reminderLeadHours <= 0) return;
    if (visit.status !== "confirmed" || !visit.customerEmail) return;
    const startsAt = new Date(visit.startsAt);
    const sendAt = reminderSendAt(startsAt, settings, options.reminderRuns);
    if (sendAt.getTime() <= clock().getTime() + HOUR_MS) return;
    const expiresAt = new Date(Math.max(sendAt.getTime() + MINUTE_MS, startsAt.getTime() - 30 * MINUTE_MS));
    await step("queue:visit_reminder", visit.id, event.id, () =>
      enqueueMessage(db, {
        tenantId: event.tenantId,
        to: visit.customerEmail as string,
        templateKey: "visit_reminder",
        channel: "email",
        vars: schedulingEmailVars(event, settings, {
          manageUrl: null,
          bookUrl: options.bookUrl,
          adminUrl: options.adminUrl,
          locale: options.locale,
        }),
        sendAt,
        expiresAt,
        refType: SCHEDULING_COMMS_REF_TYPE,
        refId: visit.id,
        dedupeKey: `visit:${visit.id}:reminder:${visit.sequence}`,
        // The listener has already judged the timing on its own clock.
        skipIfPast: false,
      }),
    );
  }

  async function onEvent(event: SchedulingEvent): Promise<void> {
    try {
      let settings: SchedulingSettings;
      try {
        settings = await getSchedulingSettings(db, event.tenantId);
      } catch (error) {
        report(error, { visitId: event.visitId, eventId: event.id, step: "settings" });
        return;
      }
      if (!ensured.has(event.tenantId)) {
        await step("templates", event.visitId, event.id, () => ensureTemplates(event.tenantId));
      }
      const pending = event.data.visit.status === "pending";
      switch (event.type) {
        case "visit.requested":
          if (pending) await sendCustomer(event, settings, "visit_requested", true);
          await sendStaff(event, settings);
          return;
        case "visit.confirmed":
          // A confirmation re-sent to a corrected email address replaces a
          // reminder queued for the old one; for an accept there is nothing
          // to withdraw and this is one cheap query.
          await withdrawReminder(event);
          await sendCustomer(event, settings, "visit_confirmed", true);
          await queueReminder(event, settings);
          return;
        case "visit.declined":
          await withdrawReminder(event);
          await sendCustomer(event, settings, "visit_declined", false);
          return;
        case "visit.rescheduled":
          await withdrawReminder(event);
          await sendCustomer(event, settings, "visit_rescheduled", true);
          await sendStaff(event, settings);
          await queueReminder(event, settings);
          return;
        case "visit.reassigned":
          // The reminder stays: the time didn't change, and neither did the sequence.
          await sendCustomer(event, settings, "visit_reassigned", true);
          return;
        case "visit.cancelled":
          await withdrawReminder(event);
          await sendCustomer(event, settings, "visit_cancelled", false);
          await sendStaff(event, settings);
          return;
        case "visit.expired":
          await withdrawReminder(event);
          await sendCustomer(event, settings, "visit_expired", false);
          await sendStaff(event, settings);
          return;
        case "visit.started":
        case "visit.completed":
          return;
      }
    } catch (error) {
      report(error, { visitId: event.visitId, eventId: event.id, step: "event" });
    }
  }

  /**
   * At send time, re-check a queued reminder against the visit — still there,
   * still confirmed, still the same version (its dedupe key carries the
   * sequence; a moved visit, or one whose email was corrected, has a newer
   * one), more than 30 minutes away, reminders still switched on — and render
   * it again from the visit AS IT IS NOW: the address it goes TO (`to`), and
   * every variable (a name or address staff corrected since the reminder was
   * queued). Past the change deadline the manage line gives the phone instead
   * of an offer the server would refuse, and no link is minted; before it, a
   * fresh token goes in the link. The withdrawal on every move is the first
   * line; this is the backstop.
   */
  async function beforeSend(row: ScheduledRow): Promise<BeforeSendResult | null> {
    if (row.refType !== SCHEDULING_COMMS_REF_TYPE) return null;
    if (!row.refId) return { skip: true, reason: "the reminder names no visit" };
    const visit = await getBookingRow(db, row.tenantId, row.refId);
    if (!visit) return { skip: true, reason: "the visit no longer exists" };
    if (visit.status !== "confirmed") return { skip: true, reason: `the visit is ${visit.status.replace(/_/g, " ")}` };
    const queuedFor = /:reminder:(\d+)$/.exec(row.dedupeKey ?? "");
    if (queuedFor && Number(queuedFor[1]) !== visit.sequence) {
      return { skip: true, reason: "the visit has moved since this reminder was queued" };
    }
    if (!visit.customerEmail) return { skip: true, reason: "the visit has no email address any more" };
    const settings = await getSchedulingSettings(db, row.tenantId);
    if (settings.reminderLeadHours <= 0) return { skip: true, reason: "reminders are switched off" };
    const now = clock();
    const { startsAt } = instantsOf(visit, settings.timeZone);
    if (startsAt.getTime() - now.getTime() < 30 * MINUTE_MS) {
      return { skip: true, reason: "the visit starts in under 30 minutes" };
    }
    const changeable = now.getTime() < startsAt.getTime() - settings.cancelCutoffHours * HOUR_MS;
    let manageUrl: string | null = null;
    if (changeable) {
      const token = await insertManageToken(db, row.tenantId, visit.id);
      manageUrl = options.manageUrl(token, row.tenantId);
      minted.push({ tenantId: row.tenantId, scheduledId: row.id, token });
    }
    let resourceName: string | null = null;
    if (visit.resourceId) {
      try {
        resourceName = (await resourceNames(db, row.tenantId, [visit.resourceId])).get(visit.resourceId) ?? null;
      } catch {
        /* the crew's name is a nicety */
      }
    }
    const snapshot = toVisitSnapshot(visit, { settings, resourceName });
    const vars = schedulingEmailVars(
      {
        id: row.id,
        type: "visit.confirmed",
        tenantId: row.tenantId,
        visitId: visit.id,
        occurredAt: now.toISOString(),
        actor: { type: "system", id: null },
        data: { visit: snapshot, notify: true },
      },
      settings,
      { manageUrl, bookUrl: options.bookUrl, adminUrl: options.adminUrl, locale: options.locale, now },
    );
    return { to: visit.customerEmail, vars };
  }

  /**
   * Scrub every manage link from the delivery log, and return how many rows
   * changed:
   *
   *   1. each link `beforeSend` minted in this process (exact replace, in the
   *      rows of its queue row, whatever their status); a failed update is
   *      kept for the next call;
   *   2. then a SWEEP of the last two weeks of scheduling emails for anything
   *      shaped like a token, whatever process minted it. A drain that threw
   *      part-way, a function killed at its time limit, a send that finished
   *      after the listener stopped waiting — each used to leave a working key
   *      in a log every staff member can read, because the list of what to
   *      scrub lived only in this process's memory.
   */
  async function redactSent(): Promise<number> {
    const work = minted.splice(0, minted.length);
    let changed = 0;
    for (const item of work) {
      try {
        const rows = (await db
          .update(commsMessages)
          .set({
            subject: sql`replace(${commsMessages.subject}, ${item.token}, ':token')`,
            body: sql`replace(${commsMessages.body}, ${item.token}, ':token')`,
          })
          .where(
            and(
              eq(commsMessages.tenantId, item.tenantId),
              eq(commsMessages.scheduledId, item.scheduledId),
              sql`(position(${item.token} in ${commsMessages.body}) > 0 or position(${item.token} in coalesce(${commsMessages.subject}, '')) > 0)`,
            ),
          )
          .returning({ id: commsMessages.id })) as Array<{ id: string }>;
        changed += rows.length;
      } catch (error) {
        minted.push(item);
        report(error, { visitId: "", step: "redact" });
      }
    }
    try {
      const swept = (await db
        .update(commsMessages)
        .set({
          subject: sql`regexp_replace(${commsMessages.subject}, ${TOKEN_IN_TEXT}, ':token', 'g')`,
          body: sql`regexp_replace(${commsMessages.body}, ${TOKEN_IN_TEXT}, ':token', 'g')`,
        })
        .where(
          and(
            inArray(
              commsMessages.templateKey,
              SCHEDULING_EMAIL_TEMPLATES.map((template) => template.key),
            ),
            gt(commsMessages.createdAt, sql`now() - make_interval(days => ${SWEEP_DAYS}::int)`),
            sql`(${commsMessages.body} ~ ${TOKEN_IN_TEXT} or coalesce(${commsMessages.subject}, '') ~ ${TOKEN_IN_TEXT})`,
          ),
        )
        .returning({ id: commsMessages.id })) as Array<{ id: string }>;
      changed += swept.length;
    } catch (error) {
      report(error, { visitId: "", step: "redact-sweep" });
    }
    return changed;
  }

  return { onEvent, beforeSend, redactSent, ensureTemplates, verify };
}
