import { and, asc, eq, gte, inArray, lt, lte, ne, notInArray, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  DEFAULT_SLOT_STEP_MINUTES,
  findFreeSlots,
  minutesToTime,
  scoreSlot,
  sortScoredSlots,
  timeToMinutes,
  windowsOverlap,
  type BookingWindow,
  type FreeSlot,
  type ScoredSlot,
} from "./math.js";
import { createHaversineMapsProvider, type DriveTime, type LatLng, type MapsProvider } from "./maps.js";
import {
  decodeSlotId,
  resolvePublicBookingPolicy,
  toPublicSlot,
  type PublicBookingPolicy,
  type PublicSlot,
  type ResolvedPublicBookingPolicy,
} from "./public.js";
import {
  BOOKING_STATUSES,
  INACTIVE_BOOKING_STATUSES,
  canTransitionBooking,
  isRevivingMove,
} from "./status.js";
import { END_TIME_PATTERN, TIME_OF_DAY_PATTERN } from "./time.js";
import {
  schedulingAvailability,
  schedulingBookings,
  schedulingDriveCache,
  schedulingResources,
} from "./schema.js";

export * from "./math.js";
export * from "./maps.js";
export * from "./status.js";
export * from "./permissions.js";
// The public projection and its policy. The slot-id codec stays internal: an
// id is something a host passes back, never something it builds.
export {
  DEFAULT_PUBLIC_BOOKING_POLICY,
  resolvePublicBookingPolicy,
  toPublicSlot,
  type PublicBookingPolicy,
  type PublicSlot,
  type ResolvedPublicBookingPolicy,
} from "./public.js";
export {
  schedulingAvailability,
  schedulingBookings,
  schedulingDriveCache,
  schedulingResources,
} from "./schema.js";

export type SchedulingDb = PgDatabase<any, any, any>;

export type ResourceRow = typeof schedulingResources.$inferSelect;
export type AvailabilityRow = typeof schedulingAvailability.$inferSelect;
export type BookingRow = typeof schedulingBookings.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A start or opening time: zero-padded 24-hour "HH:MM", 00:00–23:59. Use it in
 * a host's own inputs so a form's times are checked the way the package checks
 * them ("9:00" and "16:99" are not times).
 */
export const timeOfDaySchema = z.string().regex(TIME_OF_DAY_PATTERN, "Use a 24-hour HH:MM time, like 09:30.");
/** An end or closing time: a time of day, or "24:00" for midnight at the end of the day. */
export const endTimeSchema = z.string().regex(END_TIME_PATTERN, "Use a 24-hour HH:MM time, like 17:00 (24:00 for midnight).");

// --- Refusals --------------------------------------------------------------

/**
 * Why a slot can't be booked, for code to branch on (`error.code`); the
 * message is for a person.
 *
 * THE PUBLIC CODES ARE DELIBERATELY COARSE. `requestPublicBooking` says
 * `slot_unavailable` for "taken", "outside hours", "no time to drive there",
 * "this crew is paused" AND "no such slot in this tenant", so a refusal never
 * tells an anonymous caller whether an id exists or where another visit is.
 * The rest are about the request itself and say so: `too_soon`, `too_far`,
 * `invalid_duration`, `address_unresolved` (the provider couldn't place the
 * address, or the policy wants one and none came) and `too_many_requests`
 * (this requester already has the policy's limit of requests waiting).
 *
 * THE STAFF PATHS SAY MORE, because staff can act on it. `createBooking`,
 * `setBookingStatus` and `validateBookingSlot` (on its result's `code`) use
 * `slot_unavailable` only when another visit is in the way — an overlap, a
 * drive that doesn't fit, a day already at its cap — and `outside_hours`,
 * `invalid_window` (the end isn't after the start) and `resource_unavailable`
 * (no such crew, or removed) for the rest. A host answers `slot_unavailable`
 * with "pick another time"; given to a 03:00 booking that can never succeed,
 * that answer loops.
 */
export type BookingRefusalCode =
  | "slot_unavailable"
  | "too_soon"
  | "too_far"
  | "invalid_duration"
  | "address_unresolved"
  | "too_many_requests"
  | "outside_hours"
  | "invalid_window"
  | "resource_unavailable";

/** The codes a staff-path refusal carries (see `BookingRefusalCode`). */
export type StaffRefusalCode = "slot_unavailable" | "outside_hours" | "invalid_window" | "resource_unavailable";

export class BookingNotBookableError extends Error {
  readonly name = "BookingNotBookableError";
  readonly code: BookingRefusalCode;
  constructor(reason: string, code: BookingRefusalCode = "slot_unavailable") {
    super(reason);
    this.code = code;
  }
}

/** A status move BOOKING_STATUS_TRANSITIONS doesn't allow (completed → pending, say). */
export class BookingStatusTransitionError extends Error {
  readonly name = "BookingStatusTransitionError";
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`A visit can't move from ${from} to ${to}.`);
  }
}

const SLOT_UNAVAILABLE = "That time is no longer available. Please pick another.";

// --- Locks -----------------------------------------------------------------

/**
 * Serialise every write that can put a visit on one resource's calendar —
 * public request, staff booking, un-cancel, an hours change — behind a
 * transaction-scoped advisory lock on (tenant, resource). Validate-then-insert
 * without it is a race: two requests for the same 10:00 both read an empty
 * slot, both pass, both insert. Under the lock the second one re-reads after
 * the first commits and sees the visit. The same shape as
 * @adminigloo/booking's `lockHosts`, and only meaningful inside a transaction
 * (outside one it is released the moment the statement ends).
 *
 * NOTHING SLOW HAPPENS UNDER IT. Geocoding and drive times are looked up before
 * a writer takes it (see `driveTimesBeforeLock`); while it is held, a writer
 * only reads and writes this database on its own transaction.
 */
async function lockResource(tx: SchedulingDb, tenantId: string, resourceId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`scheduling:${tenantId}:${resourceId}`}))`);
}

/**
 * Serialise one requester's public requests, so the count of requests they
 * have waiting (`maxOpenRequestsPerRequester`) is read and acted on by one
 * request at a time. Always taken BEFORE the crew lock: the one path that takes
 * both takes them in that order, so two requests can't each hold the lock the
 * other is waiting for.
 */
async function lockRequester(tx: SchedulingDb, tenantId: string, requesterKey: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`scheduling-requester:${tenantId}:${requesterKey}`}))`,
  );
}

// --- Resources -------------------------------------------------------------

/** The editable fields of a resource, with no defaults (see the two schemas below). */
const resourceShape = {
  name: z.string().min(1).max(200),
  userId: z.string().max(200).nullish(),
  homeBaseAddress: z.string().max(500).nullish(),
  homeBaseLat: z.number().nullish(),
  homeBaseLng: z.number().nullish(),
  skills: z.array(z.string().max(60)).max(50),
  workStartTime: timeOfDaySchema,
  workEndTime: endTimeSchema,
  maxJobsPerDay: z.number().int().min(1).max(50),
  acceptsPublicBookings: z.boolean(),
};

export const createResourceSchema = z.object({
  tenantId: z.string().min(1).max(200),
  ...resourceShape,
  skills: resourceShape.skills.default([]),
  workStartTime: resourceShape.workStartTime.default("08:00"),
  workEndTime: resourceShape.workEndTime.default("17:00"),
  maxJobsPerDay: resourceShape.maxJobsPerDay.default(6),
  acceptsPublicBookings: resourceShape.acceptsPublicBookings.default(true),
});
export type CreateResourceInput = z.input<typeof createResourceSchema>;

/**
 * A partial resource edit. No `tenantId` and no `id` — a patch cannot move a
 * crew to another workspace, which the old `Partial<CreateResourceInput>` could
 * (it was spread straight into the UPDATE). No `hoursConfigured` (only
 * `setAvailability` sets it) and no `isActive` (`deactivateResource` /
 * `reactivateResource`). No defaults either, so an omitted field stays as it
 * is. Unknown keys are dropped.
 */
export const updateResourceSchema = z.object(resourceShape).partial();
export type UpdateResourceInput = z.input<typeof updateResourceSchema>;

export async function createResource(db: SchedulingDb, input: CreateResourceInput): Promise<ResourceRow> {
  const values = createResourceSchema.parse(input);
  const [row] = await db.insert(schedulingResources).values(values).returning();
  return row as ResourceRow;
}

/** Edit one of this tenant's resources; null when the id is not theirs. */
export async function updateResource(
  db: SchedulingDb,
  tenantId: string,
  id: string,
  patch: UpdateResourceInput,
): Promise<ResourceRow | null> {
  const parsed = updateResourceSchema.parse(patch);
  const [row] = await db
    .update(schedulingResources)
    .set({ ...parsed, updatedAt: new Date() })
    .where(and(eq(schedulingResources.id, id), eq(schedulingResources.tenantId, tenantId)))
    .returning();
  return (row as ResourceRow) ?? null;
}

/**
 * Take one of this tenant's resources off the schedule; false when the id is
 * not theirs. The finders stop offering it, `listResources` stops listing it
 * (ask with `includeInactive`), and a staff booking or an un-cancel onto it is
 * refused (`resource_unavailable`). Its existing visits are left as they are —
 * nothing reassigns them. `reactivateResource` puts it back.
 */
export async function deactivateResource(db: SchedulingDb, tenantId: string, id: string): Promise<boolean> {
  return setResourceActive(db, tenantId, id, false);
}

/**
 * Put one of this tenant's removed resources back on the schedule, with the
 * hours and online-booking switch it had; false when the id is not theirs.
 * Without it a crew removed by mistake could only come back by hand in SQL:
 * the patch schema has no `isActive` on purpose, so `updateResource` can't.
 */
export async function reactivateResource(db: SchedulingDb, tenantId: string, id: string): Promise<boolean> {
  return setResourceActive(db, tenantId, id, true);
}

async function setResourceActive(db: SchedulingDb, tenantId: string, id: string, isActive: boolean): Promise<boolean> {
  const [row] = await db
    .update(schedulingResources)
    .set({ isActive, updatedAt: new Date() })
    .where(and(eq(schedulingResources.id, id), eq(schedulingResources.tenantId, tenantId)))
    .returning({ id: schedulingResources.id });
  return row !== undefined;
}

export interface ListResourcesOptions {
  /**
   * Include deactivated resources. A seed asks this way: "does this tenant
   * have ANY crews" is a different question from "which crews are working",
   * and asking the second one is how a removed crew's demo replacement kept
   * coming back.
   */
  includeInactive?: boolean;
}

/**
 * This tenant's resources, by name. The id breaks a tie between two crews with
 * one name, so the order — and with it which crew the public offer gives a
 * shared time to — is the same on every call.
 */
export async function listResources(
  db: SchedulingDb,
  tenantId: string,
  options: ListResourcesOptions = {},
): Promise<ResourceRow[]> {
  return (await db
    .select()
    .from(schedulingResources)
    .where(
      options.includeInactive
        ? eq(schedulingResources.tenantId, tenantId)
        : and(eq(schedulingResources.tenantId, tenantId), eq(schedulingResources.isActive, true)),
    )
    .orderBy(asc(schedulingResources.name), asc(schedulingResources.id))) as ResourceRow[];
}

async function getResourceRow(db: SchedulingDb, tenantId: string, id: string): Promise<ResourceRow | null> {
  const [row] = (await db
    .select()
    .from(schedulingResources)
    .where(and(eq(schedulingResources.id, id), eq(schedulingResources.tenantId, tenantId)))
    .limit(1)) as ResourceRow[];
  return row ?? null;
}

// --- Availability ----------------------------------------------------------

export const availabilityBlockSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6).nullish(),
  specificDate: z.coerce.date().nullish(),
  startTime: timeOfDaySchema,
  endTime: endTimeSchema,
  isAvailable: z.boolean().default(true),
  note: z.string().max(300).nullish(),
});

export const setAvailabilitySchema = z.object({
  tenantId: z.string().min(1),
  resourceId: z.string().min(1),
  blocks: z.array(availabilityBlockSchema).max(200),
});

/**
 * Full-replace one of this tenant's resources' availability (weekly rows +
 * dated exceptions) and mark its hours as configured. False — and nothing
 * written — when the resource is not this tenant's: 0.2 deleted by resource id
 * alone and inserted under the CALLER's tenant, so one business could wipe
 * another's hours given an id.
 *
 * After this call the saved weekly rows ARE the week: a weekday with no row is
 * a day off, and `blocks: []` turns the resource off every day. (The Mon–Fri
 * fallback is for a resource whose hours were never saved; see
 * `resolveDayWindow`.) Dated exceptions are part of the replace, so a caller
 * editing only the week sends the existing exceptions back with it.
 *
 * One transaction under the resource lock, so a booking being validated at the
 * same moment sees the old hours or the new ones, never an empty week halfway
 * through the replace.
 */
export async function setAvailability(
  db: SchedulingDb,
  input: z.input<typeof setAvailabilitySchema>,
): Promise<boolean> {
  const parsed = setAvailabilitySchema.parse(input);
  return db.transaction(async (tx) => {
    await lockResource(tx, parsed.tenantId, parsed.resourceId);
    const resource = await getResourceRow(tx, parsed.tenantId, parsed.resourceId);
    if (!resource) return false;
    await tx
      .delete(schedulingAvailability)
      .where(
        and(
          eq(schedulingAvailability.tenantId, parsed.tenantId),
          eq(schedulingAvailability.resourceId, parsed.resourceId),
        ),
      );
    if (parsed.blocks.length > 0) {
      await tx.insert(schedulingAvailability).values(
        parsed.blocks.map((b) => ({
          tenantId: parsed.tenantId,
          resourceId: parsed.resourceId,
          dayOfWeek: b.specificDate ? null : b.dayOfWeek ?? null,
          specificDate: b.specificDate ?? null,
          startTime: b.startTime,
          endTime: b.endTime,
          isAvailable: b.isAvailable,
          note: b.note ?? null,
        })),
      );
    }
    await tx
      .update(schedulingResources)
      .set({ hoursConfigured: true, updatedAt: new Date() })
      .where(and(eq(schedulingResources.id, parsed.resourceId), eq(schedulingResources.tenantId, parsed.tenantId)));
    return true;
  });
}

/** One of this tenant's resources' availability rows ([] when the resource is not theirs). */
export async function listAvailability(
  db: SchedulingDb,
  tenantId: string,
  resourceId: string,
): Promise<AvailabilityRow[]> {
  return (await db
    .select()
    .from(schedulingAvailability)
    .where(
      and(eq(schedulingAvailability.tenantId, tenantId), eq(schedulingAvailability.resourceId, resourceId)),
    )) as AvailabilityRow[];
}

function sameUtcDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

/**
 * The window a resource works on a given day, or null if it isn't available.
 * Precedence: a dated exception for that day wins (blocked → null); else the
 * recurring row for that weekday; else — only while the resource's hours have
 * NEVER been saved and it has no weekly rows — a Mon–Fri fallback to its own
 * work hours, so a freshly created resource is immediately bookable.
 *
 * The fallback used to key on "no rows at all", which got both edges wrong.
 * Unticking every day and saving left no rows, so a crew someone had just
 * switched off came back Mon–Fri; and a never-configured crew given one dated
 * exception had a row, so it lost every other day. `hoursConfigured` (set by
 * `setAvailability`) is the explicit answer to "were these hours ever set?".
 */
export function resolveDayWindow(
  rows: AvailabilityRow[],
  resource: Pick<ResourceRow, "workStartTime" | "workEndTime" | "hoursConfigured">,
  date: Date,
): { start: string; end: string } | null {
  const exceptions = rows.filter((r) => r.specificDate && sameUtcDay(new Date(r.specificDate), date));
  if (exceptions.length > 0) {
    const open = exceptions.find((r) => r.isAvailable);
    return open ? { start: open.startTime, end: open.endTime } : null;
  }
  const recurring = rows.filter((r) => !r.specificDate && r.dayOfWeek === date.getUTCDay());
  if (recurring.length > 0) {
    const open = recurring.find((r) => r.isAvailable);
    return open ? { start: open.startTime, end: open.endTime } : null;
  }
  if (!resource.hoursConfigured && !rows.some((r) => !r.specificDate)) {
    const dow = date.getUTCDay();
    if (dow >= 1 && dow <= 5) return { start: resource.workStartTime, end: resource.workEndTime };
  }
  return null;
}

// --- Days --------------------------------------------------------------------

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * One UTC day as a half-open range, [midnight, next midnight). It used to end
 * at 23:59:59.000 and be read with `lte`, so a visit whose `scheduledDate` was
 * stamped in the last second of its day (23:59:59.500, from a host's own
 * insert or a date picker that sends a time) was on no day at all: invisible
 * to the overlap check and the daily cap, so a second visit could take its
 * slot. `createBooking` stores the day's midnight now too, but a range that
 * can't drop an instant is the fix that holds for rows it didn't write.
 */
function dayRange(date: Date): { start: Date; end: Date } {
  const start = startOfUtcDay(date);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

function isoDay(date: Date): string {
  return startOfUtcDay(date).toISOString().slice(0, 10);
}

/** This tenant's visits on one resource's day that hold time (not cancelled / no-show). */
async function activeBookingsOn(
  db: SchedulingDb,
  tenantId: string,
  resourceId: string,
  date: Date,
  excludeBookingId?: string | null,
): Promise<BookingRow[]> {
  const { start, end } = dayRange(date);
  return (await db
    .select()
    .from(schedulingBookings)
    .where(
      and(
        eq(schedulingBookings.tenantId, tenantId),
        eq(schedulingBookings.resourceId, resourceId),
        gte(schedulingBookings.scheduledDate, start),
        lt(schedulingBookings.scheduledDate, end),
        notInArray(schedulingBookings.status, [...INACTIVE_BOOKING_STATUSES]),
        ...(excludeBookingId ? [ne(schedulingBookings.id, excludeBookingId)] : []),
      ),
    )) as BookingRow[];
}

function resourceDayKey(resourceId: string, day: Date): string {
  return `${resourceId} ${isoDay(day)}`;
}

/**
 * Every visit holding time on these resources' calendars from `firstDay` to
 * `lastDay` (inclusive), in ONE query, keyed by `resourceDayKey`. The finders
 * used to ask once per resource per day, so one anonymous 30-day `slots` call
 * on ten crews was some 220 queries; the day loop reads this map instead.
 */
async function activeBookingsByDay(
  db: SchedulingDb,
  tenantId: string,
  resourceIds: string[],
  firstDay: Date,
  lastDay: Date,
): Promise<Map<string, BookingRow[]>> {
  const byDay = new Map<string, BookingRow[]>();
  if (resourceIds.length === 0) return byDay;
  const rows = (await db
    .select()
    .from(schedulingBookings)
    .where(
      and(
        eq(schedulingBookings.tenantId, tenantId),
        inArray(schedulingBookings.resourceId, resourceIds),
        gte(schedulingBookings.scheduledDate, startOfUtcDay(firstDay)),
        lt(schedulingBookings.scheduledDate, dayRange(lastDay).end),
        notInArray(schedulingBookings.status, [...INACTIVE_BOOKING_STATUSES]),
      ),
    )) as BookingRow[];
  for (const row of rows) {
    const key = resourceDayKey(row.resourceId ?? "", row.scheduledDate);
    const list = byDay.get(key);
    if (list) list.push(row);
    else byDay.set(key, [row]);
  }
  return byDay;
}

/** Each resource's availability, in ONE query for all of them rather than one per resource. */
async function availabilityFor(
  db: SchedulingDb,
  tenantId: string,
  resources: ResourceRow[],
): Promise<Map<string, AvailabilityRow[]>> {
  const byResource = new Map<string, AvailabilityRow[]>(resources.map((r) => [r.id, []]));
  if (resources.length === 0) return byResource;
  const rows = (await db
    .select()
    .from(schedulingAvailability)
    .where(
      and(
        eq(schedulingAvailability.tenantId, tenantId),
        inArray(
          schedulingAvailability.resourceId,
          resources.map((r) => r.id),
        ),
      ),
    )) as AvailabilityRow[];
  for (const row of rows) byResource.get(row.resourceId)?.push(row);
  return byResource;
}

// --- Drive times, looked up before the lock ----------------------------------

export interface CachedMapsOptions {
  ttlDays?: number;
  /** Coordinate rounding for the cache key (decimal places). Default 4 (~11m). */
  precision?: number;
}

/**
 * Wrap a real maps provider so drive times are cached in the database for a few
 * days — the pattern SG Glass used to keep the Google bill down. Geocoding is
 * passed straight through. The keyless Haversine provider needs no cache (it's
 * deterministic and free), so wrap only a paid provider with this.
 *
 * The cache reads and writes on `db`, the handle it was built with — never on
 * a caller's transaction. That is safe with every function here: they look
 * drive times up before taking a crew's lock, outside any transaction. Don't
 * hand it to `validateBookingSlot` inside a transaction of your own; on a
 * one-connection handle the cache would wait for the connection your
 * transaction is holding.
 */
export function createCachedMapsProvider(
  base: MapsProvider,
  db: SchedulingDb,
  options: CachedMapsOptions = {},
): MapsProvider {
  const ttlMs = (options.ttlDays ?? 7) * 24 * 60 * 60 * 1000;
  const p = options.precision ?? 4;
  const round = (n: number): number => Math.round(n * 10 ** p) / 10 ** p;
  return {
    geocodes: base.geocodes,
    geocode: (address) => base.geocode(address),
    async driveTime(origin, dest): Promise<DriveTime | null> {
      const oLat = round(origin.lat);
      const oLng = round(origin.lng);
      const dLat = round(dest.lat);
      const dLng = round(dest.lng);
      const [hit] = await db
        .select()
        .from(schedulingDriveCache)
        .where(
          and(
            eq(schedulingDriveCache.originLat, oLat),
            eq(schedulingDriveCache.originLng, oLng),
            eq(schedulingDriveCache.destLat, dLat),
            eq(schedulingDriveCache.destLng, dLng),
            gte(schedulingDriveCache.fetchedAt, new Date(Date.now() - ttlMs)),
          ),
        )
        .limit(1);
      if (hit) {
        const row = hit as typeof schedulingDriveCache.$inferSelect;
        return { durationMinutes: row.durationMinutes, distanceMiles: row.distanceMiles };
      }
      const fresh = await base.driveTime(origin, dest);
      if (fresh) {
        await db.insert(schedulingDriveCache).values({
          originLat: oLat,
          originLng: oLng,
          destLat: dLat,
          destLng: dLng,
          durationMinutes: fresh.durationMinutes,
          distanceMiles: fresh.distanceMiles,
        });
      }
      return fresh;
    },
  };
}

const driveKey = (origin: LatLng, dest: LatLng): string => `${origin.lat},${origin.lng}>${dest.lat},${dest.lng}`;

interface DriveLookup {
  tenantId: string;
  resourceId: string;
  date: Date;
  /** The new (or revived) visit's coordinates; null means there is nothing to look up. */
  job: LatLng | null;
  /** The visit being revived, which is not its own neighbour. */
  excludeBookingId?: string | null;
}

/**
 * Every drive time a writer's `validateBookingSlot` could ask for, looked up
 * BEFORE the crew lock is taken, and a provider that answers from them without
 * calling anybody.
 *
 * WHY. A real provider's `driveTime` is an HTTP round trip, and
 * `createCachedMapsProvider` reads and writes its cache on the handle it was
 * built with. Asked from inside the writer's transaction, the first held the
 * crew's lock — and a pooled connection — through every round trip (eight of
 * them for one request on a day with three visits); the second needed a SECOND
 * connection while the transaction held the first. On a one-connection handle
 * that never returns, and with a pool's worth of requests doing it at once,
 * every transaction waits for a connection none of them will give back.
 *
 * So the lookups happen here, outside any transaction: both directions between
 * the job and every visit with coordinates on that crew's day (the validator
 * checks the drive in from each visit before the job and out to each one
 * after). Under the lock the visits are read again; a visit that landed in
 * between — the few milliseconds from this read to the lock — has no looked-up
 * time and gets the straight-line Haversine estimate rather than a network
 * call. A lookup that failed (null) stays null, which the validator reads as
 * "unknown", as it always has.
 */
async function driveTimesBeforeLock(db: SchedulingDb, maps: MapsProvider, lookup: DriveLookup): Promise<MapsProvider> {
  const estimate = createHaversineMapsProvider();
  const { job } = lookup;
  // No coordinates for the job: the validator makes no drive call at all.
  if (!job) return estimate;

  const known = new Map<string, DriveTime | null>();
  const pending: Promise<void>[] = [];
  const lookUp = (origin: LatLng, dest: LatLng): void => {
    const key = driveKey(origin, dest);
    if (known.has(key)) return;
    known.set(key, null);
    pending.push(
      maps.driveTime(origin, dest).then((time) => {
        known.set(key, time);
      }),
    );
  };
  const visits = await activeBookingsOn(db, lookup.tenantId, lookup.resourceId, lookup.date, lookup.excludeBookingId);
  for (const visit of visits) {
    if (visit.lat == null || visit.lng == null) continue;
    const at = { lat: visit.lat, lng: visit.lng };
    lookUp(at, job);
    lookUp(job, at);
  }
  await Promise.all(pending);

  return {
    geocodes: false,
    geocode: async () => null,
    driveTime: async (origin, dest) => {
      const key = driveKey(origin, dest);
      return known.has(key) ? (known.get(key) ?? null) : estimate.driveTime(origin, dest);
    },
  };
}

// --- The finder: one resource, one day ---------------------------------------

interface ResourceDayInput {
  resource: ResourceRow;
  availability: AvailabilityRow[];
  /** The visits holding time on this resource's day, already read (see `activeBookingsByDay`). */
  active: BookingRow[];
  day: Date;
  durationMinutes: number;
  stepMinutes: number;
  /**
   * Minutes kept clear before and after every visit, whatever its address —
   * the public offer's travel buffer. The staff finder passes none and checks
   * real drive times from `jobCoords` instead.
   */
  bufferMinutes?: number;
  jobCoords: LatLng | null;
  maps: MapsProvider;
  preferredResourceId?: string | null;
  /** Starts before this instant are not offered (the public notice). */
  earliestStart?: Date | null;
  /** Starts after this instant are not offered (the public horizon). */
  latestStart?: Date | null;
}

/**
 * Every start one resource can take on one day, scored. The ONE place a slot
 * is decided: the staff finder, the public offer and the public request's
 * "is this still on offer?" re-check all call it, so what is offered and what
 * is accepted cannot drift apart. It reads nothing itself — the callers load a
 * whole range's visits and hours in one query each.
 *
 * The per-day cap is all-or-nothing. 0.2 sliced the day's offers to the
 * remaining capacity, which was harmless with one offer per gap and is wrong
 * with a grid: each start is an ALTERNATIVE, not another job, so a crew with
 * room for two more visits offered only 08:00 and 08:30.
 *
 * With job coordinates, a start the crew can't drive to in time (from the job
 * before its gap) or can't leave in time (for the job after) is not offered —
 * the same buffer `validateBookingSlot` refuses, checked once per gap rather
 * than once per start.
 */
async function slotsForResourceDay(input: ResourceDayInput): Promise<ScoredSlot[]> {
  const { resource, jobCoords, maps } = input;
  const window = resolveDayWindow(input.availability, resource, input.day);
  if (!window) return [];
  if (input.active.length >= resource.maxJobsPerDay) return [];

  const buffer = input.bufferMinutes ?? 0;
  const windows: BookingWindow[] = input.active.map((b) => ({
    start: minutesToTime(Math.max(0, timeToMinutes(b.startTime) - buffer)),
    end: minutesToTime(Math.min(24 * 60, timeToMinutes(b.endTime) + buffer)),
    lat: b.lat,
    lng: b.lng,
    address: b.address ?? "",
  }));
  const free = findFreeSlots(window.start, window.end, windows, input.durationMinutes, input.stepMinutes);

  const dayStart = startOfUtcDay(input.day);
  const iso = isoDay(input.day);

  // One drive lookup per gap end, not per start: every start in a gap shares
  // the same previous and next job objects.
  const fromPrevious = new Map<NonNullable<FreeSlot["previousJob"]>, Promise<DriveTime | null>>();
  const toNext = new Map<NonNullable<FreeSlot["nextJob"]>, Promise<DriveTime | null>>();
  let fromHomeBase: Promise<DriveTime | null> | null = null;

  const scored: ScoredSlot[] = [];
  for (const slot of free) {
    const startMs = dayStart.getTime() + timeToMinutes(slot.startTime) * 60_000;
    if (input.earliestStart && startMs < input.earliestStart.getTime()) continue;
    if (input.latestStart && startMs > input.latestStart.getTime()) continue;

    let driveMinutes: number | null = null;
    let homeBaseDrive: number | null = null;
    if (jobCoords) {
      const prev = slot.previousJob;
      if (prev && prev.lat != null && prev.lng != null) {
        if (!fromPrevious.has(prev)) {
          fromPrevious.set(prev, maps.driveTime({ lat: prev.lat, lng: prev.lng }, jobCoords));
        }
        driveMinutes = (await fromPrevious.get(prev))?.durationMinutes ?? null;
        if (driveMinutes !== null && timeToMinutes(slot.startTime) - timeToMinutes(prev.endTime) < driveMinutes) {
          continue;
        }
      } else if (!prev && resource.homeBaseLat != null && resource.homeBaseLng != null) {
        fromHomeBase ??= maps.driveTime({ lat: resource.homeBaseLat, lng: resource.homeBaseLng }, jobCoords);
        homeBaseDrive = (await fromHomeBase)?.durationMinutes ?? null;
      }
      const next = slot.nextJob;
      if (next && next.lat != null && next.lng != null) {
        if (!toNext.has(next)) toNext.set(next, maps.driveTime(jobCoords, { lat: next.lat, lng: next.lng }));
        const onward = (await toNext.get(next))?.durationMinutes ?? null;
        if (onward !== null && timeToMinutes(next.startTime) - timeToMinutes(slot.endTime) < onward) continue;
      }
    }

    scored.push({
      date: iso,
      startTime: slot.startTime,
      endTime: slot.endTime,
      resourceId: resource.id,
      resourceName: resource.name,
      driveMinutesFromPrevious: driveMinutes,
      previousJobAddress: slot.previousJob?.address ?? null,
      score: scoreSlot({
        driveMinutesFromPrevious: driveMinutes,
        homeBaseDriveMinutes: homeBaseDrive,
        startTime: slot.startTime,
        isPreferredResource: input.preferredResourceId === resource.id,
        isGapStart: slot.isGapStart,
      }),
    });
  }
  return scored;
}

function skillMatches(resource: ResourceRow, requiredSkill: string | null | undefined): boolean {
  return !requiredSkill || resource.skills.length === 0 || resource.skills.includes(requiredSkill);
}

// --- The staff finder: scored slots ------------------------------------------

export interface FindSlotsOptions {
  tenantId: string;
  jobAddress?: string | null;
  jobLat?: number | null;
  jobLng?: number | null;
  durationMinutes: number;
  startDate: Date;
  endDate: Date;
  requiredSkill?: string | null;
  preferredResourceId?: string | null;
  /** Minutes between offered starts. Default 30; `Infinity` for one per gap. */
  slotStepMinutes?: number;
}

/**
 * The whole point of the package: open slots across every resource, scored by
 * drive time from the previous job (via the injected maps provider), best
 * first. Falls back to the keyless Haversine provider if none is given.
 *
 * STAFF ONLY. Each `ScoredSlot` names the crew and carries the previous job's
 * address — another customer's home — and its drive filter depends on the
 * job's address. A public route uses `findPublicSlots`, which returns
 * `PublicSlot`s and nothing else.
 */
export async function findAvailableSlots(
  db: SchedulingDb,
  options: FindSlotsOptions,
  maps: MapsProvider = createHaversineMapsProvider(),
): Promise<ScoredSlot[]> {
  let jobCoords: LatLng | null =
    options.jobLat != null && options.jobLng != null
      ? { lat: options.jobLat, lng: options.jobLng }
      : null;
  if (!jobCoords && options.jobAddress) {
    jobCoords = await maps.geocode(options.jobAddress);
  }

  const resources = (await listResources(db, options.tenantId)).filter((r) => {
    if (options.preferredResourceId && r.id !== options.preferredResourceId) return false;
    return skillMatches(r, options.requiredSkill);
  });
  if (resources.length === 0) return [];

  // The range's hours and visits in one query each, not one per resource per
  // day (14 days × N resources was 14N round-trips).
  const availability = await availabilityFor(db, options.tenantId, resources);
  const visits = await activeBookingsByDay(
    db,
    options.tenantId,
    resources.map((r) => r.id),
    options.startDate,
    options.endDate,
  );

  const scored: ScoredSlot[] = [];
  for (
    let day = new Date(options.startDate);
    day.getTime() <= options.endDate.getTime();
    day = new Date(day.getTime() + DAY_MS)
  ) {
    for (const resource of resources) {
      scored.push(
        ...(await slotsForResourceDay({
          resource,
          availability: availability.get(resource.id) ?? [],
          active: visits.get(resourceDayKey(resource.id, day)) ?? [],
          day,
          durationMinutes: options.durationMinutes,
          stepMinutes: options.slotStepMinutes ?? DEFAULT_SLOT_STEP_MINUTES,
          jobCoords,
          maps,
          preferredResourceId: options.preferredResourceId ?? null,
        })),
      );
    }
  }

  return sortScoredSlots(scored);
}

// --- The public offer ----------------------------------------------------------

interface PublicOfferQuery {
  tenantId: string;
  durationMinutes: number;
  requiredSkill?: string | null;
  /** UTC midnight of the first day. */
  firstDay: Date;
  /** UTC midnight of the last day (inclusive). */
  lastDay: Date;
  policy: ResolvedPublicBookingPolicy;
  earliestStart: Date;
  latestStart: Date;
}

/**
 * THE PUBLIC OFFER: for each day and start, the one crew that takes it.
 * `findPublicSlots` shows it. `requestPublicBooking` works it out again — once
 * to find the crew, and once more under that crew's lock — and books only a
 * (day, start) that is in it, on the crew it names. So everything that shapes
 * the list also binds the request: hours, notice, horizon, the daily cap,
 * overlaps, the travel buffer, the skill, which crew gets a shared time, and
 * `maxSlotsPerDay`.
 *
 * IT NEVER DEPENDS ON WHO IS ASKING. No address, no drive time: every visit is
 * padded by the policy's `travelBufferMinutes`, the same for everybody (see
 * that field for the side channel a drive-scored public list was). Scores
 * therefore come only from each crew's own calendar — the start right after a
 * visit, and mornings, score higher — which is what picks the crew for a time
 * two are free at, and what `maxSlotsPerDay` keeps. A tie goes to the first
 * crew in `listResources` order, which is stable.
 *
 * Only active resources that accept public bookings are offered; a crew at its
 * daily cap offers nothing that day. Three queries whatever the range: the
 * crews, their hours, the range's visits.
 */
async function publicOffer(db: SchedulingDb, query: PublicOfferQuery): Promise<ScoredSlot[]> {
  const { policy } = query;
  const resources = (await listResources(db, query.tenantId)).filter(
    (r) => r.acceptsPublicBookings && skillMatches(r, query.requiredSkill),
  );
  if (resources.length === 0) return [];
  const availability = await availabilityFor(db, query.tenantId, resources);
  const visits = await activeBookingsByDay(
    db,
    query.tenantId,
    resources.map((r) => r.id),
    query.firstDay,
    query.lastDay,
  );
  // Never called: the public offer has no job coordinates. Passed because the
  // finder takes one.
  const noDrives = createHaversineMapsProvider();

  const best = new Map<string, ScoredSlot>();
  for (let day = query.firstDay; day.getTime() <= query.lastDay.getTime(); day = new Date(day.getTime() + DAY_MS)) {
    for (const resource of resources) {
      const slots = await slotsForResourceDay({
        resource,
        availability: availability.get(resource.id) ?? [],
        active: visits.get(resourceDayKey(resource.id, day)) ?? [],
        day,
        durationMinutes: query.durationMinutes,
        stepMinutes: policy.slotStepMinutes,
        bufferMinutes: policy.travelBufferMinutes,
        jobCoords: null,
        maps: noDrives,
        earliestStart: query.earliestStart,
        latestStart: query.latestStart,
      });
      for (const slot of slots) {
        const key = `${slot.date} ${slot.startTime}`;
        const held = best.get(key);
        if (!held || slot.score > held.score) best.set(key, slot);
      }
    }
  }

  let offered = [...best.values()];
  if (policy.maxSlotsPerDay != null) {
    const perDay = new Map<string, ScoredSlot[]>();
    for (const slot of offered) perDay.set(slot.date, [...(perDay.get(slot.date) ?? []), slot]);
    offered = [...perDay.values()].flatMap((slots) =>
      [...slots]
        .sort((a, b) => b.score - a.score || a.startTime.localeCompare(b.startTime))
        .slice(0, policy.maxSlotsPerDay ?? undefined),
    );
  }
  return offered.sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
}

// --- The public finder and request -------------------------------------------

export interface PublicBookingOptions {
  /** The clock. Defaults to the wall clock per call; inject for tests. */
  now?: Date;
  /** Notice, horizon, grid, durations, buffer, caps and landing status. Pass the SAME policy to both public functions. */
  policy?: PublicBookingPolicy;
}

export interface FindPublicSlotsInput {
  tenantId: string;
  /** Must be one of the policy's `durationsMinutes`. */
  durationMinutes: number;
  /**
   * Only crews with this skill (or no skills listed). Decide it on the server,
   * from the service being booked, and pass the same one to
   * `requestPublicBooking`.
   *
   * There is no address field on purpose: the offer is the same for every
   * visitor (see `PublicBookingPolicy.travelBufferMinutes`). The visitor's
   * address is checked when the request is made.
   */
  requiredSkill?: string | null;
  /** First day to look at (UTC date). Clamped forward to now + notice. Default: today. */
  from?: Date | null;
  /** How many days to look across from `from`. Clamped to the policy horizon. Default: up to the horizon. */
  days?: number | null;
}

function assertPublicDuration(durationMinutes: number, policy: ResolvedPublicBookingPolicy): void {
  if (!policy.durationsMinutes.includes(durationMinutes)) {
    throw new BookingNotBookableError(
      `Visits can be booked online for ${policy.durationsMinutes.join(", ")} minutes.`,
      "invalid_duration",
    );
  }
}

/**
 * The slots an ANONYMOUS visitor may see: `PublicSlot`s (slot id, date, start,
 * end) and nothing else — no crew, no score, no drive time, no other
 * customer's address. Every public route that lists times must use this, never
 * `findAvailableSlots`, whose staff `ScoredSlot`s carry the previous job's
 * street address.
 *
 * The list is the public offer (see `publicOffer` in the source): one choice
 * per time, the same for every visitor, in time order. Throws
 * `BookingNotBookableError` (`invalid_duration`) for a length the policy
 * doesn't offer.
 */
export async function findPublicSlots(
  db: SchedulingDb,
  input: FindPublicSlotsInput,
  options: PublicBookingOptions = {},
): Promise<PublicSlot[]> {
  const policy = resolvePublicBookingPolicy(options.policy);
  assertPublicDuration(input.durationMinutes, policy);
  const now = options.now ?? new Date();
  const earliestStart = new Date(now.getTime() + policy.minNoticeMinutes * 60_000);
  const latestStart = new Date(now.getTime() + policy.horizonDays * DAY_MS);

  const firstDay = new Date(
    Math.max(startOfUtcDay(input.from ?? now).getTime(), startOfUtcDay(earliestStart).getTime()),
  );
  const lastDay = new Date(
    Math.min(
      input.days != null ? firstDay.getTime() + (Math.max(1, input.days) - 1) * DAY_MS : Infinity,
      startOfUtcDay(latestStart).getTime(),
    ),
  );
  if (firstDay.getTime() > lastDay.getTime()) return [];

  const offer = await publicOffer(db, {
    tenantId: input.tenantId,
    durationMinutes: input.durationMinutes,
    requiredSkill: input.requiredSkill ?? null,
    firstDay,
    lastDay,
    policy,
    earliestStart,
    latestStart,
  });
  return offer.map(toPublicSlot);
}

export const requestPublicBookingSchema = z.object({
  tenantId: z.string().min(1).max(200),
  /** From a `PublicSlot`; the server re-derives the day and start from it and picks the crew. */
  slotId: z.string().min(1).max(500),
  durationMinutes: z.number().int().min(1).max(1440),
  /** The same skill the slots were listed with. Set it on the server, from the service. */
  requiredSkill: z.string().max(60).nullish(),
  serviceType: z.string().max(60).default("visit"),
  customerName: z.string().trim().min(1).max(200),
  customerEmail: z.string().trim().email().max(320),
  customerPhone: z.string().trim().max(60).nullish(),
  /** Geocoded server-side for the drive-time check; the request carries no coordinates. */
  address: z.string().trim().max(500).nullish(),
  notes: z.string().max(2000).nullish(),
  /** A pointer staff can follow to the estimate that led here. Never read for price or access. */
  estimateId: z.string().max(200).nullish(),
});
export type RequestPublicBookingInput = z.input<typeof requestPublicBookingSchema>;

export interface RequestPublicBookingOptions extends PublicBookingOptions {
  /** Geocoding and the drive-buffer check; defaults to keyless Haversine (no geocoding). */
  maps?: MapsProvider;
  /**
   * Who is asking, as the host can tell: the caller's IP address, say
   * (`"ip:203.0.113.7"`). Never from the request body. Stored on the visit,
   * and counted against `policy.maxOpenRequestsPerRequester`. Null or omitted:
   * no per-requester cap.
   */
  requesterKey?: string | null;
}

/** What the visitor gets back: when, and whether it is confirmed or awaiting a person. Nothing about the crew. */
export interface PublicBookingReceipt {
  id: string;
  /** "YYYY-MM-DD" */
  date: string;
  startTime: string;
  endTime: string;
  status: "pending" | "confirmed";
}

function receiptFor(row: BookingRow): PublicBookingReceipt {
  return {
    id: row.id,
    date: isoDay(row.scheduledDate),
    startTime: row.startTime,
    endTime: row.endTime,
    status: row.status === "confirmed" ? "confirmed" : "pending",
  };
}

/**
 * Where a public visit is, from the address the visitor typed — geocoded here,
 * never taken from the client, and before any lock (a network call must not
 * hold up everyone else booking the crew).
 *
 * FAILS CLOSED WHEN THE PROVIDER CAN GEOCODE. An address a real geocoder can't
 * place ("99 Far Rd, gate code 1234 #"), or a geocoder that came back empty,
 * used to book the visit with no coordinates — and a visit with no
 * coordinates skips every drive check, its own and every later one against
 * it, which is the spoofed-coordinates hole by another door. Now it is
 * `address_unresolved` and the visitor fixes the address. A provider that
 * can't geocode at all (`geocodes: false`, the Haversine default) books
 * without coordinates as before; the policy's travel buffer keeps that visit
 * apart from its neighbours.
 */
async function locateVisit(
  address: string | null | undefined,
  maps: MapsProvider,
  policy: ResolvedPublicBookingPolicy,
): Promise<LatLng | null> {
  if (!address) {
    if (policy.requireAddress) {
      throw new BookingNotBookableError("Enter the address for the visit.", "address_unresolved");
    }
    return null;
  }
  if (maps.geocodes === false) return null;
  const coords = await maps.geocode(address);
  if (!coords) {
    throw new BookingNotBookableError(
      "We couldn't find that address. Check it and try again.",
      "address_unresolved",
    );
  }
  return coords;
}

/** How long a repeat of the same request gets the first one's receipt back. */
const REPEAT_WINDOW_MINUTES = 10;

interface PublicAsk {
  tenantId: string;
  day: Date;
  startTime: string;
  durationMinutes: number;
  customerEmail: string;
  requesterKey: string | null;
}

/**
 * The visit this same request made a few minutes ago, if there is one: same
 * day, start, length and email (and requester, when the host names one), still
 * pending or confirmed.
 *
 * A double click, or a retry after a slow response, used to be refused
 * `slot_unavailable` — the first request was holding the time — so the visitor
 * read "that time is gone" about a booking that had landed, picked another,
 * and staff got two requests from one person. Now the repeat gets the first
 * one's receipt.
 *
 * Bounded to a few minutes, and to the same requester when the host passes a
 * key, so all a caller can learn is that the email they typed asked for the
 * time they asked for, just now. The clock is the database's — the one that
 * stamped `created_at` — not the injectable `now`.
 */
async function recentRepeat(db: SchedulingDb, ask: PublicAsk): Promise<BookingRow | null> {
  const [row] = (await db
    .select()
    .from(schedulingBookings)
    .where(
      and(
        eq(schedulingBookings.tenantId, ask.tenantId),
        eq(schedulingBookings.scheduledDate, ask.day),
        eq(schedulingBookings.startTime, ask.startTime),
        eq(schedulingBookings.durationMinutes, ask.durationMinutes),
        sql`lower(${schedulingBookings.customerEmail}) = ${ask.customerEmail.toLowerCase()}`,
        inArray(schedulingBookings.status, ["pending", "confirmed"]),
        sql`${schedulingBookings.createdAt} > now() - interval '${sql.raw(String(REPEAT_WINDOW_MINUTES))} minutes'`,
        ...(ask.requesterKey ? [eq(schedulingBookings.requesterKey, ask.requesterKey)] : []),
      ),
    )
    .limit(1)) as BookingRow[];
  return row ?? null;
}

/** A requester's requests still waiting for a person: pending, for today or later. */
async function openRequestsFrom(db: SchedulingDb, tenantId: string, requesterKey: string, today: Date): Promise<number> {
  const [row] = await db
    .select({ open: sql<number>`count(*)::int` })
    .from(schedulingBookings)
    .where(
      and(
        eq(schedulingBookings.tenantId, tenantId),
        eq(schedulingBookings.requesterKey, requesterKey),
        eq(schedulingBookings.status, "pending"),
        gte(schedulingBookings.scheduledDate, startOfUtcDay(today)),
      ),
    );
  return Number(row?.open ?? 0);
}

/**
 * An anonymous visitor asks for a slot from `findPublicSlots`.
 *
 * Nothing about WHEN comes from the client but the slot id and a duration from
 * the policy's list: the day and start are decoded from the id, the end is
 * start + duration, the crew is the one the public offer gives that time to,
 * and the coordinates are geocoded here from the address. The (day, start)
 * must be in the public offer right now — same notice, horizon, hours, cap,
 * overlap, travel buffer, skill, crew choice and `maxSlotsPerDay` — and the
 * real drive from the neighbouring visits must fit, all checked and inserted
 * in ONE transaction under the crew's advisory lock, so two visitors racing
 * for one time get one booking and one `slot_unavailable`. The visit lands
 * `pending` unless the policy says `confirmed`.
 *
 * With a `requesterKey`, a requester already holding the policy's
 * `maxOpenRequestsPerRequester` pending requests is refused
 * `too_many_requests`. A repeat of a request made in the last few minutes
 * returns the first receipt (see `recentRepeat`).
 *
 * 0.2's generated route took createBookingSchema from the client — start,
 * end, duration, lat/lng — and wrote it `confirmed` with no lock: a visitor
 * could claim 08:00–17:00, a date in the past or years ahead, push a crew past
 * its daily cap, or race a second request into a double booking, and spoofed
 * coordinates skipped the drive check.
 *
 * Throws `BookingNotBookableError` (`code` says why) and a zod error for a
 * malformed body. An unknown slot, another tenant's slot, a paused crew, a
 * start the offer doesn't hold, a drive that doesn't fit and a taken time are
 * all the same `slot_unavailable`.
 */
export async function requestPublicBooking(
  db: SchedulingDb,
  input: RequestPublicBookingInput,
  options: RequestPublicBookingOptions = {},
): Promise<PublicBookingReceipt> {
  const parsed = requestPublicBookingSchema.parse(input);
  const policy = resolvePublicBookingPolicy(options.policy);
  assertPublicDuration(parsed.durationMinutes, policy);
  const maps = options.maps ?? createHaversineMapsProvider();
  const requesterKey = options.requesterKey?.trim().slice(0, 200) || null;
  const now = options.now ?? new Date();
  const earliestStart = new Date(now.getTime() + policy.minNoticeMinutes * 60_000);
  const latestStart = new Date(now.getTime() + policy.horizonDays * DAY_MS);

  const slot = decodeSlotId(parsed.slotId);
  if (!slot) throw new BookingNotBookableError(SLOT_UNAVAILABLE);
  const day = new Date(`${slot.date}T00:00:00Z`);
  const startMs = day.getTime() + timeToMinutes(slot.startTime) * 60_000;
  if (startMs < earliestStart.getTime()) {
    throw new BookingNotBookableError("That time is too soon to book online. Please pick a later one.", "too_soon");
  }
  if (startMs > latestStart.getTime()) {
    throw new BookingNotBookableError("That date is too far ahead to book online.", "too_far");
  }
  const endTime = minutesToTime(timeToMinutes(slot.startTime) + parsed.durationMinutes);

  const ask: PublicAsk = {
    tenantId: parsed.tenantId,
    day,
    startTime: slot.startTime,
    durationMinutes: parsed.durationMinutes,
    customerEmail: parsed.customerEmail,
    requesterKey,
  };
  // A retry after the first request committed: the time is no longer on
  // offer, so this has to be asked before the offer is — and before a paid
  // geocode of an address that already has its visit.
  const repeat = await recentRepeat(db, ask);
  if (repeat) return receiptFor(repeat);

  const coords = await locateVisit(parsed.address, maps, policy);

  const query: PublicOfferQuery = {
    tenantId: parsed.tenantId,
    durationMinutes: parsed.durationMinutes,
    requiredSkill: parsed.requiredSkill ?? null,
    firstDay: day,
    lastDay: day,
    policy,
    earliestStart,
    latestStart,
  };
  const chosen = (await publicOffer(db, query)).find((s) => s.startTime === slot.startTime);
  if (!chosen) throw new BookingNotBookableError(SLOT_UNAVAILABLE);
  const drives = await driveTimesBeforeLock(db, maps, {
    tenantId: parsed.tenantId,
    resourceId: chosen.resourceId,
    date: day,
    job: coords,
  });

  return db.transaction(async (tx) => {
    if (requesterKey) await lockRequester(tx, parsed.tenantId, requesterKey);
    await lockResource(tx, parsed.tenantId, chosen.resourceId);

    // A double click: both requests chose this crew, and this one waited on
    // the lock while the first wrote its visit.
    const doubled = await recentRepeat(tx, ask);
    if (doubled) return receiptFor(doubled);

    if (requesterKey && policy.maxOpenRequestsPerRequester != null) {
      const open = await openRequestsFrom(tx, parsed.tenantId, requesterKey, now);
      if (open >= policy.maxOpenRequestsPerRequester) {
        throw new BookingNotBookableError(
          "You already have requests waiting for us to confirm. We'll be in touch about those first.",
          "too_many_requests",
        );
      }
    }

    // Ask the offer again, under the lock: this start must still be on it, on
    // this crew. A time somebody took a moment ago, or one another crew's new
    // visit now gives to that crew instead, is not.
    const still = (await publicOffer(tx, query)).find((s) => s.startTime === slot.startTime);
    if (!still || still.resourceId !== chosen.resourceId) {
      throw new BookingNotBookableError(SLOT_UNAVAILABLE);
    }
    // And the guard every staff booking passes — with the visitor's real
    // coordinates, the drive in and out — so the two paths can never disagree
    // about what a double booking is.
    const check = await validateBookingSlot(
      tx,
      {
        tenantId: parsed.tenantId,
        resourceId: chosen.resourceId,
        date: day,
        startTime: slot.startTime,
        endTime,
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
      },
      drives,
    );
    if (!check.valid) throw new BookingNotBookableError(SLOT_UNAVAILABLE);

    const [row] = (await tx
      .insert(schedulingBookings)
      .values({
        tenantId: parsed.tenantId,
        resourceId: chosen.resourceId,
        serviceType: parsed.serviceType,
        customerName: parsed.customerName,
        customerEmail: parsed.customerEmail,
        customerPhone: parsed.customerPhone ?? null,
        address: parsed.address ?? null,
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
        scheduledDate: day,
        startTime: slot.startTime,
        endTime,
        durationMinutes: parsed.durationMinutes,
        status: policy.requestStatus,
        estimateId: parsed.estimateId ?? null,
        notes: parsed.notes ?? null,
        requesterKey,
      })
      .returning()) as BookingRow[];
    return receiptFor(row as BookingRow);
  });
}

// --- Staff bookings ----------------------------------------------------------

export const createBookingSchema = z.object({
  tenantId: z.string().min(1),
  resourceId: z.string().nullish(),
  serviceType: z.string().max(60).default("visit"),
  title: z.string().max(200).nullish(),
  customerName: z.string().max(200).nullish(),
  // An address, not just a string: a booking nobody can write back to is a
  // booking nobody can confirm. Omit it (or null) when there isn't one.
  customerEmail: z.string().trim().email().max(320).nullish(),
  customerPhone: z.string().max(60).nullish(),
  address: z.string().max(500).nullish(),
  lat: z.number().nullish(),
  lng: z.number().nullish(),
  /** The visit's day. Stored as that UTC day's midnight, whatever time of day it carries. */
  scheduledDate: z.coerce.date(),
  startTime: timeOfDaySchema,
  endTime: endTimeSchema,
  durationMinutes: z.number().int().min(1).max(1440).default(120),
  estimateId: z.string().nullish(),
  notes: z.string().max(2000).nullish(),
  // Staff bookings land confirmed; a public request goes through
  // `requestPublicBooking`, which lands pending.
  status: z.enum(["pending", "confirmed"]).default("confirmed"),
});
export type CreateBookingInput = z.input<typeof createBookingSchema>;

export interface CreateBookingOptions {
  /** Maps provider for the drive-buffer check; defaults to keyless Haversine. */
  maps?: MapsProvider;
  /**
   * Skip the availability/overlap/drive/cap validation. For trusted callers
   * only — a seed, a migration, or a staff override that has already been
   * checked. Defaults to false: an assigned booking is validated before it is
   * written, so an out-of-hours or double-booked slot cannot be inserted on the
   * direct path the way it could when this function was a bare insert.
   */
  skipValidation?: boolean;
}

/**
 * A STAFF booking: staff choose the times (the office booking a customer on
 * the phone), and the slot is still validated — hours, overlap, drive buffer,
 * the crew's daily cap, a removed crew — inside one transaction under the
 * crew's lock, the same lock the public request takes, so a staff booking and
 * a web request for the same 10:00 can't both land. Notice and horizon are
 * public rules and don't apply here. `durationMinutes` is stored as end −
 * start whenever the times describe a real window, so the two can't disagree,
 * and `scheduledDate` as its UTC day's midnight.
 *
 * Throws `BookingNotBookableError` with a staff code (see
 * `BookingRefusalCode`) and a zod error for malformed input.
 *
 * Never expose this to an anonymous caller; that is `requestPublicBooking`.
 */
export async function createBooking(
  db: SchedulingDb,
  input: CreateBookingInput,
  options: CreateBookingOptions = {},
): Promise<BookingRow> {
  const parsed = createBookingSchema.parse(input);
  const span = timeToMinutes(parsed.endTime) - timeToMinutes(parsed.startTime);
  const values = {
    ...parsed,
    scheduledDate: startOfUtcDay(parsed.scheduledDate),
    durationMinutes: span > 0 ? span : parsed.durationMinutes,
  };
  const insert = async (handle: SchedulingDb): Promise<BookingRow> => {
    const [row] = await handle.insert(schedulingBookings).values(values).returning();
    return row as BookingRow;
  };
  // Only an ASSIGNED booking can be validated — an unassigned request has no
  // resource whose availability to check.
  const resourceId = values.resourceId;
  if (!resourceId || options.skipValidation) return insert(db);

  const job = values.lat != null && values.lng != null ? { lat: values.lat, lng: values.lng } : null;
  const drives = await driveTimesBeforeLock(db, options.maps ?? createHaversineMapsProvider(), {
    tenantId: values.tenantId,
    resourceId,
    date: values.scheduledDate,
    job,
  });

  return db.transaction(async (tx) => {
    await lockResource(tx, values.tenantId, resourceId);
    const check = await validateBookingSlot(
      tx,
      {
        tenantId: values.tenantId,
        resourceId,
        date: values.scheduledDate,
        startTime: values.startTime,
        endTime: values.endTime,
        lat: values.lat ?? null,
        lng: values.lng ?? null,
      },
      drives,
    );
    if (!check.valid) {
      throw new BookingNotBookableError(check.reason ?? "This slot is not bookable", check.code);
    }
    return insert(tx);
  });
}

export async function listBookings(
  db: SchedulingDb,
  tenantId: string,
  range: { from: Date; to: Date },
): Promise<BookingRow[]> {
  return (await db
    .select()
    .from(schedulingBookings)
    .where(
      and(
        eq(schedulingBookings.tenantId, tenantId),
        gte(schedulingBookings.scheduledDate, range.from),
        lte(schedulingBookings.scheduledDate, range.to),
      ),
    )
    .orderBy(asc(schedulingBookings.scheduledDate), asc(schedulingBookings.startTime))) as BookingRow[];
}

/** One of this tenant's visits; null when the id is not theirs. */
export async function getBooking(db: SchedulingDb, tenantId: string, id: string): Promise<BookingRow | null> {
  const [row] = (await db
    .select()
    .from(schedulingBookings)
    .where(and(eq(schedulingBookings.id, id), eq(schedulingBookings.tenantId, tenantId)))
    .limit(1)) as BookingRow[];
  return row ?? null;
}

export const setBookingStatusSchema = z.object({
  id: z.string().min(1),
  status: z.enum(BOOKING_STATUSES),
});
export type SetBookingStatusInput = z.input<typeof setBookingStatusSchema>;

export interface SetBookingStatusOptions {
  /** Maps provider for the drive-buffer re-check on un-cancel; defaults to Haversine. */
  maps?: MapsProvider;
}

/**
 * Move one of this tenant's visits along BOOKING_STATUS_TRANSITIONS.
 *
 * False when the visit is not this tenant's. Re-asserting the current status is
 * a no-op that returns true. `BookingStatusTransitionError` for a move the
 * table forbids. A move that brings a visit back from `cancelled` or `no_show`
 * re-claims its slot, so the slot is re-validated (hours, overlap, drive
 * buffer, daily cap, a removed crew) first — somebody may have booked it since
 * — and a refusal throws `BookingNotBookableError` with the reason and a staff
 * code. The check and the write share one transaction under the crew's lock,
 * the lock every booking path takes; drive times are looked up before it.
 */
export async function setBookingStatus(
  db: SchedulingDb,
  tenantId: string,
  input: SetBookingStatusInput,
  options: SetBookingStatusOptions = {},
): Promise<boolean> {
  const parsed = setBookingStatusSchema.parse(input);
  const found = await getBooking(db, tenantId, parsed.id);
  if (!found) return false;

  const reviving = found.resourceId !== null && isRevivingMove(found.status, parsed.status);
  const drives =
    reviving && found.resourceId
      ? await driveTimesBeforeLock(db, options.maps ?? createHaversineMapsProvider(), {
          tenantId,
          resourceId: found.resourceId,
          date: found.scheduledDate,
          job: found.lat != null && found.lng != null ? { lat: found.lat, lng: found.lng } : null,
          excludeBookingId: found.id,
        })
      : createHaversineMapsProvider();

  return db.transaction(async (tx) => {
    if (found.resourceId) await lockResource(tx, tenantId, found.resourceId);
    // Re-read under the lock: the status we judge is the one we overwrite.
    const current = await getBooking(tx, tenantId, parsed.id);
    if (!current) return false;
    if (current.status === parsed.status) return true;
    if (!canTransitionBooking(current.status, parsed.status)) {
      throw new BookingStatusTransitionError(current.status, parsed.status);
    }
    if (current.resourceId && isRevivingMove(current.status, parsed.status)) {
      const check = await validateBookingSlot(
        tx,
        {
          tenantId,
          resourceId: current.resourceId,
          date: current.scheduledDate,
          startTime: current.startTime,
          endTime: current.endTime,
          lat: current.lat,
          lng: current.lng,
          excludeBookingId: current.id,
        },
        drives,
      );
      if (!check.valid) {
        throw new BookingNotBookableError(
          `Can't restore this visit: ${check.reason ?? "its slot is no longer free"}.`,
          check.code,
        );
      }
    }
    await tx
      .update(schedulingBookings)
      .set({ status: parsed.status, updatedAt: new Date() })
      .where(and(eq(schedulingBookings.id, current.id), eq(schedulingBookings.tenantId, tenantId)));
    return true;
  });
}

// --- Validate a booking (hours, cap, overlap, travel buffer) -----------------

export interface ValidateBookingInput {
  tenantId: string;
  resourceId: string;
  date: Date;
  startTime: string;
  endTime: string;
  lat?: number | null;
  lng?: number | null;
  /** A visit to leave out of the overlap and cap checks — the one being re-validated. */
  excludeBookingId?: string | null;
}

export interface ValidateBookingResult {
  valid: boolean;
  reason?: string;
  /** Set when `valid` is false: which kind of refusal (see `BookingRefusalCode`). */
  code?: StaffRefusalCode;
  warnings: string[];
}

/**
 * Refuse a booking outside the resource's hours, on a removed resource, past
 * its daily cap, that overlaps an existing one, or that leaves too little time
 * to drive between jobs; warn when the buffer is tight. Mirrors SG Glass's
 * guard, generalized and with the maps provider injected. Read-only: to make
 * the answer hold until the write, call it inside the writer's transaction
 * under the resource lock, as `createBooking`, `requestPublicBooking` and
 * `setBookingStatus` do — with drive times looked up before the lock, since
 * this calls `maps.driveTime` once per neighbouring visit.
 *
 * The reasons name times on the crew's calendar — fine for staff, which is who
 * this is for. The public request maps every refusal to one generic message.
 */
export async function validateBookingSlot(
  db: SchedulingDb,
  input: ValidateBookingInput,
  maps: MapsProvider = createHaversineMapsProvider(),
): Promise<ValidateBookingResult> {
  const warnings: string[] = [];
  const startMinutes = timeToMinutes(input.startTime);
  const endMinutes = timeToMinutes(input.endTime);

  if (endMinutes <= startMinutes) {
    return {
      valid: false,
      code: "invalid_window",
      reason: `The visit must end after it starts (${input.startTime}–${input.endTime})`,
      warnings,
    };
  }

  // AVAILABILITY FIRST. A slot outside the resource's working window — 3am, a
  // day off, a resource with no hours that day — is not bookable no matter what
  // else is free. `findAvailableSlots` never OFFERS such a slot, but this
  // function is the guard on the DIRECT path (a staff booking, an un-cancel)
  // where the times are caller-supplied and must be checked. Dropping this
  // guard is how an out-of-hours booking gets written.
  const resource = await getResourceRow(db, input.tenantId, input.resourceId);
  if (!resource) {
    return { valid: false, code: "resource_unavailable", reason: "Resource not found", warnings };
  }
  // A removed crew is off the schedule for staff too, not only for the
  // finders; otherwise its visits sit on a crew no list shows.
  if (!resource.isActive) {
    return { valid: false, code: "resource_unavailable", reason: "Resource is not active", warnings };
  }
  const availability = await listAvailability(db, input.tenantId, input.resourceId);
  const window = resolveDayWindow(availability, resource, input.date);
  if (!window) {
    return { valid: false, code: "outside_hours", reason: "Resource is not available on this day", warnings };
  }
  // In minutes, never as text: text is chronological only for well-formed
  // times, and this function is exported to hosts with their own inputs.
  if (startMinutes < timeToMinutes(window.start) || endMinutes > timeToMinutes(window.end)) {
    return {
      valid: false,
      code: "outside_hours",
      reason: `Time slot ${input.startTime}–${input.endTime} is outside availability (${window.start}–${window.end})`,
      warnings,
    };
  }

  const active = await activeBookingsOn(db, input.tenantId, input.resourceId, input.date, input.excludeBookingId);

  // The crew's own cap. The finder stopped offering a full day; until 0.3 the
  // direct path never asked, so one request could be the seventh visit of six.
  if (active.length >= resource.maxJobsPerDay) {
    return {
      valid: false,
      code: "slot_unavailable",
      reason: `Fully booked that day (${resource.maxJobsPerDay} visits)`,
      warnings,
    };
  }

  for (const b of active) {
    if (windowsOverlap(input.startTime, input.endTime, b.startTime, b.endTime)) {
      return { valid: false, code: "slot_unavailable", reason: `Overlaps ${b.startTime}–${b.endTime}`, warnings };
    }
  }

  const job = input.lat != null && input.lng != null ? { lat: input.lat, lng: input.lng } : null;
  if (job) {
    for (const b of active) {
      if (b.lat == null || b.lng == null) continue;
      const other = { lat: b.lat, lng: b.lng };
      // Existing job ends before the new one starts: is there time to drive FROM
      // it (other -> job) into the new slot?
      if (timeToMinutes(b.endTime) <= startMinutes) {
        const dt = await maps.driveTime(other, job);
        if (!dt) continue;
        const buffer = startMinutes - timeToMinutes(b.endTime);
        if (dt.durationMinutes > buffer) {
          return {
            valid: false,
            code: "slot_unavailable",
            reason: `Not enough time to drive from the ${b.startTime} job (${dt.durationMinutes} min drive, ${buffer} min gap)`,
            warnings,
          };
        }
        if (dt.durationMinutes > buffer - 15) {
          warnings.push(`Tight schedule: ${dt.durationMinutes} min drive into a ${buffer} min gap`);
        }
      } else if (timeToMinutes(b.startTime) >= endMinutes) {
        // Existing job starts after the new one ends: is there time to drive TO
        // it (job -> other)? The direction is reversed, and with an asymmetric
        // provider (real traffic, one-way streets) that is a different number —
        // reusing the other-> job drive here silently checked the wrong trip.
        const dt = await maps.driveTime(job, other);
        if (!dt) continue;
        const buffer = timeToMinutes(b.startTime) - endMinutes;
        if (dt.durationMinutes > buffer) {
          return {
            valid: false,
            code: "slot_unavailable",
            reason: `Not enough time to drive to the ${b.startTime} job afterward`,
            warnings,
          };
        }
      }
    }
  }

  return { valid: true, warnings };
}
