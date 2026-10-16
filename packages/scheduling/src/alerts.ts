import { and, asc, eq, gt, inArray, isNotNull, lt, lte } from "drizzle-orm";
import type { SchedulingEvent } from "./events.js";
import { formatShortSafe } from "./format.js";
import { instantsOf, labelOf, todayIn } from "./instants.js";
import { schedulingBookings, schedulingResources, schedulingSettings } from "./schema.js";
import { serviceNameFor, type SchedulingService } from "./services.js";
import { DEFAULT_SCHEDULING_SETTINGS } from "./settings.js";
import { oneLine } from "./text.js";
import type { SchedulingDb } from "./types.js";
import { isValidTimeZone } from "./zone.js";

/**
 * Alerts (Tenancy 2b-1, contract 9.1–9.2): what scheduling tells the bell.
 *
 * STRUCTURAL, NO NOTIFICATIONS IMPORT (2a D4). The shapes below are the
 * contract's 3.2 and 3.3, declared here and package-prefixed, so a host
 * passes `schedulingAlertKinds` to `defineAlertRegistry` and the drafts from
 * `schedulingAlertsFor` to `alerts.notify` without scheduling ever loading
 * @adminigloo/notifications. A host with its own inbox reads the drafts as
 * plain data.
 *
 * THE WORDS ARE SCHEDULING'S (D3). Titles, bodies and dedupe keys are written
 * here, by the package that knows the fact, so a wording fix reaches every
 * project by npm. The glue only connects the event stream to `notify`.
 *
 * ONE DECISION FOR THE ALERT AND THE OFFICE EMAIL (D6, 3.4). Which event is
 * worth telling the office about, under which kind and which dedupe key, is
 * `schedulingOfficeNotice` below, and BOTH the mapper and the comms listener
 * (`./comms`) ask it. The office email's claim (`alerts.claimEmails`) looks
 * the alert row up by that kind and key; if the two halves computed them
 * separately, a wording tweak in one would leave every lead emailed twice or
 * never.
 */

// ---- shapes (contract 3.2 / 3.3, package-prefixed) --------------------------

export type SchedulingAlertChannel = "in_app" | "email";

export interface SchedulingAlertKind {
  /** Permanent. /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$/, at most 64 characters. */
  readonly key: string;
  /** What a person sees in Alert settings, a plain phrase. */
  readonly label: string;
  readonly description?: string;
  /** The heading it is listed under. */
  readonly category: string;
  readonly audience: {
    /** Only active members holding this may receive it (D4). */
    readonly permission: string;
    /** The routing group whose chosen people get it (default: the owner). Absent: everyone holding `permission`. */
    readonly routing?: string;
    /** People assigned to the record who hold this also get it (crew). */
    readonly assigned?: { readonly permission: string };
  };
  /** For someone who never chose. */
  readonly defaultChannel: SchedulingAlertChannel;
  /** false: never emailed, and the choice isn't offered. Default true. */
  readonly email?: boolean;
  /** "producer": the package sends its own office email for it (D6). Default "notifications". */
  readonly emailBy?: "notifications" | "producer";
  /** Order inside its category. Default 100. */
  readonly order?: number;
}

export interface SchedulingAlertRouting {
  /** /^[a-z][a-z0-9-]{1,31}$/. Permanent (stored). */
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  /** Who may be chosen for it: members holding this. */
  readonly permission: string;
  readonly order?: number;
}

export interface SchedulingAlertKinds {
  readonly kinds: readonly SchedulingAlertKind[];
  readonly routings: readonly SchedulingAlertRouting[];
}

export interface SchedulingAlertDraft {
  readonly tenantId: string;
  /** A registered kind key. */
  readonly kind: string;
  /** One line, 1–200 characters, plain text: no CR, LF, U+2028 or U+2029 (it becomes an email Subject; D18). */
  readonly title: string;
  /** At most 2000 characters, plain text, may have line breaks; null = none. */
  readonly body: string | null;
  /** Where it opens: a path on this site; null = nothing to open. */
  readonly href: string | null;
  /** Where it opens for someone reached ONLY through `assigned` (crew). Default `href`. */
  readonly assignedHref?: string | null;
  /** D7: from the durable fact; 1–200 characters. */
  readonly dedupeKey: string;
  /** What it is about. */
  readonly subject: { readonly type: string; readonly id: string } | null;
  /** Who caused it; never alerted about it. null for a customer or the system. */
  readonly actorUserId: string | null;
  /** For kinds with `audience.assigned`: who is on the record (as text). */
  readonly assignedUserIds?: readonly string[];
  /** Where a reply to the email copy goes (the customer). */
  readonly replyTo?: string | null;
}

// ---- the fragment -------------------------------------------------------------

/** The record type every scheduling alert is about (`subject.type`), and the file record type (files.ts). */
export const SCHEDULING_VISIT_SUBJECT = "scheduling.visit";

export type SchedulingAlertKindKey =
  | "scheduling.visit.requested"
  | "scheduling.visit.moved"
  | "scheduling.visit.cancelled"
  | "scheduling.request.expiring"
  | "scheduling.request.expired";

const VISITS = "visits";
const CATEGORY = "Visits";

/**
 * Scheduling's alert kinds and its one routing group (contract 9.1).
 *
 * Every kind defaults to "In the app and by email": a visit request is new
 * work, and a customer moving or cancelling changes somebody's day. Noise is
 * kept down by WHO hears (the "visits" group, the owner until someone else
 * is chosen; D4, D5), not by switching kinds off.
 *
 * The three kinds whose office email scheduling already sends (2a's
 * `visit_staff_notice`, rich, editable in Messages, replying to the customer)
 * are `emailBy: "producer"`: notifications writes the in-app rows and claims
 * the email for the comms listener, never a second copy (D6). The crew are
 * not the office (review BO-03): reached only through `assigned`, they get
 * notifications' own copy linking to their day.
 *
 * "About to lapse" has no office email of its own (it is produced by the
 * alerts cron from the records, D8), so notifications sends it.
 */
export const schedulingAlertKinds: SchedulingAlertKinds = Object.freeze({
  kinds: Object.freeze([
    Object.freeze({
      key: "scheduling.visit.requested",
      label: "A customer asks for a visit, or books one",
      category: CATEGORY,
      audience: Object.freeze({ permission: "schedule.view", routing: VISITS }),
      defaultChannel: "email",
      emailBy: "producer",
      order: 10,
    }),
    Object.freeze({
      key: "scheduling.visit.moved",
      label: "A customer moves a visit",
      category: CATEGORY,
      audience: Object.freeze({
        permission: "schedule.view",
        routing: VISITS,
        assigned: Object.freeze({ permission: "schedule.route" }),
      }),
      defaultChannel: "email",
      emailBy: "producer",
      order: 20,
    }),
    Object.freeze({
      key: "scheduling.visit.cancelled",
      label: "A customer cancels a visit",
      category: CATEGORY,
      audience: Object.freeze({
        permission: "schedule.view",
        routing: VISITS,
        assigned: Object.freeze({ permission: "schedule.route" }),
      }),
      defaultChannel: "email",
      emailBy: "producer",
      order: 30,
    }),
    Object.freeze({
      key: "scheduling.request.expiring",
      label: "A visit request is about to lapse unanswered",
      category: CATEGORY,
      audience: Object.freeze({ permission: "schedule.view", routing: VISITS }),
      defaultChannel: "email",
      emailBy: "notifications",
      order: 40,
    }),
    Object.freeze({
      key: "scheduling.request.expired",
      label: "A visit request lapsed unanswered",
      category: CATEGORY,
      audience: Object.freeze({ permission: "schedule.view", routing: VISITS }),
      defaultChannel: "email",
      emailBy: "producer",
      order: 50,
    }),
  ] satisfies SchedulingAlertKind[]),
  routings: Object.freeze([
    Object.freeze({
      key: VISITS,
      label: "Visit requests and customer changes",
      description: "New visit requests, a customer moving or cancelling, and requests about to lapse.",
      permission: "schedule.view",
      order: 20,
    }),
  ] satisfies SchedulingAlertRouting[]),
});

// ---- the shared decision (D6, 3.4) --------------------------------------------

/** 2a's office-notice labels (the `{{subjectTag}}` of `visit_staff_notice`). */
export type StaffNoticeKind = "New request" | "New booking" | "Visit moved" | "Visit cancelled" | "Request expired";

export interface SchedulingOfficeNoticeSpec {
  /** The office email's own label (2a, unchanged). */
  readonly notice: StaffNoticeKind;
  /** The alert kind this fact is (contract 9.1). */
  readonly kind: SchedulingAlertKindKey;
  /** D7: from the durable fact, never from the event's id. */
  readonly dedupeKey: string;
}

/**
 * The office notice an event warrants, with its alert kind and dedupe key,
 * or null. THE ONE PLACE this is decided (see the module comment): never for
 * a change staff made themselves; a request that lapses unanswered is one (a
 * lost sale the office never used to hear about).
 *
 * The keys come from facts: a request (or booking) is one per visit, so a
 * retried submit, an event handed over twice and an auto-confirmed booking's
 * second event all land on the same row; a move and a cancel carry the
 * visit's `sequence` AFTER the change, so the customer moving twice is two
 * alerts, and the same move delivered twice is one.
 */
export function schedulingOfficeNotice(event: SchedulingEvent): SchedulingOfficeNoticeSpec | null {
  const visitId = event.visitId;
  const sequence = event.data.visit.sequence;
  if (event.type === "visit.expired") {
    return { notice: "Request expired", kind: "scheduling.request.expired", dedupeKey: `scheduling.request.expired:${visitId}` };
  }
  if (event.actor.type === "staff") return null;
  if (event.type === "visit.requested") {
    return {
      notice: event.data.visit.status === "confirmed" ? "New booking" : "New request",
      kind: "scheduling.visit.requested",
      dedupeKey: `scheduling.visit.requested:${visitId}`,
    };
  }
  if (event.type === "visit.rescheduled" && event.actor.type === "customer") {
    return { notice: "Visit moved", kind: "scheduling.visit.moved", dedupeKey: `scheduling.visit.moved:${visitId}:${sequence}` };
  }
  if (event.type === "visit.cancelled" && event.actor.type === "customer") {
    return {
      notice: "Visit cancelled",
      kind: "scheduling.visit.cancelled",
      dedupeKey: `scheduling.visit.cancelled:${visitId}:${sequence}`,
    };
  }
  return null;
}

// ---- helpers -------------------------------------------------------------------

/**
 * Fill an href pattern (2a 7.10's `{id}` rule): each `{name}` becomes the
 * URL-encoded value, so the same package serves `/app/…` and `/admin/…`. A
 * placeholder with no value is left as it is (the host's pattern is the
 * host's), and an id can never add a `/`, a `?` or a space to the path.
 */
export function fillHref(pattern: string, values: Readonly<Record<string, string>>): string {
  return pattern.replace(/\{([a-zA-Z]+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? encodeURIComponent(values[name] as string) : whole,
  );
}

/** At most `max` characters, cut on a character with an ellipsis. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * One line, for a title (D18: it becomes an email Subject). What a customer
 * typed can carry a CR, an LF or a Unicode line separator from an older row
 * or a host's own form; every control character and separator becomes a
 * space, and the whole is clipped to 200.
 */
function titleOf(text: string): string {
  return clip(oneLine(text), 200);
}

function bodyOf(lines: ReadonlyArray<string | null | undefined>): string | null {
  const text = lines.filter((line): line is string => typeof line === "string" && line.trim() !== "").join("\n");
  return text ? clip(text, 2000) : null;
}

/** What a customer typed, on one line; null when blank. */
function typed(value: string | null | undefined): string | null {
  const line = oneLine(value ?? "");
  return line ? line : null;
}

/** "Pat Rivera", or "a customer" / "A customer" at the start of a sentence. */
function customerWord(name: string | null | undefined, start: boolean): string {
  return typed(name) ?? (start ? "A customer" : "a customer");
}

/** "Pat Rivera's", or "a customer's" / "A customer's". */
function customerPossessive(name: string | null | undefined, start: boolean): string {
  return `${customerWord(name, start)}'s`;
}

function zoneOf(zone: string | null | undefined): string {
  return typeof zone === "string" && isValidTimeZone(zone) ? zone : "UTC";
}

/**
 * The people linked to these crews (`scheduling_resources.user_id`), in ONE
 * query, in this tenant. A crew with nobody linked adds nobody. Internal:
 * the mapper's `assignedUserIds` and the office notice's (3.4) both come
 * from here, so they are always the same people.
 */
export async function crewUserIds(
  db: SchedulingDb,
  tenantId: string,
  resourceIds: ReadonlyArray<string | null | undefined>,
): Promise<string[]> {
  const people = new Set<string>();
  for (const users of (await crewByResource(db, tenantId, resourceIds)).values()) for (const user of users) people.add(user);
  return [...people];
}

/** The same ONE query as `crewUserIds`, kept per crew: who is on each of `resourceIds` (a crew with nobody linked is absent). */
async function crewByResource(
  db: SchedulingDb,
  tenantId: string,
  resourceIds: ReadonlyArray<string | null | undefined>,
): Promise<ReadonlyMap<string, readonly string[]>> {
  const wanted = [...new Set(resourceIds.filter((id): id is string => typeof id === "string" && id.length > 0))];
  const out = new Map<string, string[]>();
  if (wanted.length === 0) return out;
  const rows = (await db
    .select({ id: schedulingResources.id, userId: schedulingResources.userId })
    .from(schedulingResources)
    .where(
      and(
        eq(schedulingResources.tenantId, tenantId),
        inArray(schedulingResources.id, wanted),
        isNotNull(schedulingResources.userId),
      ),
    )) as Array<{ id: string; userId: string | null }>;
  for (const row of rows) {
    if (!row.userId || row.userId.trim() === "") continue;
    const users = out.get(row.id) ?? [];
    if (!users.includes(row.userId)) users.push(row.userId);
    out.set(row.id, users);
  }
  return out;
}

// ---- the mapper ------------------------------------------------------------------

export interface SchedulingAlertsForOptions {
  /**
   * Patterns: `visit` takes {id} and {date} ("/app/schedule?date={date}&visit={id}");
   * `crewDay` is a path ("/app/schedule/today"); `visitFiles` takes {id}
   * ("/app/schedule/visits/{id}/files"), absent without file storage.
   */
  readonly hrefs: { readonly visit: string; readonly crewDay: string; readonly visitFiles?: string };
  /** Default "en-US". */
  readonly locale?: string;
  /** Default `new Date()`: decides whether the crew's link is today's route (review BO-04). */
  readonly now?: Date;
}

/**
 * Scheduling's event → alert drafts (contract 9.1). An alert is written
 * exactly when the comms listener writes an office notice
 * (`schedulingOfficeNotice`), and nothing else: never for a change staff
 * made, never for the crew's own progress.
 *
 * Times are 2a's short form ("Tue, Nov 3, 9:00 AM MST") in the visit's own
 * zone. A move states both times in full in its body, so the alert says
 * everything even where its link can't show the day (review BO-04: a crew
 * member's route is today-only).
 *
 * The crew (`assignedUserIds`, moves and cancels): the people linked to the
 * visit's crew, in ONE query (with the previous crew's, on a move); their
 * link (`assignedHref`) is today's route when the visit is today in its zone
 * at `now`, else the visit's photos-and-files page (which a crew member on it
 * may open, and whose heading carries the time), else nothing. Every crew
 * body carries the job's address (review BO-13).
 *
 * A MOVE ONTO ANOTHER CREW is two drafts of one fact (review BO-2): the move
 * itself, for the office and the new crew ("Now Wed, Nov 4, 10:00 AM MST,
 * with South. It was Tue, Nov 3, 9:00 AM MST, with North."), then, for the
 * people who were only on the old crew, "Pat Rivera's visit is off your
 * route: moved to …", opening today's route when the visit was on it today,
 * else nothing. Both carry the move's kind and key: notifications keeps one
 * row per person per key, the first draft's (D7), so nobody gets both.
 * CONTRACT: 9.1 has one draft with both crews in `assignedUserIds`; the old
 * crew then read the new crew's words and opened a page they may no longer
 * open.
 *
 * Never throws for a crew lookup that fails: the office still gets its
 * alert, and the crew are simply not added (the alert must never cost the
 * office the lead).
 */
export async function schedulingAlertsFor(
  db: SchedulingDb,
  event: SchedulingEvent,
  options: SchedulingAlertsForOptions,
): Promise<readonly SchedulingAlertDraft[]> {
  const spec = schedulingOfficeNotice(event);
  if (!spec) return [];
  const locale = options.locale ?? "en-US";
  const now = options.now ?? new Date();
  const visit = event.data.visit;
  const zone = zoneOf(visit.timeZone);
  const when = formatShortSafe(new Date(visit.startsAt), zone, locale);
  const service = typed(visit.serviceName) ?? "Visit";
  const href = fillHref(options.hrefs.visit, { id: visit.id, date: visit.date });
  const base = {
    tenantId: event.tenantId,
    kind: spec.kind,
    href,
    dedupeKey: spec.dedupeKey,
    subject: { type: SCHEDULING_VISIT_SUBJECT, id: visit.id },
    actorUserId: null,
    replyTo: visit.customerEmail?.trim() || null,
  } as const;

  switch (spec.kind) {
    case "scheduling.visit.requested": {
      const address = typed(visit.address);
      const title =
        spec.notice === "New booking"
          ? `New booking: ${customerWord(visit.customerName, false)}, ${when}`
          : `New visit request: ${customerWord(visit.customerName, false)}, ${when}`;
      return [
        {
          ...base,
          title: titleOf(title),
          body: bodyOf([
            `${service}${address ? ` at ${address}` : ""}.`,
            event.data.addressUnverified ? "The address couldn't be found on the map. Check it with them." : null,
          ]),
        },
      ];
    }
    case "scheduling.visit.moved":
    case "scheduling.visit.cancelled": {
      const previous = spec.kind === "scheduling.visit.moved" ? event.data.previous : undefined;
      const previousCrew = previous?.resourceId ?? null;
      let crews: ReadonlyMap<string, readonly string[]> = new Map();
      try {
        crews = await crewByResource(db, event.tenantId, [visit.resourceId, previousCrew]);
      } catch {
        // The crew are a nicety on top of the office's alert, never a reason to lose it.
      }
      const onVisit = visit.resourceId ? [...(crews.get(visit.resourceId) ?? [])] : [];
      // On a move to ANOTHER crew, the people who were only on the old one
      // (review BO-2): the visit is off their route.
      const crewChanged = previous !== undefined && previousCrew !== (visit.resourceId ?? null);
      const offRoute = crewChanged && previousCrew ? (crews.get(previousCrew) ?? []).filter((user) => !onVisit.includes(user)) : [];
      // The date the crew should look at: the NEW date on a move, the date on a cancel.
      const today = todayIn(now, zone);
      const assignedHref =
        visit.date === today
          ? options.hrefs.crewDay
          : options.hrefs.visitFiles
            ? fillHref(options.hrefs.visitFiles, { id: visit.id })
            : null;
      // Where the job is (review BO-13): the one thing a crew member needs.
      const address = typed(visit.address);
      const job = `${service}${address ? ` at ${address}` : ""}`;
      if (spec.kind === "scheduling.visit.moved") {
        const was = previous ? formatShortSafe(new Date(previous.startsAt), zone, locale) : null;
        const newCrew = typed(visit.resourceName);
        const oldCrew = typed(previous?.resourceName);
        // On a crew change both times say whose they are.
        const nowWith = crewChanged && newCrew ? `, with ${newCrew}` : "";
        const wasWith = crewChanged && oldCrew ? `, with ${oldCrew}` : "";
        const drafts: SchedulingAlertDraft[] = [
          {
            ...base,
            title: titleOf(`${customerWord(visit.customerName, true)} moved their visit to ${when}`),
            body: bodyOf([`Now ${when}${nowWith}.${was ? ` It was ${was}${wasWith}.` : ""} ${job}.`]),
            assignedHref,
            assignedUserIds: onVisit,
          },
        ];
        if (offRoute.length > 0) {
          // THE OLD CREW'S OWN WORDS (review BO-2). Word for word what the new
          // crew got, plus a link to a page they may no longer open, read as
          // "my job moved to Tuesday": a wasted trip, or two crews at one
          // house. SAME kind and key as the move: notifications keeps ONE row
          // per person per key, the first draft's (D7), so the office and the
          // new crew keep the move above and only the people who were on the
          // old crew alone get this one. Their link: today's route when the
          // visit was on it today (it is gone from there), else nothing to open.
          drafts.push({
            ...base,
            title: titleOf(`${customerPossessive(visit.customerName, true)} visit is off your route: moved to ${when}`),
            body: bodyOf([`${newCrew ? `It's now with ${newCrew}.` : "Another crew has it now."}${was ? ` It was ${was}.` : ""} ${job}.`]),
            assignedHref: previous && previous.date === today ? options.hrefs.crewDay : null,
            assignedUserIds: offRoute,
          });
        }
        return drafts;
      }
      const reason = typed(event.data.reason);
      return [
        {
          ...base,
          title: titleOf(`${customerWord(visit.customerName, true)} cancelled their visit on ${when}`),
          body: bodyOf([`${job}.${reason ? ` They said: ${reason}` : ""}`]),
          assignedHref,
          assignedUserIds: onVisit,
        },
      ];
    }
    case "scheduling.request.expired":
      return [
        {
          ...base,
          title: titleOf(`${customerPossessive(visit.customerName, true)} visit request lapsed unanswered`),
          body: bodyOf([`They asked for ${when} (${service}).`]),
        },
      ];
    default:
      return [];
  }
}

// ---- the expiring sweep (contract 9.2) ------------------------------------------

export interface ExpiringRequest {
  readonly id: string;
  readonly sequence: number;
  readonly customerName: string | null;
  readonly serviceName: string;
  readonly date: string;
  readonly startsAt: Date;
  readonly timeZone: string;
  readonly pendingExpiresAt: Date;
}

export interface ListExpiringRequestsOptions {
  readonly now?: Date;
  /** Default 26 h: a daily cron sees each request once before it lapses. 1–168. */
  readonly withinHours?: number;
  /** Default now − 6 h: a request made this afternoon whose "new request" alert has just gone isn't nagged about tonight. */
  readonly createdBefore?: Date;
  /** Default 200, at most 1000. */
  readonly limit?: number;
}

const HOUR_MS = 3_600_000;

/**
 * Pending requests whose deadline falls in (now, now + withinHours] AND that
 * were made before `createdBefore` (default now − 6 h): a request for
 * tomorrow morning made this afternoon has a deadline tonight, and its "new
 * request" alert has just gone; a second email 15 minutes later is noise
 * (review BO-15). Default 26 h (a daily cron sees each once before it
 * lapses), limit 200. Soonest deadline first.
 *
 * ONE QUERY, on `scheduling_bookings_pending_expiry_idx` (tenant, status,
 * deadline), with the tenant's settings row joined for the zone and the
 * service names: the alert is written in the business's clock. The time-
 * based kinds are PRODUCED by the cron from the records themselves (D8), so
 * this is at least once by construction; the dedupe key (the visit and its
 * sequence) makes a second run, or a second cron, a no-op.
 */
export async function listExpiringRequests(
  db: SchedulingDb,
  tenantId: string,
  options: ListExpiringRequestsOptions = {},
): Promise<readonly ExpiringRequest[]> {
  const now = options.now ?? new Date();
  const withinHours = Math.max(1, Math.min(168, Number.isFinite(options.withinHours) ? (options.withinHours as number) : 26));
  const until = new Date(now.getTime() + withinHours * HOUR_MS);
  const createdBefore = options.createdBefore ?? new Date(now.getTime() - 6 * HOUR_MS);
  const limit = Math.max(1, Math.min(1000, Math.trunc(options.limit ?? 200)));
  const b = schedulingBookings;
  const s = schedulingSettings;
  const rows = (await db
    .select({
      id: b.id,
      sequence: b.sequence,
      customerName: b.customerName,
      serviceType: b.serviceType,
      scheduledDate: b.scheduledDate,
      startTime: b.startTime,
      endTime: b.endTime,
      startsAt: b.startsAt,
      endsAt: b.endsAt,
      pendingExpiresAt: b.pendingExpiresAt,
      timeZone: s.timeZone,
      services: s.services,
    })
    .from(b)
    .leftJoin(s, eq(s.tenantId, b.tenantId))
    .where(
      and(
        eq(b.tenantId, tenantId),
        eq(b.status, "pending"),
        gt(b.pendingExpiresAt, now),
        lte(b.pendingExpiresAt, until),
        lt(b.createdAt, createdBefore),
      ),
    )
    .orderBy(asc(b.pendingExpiresAt), asc(b.id))
    .limit(limit)) as Array<{
    id: string;
    sequence: number;
    customerName: string | null;
    serviceType: string;
    scheduledDate: Date;
    startTime: string;
    endTime: string;
    startsAt: Date | null;
    endsAt: Date | null;
    pendingExpiresAt: Date | null;
    timeZone: string | null;
    services: SchedulingService[] | null;
  }>;
  const out: ExpiringRequest[] = [];
  for (const row of rows) {
    if (!row.pendingExpiresAt) continue;
    const zone = zoneOf(row.timeZone);
    const services = Array.isArray(row.services) && row.services.length > 0 ? row.services : DEFAULT_SCHEDULING_SETTINGS.services;
    out.push({
      id: row.id,
      sequence: row.sequence,
      customerName: row.customerName,
      serviceName: serviceNameFor(services, row.serviceType),
      date: labelOf(row.scheduledDate),
      startsAt: instantsOf(row, zone).startsAt,
      timeZone: zone,
      pendingExpiresAt: row.pendingExpiresAt,
    });
  }
  return out;
}

/**
 * The "answer it or it lapses" alert for one request (contract 9.2), for the
 * alerts cron. The key carries the visit's sequence: a request that is moved
 * and gets a new deadline is a new fact, the same request seen by tomorrow's
 * run again is not.
 */
export function schedulingExpiringAlert(
  tenantId: string,
  request: ExpiringRequest,
  options: { readonly hrefs: { readonly visit: string }; readonly locale?: string },
): SchedulingAlertDraft {
  const locale = options.locale ?? "en-US";
  const zone = zoneOf(request.timeZone);
  const deadline = formatShortSafe(request.pendingExpiresAt, zone, locale);
  const when = formatShortSafe(request.startsAt, zone, locale);
  const service = typed(request.serviceName) ?? "Visit";
  return {
    tenantId,
    kind: "scheduling.request.expiring",
    title: titleOf(`Answer ${customerPossessive(request.customerName, false)} visit request by ${deadline}, or it lapses`),
    body: bodyOf([`They asked for ${when} (${service}).`]),
    href: fillHref(options.hrefs.visit, { id: request.id, date: request.date }),
    dedupeKey: `scheduling.request.expiring:${request.id}:${request.sequence}`,
    subject: { type: SCHEDULING_VISIT_SUBJECT, id: request.id },
    actorUserId: null,
  };
}
