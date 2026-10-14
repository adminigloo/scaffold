import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { emitEvents, type EventSpec } from "./events.js";
import { earliest, labelOf, visitInstants } from "./instants.js";
import { settingsLockKey } from "./internal.js";
import {
  DEFAULT_PUBLIC_BOOKING_POLICY,
  type PublicBookingPolicy,
  type ResolvedPublicBookingPolicy,
} from "./public.js";
import { schedulingBookings, schedulingSettings } from "./schema.js";
import { SERVICE_KEY_PATTERN, type SchedulingService } from "./services.js";
import type { BookingRow, SchedulingDb, SchedulingWriteOptions, SettingsRow } from "./types.js";
import type { SettingsWire } from "./wire.js";
import { isValidTimeZone } from "./zone.js";

/**
 * A business's scheduling settings: one `scheduling_settings` row per tenant.
 *
 * 0.3 took a `PublicBookingPolicy` object from the host's code, so changing
 * the notice period, switching on auto-confirm or adding a service meant a
 * developer and a deploy. A business owner decides these, so they live in the
 * database and the settings screen edits them. A tenant that never saved
 * settings reads the defaults below, with the zone `UTC` — 0.3's behaviour.
 */

export interface SchedulingSettingsValues {
  /** IANA zone. Every visit's wall clock is read in it. */
  timeZone: string;
  businessName: string;
  contactEmail: string | null;
  contactPhone: string | null;
  /** Up to 5 addresses for new-request and customer-change notices. */
  staffNotifyEmails: string[];
  /** 1–20 services. */
  services: SchedulingService[];
  slotStepMinutes: number;
  minNoticeMinutes: number;
  horizonDays: number;
  travelBufferMinutes: number;
  maxSlotsPerDay: number | null;
  maxOpenRequestsPerRequester: number | null;
  requireAddress: boolean;
  /** True: online requests land `confirmed`. False: a person accepts each one. */
  autoConfirm: boolean;
  /** False closes online booking for the tenant (cancelling a visit online still works). */
  publicBookingEnabled: boolean;
  /** An unanswered request stops holding its time after this many hours. */
  pendingExpiryHours: number;
  /** The reminder goes this many hours before a confirmed visit; 0 = none. */
  reminderLeadHours: number;
  /** Customers can change or cancel online until this many hours before; 0 = up to the start. */
  cancelCutoffHours: number;
}

export interface SchedulingSettings extends SchedulingSettingsValues {
  tenantId: string;
  /** False: no row yet, every value is a default. */
  saved: boolean;
  updatedAt: Date | null;
  /**
   * True when a `company` seam supplied the name, contact and zone (Tenancy
   * 2a, D5): the settings screen shows them read-only and a save drops them.
   * Always false from `getSchedulingSettings`; see `resolveSchedulingSettings`.
   */
  managedByCompany: boolean;
  /**
   * With `managedByCompany`: true when the zone in use IS the company's own,
   * false while the company hasn't set one and scheduling's stored (starting)
   * zone stands in (review T2A-BO-07) — the screens then say so, and online
   * booking waits for the company's zone. Absent outside a company.
   */
  zoneFromCompany?: boolean;
}

export const DEFAULT_SCHEDULING_SETTINGS: Readonly<SchedulingSettingsValues> = Object.freeze({
  timeZone: "UTC",
  businessName: "",
  contactEmail: null,
  contactPhone: null,
  staffNotifyEmails: [],
  services: [{ key: "visit", name: "Visit", durationMinutes: 60 }],
  slotStepMinutes: 30,
  minNoticeMinutes: 1440,
  horizonDays: 30,
  travelBufferMinutes: 30,
  maxSlotsPerDay: null,
  maxOpenRequestsPerRequester: 3,
  requireAddress: false,
  autoConfirm: false,
  publicBookingEnabled: true,
  pendingExpiryHours: 48,
  reminderLeadHours: 24,
  cancelCutoffHours: 24,
});

/** A blank text field from a form means "none". */
const blankToNull = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? null : value;

const multipleOf5 = (n: number): boolean => n % 5 === 0;

export const schedulingServiceSchema = z.object({
  key: z
    .string()
    .trim()
    .regex(SERVICE_KEY_PATTERN, "Use lowercase letters, digits and dashes, like free-estimate (up to 40)."),
  name: z.string().trim().min(1, "Give the service a name.").max(80),
  durationMinutes: z
    .number()
    .int()
    .min(15, "A service is at least 15 minutes.")
    .max(720, "A service is at most 12 hours.")
    .refine(multipleOf5, "Use a multiple of 5 minutes."),
  description: z.preprocess(blankToNull, z.string().trim().max(300).nullable()).optional(),
  requiredSkill: z.preprocess(blankToNull, z.string().trim().max(60).nullable()).optional(),
});

/**
 * A partial settings edit. Every field is optional and a patch changes only
 * the keys it names; unknown keys are dropped. Each refusal is a ZodError
 * issue with a path, so a settings screen can put the message beside the
 * field.
 */
export const updateSchedulingSettingsSchema = z
  .object({
    timeZone: z.string().refine((zone) => isValidTimeZone(zone), "Pick a time zone from the list."),
    businessName: z.string().trim().max(120),
    contactEmail: z.preprocess(blankToNull, z.string().trim().email("Enter an email address.").max(320).nullable()),
    contactPhone: z.preprocess(blankToNull, z.string().trim().max(40).nullable()),
    staffNotifyEmails: z
      .array(z.string().trim().email("Enter an email address.").max(320))
      .max(5, "Up to 5 addresses."),
    services: z
      .array(schedulingServiceSchema)
      .min(1, "Offer at least one service.")
      .max(20, "Up to 20 services.")
      .superRefine((services, ctx) => {
        const seen = new Set<string>();
        services.forEach((service, index) => {
          if (seen.has(service.key)) {
            ctx.addIssue({ code: "custom", path: [index, "key"], message: "Each service needs its own key." });
          }
          seen.add(service.key);
        });
      }),
    slotStepMinutes: z.number().int().min(5).max(240).refine(multipleOf5, "Use a multiple of 5 minutes."),
    minNoticeMinutes: z.number().int().min(0).max(43200),
    horizonDays: z.number().int().min(1).max(365),
    travelBufferMinutes: z.number().int().min(0).max(240),
    maxSlotsPerDay: z.number().int().min(1).max(100).nullable(),
    maxOpenRequestsPerRequester: z.number().int().min(1).max(50).nullable(),
    requireAddress: z.boolean(),
    autoConfirm: z.boolean(),
    publicBookingEnabled: z.boolean(),
    pendingExpiryHours: z.number().int().min(1).max(720),
    reminderLeadHours: z.number().int().min(0).max(168),
    cancelCutoffHours: z.number().int().min(0).max(168),
  })
  .partial();
export type UpdateSchedulingSettingsInput = z.input<typeof updateSchedulingSettingsSchema>;

function cleanServices(value: unknown): SchedulingService[] {
  if (!Array.isArray(value)) return [...DEFAULT_SCHEDULING_SETTINGS.services];
  const services = value.filter(
    (item): item is SchedulingService =>
      !!item &&
      typeof item === "object" &&
      typeof (item as SchedulingService).key === "string" &&
      typeof (item as SchedulingService).name === "string" &&
      typeof (item as SchedulingService).durationMinutes === "number",
  );
  return services.length > 0
    ? services.map((service) => ({
        key: service.key,
        name: service.name,
        durationMinutes: service.durationMinutes,
        description: service.description ?? null,
        requiredSkill: service.requiredSkill ?? null,
      }))
    : [...DEFAULT_SCHEDULING_SETTINGS.services];
}

/** A stored row → settings. Defensive about hand-written rows: a zone the runtime doesn't know reads as UTC. */
function fromRow(row: SettingsRow): SchedulingSettings {
  return {
    tenantId: row.tenantId,
    timeZone: isValidTimeZone(row.timeZone) ? row.timeZone : "UTC",
    businessName: row.businessName,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone,
    staffNotifyEmails: Array.isArray(row.staffNotifyEmails)
      ? row.staffNotifyEmails.filter((email): email is string => typeof email === "string")
      : [],
    services: cleanServices(row.services),
    slotStepMinutes: row.slotStepMinutes,
    minNoticeMinutes: row.minNoticeMinutes,
    horizonDays: row.horizonDays,
    travelBufferMinutes: row.travelBufferMinutes,
    maxSlotsPerDay: row.maxSlotsPerDay,
    maxOpenRequestsPerRequester: row.maxOpenRequestsPerRequester,
    requireAddress: row.requireAddress,
    autoConfirm: row.autoConfirm,
    publicBookingEnabled: row.publicBookingEnabled,
    pendingExpiryHours: row.pendingExpiryHours,
    reminderLeadHours: row.reminderLeadHours,
    cancelCutoffHours: row.cancelCutoffHours,
    saved: true,
    updatedAt: row.updatedAt,
    managedByCompany: false,
  };
}

function defaultsFor(tenantId: string): SchedulingSettings {
  return {
    ...DEFAULT_SCHEDULING_SETTINGS,
    staffNotifyEmails: [],
    services: DEFAULT_SCHEDULING_SETTINGS.services.map((service) => ({ ...service })),
    tenantId,
    saved: false,
    updatedAt: null,
    managedByCompany: false,
  };
}

/** This tenant's settings, or the defaults (`saved: false`) when it never saved any. Never writes. */
export async function getSchedulingSettings(db: SchedulingDb, tenantId: string): Promise<SchedulingSettings> {
  const [row] = (await db
    .select()
    .from(schedulingSettings)
    .where(eq(schedulingSettings.tenantId, tenantId))
    .limit(1)) as SettingsRow[];
  return row ? fromRow(row) : defaultsFor(tenantId);
}

/** The visit statuses whose instants follow a zone change: everything still to happen or happening. */
const RE_ZONED_STATUSES = ["pending", "confirmed", "in_progress"] as const;

/**
 * Upsert this tenant's settings; a patch only changes the keys it names.
 *
 * CHANGING `timeZone` KEEPS EVERY VISIT AT ITS WALL-CLOCK TIME. Those times are
 * what the customer was shown and what the crew's day is built from; the zone
 * was simply wrong (or never set — this is the upgrade path for a 0.3 install).
 * In the same transaction every pending, confirmed or in-progress visit gets
 * its instants recomputed in the new zone (a pending one's expiry is pulled in
 * to its new start if that is sooner) and `sequence + 1`, so a stale reminder
 * is skipped at send time. After commit, `visit.rescheduled` is emitted for
 * each that starts after `now`, with `via: "time_zone"`: the comms listener
 * re-queues the reminders. Nobody is emailed unless `options.notify` is true
 * — the settings screen offers it when there are upcoming visits, because a
 * zone that was wrong means the customer was shown the wrong zone too, and
 * the email ("we had your visit in the wrong time zone") is the honest fix.
 *
 * THE RE-QUEUE RUNS EIGHT AT A TIME (`concurrency`). Every event is about a
 * different visit, and a business with hundreds of upcoming visits, one
 * listener call after another inside the save request, could outlast the
 * function's time limit part-way through: every sequence already bumped, so
 * the visits not yet reached would get no reminder at all.
 *
 * Visit writers take the same settings lock SHARED (`lockSettingsShared`)
 * and refuse when the zone moved under them, so no visit can be written with
 * the old zone's instants after this rewrite.
 */
export async function updateSchedulingSettings(
  db: SchedulingDb,
  tenantId: string,
  patch: UpdateSchedulingSettingsInput,
  options: SchedulingWriteOptions = {},
): Promise<SchedulingSettings> {
  const parsed = updateSchedulingSettingsSchema.parse(patch);
  const now = options.now ?? new Date();
  const moved: Array<{ before: BookingRow; after: BookingRow }> = [];

  const saved = await db.transaction(async (tx) => {
    // One settings write per tenant at a time, so two saves can't each
    // re-derive the visits from a zone the other is replacing.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${settingsLockKey(tenantId)}))`);
    const [current] = (await tx
      .select()
      .from(schedulingSettings)
      .where(eq(schedulingSettings.tenantId, tenantId))
      .limit(1)) as SettingsRow[];
    const oldZone = current ? fromRow(current).timeZone : DEFAULT_SCHEDULING_SETTINGS.timeZone;

    const values = { ...parsed } as Partial<SchedulingSettingsValues>;
    const [row] = (await tx
      .insert(schedulingSettings)
      .values({ tenantId, ...values, updatedAt: now })
      .onConflictDoUpdate({ target: schedulingSettings.tenantId, set: { ...values, updatedAt: now } })
      .returning()) as SettingsRow[];
    const next = fromRow(row as SettingsRow);

    if (next.timeZone !== oldZone) {
      const visits = (await tx
        .select()
        .from(schedulingBookings)
        .where(
          and(eq(schedulingBookings.tenantId, tenantId), inArray(schedulingBookings.status, [...RE_ZONED_STATUSES])),
        )) as BookingRow[];
      const rewrites = visits.map((visit) => {
        const { startsAt, endsAt } = visitInstants(labelOf(visit.scheduledDate), visit.startTime, visit.endTime, next.timeZone);
        return {
          before: visit,
          after: {
            ...visit,
            startsAt,
            endsAt,
            pendingExpiresAt: visit.status === "pending" ? earliest(visit.pendingExpiresAt, startsAt) : visit.pendingExpiresAt,
            sequence: visit.sequence + 1,
            updatedAt: now,
          },
        };
      });
      await rewriteInstants(tx, tenantId, rewrites.map((r) => r.after));
      moved.push(...rewrites);
    }
    return next;
  });

  const specs: EventSpec[] = moved
    .filter(({ after }) => after.startsAt !== null && after.startsAt.getTime() > now.getTime())
    .map(({ before, after }) => ({
      type: "visit.rescheduled",
      row: after,
      previous: before,
      actor: options.actor ?? { type: "staff", id: null },
      notify: options.notify === true,
      via: "time_zone",
    }));
  await emitEvents(db, tenantId, specs, {
    settings: saved,
    now,
    onEvent: options.onEvent,
    onEventError: options.onEventError,
    concurrency: 8,
  });
  return saved;
}

const REWRITE_CHUNK = 200;

/**
 * Write new instants (and sequence, expiry) for many visits in a few
 * statements: an UPDATE … FROM (VALUES …) per 200 rows rather than a round
 * trip per visit, which on a serverless driver is the difference between a
 * settings save that answers and one that times out.
 */
export async function rewriteInstants(
  tx: SchedulingDb,
  tenantId: string,
  rows: ReadonlyArray<
    Pick<BookingRow, "id" | "startsAt" | "endsAt" | "pendingExpiresAt" | "sequence">
  >,
): Promise<void> {
  for (let i = 0; i < rows.length; i += REWRITE_CHUNK) {
    const chunk = rows.slice(i, i + REWRITE_CHUNK);
    const values = sql.join(
      chunk.map(
        (row) =>
          sql`(${row.id}, ${row.startsAt?.toISOString() ?? null}::timestamptz, ${row.endsAt?.toISOString() ?? null}::timestamptz, ${row.pendingExpiresAt?.toISOString() ?? null}::timestamptz, ${row.sequence}::integer)`,
      ),
      sql`, `,
    );
    await tx.execute(sql`
      update ${schedulingBookings} as b
      set starts_at = v.starts_at, ends_at = v.ends_at, pending_expires_at = v.pending_expires_at,
          sequence = v.sequence, updated_at = now()
      from (values ${values}) as v(id, starts_at, ends_at, pending_expires_at, sequence)
      where b.id = v.id and b.tenant_id = ${tenantId}`);
  }
}

/**
 * The 0.3 policy object the public functions run on, from settings:
 * `durationsMinutes` is the distinct service durations in ascending order,
 * `requestStatus` is `confirmed` when the business auto-confirms; the rest map
 * by name.
 */
export function settingsToPolicy(settings: SchedulingSettingsValues): ResolvedPublicBookingPolicy {
  return {
    minNoticeMinutes: settings.minNoticeMinutes,
    horizonDays: settings.horizonDays,
    slotStepMinutes: settings.slotStepMinutes,
    durationsMinutes: [...new Set(settings.services.map((service) => service.durationMinutes))].sort((a, b) => a - b),
    requestStatus: settings.autoConfirm ? "confirmed" : "pending",
    maxSlotsPerDay: settings.maxSlotsPerDay,
    travelBufferMinutes: settings.travelBufferMinutes,
    maxOpenRequestsPerRequester: settings.maxOpenRequestsPerRequester,
    requireAddress: settings.requireAddress,
  };
}

/**
 * The policy the public functions actually run on: the defaults, then the
 * tenant's settings, then whatever fields `options.policy` defines. So a 0.3
 * caller that passes a policy keeps its numbers. The zone always comes from
 * settings.
 *
 * CONTRACT: a tenant that never SAVED settings, called by 0.3 code that passes
 * `durationMinutes` and no policy, keeps 0.3's default lengths (30–240
 * minutes) alongside the default service's 60. Without this, upgrading the
 * package alone would refuse every 0.3 request for a 120-minute visit as
 * `invalid_duration`. Once the business saves its services, the services are
 * the list.
 */
export function publicPolicyFor(
  settings: SchedulingSettings,
  policy: PublicBookingPolicy | undefined,
): ResolvedPublicBookingPolicy {
  const base = settingsToPolicy(settings);
  const durations =
    policy?.durationsMinutes ??
    (settings.saved
      ? base.durationsMinutes
      : [...new Set([...DEFAULT_PUBLIC_BOOKING_POLICY.durationsMinutes, ...base.durationsMinutes])].sort((a, b) => a - b));
  const pick = <K extends keyof PublicBookingPolicy>(key: K): ResolvedPublicBookingPolicy[K] =>
    (policy && policy[key] !== undefined ? policy[key] : base[key]) as ResolvedPublicBookingPolicy[K];
  return {
    minNoticeMinutes: pick("minNoticeMinutes"),
    horizonDays: pick("horizonDays"),
    slotStepMinutes: pick("slotStepMinutes"),
    durationsMinutes: durations,
    requestStatus: pick("requestStatus"),
    maxSlotsPerDay: pick("maxSlotsPerDay"),
    travelBufferMinutes: pick("travelBufferMinutes"),
    maxOpenRequestsPerRequester: pick("maxOpenRequestsPerRequester"),
    requireAddress: pick("requireAddress"),
  };
}

/**
 * Settings → the wire (`SettingsWire`). `companySettingsHref` is where the
 * owner changes the company-owned fields when `settings.managedByCompany`
 * (Tenancy 2a, D6); the wire's `managedByCompany` is null otherwise.
 */
export function toSettingsWire(settings: SchedulingSettings, options: { readonly companySettingsHref?: string | null } = {}): SettingsWire {
  return {
    timeZone: settings.timeZone,
    businessName: settings.businessName,
    contactEmail: settings.contactEmail,
    contactPhone: settings.contactPhone,
    staffNotifyEmails: [...settings.staffNotifyEmails],
    services: settings.services.map((service) => ({
      key: service.key,
      name: service.name,
      durationMinutes: service.durationMinutes,
      description: service.description ?? null,
      requiredSkill: service.requiredSkill ?? null,
    })),
    slotStepMinutes: settings.slotStepMinutes,
    minNoticeMinutes: settings.minNoticeMinutes,
    horizonDays: settings.horizonDays,
    travelBufferMinutes: settings.travelBufferMinutes,
    maxSlotsPerDay: settings.maxSlotsPerDay,
    maxOpenRequestsPerRequester: settings.maxOpenRequestsPerRequester,
    requireAddress: settings.requireAddress,
    autoConfirm: settings.autoConfirm,
    publicBookingEnabled: settings.publicBookingEnabled,
    pendingExpiryHours: settings.pendingExpiryHours,
    reminderLeadHours: settings.reminderLeadHours,
    cancelCutoffHours: settings.cancelCutoffHours,
    saved: settings.saved,
    updatedAt: settings.updatedAt ? settings.updatedAt.toISOString() : null,
    managedByCompany: settings.managedByCompany ? { href: options.companySettingsHref ?? null } : null,
  };
}
