/**
 * @adminigloo/estimator/comms — the emails an estimate deserves, delivered
 * through @adminigloo/comms (an OPTIONAL peer: only this entry imports it, so
 * an app that sends its own mail imports the barrel and never needs comms).
 *
 *   const estimatorComms = createEstimatorCommsListener({ db, senders, quoteUrl, adminEstimateUrl, bookUrl });
 *   createEstimatorHandlers({ …, onEvent: estimatorComms.onEvent });
 *   createEstimatorAdminHandlers({ …, onEvent: estimatorComms.onEvent });
 *   // the comms cron:
 *   try {
 *     await runDueMessages(db, senders, { beforeSend: async (row) => (await estimatorComms.beforeSend(row)) ?? "send" });
 *   } finally {
 *     await estimatorComms.redactSent();
 *   }
 *
 * WHAT GOES OUT, per event (section 7.1 of the 0.3 contract): the customer's
 * copy of their estimate and a new-lead notice to the office; the quote with
 * its link; a follow-up when nobody answers, withdrawn the moment they do; a
 * thank-you with the next step when they accept; a note when it expires; and
 * an office notice when a customer accepts or declines, or a quote lapses.
 *
 * THE COMMS TENANT IS THE ESTIMATOR TENANT: templates, sends and the queue all
 * use `event.tenantId`.
 *
 * NO KEY SITS IN A TABLE. A quote link is a key to the customer's quote.
 *   - An email sent now gets a freshly minted token; right after the send,
 *     that one `comms_messages` row is rewritten with the token replaced by
 *     ":token". The plaintext sits in the delivery log only between the
 *     insert and that update.
 *   - The follow-up is QUEUED without a link (it sits in `comms_scheduled`
 *     for days). At send time `beforeSend` mints a token and injects the link,
 *     and `redactSent()` — run right after `runDueMessages`, in a `finally` —
 *     scrubs it from the delivery log, and sweeps the recent log for any token
 *     a crashed run left behind.
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
import { getEstimateDetail, getEstimateRow, staffDetailOf, type EstimateStaffDetail } from "./estimates.js";
import { loadSnapshots, type EstimatorEvent, type EstimatorEventListener } from "./events.js";
import { insertQuoteToken, issueQuoteToken } from "./quotes.js";
import { formatMoney, getEstimatorSettings, type EstimatorSettings } from "./settings.js";
import { pct } from "./build.js";
import { assumptionForEmail } from "./recipes.js";
import { forEmail, greetingName } from "./text.js";
import type { EstimatorDb } from "./types.js";
import type { EstimateSnapshot } from "./wire.js";

export type { EstimateStaffDetail } from "./estimates.js";

/** The comms `refType` every queued estimate message is tagged with (`refId` = the estimate id). */
export const ESTIMATOR_COMMS_REF_TYPE = "estimator_estimate";

export type EstimatorTemplateKey =
  | "estimate_lead_customer"
  | "estimate_lead_staff"
  | "quote_sent"
  | "quote_follow_up"
  | "quote_accepted_customer"
  | "quote_expired_customer"
  | "quote_staff_notice";

/**
 * The default emails, plain text with `{{variables}}`. They speak as the
 * business and promise nothing the package can't see happen. Inserted once per
 * tenant if absent (`ensureTemplates`), so an owner's edits in the comms admin
 * are never overwritten. A line that is only a variable may render empty (no
 * reading, no corrections); the HTML part folds the blank paragraph away.
 */
export const ESTIMATOR_EMAIL_TEMPLATES: ReadonlyArray<{
  key: EstimatorTemplateKey;
  audience: "customer" | "staff";
  subject: string;
  body: string;
}> = Object.freeze([
  {
    key: "estimate_lead_customer",
    audience: "customer",
    subject: "Your estimate from {{businessName}} ({{estimateNumber}})",
    body: [
      "Hi {{firstName}},",
      "",
      "Thanks for asking. Here's the estimate you saw on our website:",
      "",
      "{{lineSummary}}",
      "",
      "{{estimateLine}}",
      "{{assumptionLine}}",
      "",
      "This is a ballpark from what you told us. We'll confirm the price once we've seen the job, and we'll be in touch soon.",
      "",
      "Your reference: {{estimateNumber}}",
      "",
      "{{contactLine}}",
      "",
      "{{businessName}}",
    ].join("\n"),
  },
  {
    key: "estimate_lead_staff",
    audience: "staff",
    subject: "New lead: {{customerName}}, {{rangeText}} ({{estimateNumber}})",
    body: [
      "{{customerName}} asked for an estimate on your website.",
      "",
      "{{lineSummary}}",
      "",
      "{{estimateLine}}",
      "{{rangeWhyLine}}",
      "{{readingLine}}",
      "{{correctionLine}}",
      "{{photoLine}}",
      "",
      "Who: {{customerName}}",
      "Email: {{customerEmail}}",
      "Phone: {{customerPhone}}",
      "Where: {{address}}",
      "Notes: {{notes}}",
      "",
      "{{adminLine}}",
    ].join("\n"),
  },
  {
    key: "quote_sent",
    audience: "customer",
    subject: "Your quote from {{businessName}} ({{estimateNumber}})",
    body: [
      "Hi {{firstName}},",
      "",
      "{{messageLine}}",
      "",
      "Total: {{totalText}}",
      "Good until: {{validUntilText}}",
      "",
      "{{quoteLine}}",
      "",
      "{{contactLine}}",
      "",
      "{{businessName}}",
    ].join("\n"),
  },
  {
    key: "quote_follow_up",
    audience: "customer",
    subject: "Following up on your quote {{estimateNumber}}",
    body: [
      "Hi {{firstName}},",
      "",
      "Just checking in on the quote we sent on {{sentDateText}} for {{totalText}}. It's good until {{validUntilText}}.",
      "",
      "{{quoteLine}}",
      "",
      "{{contactLine}}",
      "",
      "{{businessName}}",
    ].join("\n"),
  },
  {
    key: "quote_accepted_customer",
    audience: "customer",
    subject: "Thanks, you've accepted quote {{estimateNumber}}",
    body: [
      "Hi {{firstName}},",
      "",
      "Thanks for accepting our quote for {{totalText}}.",
      "",
      "{{nextStepLine}}",
      "",
      "{{quoteLine}}",
      "",
      "{{contactLine}}",
      "",
      "{{businessName}}",
    ].join("\n"),
  },
  {
    key: "quote_expired_customer",
    audience: "customer",
    subject: "Your quote {{estimateNumber}} has expired",
    body: [
      "Hi {{firstName}},",
      "",
      "The quote we sent for {{totalText}} expired on {{validUntilText}}. Prices can change, so if you'd still like the work, get in touch and we'll send you an updated one.",
      "",
      "{{contactLine}}",
      "",
      "{{businessName}}",
    ].join("\n"),
  },
  {
    key: "quote_staff_notice",
    audience: "staff",
    subject: "{{subjectTag}}: {{customerName}}, {{estimateNumber}}",
    body: [
      "{{headline}}",
      "",
      "Total: {{totalText}}",
      "{{responseNoteLine}}",
      "",
      "Who: {{customerName}}",
      "Email: {{customerEmail}}",
      "Phone: {{customerPhone}}",
      "Where: {{address}}",
      "",
      "{{adminLine}}",
    ].join("\n"),
  },
]);

// --- Variables -----------------------------------------------------------------------

export interface EstimatorEmailVarsOptions {
  /** The customer's quote link for THIS message, or null (a lead, a queued follow-up, a staff notice). */
  quoteUrl: string | null;
  /** The estimate in the admin, for staff emails. */
  adminUrl?: string | undefined;
  /** The accepted email's next step ("Pick a time for the work here: …"). */
  bookUrl?: string | null | undefined;
  /** Default: the settings' locale. */
  locale?: string | undefined;
  /** Who reads it. An unknown value is "—" in a staff email and nothing in a customer's. Default "customer". */
  audience?: "customer" | "staff";
  /** What a staff email adds and an event never carries: the photo count, each line's reading and corrections. */
  staffDetail?: EstimateStaffDetail | null;
}

const LINK_FREE_QUOTE_LINE = "Use the link in our earlier email to see it, or reply to this one.";

function contactLineFor(settings: Pick<EstimatorSettings, "contactPhone" | "contactEmail">): string {
  const phone = settings.contactPhone?.trim();
  const email = settings.contactEmail?.trim();
  if (phone && email) return `Questions? Call ${phone} or email ${email}.`;
  if (phone) return `Questions? Call ${phone}.`;
  if (email) return `Questions? Email ${email}.`;
  return "";
}

function longDate(iso: string | null, settings: EstimatorSettings, locale: string): string {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat(locale, { month: "long", day: "numeric", year: "numeric", timeZone: settings.timeZone }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(iso));
  }
}

type StaffNoticeKind = "Quote accepted" | "Quote declined" | "Quote expired";

/** The staff notice an event warrants, or null. Never for a change staff made themselves. */
function staffNoticeKind(event: EstimatorEvent): StaffNoticeKind | null {
  if (event.type === "quote.expired") return "Quote expired";
  if (event.actor.type !== "customer") return null;
  if (event.type === "quote.accepted") return "Quote accepted";
  if (event.type === "quote.declined") return "Quote declined";
  return null;
}

/**
 * Every template variable for one event, as strings (pure). Exported for
 * tests and for a host that sends through its own mailer. Every variable any
 * template uses is present (possibly empty), so a send records no missing
 * variables.
 *
 * WHAT A CUSTOMER TYPED IS NEVER A LINK — in ANY email. The name, phone,
 * address and notes come from an anonymous form; the customer's copy goes to
 * an address nobody verified, from the business's domain, and the office's
 * notice is one an attacker can fill with "your account is suspended, sign in
 * at https://…" (review ADV-8). Every value a visitor typed is one line with
 * any link-shaped text broken (`forEmail(…, "customer")`), whoever reads it;
 * staff can still read the address. The line's name is the product's (a
 * visitor can't name a line, review ADV-1) and is treated the same way. The
 * greeting uses the first name only when it looks like one ("there"
 * otherwise).
 */
export function estimatorEmailVars(
  event: EstimatorEvent,
  settings: EstimatorSettings,
  options: EstimatorEmailVarsOptions,
): Record<string, string> {
  const locale = options.locale ?? settings.locale;
  const money = { currency: event.data.estimate.currency || settings.currency, locale };
  const audience = options.audience === "staff" ? "staff" : "customer";
  const staff = audience === "staff";
  const unknown = staff ? "—" : "";
  // Anything a visitor typed: one line, and never a link, in every email.
  const typed = (value: string | null | undefined): string => forEmail(value ?? "", "customer");
  const estimate = event.data.estimate;
  const customerName = typed(estimate.customerName);
  const who = customerName || "A customer";

  const whole = (cents: number) => formatMoney(cents, money, true);
  const exact = (cents: number) => formatMoney(cents, money);
  const single = estimate.rangeLow === estimate.rangeHigh;
  const rangeText = single ? whole(estimate.rangeLow) : `${whole(estimate.rangeLow)} – ${whole(estimate.rangeHigh)}`;
  const taxed = estimate.taxRateBp > 0;
  const estimateLine = taxed ? `Estimate: ${rangeText}, plus ${pct(estimate.taxRateBp)} sales tax.` : `Estimate: ${rangeText}.`;
  const totalText = taxed ? `${exact(estimate.total)}, including ${exact(estimate.taxAmount)} sales tax` : exact(estimate.total);

  const lineSummary = estimate.lines
    .map((line) => {
      let text = `• ${typed(line.description)}`;
      if (line.inputsSummary) text += `: ${line.inputsSummary}`;
      if (line.options.length > 0) text += ` (${line.options.join(", ")})`;
      const amount =
        line.total === 0 && line.lowTotal === 0 && line.highTotal === 0
          ? "priced after a look"
          : line.lowTotal === line.highTotal
            ? whole(line.total)
            : `${whole(line.lowTotal)} – ${whole(line.highTotal)}`;
      return `${text}, ${amount}`;
    })
    .join("\n");
  const assumptions: string[] = [];
  // An email has no field to type a height into: "measure one step and enter
  // it" becomes "reply with the height of one step" (review EST-R14).
  for (const line of estimate.lines) {
    const said = line.assumption ? assumptionForEmail(line.assumption) : null;
    if (said && !assumptions.includes(said)) assumptions.push(said);
  }

  const detail = options.staffDetail ?? null;
  const readingLine = staff && detail
    ? detail.lines
        .filter((line) => line.reading)
        .map((line) => `From the photo: ${line.reading?.lines.join(" ")} (${line.reading?.confidence} confidence).`)
        .join("\n")
    : "";
  const corrections = staff && detail ? detail.lines.flatMap((line) => line.corrections) : [];
  const correctionLine =
    corrections.length > 0
      ? `The customer changed: ${corrections.map((c) => `${c.label.toLowerCase()} ${c.from} → ${c.to ?? "nothing"}`).join(", ")}.`
      : "";
  const photoCount = detail?.photoCount ?? estimate.photoCount;
  // Not "attached": the email carries no file; the photos are on the estimate (review EST-R14).
  const photoLine =
    staff && photoCount > 0 ? `${photoCount} photo${photoCount === 1 ? ": see it" : "s: see them"} on the estimate.` : "";
  const rangeWhyLine = staff && !single && estimate.rangeReasons.length > 0 ? `Why it's a range: ${estimate.rangeReasons.join("; ")}.` : "";

  const kind = staffNoticeKind(event);
  const headline =
    kind === "Quote accepted"
      ? `${who} accepted quote ${estimate.number} for ${totalText}. Next: schedule the work.`
      : kind === "Quote declined"
        ? `${who} declined quote ${estimate.number}.`
        : kind === "Quote expired"
          ? `Quote ${estimate.number} for ${who} expired without an answer. Call them if you'd still like the work.`
          : `Quote ${estimate.number} for ${who} has changed.`;
  const note = event.data.note?.trim();

  return {
    firstName: greetingName(estimate.customerName),
    customerName: customerName || unknown,
    customerEmail: estimate.customerEmail?.trim() || unknown,
    customerPhone: typed(estimate.customerPhone) || unknown,
    address: typed(estimate.jobAddress) || unknown,
    notes: typed(estimate.notes) || unknown,
    businessName: settings.businessName.trim() || unknown,
    estimateNumber: estimate.number,
    rangeText,
    estimateLine,
    totalText,
    lineSummary,
    assumptionLine: assumptions.join(" "),
    rangeWhyLine,
    readingLine,
    correctionLine,
    photoLine,
    adminLine: options.adminUrl ? `Open it: ${options.adminUrl}` : "Open it in your estimates.",
    quoteUrl: options.quoteUrl ?? "",
    quoteLine: options.quoteUrl
      ? `See the details and accept or decline it here, no account needed:\n${options.quoteUrl}`
      : LINK_FREE_QUOTE_LINE,
    validUntilText: longDate(estimate.validUntil, settings, locale),
    sentDateText: longDate(estimate.sentAt, settings, locale),
    messageLine: estimate.quoteMessage?.trim() || "Here's your quote for the work we talked about.",
    nextStepLine: options.bookUrl ? `Pick a time for the work here: ${options.bookUrl}` : "We'll be in touch soon to schedule the work.",
    contactLine: contactLineFor(settings),
    subjectTag: kind ?? "Quote update",
    headline,
    responseNoteLine: note ? `Their note: "${typed(note)}"` : "",
  };
}

// --- When follow-ups can actually go out --------------------------------------------------

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * HOUR_MS;

/** When the comms cron runs: once a day at a UTC time, or every N minutes (scheduling's `reminderRuns`). */
export type FollowUpRuns = { dailyAtUtc: string } | { everyMinutes: number };

/**
 * COPIED FROM @adminigloo/scheduling's comms.ts (`lastRunAtOrBefore`); change
 * both or neither. The last run of the comms cron at or before `instant`: a
 * follow-up due at 16:00Z on a cron that runs at 14:00Z goes out at 14:00Z the
 * same day (a little early) rather than the next day.
 */
export function lastRunAtOrBefore(instant: Date, runs: FollowUpRuns): Date {
  if ("everyMinutes" in runs) {
    const step = Math.max(1, Math.trunc(runs.everyMinutes)) * MINUTE_MS;
    return new Date(Math.floor(instant.getTime() / step) * step);
  }
  const match = /^(\d{1,2}):(\d{2})$/.exec(runs.dailyAtUtc.trim());
  if (!match) return instant;
  const sameDay = Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate(), Number(match[1]), Number(match[2]));
  return new Date(sameDay <= instant.getTime() ? sameDay : sameDay - DAY_MS);
}

/** When a quote's follow-up goes: `sentAt + followUpDays`, on the last cron run at or before it. */
export function followUpSendAt(sentAt: Date, followUpDays: number, runs?: FollowUpRuns): Date {
  const target = new Date(sentAt.getTime() + followUpDays * DAY_MS);
  return runs ? lastRunAtOrBefore(target, runs) : target;
}

// --- The listener ----------------------------------------------------------------------------

export interface EstimatorCommsOptions {
  /** The comms tables live in the same database as the estimates. */
  db: EstimatorDb;
  senders: CommsSenders;
  /** The customer's quote page for a token. */
  quoteUrl: (token: string, tenantId: string) => string;
  /** The estimate in the admin, in staff emails. */
  adminEstimateUrl?: (estimateId: string, tenantId: string) => string;
  /** The accepted email's next step (scheduling's booking page with the estimate). */
  bookUrl?: (estimate: EstimateSnapshot, tenantId: string) => string | null;
  /** Who gets staff emails when the business saved no `leadNotifyEmails`. */
  staffEmails?: readonly string[];
  /** Default: the settings' locale. */
  locale?: string;
  /** Queue a follow-up after each sent quote. Default true (and `followUpDays` > 0). */
  followUps?: boolean;
  /** When the comms cron runs (`{ dailyAtUtc: "14:00" }`, `{ everyMinutes: 15 }`). Default: the exact instant. */
  followUpRuns?: FollowUpRuns;
  /** Longest a single send may hold up the request that caused it, in ms. Default 10000; 0 waits for ever. */
  sendTimeoutMs?: number;
  now?: () => Date;
  /** Told about each step that failed. The listener never throws. Default `console.error`. */
  onError?: (error: unknown, context: { estimateId: string; eventId?: string; step: string }) => void;
}

export interface EstimatorCommsListener {
  /** Hand to the handlers' (or any writer's) `onEvent`. Never throws. */
  onEvent: EstimatorEventListener;
  /** For `runDueMessages`' `beforeSend`: null → not an estimator row (decide it yourself, usually "send"). */
  beforeSend(row: ScheduledRow): Promise<BeforeSendResult | null>;
  /** Run right after `runDueMessages`, in a `finally`: scrubs every quote link from the delivery log. */
  redactSent(): Promise<number>;
  /** Insert the seven templates for a tenant if absent; returns how many were added. */
  ensureTemplates(tenantId: string): Promise<number>;
  /** Check the comms tables are there, at startup or in a health check: a plain sentence when they aren't. */
  verify(): Promise<void>;
}

/** What a host sees when the comms migration never ran. */
export const COMMS_TABLES_MISSING =
  "The @adminigloo/comms tables (comms_templates, comms_messages, comms_scheduled) aren't in this database, so no estimate email can be sent. Generate and run the comms migration beside the estimator one (see the estimator README).";

function isMissingTable(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : String(error);
  return /comms_(templates|messages|scheduled)/.test(text) && /does not exist|no such table|undefined table/i.test(text);
}

/** A quote token as it appears in a link: 43 base64url characters, alone. (UUIDv7 ids are 36 with dashes: never matched.) */
const TOKEN_IN_TEXT = "(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])";
/** How far back `redactSent` sweeps the delivery log for a link a crashed run left behind. */
const SWEEP_DAYS = 14;

/**
 * The comms wiring for estimate events: which email goes to whom, the
 * follow-up queue, and the key-free delivery log. Each step — the withdrawal,
 * each send, the queueing — runs in its own try/catch and reports through
 * `onError`, so one failure doesn't stop the others and `onEvent` never
 * rejects. The follow-up is WITHDRAWN FIRST, before any send.
 */
export function createEstimatorCommsListener(options: EstimatorCommsOptions): EstimatorCommsListener {
  const { db } = options;
  const ensured = new Set<string>();
  const minted: Array<{ tenantId: string; scheduledId: string; token: string }> = [];
  const clock = () => options.now?.() ?? new Date();
  const timeoutMs = options.sendTimeoutMs ?? 10_000;
  const templateKeys = ESTIMATOR_EMAIL_TEMPLATES.map((template) => template.key);

  const report = (error: unknown, context: { estimateId: string; eventId?: string; step: string }) => {
    try {
      if (options.onError) options.onError(error, context);
      else console.error("[@adminigloo/estimator/comms] an email step failed", context, error);
    } catch {
      /* a broken reporter must not break the listener */
    }
  };
  const step = async (name: string, estimateId: string, eventId: string | undefined, work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (error) {
      report(error, { estimateId, ...(eventId ? { eventId } : {}), step: name });
    }
  };
  /** A send that may take no longer than `timeoutMs`; a late one finishes in the background. */
  const bounded = <T>(work: Promise<T>, label: string): Promise<T> => {
    if (!(timeoutMs > 0)) return work;
    work.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} took longer than ${timeoutMs} ms; left to finish in the background`)), timeoutMs);
    });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  };

  async function ensureTemplates(tenantId: string): Promise<number> {
    let added: Array<{ id: string }>;
    try {
      added = (await db
        .insert(commsTemplates)
        .values(
          ESTIMATOR_EMAIL_TEMPLATES.map((template) => ({
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
      throw new Error(isMissingTable(error) ? COMMS_TABLES_MISSING : `The comms tables couldn't be read: ${String(error)}`, { cause: error });
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

  const bookUrlFor = (estimate: EstimateSnapshot, tenantId: string): string | null => {
    try {
      return options.bookUrl ? options.bookUrl(estimate, tenantId) : null;
    } catch {
      return null;
    }
  };

  async function sendCustomer(event: EstimatorEvent, settings: EstimatorSettings, templateKey: EstimatorTemplateKey, withLink: boolean) {
    const estimate = event.data.estimate;
    if (!event.data.notify || !estimate.customerEmail) return;
    await step(`send:${templateKey}`, estimate.id, event.id, async () => {
      let token: string | null = null;
      if (withLink) token = await issueQuoteToken(db, event.tenantId, estimate.id);
      const vars = estimatorEmailVars(event, settings, {
        quoteUrl: token ? options.quoteUrl(token, event.tenantId) : null,
        bookUrl: bookUrlFor(estimate, event.tenantId),
        locale: options.locale,
      });
      const message = await bounded(
        sendNow(
          db,
          {
            tenantId: event.tenantId,
            to: estimate.customerEmail as string,
            templateKey,
            vars,
            idempotencyKey: `estimate:${estimate.id}:${event.id}:customer`,
          },
          options.senders,
        ),
        `the ${templateKey} email`,
      );
      if (token && message?.id) await redactMessage(event.tenantId, message.id, token);
    });
  }

  async function staffDetail(event: EstimatorEvent): Promise<EstimateStaffDetail | null> {
    try {
      const detail = await getEstimateDetail(db, event.tenantId, event.estimateId, { includeCosts: false, now: clock() });
      return detail ? staffDetailOf(detail) : null;
    } catch (error) {
      report(error, { estimateId: event.estimateId, eventId: event.id, step: "staff-detail" });
      return null;
    }
  }

  async function sendStaff(event: EstimatorEvent, settings: EstimatorSettings, templateKey: EstimatorTemplateKey) {
    if (event.type !== "lead.received" && !staffNoticeKind(event)) return;
    if (event.type === "lead.received" && event.actor.type === "staff") return;
    const recipients = settings.leadNotifyEmails.length > 0 ? settings.leadNotifyEmails : [...(options.staffEmails ?? [])];
    if (recipients.length === 0) return;
    const vars = estimatorEmailVars(event, settings, {
      quoteUrl: null,
      adminUrl: options.adminEstimateUrl ? options.adminEstimateUrl(event.estimateId, event.tenantId) : undefined,
      locale: options.locale,
      audience: "staff",
      staffDetail: await staffDetail(event),
    });
    // Side by side: five office addresses behind a slow mail server must not
    // add up to minutes on the customer's request.
    await Promise.all(
      recipients.map((to, index) =>
        step(`send:${templateKey}`, event.estimateId, event.id, () =>
          bounded(
            sendNow(
              db,
              {
                tenantId: event.tenantId,
                to,
                templateKey,
                vars,
                idempotencyKey: `estimate:${event.estimateId}:${event.id}:staff:${index}`,
              },
              options.senders,
            ),
            "the office email",
          ),
        ),
      ),
    );
  }

  async function withdrawFollowUp(event: EstimatorEvent) {
    await step("withdraw", event.estimateId, event.id, () =>
      cancelScheduled(db, { tenantId: event.tenantId, refType: ESTIMATOR_COMMS_REF_TYPE, refId: event.estimateId }),
    );
  }

  /**
   * Queue the follow-up for a quote just sent, at `sentAt + followUpDays`
   * (on the cron run before it), when that is before the quote expires and
   * more than an hour away. LINK-FREE: this row sits in a table for days;
   * `beforeSend` renders it again from the quote as it is then, with a fresh
   * link. The dedupe key carries the quote's sequence, which `beforeSend`
   * checks, so a follow-up for a revised quote never goes.
   */
  async function queueFollowUp(event: EstimatorEvent, settings: EstimatorSettings) {
    const estimate = event.data.estimate;
    if (options.followUps === false || settings.followUpDays <= 0) return;
    if (!estimate.customerEmail || !estimate.sentAt || !estimate.validUntil) return;
    const sendAt = followUpSendAt(new Date(estimate.sentAt), settings.followUpDays, options.followUpRuns);
    const validUntil = new Date(estimate.validUntil);
    if (sendAt.getTime() >= validUntil.getTime()) return;
    if (sendAt.getTime() <= clock().getTime() + HOUR_MS) return;
    await step("queue:quote_follow_up", estimate.id, event.id, () =>
      enqueueMessage(db, {
        tenantId: event.tenantId,
        to: estimate.customerEmail as string,
        templateKey: "quote_follow_up",
        channel: "email",
        vars: estimatorEmailVars(event, settings, { quoteUrl: null, locale: options.locale }),
        sendAt,
        expiresAt: validUntil,
        refType: ESTIMATOR_COMMS_REF_TYPE,
        refId: estimate.id,
        dedupeKey: `estimate:${estimate.id}:followup:${estimate.quoteSequence}`,
        // The listener has already judged the timing on its own clock.
        skipIfPast: false,
      }),
    );
  }

  async function onEvent(event: EstimatorEvent): Promise<void> {
    try {
      let settings: EstimatorSettings;
      try {
        settings = await getEstimatorSettings(db, event.tenantId);
      } catch (error) {
        report(error, { estimateId: event.estimateId, eventId: event.id, step: "settings" });
        return;
      }
      if (!ensured.has(event.tenantId)) {
        await step("templates", event.estimateId, event.id, () => ensureTemplates(event.tenantId));
      }
      switch (event.type) {
        case "lead.received":
          await sendCustomer(event, settings, "estimate_lead_customer", false);
          await sendStaff(event, settings, "estimate_lead_staff");
          return;
        case "quote.sent":
          if (event.data.via === "resend") {
            // The follow-up already queued stays: same quote, same sequence.
            await sendCustomer(event, settings, "quote_sent", true);
            return;
          }
          await withdrawFollowUp(event);
          await sendCustomer(event, settings, "quote_sent", true);
          await queueFollowUp(event, settings);
          return;
        case "quote.viewed":
          return;
        case "quote.accepted":
          await withdrawFollowUp(event);
          await sendCustomer(event, settings, "quote_accepted_customer", true);
          await sendStaff(event, settings, "quote_staff_notice");
          return;
        case "quote.declined":
          await withdrawFollowUp(event);
          await sendStaff(event, settings, "quote_staff_notice");
          return;
        case "quote.expired":
          await withdrawFollowUp(event);
          await sendCustomer(event, settings, "quote_expired_customer", false);
          await sendStaff(event, settings, "quote_staff_notice");
          return;
        case "quote.revised":
        case "estimate.converted":
          await withdrawFollowUp(event);
          return;
      }
    } catch (error) {
      report(error, { estimateId: event.estimateId, eventId: event.id, step: "event" });
    }
  }

  /**
   * At send time, re-check a queued follow-up against the quote — still
   * there, still waiting for an answer, still the same version (the dedupe
   * key's sequence), not past its date, still with an email — and render it
   * again from the quote AS IT IS NOW, with a fresh link. The withdrawal on
   * every answer is the first line; this is the backstop.
   */
  async function beforeSend(row: ScheduledRow): Promise<BeforeSendResult | null> {
    if (row.refType !== ESTIMATOR_COMMS_REF_TYPE) return null;
    if (!row.refId) return { skip: true, reason: "the follow-up names no estimate" };
    const estimate = await getEstimateRow(db, row.tenantId, row.refId);
    if (!estimate) return { skip: true, reason: "the estimate no longer exists" };
    if (estimate.status !== "sent" && estimate.status !== "viewed") {
      return {
        skip: true,
        reason: estimate.status === "approved" || estimate.status === "rejected" || estimate.status === "converted"
          ? "the customer has answered"
          : `the quote is ${estimate.status}`,
      };
    }
    const queuedFor = /:followup:(\d+)$/.exec(row.dedupeKey ?? "");
    if (queuedFor && Number(queuedFor[1]) !== estimate.quoteSequence) {
      return { skip: true, reason: "the quote was revised since this was queued" };
    }
    const now = clock();
    if (!estimate.validUntil || estimate.validUntil.getTime() <= now.getTime()) return { skip: true, reason: "the quote has expired" };
    if (!estimate.customerEmail) return { skip: true, reason: "the quote has no email address any more" };
    const settings = await getEstimatorSettings(db, row.tenantId);
    const snapshot = (await loadSnapshots(db, row.tenantId, [estimate.id])).get(estimate.id);
    if (!snapshot) return { skip: true, reason: "the estimate no longer exists" };
    const token = await insertQuoteToken(db, row.tenantId, estimate.id, estimate.quoteSequence);
    minted.push({ tenantId: row.tenantId, scheduledId: row.id, token });
    const vars = estimatorEmailVars(
      {
        id: row.id,
        type: "quote.sent",
        tenantId: row.tenantId,
        estimateId: estimate.id,
        occurredAt: now.toISOString(),
        actor: { type: "system", id: null },
        data: { estimate: snapshot, notify: true },
      },
      settings,
      { quoteUrl: options.quoteUrl(token, row.tenantId), locale: options.locale },
    );
    return { to: estimate.customerEmail, vars };
  }

  /**
   * Scrub every quote link from the delivery log, and return how many rows
   * changed: each link `beforeSend` minted in this process (exact replace),
   * then a SWEEP of the last two weeks of estimator emails for anything shaped
   * like a token, whatever process minted it — so the scrub never depends on
   * this process's memory surviving a crash.
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
        report(error, { estimateId: "", step: "redact" });
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
            inArray(commsMessages.templateKey, templateKeys),
            gt(commsMessages.createdAt, sql`now() - make_interval(days => ${SWEEP_DAYS}::int)`),
            sql`(${commsMessages.body} ~ ${TOKEN_IN_TEXT} or coalesce(${commsMessages.subject}, '') ~ ${TOKEN_IN_TEXT})`,
          ),
        )
        .returning({ id: commsMessages.id })) as Array<{ id: string }>;
      changed += swept.length;
    } catch (error) {
      report(error, { estimateId: "", step: "redact-sweep" });
    }
    return changed;
  }

  return { onEvent, beforeSend, redactSent, ensureTemplates, verify };
}
