import { and, eq, gt, gte, inArray, isNull, lt, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { DAY_MS, labelOf } from "./instants.js";
import { createHaversineMapsProvider, type DriveTime, type LatLng, type MapsProvider } from "./maps.js";
import { schedulingAvailability, schedulingBookings, schedulingResources, schedulingSettings } from "./schema.js";
import { INACTIVE_BOOKING_STATUSES } from "./status.js";
import { BookingNotBookableError, type AvailabilityRow, type BookingRow, type ResourceRow, type SchedulingDb } from "./types.js";
import { isValidTimeZone } from "./zone.js";

/**
 * Helpers every module shares and nothing outside the package may call: the
 * locks, the row reads, the "which visits hold time" queries and the drive
 * lookups done before a lock. Not exported from the barrel.
 */

// --- Locks -----------------------------------------------------------------

/** The advisory-lock key of one crew. The lock tests read it from the query log. */
export function resourceLockKey(tenantId: string, resourceId: string): string {
  return `scheduling:${tenantId}:${resourceId}`;
}

/**
 * Serialise every write that can put a visit on one resource's calendar —
 * public request, staff booking, a move, un-cancel, an hours change — behind
 * a transaction-scoped advisory lock on (tenant, resource). Validate-then-
 * insert without it is a race: two requests for the same 10:00 both read an
 * empty slot, both pass, both insert. Under the lock the second one re-reads
 * after the first commits and sees the visit. The same shape as
 * @adminigloo/booking's `lockHosts`, and only meaningful inside a transaction
 * (outside one it is released the moment the statement ends).
 *
 * NOTHING SLOW HAPPENS UNDER IT. Geocoding and drive times are looked up before
 * a writer takes it (see `driveTimesBeforeLock`); while it is held, a writer
 * only reads and writes this database on its own transaction.
 */
export async function lockResource(tx: SchedulingDb, tenantId: string, resourceId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${resourceLockKey(tenantId, resourceId)}))`);
}

/**
 * Lock several crews (a move from one crew to another) in SORTED key order, so
 * two moves in opposite directions can't each hold the lock the other waits
 * for.
 */
export async function lockResources(
  tx: SchedulingDb,
  tenantId: string,
  resourceIds: ReadonlyArray<string | null | undefined>,
): Promise<void> {
  const keys = [...new Set(resourceIds.filter((id): id is string => !!id))]
    .map((id) => ({ id, key: resourceLockKey(tenantId, id) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const { id } of keys) await lockResource(tx, tenantId, id);
}

/** The advisory-lock key of a tenant's settings: `updateSchedulingSettings` takes it exclusively. */
export function settingsLockKey(tenantId: string): string {
  return `scheduling-settings:${tenantId}`;
}

/**
 * The time-zone fence every writer that turns a wall clock into instants
 * takes, FIRST on its transaction: the tenant's settings lock, SHARED.
 *
 * WHY. A writer reads the settings once per request and computes `starts_at`
 * from that zone before its transaction. A zone change committed in between
 * rewrites every visit that exists when it runs, under the settings lock
 * taken exclusively — but not a visit inserted a moment later from the old
 * zone, which would keep the old zone's instants for good: its notice, cutoff,
 * reminder and expiry all off by the offset. Shared, so writers never wait on
 * each other; exclusive against a settings save, so a save and a write run one
 * after the other. Taken before any crew lock (the order is settings, then
 * requester, then crews), and `assertZone` re-reads the zone under it.
 */
export async function lockSettingsShared(tx: SchedulingDb, tenantId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext(${settingsLockKey(tenantId)}))`);
}

/**
 * Under `lockSettingsShared`: the zone the caller worked its instants out in
 * must still be the tenant's. When a save changed it between the caller's
 * settings read and its lock, the write is refused — "try again" reads the new
 * zone — rather than stored an hour off. Rare (zones are set once), so a retry
 * is the whole cost.
 */
export async function assertZone(tx: SchedulingDb, tenantId: string, zone: string): Promise<void> {
  const [row] = (await tx
    .select({ timeZone: schedulingSettings.timeZone })
    .from(schedulingSettings)
    .where(eq(schedulingSettings.tenantId, tenantId))
    .limit(1)) as Array<{ timeZone: string }>;
  const current = row && isValidTimeZone(row.timeZone) ? row.timeZone : "UTC";
  if (current !== zone) {
    throw new BookingNotBookableError(
      "The business's time zone was changed a moment ago, so that time has to be checked again. Please try again.",
      "slot_unavailable",
    );
  }
}

/**
 * Serialise one requester's public requests, so the count of requests they
 * have waiting (`maxOpenRequestsPerRequester`) is read and acted on by one
 * request at a time. Always taken BEFORE the crew lock: the one path that takes
 * both takes them in that order, so two requests can't each hold the lock the
 * other is waiting for.
 */
export async function lockRequester(tx: SchedulingDb, tenantId: string, requesterKey: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`scheduling-requester:${tenantId}:${requesterKey}`}))`,
  );
}

// --- Row reads ---------------------------------------------------------------

export async function getResourceRow(db: SchedulingDb, tenantId: string, id: string): Promise<ResourceRow | null> {
  const [row] = (await db
    .select()
    .from(schedulingResources)
    .where(and(eq(schedulingResources.id, id), eq(schedulingResources.tenantId, tenantId)))
    .limit(1)) as ResourceRow[];
  return row ?? null;
}

export async function getBookingRow(db: SchedulingDb, tenantId: string, id: string): Promise<BookingRow | null> {
  const [row] = (await db
    .select()
    .from(schedulingBookings)
    .where(and(eq(schedulingBookings.id, id), eq(schedulingBookings.tenantId, tenantId)))
    .limit(1)) as BookingRow[];
  return row ?? null;
}

// --- Which visits hold time --------------------------------------------------

/**
 * OVERDUE REQUESTS HOLD NO TIME. A pending visit whose `pending_expires_at` is
 * at or before `now` stops holding its slot at that instant, whether or not
 * the sweep (`expirePendingRequests`) has flipped it to `expired` yet — the
 * way @adminigloo/booking treats an expired hold. So correctness never waits
 * on a cron: the slot is offered again, and bookable, the moment the deadline
 * passes.
 */
export function notOverdue(now: Date): SQL {
  return or(
    ne(schedulingBookings.status, "pending"),
    isNull(schedulingBookings.pendingExpiresAt),
    gt(schedulingBookings.pendingExpiresAt, now),
  ) as SQL;
}

/** Is this row an overdue request (holding no time)? */
export function isOverdue(row: Pick<BookingRow, "status" | "pendingExpiresAt">, now: Date): boolean {
  return row.status === "pending" && row.pendingExpiresAt !== null && row.pendingExpiresAt.getTime() <= now.getTime();
}

/**
 * One calendar day's label range, [midnight, next midnight) on the UTC label
 * scale `scheduled_date` uses. Half-open so a row stamped in the last second
 * of its day (a host's own insert) is still on it.
 */
export function dayRange(date: Date): { start: Date; end: Date } {
  const start = new Date(`${labelOf(date)}T00:00:00Z`);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

export function resourceDayKey(resourceId: string, day: Date | string): string {
  return `${resourceId} ${typeof day === "string" ? day : labelOf(day)}`;
}

/** This tenant's visits on one resource's day that hold time (active, and not an overdue request). */
export async function activeBookingsOn(
  db: SchedulingDb,
  tenantId: string,
  resourceId: string,
  date: Date,
  options: { excludeBookingId?: string | null; now?: Date } = {},
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
        notOverdue(options.now ?? new Date()),
        ...(options.excludeBookingId ? [ne(schedulingBookings.id, options.excludeBookingId)] : []),
      ),
    )) as BookingRow[];
}

/**
 * Every visit holding time on these resources' calendars from `firstDay` to
 * `lastDay` (inclusive), in ONE query, keyed by `resourceDayKey`. The finders
 * used to ask once per resource per day, so one anonymous 30-day `slots` call
 * on ten crews was some 220 queries; the day loop reads this map instead.
 */
export async function activeBookingsByDay(
  db: SchedulingDb,
  tenantId: string,
  resourceIds: string[],
  firstDay: Date,
  lastDay: Date,
  options: { excludeBookingId?: string | null; now?: Date } = {},
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
        gte(schedulingBookings.scheduledDate, dayRange(firstDay).start),
        lt(schedulingBookings.scheduledDate, dayRange(lastDay).end),
        notInArray(schedulingBookings.status, [...INACTIVE_BOOKING_STATUSES]),
        notOverdue(options.now ?? new Date()),
        ...(options.excludeBookingId ? [ne(schedulingBookings.id, options.excludeBookingId)] : []),
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
export async function availabilityFor(
  db: SchedulingDb,
  tenantId: string,
  resources: ReadonlyArray<Pick<ResourceRow, "id">>,
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

const driveKey = (origin: LatLng, dest: LatLng): string => `${origin.lat},${origin.lng}>${dest.lat},${dest.lng}`;

export interface DriveLookup {
  tenantId: string;
  resourceId: string;
  date: Date;
  /** The new (or moved, or revived) visit's coordinates; null means there is nothing to look up. */
  job: LatLng | null;
  /** The visit being moved or revived, which is not its own neighbour. */
  excludeBookingId?: string | null;
  now?: Date;
}

/**
 * Every drive time a writer's `validateBookingSlot` could ask for, looked up
 * BEFORE the crew lock is taken, and a provider that answers from them without
 * calling anybody.
 *
 * WHY. A real provider's `driveTime` is an HTTP round trip, and
 * `createCachedMapsProvider` reads and writes its cache on the handle it was
 * built with. Asked from inside the writer's transaction, the first held the
 * crew's lock — and a pooled connection — through every round trip; the
 * second needed a SECOND connection while the transaction held the first. On
 * a one-connection handle that never returns, and with a pool's worth of
 * requests doing it at once, every transaction waits for a connection none of
 * them will give back.
 *
 * So the lookups happen here, outside any transaction: both directions between
 * the job and every visit with coordinates on that crew's day. Under the lock
 * the visits are read again; a visit that landed in between has no looked-up
 * time and gets the straight-line Haversine estimate rather than a network
 * call. A lookup that failed (null) stays null, which the validator reads as
 * "unknown", as it always has.
 */
export async function driveTimesBeforeLock(db: SchedulingDb, maps: MapsProvider, lookup: DriveLookup): Promise<MapsProvider> {
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
      maps
        .driveTime(origin, dest)
        .then((time) => {
          known.set(key, time);
        })
        // `driveTime` must never throw; a provider that does anyway reads as "unknown".
        .catch(() => undefined),
    );
  };
  const visits = await activeBookingsOn(db, lookup.tenantId, lookup.resourceId, lookup.date, {
    excludeBookingId: lookup.excludeBookingId ?? null,
    ...(lookup.now ? { now: lookup.now } : {}),
  });
  for (const visit of visits) {
    if (visit.lat == null || visit.lng == null) continue;
    const at = { lat: visit.lat, lng: visit.lng };
    lookUp(at, job);
    lookUp(job, at);
  }
  await Promise.all(pending);

  return {
    geocodes: false,
    ...(maps.estimates !== undefined ? { estimates: maps.estimates } : {}),
    geocode: async () => null,
    driveTime: async (origin, dest) => {
      const key = driveKey(origin, dest);
      return known.has(key) ? (known.get(key) ?? null) : estimate.driveTime(origin, dest);
    },
  };
}

/**
 * Geocode an address, telling "no such place" (null) from "couldn't ask"
 * (the provider threw). Never throws.
 */
export async function tryGeocode(
  maps: MapsProvider,
  address: string | null | undefined,
): Promise<{ coords: LatLng | null; failed: boolean }> {
  if (!address || !address.trim() || maps.geocodes === false) return { coords: null, failed: false };
  try {
    const coords = await maps.geocode(address);
    return { coords, failed: false };
  } catch {
    return { coords: null, failed: true };
  }
}
