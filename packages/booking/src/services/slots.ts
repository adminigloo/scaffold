/**
 * Availability against the database: load what the engine needs, run it, and
 * re-check one exact start under the host lock.
 *
 * ONE COMPUTATION, TWO CALLERS. The slot list a prospect sees and the check a
 * hold or booking runs at write time both go through `hostSlots` — so a time
 * that was offered and a time that can be taken can never be decided by two
 * different pieces of code. (Squire's booking path re-ran its own variant and
 * a reschedule tested the new time against the booking being moved: "the
 * reschedule blocks itself". Here the moving booking's id is excluded.)
 *
 * External busy is fetched BEFORE any transaction opens: it is a network call
 * of up to five seconds, our advisory lock cannot make Google's answer any
 * fresher, and holding a lock across it would serialise every prospect behind
 * the slowest calendar fetch.
 */

import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { BookingError } from "../errors.js";
import {
  generateSlots,
  pickHost,
  windowsByDateFor,
  type BusyInterval,
  type DateException,
  type Interval,
  type Slot,
  type WeeklyWindow,
} from "../engine.js";
import {
  bookingAvailability,
  bookingBlackouts,
  bookingBookings,
  bookingEvents,
  bookingExceptions,
  bookingHosts,
  bookingTypes,
} from "../schema.js";
import { addDays, dateIn, eachDate } from "../zone.js";
import { isLive, nowOf, type BookingContext, type BookingDb, type BookingRow, type HostRow, type TypeRow } from "./context.js";

const DAY_MS = 86_400_000;

/** The type's host pool: active hosts of this tenant, narrowed to `type.hostIds` when it names any. Sorted by id. */
export async function poolHosts(db: BookingDb, tenantId: string, type: Pick<TypeRow, "hostIds">): Promise<HostRow[]> {
  const rows: HostRow[] = await db
    .select()
    .from(bookingHosts)
    .where(and(eq(bookingHosts.tenantId, tenantId), eq(bookingHosts.isActive, true)))
    .orderBy(asc(bookingHosts.id));
  const wanted = type.hostIds ?? [];
  return wanted.length === 0 ? rows : rows.filter((host) => wanted.includes(host.id));
}

/** An ACTIVE type by key, or the one not-found. */
export async function activeTypeByKey(db: BookingDb, tenantId: string, key: string): Promise<TypeRow> {
  const rows: TypeRow[] = await db
    .select()
    .from(bookingTypes)
    .where(and(eq(bookingTypes.tenantId, tenantId), eq(bookingTypes.key, key), eq(bookingTypes.isActive, true)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new BookingError("not_found");
  return row;
}

export interface ExternalBusy {
  byHost: Map<string, Interval[]>;
  /** 'off': no source, or no host in the pool has a calendar address. */
  status: "ok" | "degraded" | "off";
}

/**
 * External busy for each host with a calendar address, never throwing. A
 * failure degrades THAT host to internal-only for this request and records
 * the error on the host row so the admin sees "Calendar sync failing since …".
 * The row is written only when the sync state CHANGES.
 */
export async function fetchExternalBusy(
  ctx: BookingContext,
  hosts: readonly HostRow[],
  from: Date,
  to: Date,
): Promise<ExternalBusy> {
  const byHost = new Map<string, Interval[]>();
  const source = ctx.busySource;
  const withCalendar = hosts.filter((host) => host.busyIcsUrl);
  if (!source || withCalendar.length === 0) return { byHost, status: "off" };
  let degraded = false;
  const now = nowOf(ctx);
  await Promise.all(
    withCalendar.map(async (host) => {
      try {
        const busy = await source.busy({
          host: { id: host.id, timezone: host.timezone, busyIcsUrl: host.busyIcsUrl },
          from,
          to,
        });
        byHost.set(host.id, busy.map((interval) => ({ start: interval.start, end: interval.end })));
        await recordSyncOk(ctx.db, host, now);
      } catch (error) {
        degraded = true;
        await recordSyncError(ctx.db, host, error, now);
      }
    }),
  );
  return { byHost, status: degraded ? "degraded" : "ok" };
}

function syncMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 300) || "calendar sync failed";
}

export async function recordSyncError(db: BookingDb, host: HostRow, error: unknown, now: Date): Promise<void> {
  const message = syncMessage(error);
  if (host.busySyncError === message && host.busySyncFailingSince) return;
  try {
    await db
      .update(bookingHosts)
      .set({ busySyncError: message, busySyncFailingSince: host.busySyncFailingSince ?? now })
      .where(and(eq(bookingHosts.tenantId, host.tenantId), eq(bookingHosts.id, host.id)));
  } catch {
    // Recording the failure is best-effort; the prospect's slot list is not.
  }
}

export async function recordSyncOk(
  db: BookingDb,
  host: HostRow,
  now: Date,
  options: { force?: boolean } = {},
): Promise<void> {
  // "Last synced" is refreshed at most hourly from slot reads — enough for an
  // admin to trust it, without a write on every page view.
  const stale = !host.busySyncOkAt || now.getTime() - host.busySyncOkAt.getTime() > 60 * 60 * 1000;
  if (!options.force && !host.busySyncError && !stale) return;
  try {
    await db
      .update(bookingHosts)
      .set({ busySyncError: null, busySyncFailingSince: null, busySyncOkAt: now })
      .where(and(eq(bookingHosts.tenantId, host.tenantId), eq(bookingHosts.id, host.id)));
  } catch {
    // Best-effort, as above.
  }
}

interface SchedulingData {
  weeklyByHost: Map<string, WeeklyWindow[]>;
  exceptionsByHost: Map<string, DateException[]>;
  blackouts: string[];
  /** Live bookings of the pool, minus the excluded ids. */
  live: BookingRow[];
  typesById: Map<string, TypeRow>;
}

/**
 * Everything the engine needs for these hosts across [from, to), in five
 * queries regardless of how many days or hosts. Dates are widened by a day
 * each side because host zones can sit fourteen hours either side of UTC.
 */
export async function loadSchedulingData(
  db: BookingDb,
  tenantId: string,
  hostIds: readonly string[],
  from: Date,
  to: Date,
  now: Date,
  excludeIds: readonly string[] = [],
): Promise<SchedulingData> {
  const weeklyByHost = new Map<string, WeeklyWindow[]>();
  const exceptionsByHost = new Map<string, DateException[]>();
  if (hostIds.length === 0) {
    return { weeklyByHost, exceptionsByHost, blackouts: [], live: [], typesById: new Map() };
  }
  const fromDate = addDays(from.toISOString().slice(0, 10), -1);
  const toDate = addDays(to.toISOString().slice(0, 10), 1);
  const ids = [...hostIds];

  const [weekly, exceptions, blackouts, bookings, types] = await Promise.all([
    db
      .select()
      .from(bookingAvailability)
      .where(and(eq(bookingAvailability.tenantId, tenantId), inArray(bookingAvailability.hostId, ids))),
    db
      .select()
      .from(bookingExceptions)
      .where(
        and(
          eq(bookingExceptions.tenantId, tenantId),
          inArray(bookingExceptions.hostId, ids),
          gte(bookingExceptions.date, fromDate),
          lte(bookingExceptions.date, toDate),
        ),
      ),
    db
      .select({ date: bookingBlackouts.date })
      .from(bookingBlackouts)
      .where(
        and(eq(bookingBlackouts.tenantId, tenantId), gte(bookingBlackouts.date, fromDate), lte(bookingBlackouts.date, toDate)),
      ),
    db
      .select()
      .from(bookingBookings)
      .where(
        and(
          eq(bookingBookings.tenantId, tenantId),
          inArray(bookingBookings.hostId, ids),
          // A margin either side for buffers (capped at four hours each by the type schema).
          lt(bookingBookings.startUtc, new Date(to.getTime() + DAY_MS)),
          gt(bookingBookings.endUtc, new Date(from.getTime() - DAY_MS)),
          or(
            inArray(bookingBookings.status, ["confirmed", "requested"]),
            and(eq(bookingBookings.status, "hold"), gt(bookingBookings.holdExpiresAt, now)),
          ),
        ),
      ),
    db.select().from(bookingTypes).where(eq(bookingTypes.tenantId, tenantId)),
  ]);

  for (const row of weekly as Array<typeof bookingAvailability.$inferSelect>) {
    const list = weeklyByHost.get(row.hostId) ?? [];
    list.push({ dayOfWeek: row.dayOfWeek, startMinute: row.startMinute, endMinute: row.endMinute });
    weeklyByHost.set(row.hostId, list);
  }
  for (const row of exceptions as Array<typeof bookingExceptions.$inferSelect>) {
    const list = exceptionsByHost.get(row.hostId) ?? [];
    list.push({ date: row.date, kind: row.kind, startMinute: row.startMinute, endMinute: row.endMinute });
    exceptionsByHost.set(row.hostId, list);
  }
  const excluded = new Set(excludeIds);
  return {
    weeklyByHost,
    exceptionsByHost,
    blackouts: (blackouts as Array<{ date: string }>).map((row) => row.date),
    live: (bookings as BookingRow[]).filter((row) => !excluded.has(row.id) && isLive(row, now)),
    typesById: new Map((types as TypeRow[]).map((type) => [type.id, type])),
  };
}

/**
 * One host's offered starts for a type across [from, to). `engineNow` is the
 * clock notice and horizon are measured from — normally now; when a live hold
 * is being converted, the moment the hold was taken, so a prospect who held a
 * slot right at the notice boundary is not refused it ten minutes later.
 */
export function hostSlots(input: {
  host: HostRow;
  type: TypeRow;
  data: SchedulingData;
  external: readonly Interval[];
  from: Date;
  to: Date;
  engineNow: Date;
}): Slot[] {
  const { host, type, data } = input;
  const zone = host.timezone;
  const dates = eachDate(dateIn(input.from, zone), dateIn(new Date(input.to.getTime() - 1), zone));
  const windowsByDate = windowsByDateFor(
    dates,
    data.weeklyByHost.get(host.id) ?? [],
    data.exceptionsByHost.get(host.id) ?? [],
    data.blackouts,
  );
  // External events ask for no clear time of their own; the candidate's
  // buffers still apply against them inside the engine.
  const busy: BusyInterval[] = [...input.external];
  const bookedCountByDate = new Map<string, number>();
  for (const row of data.live) {
    if (row.hostId !== host.id) continue;
    // Each occupant carries ITS OWN type's buffers, unpadded, so the engine
    // can apply the larger-of-the-two rule at every gap (Squire's D17).
    const ownType = data.typesById.get(row.typeId);
    busy.push({
      start: row.startUtc,
      end: row.endUtc,
      bufferBeforeMinutes: ownType?.bufferBeforeMinutes ?? 0,
      bufferAfterMinutes: ownType?.bufferAfterMinutes ?? 0,
    });
    if (row.typeId === type.id) {
      const date = dateIn(row.startUtc, zone);
      bookedCountByDate.set(date, (bookedCountByDate.get(date) ?? 0) + 1);
    }
  }
  return generateSlots({
    host: { id: host.id, timezone: zone },
    type,
    windowsByDate,
    busy,
    bookedCountByDate,
    now: input.engineNow,
    from: input.from,
    to: input.to,
  });
}

/**
 * The hosts free at exactly `start` — the write-time re-check. Runs the same
 * engine over that one day, so "offered" and "bookable" cannot drift apart.
 */
export async function freeHostsAt(input: {
  db: BookingDb;
  tenantId: string;
  type: TypeRow;
  hosts: readonly HostRow[];
  start: Date;
  external: ExternalBusy;
  now: Date;
  engineNow?: Date;
  excludeIds?: readonly string[];
}): Promise<HostRow[]> {
  const from = new Date(input.start.getTime() - DAY_MS);
  const to = new Date(input.start.getTime() + DAY_MS);
  const data = await loadSchedulingData(
    input.db,
    input.tenantId,
    input.hosts.map((host) => host.id),
    from,
    to,
    input.now,
    input.excludeIds,
  );
  return input.hosts.filter((host) =>
    hostSlots({
      host,
      type: input.type,
      data,
      external: input.external.byHost.get(host.id) ?? [],
      from: input.start,
      to: new Date(input.start.getTime() + 60_000),
      engineNow: input.engineNow ?? input.now,
    }).some((slot) => slot.start.getTime() === input.start.getTime()),
  );
}

/**
 * Serialise every write that could claim time on these hosts. One
 * transaction-scoped advisory lock per host — `hashtext('booking:' || tenant
 * || ':' || host)` — taken in sorted order so two transactions that need the
 * same pair of hosts can never deadlock. Locking the whole pool rather than
 * only the eventually-chosen host lets the re-check and the assignment run
 * under one consistent view; pools are a handful of people, so the extra
 * serialisation is free.
 */
export async function lockHosts(db: BookingDb, tenantId: string, hostIds: readonly string[]): Promise<void> {
  for (const hostId of [...new Set(hostIds)].sort()) {
    await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`booking:${tenantId}:${hostId}`}))`);
  }
}

/** Fewest live bookings in the next seven days wins; ties to the lowest id. */
export async function assignHost(
  db: BookingDb,
  tenantId: string,
  candidates: readonly HostRow[],
  now: Date,
): Promise<HostRow | null> {
  if (candidates.length <= 1) return candidates[0] ?? null;
  const rows: Array<Pick<BookingRow, "hostId" | "status" | "holdExpiresAt">> = await db
    .select({ hostId: bookingBookings.hostId, status: bookingBookings.status, holdExpiresAt: bookingBookings.holdExpiresAt })
    .from(bookingBookings)
    .where(
      and(
        eq(bookingBookings.tenantId, tenantId),
        inArray(
          bookingBookings.hostId,
          candidates.map((host) => host.id),
        ),
        gte(bookingBookings.startUtc, now),
        lt(bookingBookings.startUtc, new Date(now.getTime() + 7 * DAY_MS)),
        inArray(bookingBookings.status, ["confirmed", "requested", "hold"]),
      ),
    );
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!isLive(row, now)) continue;
    counts.set(row.hostId, (counts.get(row.hostId) ?? 0) + 1);
  }
  const chosen = pickHost(candidates.map((host) => ({ hostId: host.id, upcoming: counts.get(host.id) ?? 0 })));
  return candidates.find((host) => host.id === chosen) ?? null;
}

/**
 * Did this hold token already become a booking that still stands, at or
 * after `since`? A booked row keeps its hold's token hash (only rows whose
 * status is 'hold' are ever released, purged or converted by it), and the
 * 'booked' audit row dates the conversion, so a second submit of the same
 * form is recognised for what it is instead of being read as a lapsed hold
 * whose time somebody else took. Tenant-scoped.
 */
export async function bookedFromHoldSince(
  db: BookingDb,
  tenantId: string,
  holdTokenHash: string,
  since: Date,
): Promise<boolean> {
  const booked: Array<{ id: string }> = await db
    .select({ id: bookingBookings.id })
    .from(bookingBookings)
    .where(
      and(
        eq(bookingBookings.tenantId, tenantId),
        eq(bookingBookings.holdTokenHash, holdTokenHash),
        isNotNull(bookingBookings.manageTokenHash),
        inArray(bookingBookings.status, ["confirmed", "requested"]),
      ),
    )
    .limit(5);
  if (booked.length === 0) return false;
  const events: Array<{ at: Date }> = await db
    .select({ at: bookingEvents.at })
    .from(bookingEvents)
    .where(
      and(
        eq(bookingEvents.tenantId, tenantId),
        inArray(
          bookingEvents.bookingId,
          booked.map((row) => row.id),
        ),
        eq(bookingEvents.kind, "booked"),
        gte(bookingEvents.at, since),
      ),
    )
    .limit(1);
  return events.length > 0;
}

/**
 * A deleted hold takes its audit rows with it. Without this, every released,
 * replaced or converted hold left a "held" event pointing at a booking id that
 * no longer exists — history for a row nobody can open.
 */
export async function deleteEventsFor(db: BookingDb, tenantId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(bookingEvents).where(and(eq(bookingEvents.tenantId, tenantId), inArray(bookingEvents.bookingId, [...ids])));
}

/**
 * Live holds a requester already has, by the SHA-256 of their hold subject
 * (see holdSlot). Run under the host lock, after any hold being replaced was
 * released, so the replaced hold is not counted against them.
 */
export async function liveHoldsOfSubject(db: BookingDb, tenantId: string, subjectHash: string, now: Date): Promise<number> {
  const rows: Array<{ n: number }> = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(bookingBookings)
    .where(
      and(
        eq(bookingBookings.tenantId, tenantId),
        eq(bookingBookings.holdSubjectHash, subjectHash),
        eq(bookingBookings.status, "hold"),
        gt(bookingBookings.holdExpiresAt, now),
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

/** A hold row by its token, live or not (callers decide). Tenant-scoped. */
export async function holdByTokenHash(db: BookingDb, tenantId: string, holdTokenHash: string): Promise<BookingRow | null> {
  const rows: BookingRow[] = await db
    .select()
    .from(bookingBookings)
    .where(
      and(
        eq(bookingBookings.tenantId, tenantId),
        eq(bookingBookings.holdTokenHash, holdTokenHash),
        eq(bookingBookings.status, "hold"),
        isNull(bookingBookings.manageTokenHash),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
