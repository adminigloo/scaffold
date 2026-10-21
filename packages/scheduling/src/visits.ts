import { parseHistoryDate } from "./history.js";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { z } from "zod";
import { emitEvents, type EventSpec, type SchedulingActor } from "./events.js";
import { earliest, instantsOf, labelDate, labelOf, visitInstants } from "./instants.js";
import {
  assertZone,
  driveTimesBeforeLock,
  getBookingRow,
  isOverdue,
  lockResource,
  lockResources,
  lockSettingsShared,
  tryGeocode,
} from "./internal.js";
import { createHaversineMapsProvider, type LatLng } from "./maps.js";
import { minutesToTime, timeToMinutes } from "./math.js";
import { schedulingBookings, schedulingVisitTokens } from "./schema.js";
import { getSchedulingSettings, type SchedulingSettings } from "./settings.js";
import {
  canTransitionBooking,
  isActiveBookingStatus,
  isRevivingMove,
  STAFF_SETTABLE_STATUSES,
} from "./status.js";
import {
  BookingNotBookableError,
  BookingStatusTransitionError,
  endTimeSchema,
  timeOfDaySchema,
  type BookingRow,
  type SchedulingDb,
  type SchedulingWriteOptions,
} from "./types.js";
import { singleLine } from "./text.js";
import { validateBookingSlot } from "./validate.js";
import { clock12, range12 } from "./words.js";
import { isValidDateString } from "./zone.js";

/**
 * The staff side of a visit: booking one on the phone, moving it, giving it to
 * another crew, editing its details, and moving it through its lifecycle.
 * Every write that can put a visit on a crew's calendar runs in one
 * transaction under that crew's lock (both crews' for a move between them),
 * with drive times looked up before the lock; every write emits its event
 * after commit.
 */

const STAFF: SchedulingActor = { type: "staff", id: null };

const GEOCODE_WARNING = "We couldn't place that address on the map, so drive times will skip this visit.";

async function settingsFor(db: SchedulingDb, tenantId: string, options: { settings?: SchedulingSettings }) {
  return options.settings ?? (await getSchedulingSettings(db, tenantId));
}

/** The deadline a visit landing `pending` gets: `pendingExpiryHours` from now, or its start if sooner. */
function pendingDeadline(settings: SchedulingSettings, now: Date, startsAt: Date): Date | null {
  return earliest(new Date(now.getTime() + settings.pendingExpiryHours * 3_600_000), startsAt);
}

// --- Staff bookings ----------------------------------------------------------

export const createBookingSchema = z.object({
  tenantId: z.string().min(1),
  resourceId: z.string().nullish(),
  /** A service key (see the tenant's settings). Default "visit". */
  serviceType: z.string().max(60).default("visit"),
  title: z.string().max(200).nullish(),
  // One line each: these reach email subjects and the customer's emails (see text.ts).
  customerName: singleLine(200).nullish(),
  // An address, not just a string: a booking nobody can write back to is a
  // booking nobody can confirm. Omit it (or null) when there isn't one.
  customerEmail: z.string().trim().email().max(320).nullish(),
  customerPhone: singleLine(60).nullish(),
  address: singleLine(500).nullish(),
  lat: z.number().nullish(),
  lng: z.number().nullish(),
  /**
   * The visit's calendar date in the business's zone: "2026-11-02", or a Date
   * whose UTC date is the day (0.3's way). Stored as that date's UTC midnight.
   */
  scheduledDate: z.coerce.date(),
  /** Wall-clock times in the business's zone. */
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

export interface CreateBookingOptions extends SchedulingWriteOptions {
  /**
   * Skip the availability/overlap/drive/cap validation. For trusted callers
   * only — a seed, a migration, or a staff override that has already been
   * checked. Defaults to false: an assigned booking is validated before it is
   * written, so an out-of-hours or double-booked slot cannot be inserted on the
   * direct path.
   */
  skipValidation?: boolean;
  /**
   * 0.7, past records (staff and server paths only): the day this visit was
   * really booked — not in the future, not before 2000, a day in the
   * business's zone. Saved as booked that day (`entered_at`/`entered_by`
   * record that it was typed in now).
   *
   * HISTORY ONLY WHEN THE VISIT IS OVER. A visit that ended before it was
   * typed in is a record of what happened: its event carries the booked day,
   * nobody is told or alerted, and its slot isn't checked against today's
   * hours. A visit still to come is a real booking whenever it was made: its
   * slot, hours and crew are checked and the customer is told as usual — a
   * booked-on date never lets a second visit into a taken slot.
   */
  bookedAt?: Date | string;
}

/**
 * A STAFF booking: staff choose the times (the office booking a customer on
 * the phone), and the slot is still validated — hours, overlap, drive buffer,
 * the crew's daily cap, a removed crew — inside one transaction under the
 * crew's lock, the same lock the public request takes, so a staff booking and
 * a web request for the same 10:00 can't both land. Notice and horizon are
 * public rules and don't apply here, and the clock isn't checked: a past date
 * is allowed (back-filling yesterday's job).
 *
 * Before any lock, an `address` without coordinates is geocoded when the
 * provider can; if that fails the visit is saved without coordinates and a
 * warning says drive times will skip it. The instants are written from the
 * tenant's zone; a pending visit gets its deadline. `durationMinutes` is end −
 * start whenever the times describe a real window.
 *
 * Returns the visit and the warnings (a geocode that failed, a tight drive).
 * After commit: `visit.confirmed` (via staff) for a confirmed visit,
 * `visit.requested` (via staff) for a pending one.
 *
 * Throws `BookingNotBookableError` with a staff code and a zod error for
 * malformed input. Never expose this to an anonymous caller; that is
 * `requestPublicBooking`.
 */
export async function bookVisit(
  db: SchedulingDb,
  input: CreateBookingInput,
  options: CreateBookingOptions = {},
): Promise<{ visit: BookingRow; warnings: string[] }> {
  const parsed = createBookingSchema.parse(input);
  const settings = await settingsFor(db, parsed.tenantId, options);
  const enteredAt = options.now ?? new Date();
  const backdated = options.bookedAt !== undefined;
  // A day ("2025-05-02") is that day in the business's zone.
  const bookedOn = backdated ? parseHistoryDate(options.bookedAt, enteredAt, "bookedAt", null, settings.timeZone) : enteredAt;
  const maps = options.maps ?? createHaversineMapsProvider();
  const warnings: string[] = [];

  let lat = parsed.lat ?? null;
  let lng = parsed.lng ?? null;
  if ((lat == null || lng == null) && parsed.address && parsed.address.trim() && maps.geocodes !== false) {
    const { coords } = await tryGeocode(maps, parsed.address);
    if (coords) {
      lat = coords.lat;
      lng = coords.lng;
    } else {
      lat = null;
      lng = null;
      warnings.push(GEOCODE_WARNING);
    }
  }

  const date = labelOf(parsed.scheduledDate);
  const span = timeToMinutes(parsed.endTime) - timeToMinutes(parsed.startTime);
  const { startsAt, endsAt } = visitInstants(date, parsed.startTime, parsed.endTime, settings.timeZone);
  // A past record only when the visit itself is over; one still to come is
  // checked and announced like any booking, and `now` is the real clock.
  const history = backdated && endsAt.getTime() <= enteredAt.getTime();
  const now = history ? bookedOn : enteredAt;
  const values = {
    ...parsed,
    lat,
    lng,
    scheduledDate: labelDate(date),
    durationMinutes: span > 0 ? span : parsed.durationMinutes,
    startsAt,
    endsAt,
    origin: "staff",
    pendingExpiresAt: parsed.status === "pending" && !history ? pendingDeadline(settings, enteredAt, startsAt) : null,
    ...(backdated ? { createdAt: bookedOn, updatedAt: history ? bookedOn : enteredAt, enteredAt, enteredBy: options.actor?.id ?? null } : {}),
  };
  const insert = async (handle: SchedulingDb): Promise<BookingRow> => {
    const [row] = await handle.insert(schedulingBookings).values(values).returning();
    return row as BookingRow;
  };

  let visit: BookingRow;
  // Only an ASSIGNED booking can be validated — an unassigned request has no
  // resource whose availability to check.
  const resourceId = values.resourceId;
  if (!resourceId || options.skipValidation || history) {
    // Unvalidated, but still behind the time-zone fence: its instants are
    // this request's zone, which a settings save must not change under it.
    visit = await db.transaction(async (tx) => {
      await lockSettingsShared(tx, values.tenantId);
      await assertZone(tx, values.tenantId, settings.timeZone);
      return insert(tx);
    });
  } else {
    const job = lat != null && lng != null ? { lat, lng } : null;
    const drives = await driveTimesBeforeLock(db, maps, {
      tenantId: values.tenantId,
      resourceId,
      date: values.scheduledDate,
      job,
      now,
    });
    visit = await db.transaction(async (tx) => {
      await lockSettingsShared(tx, values.tenantId);
      await lockResource(tx, values.tenantId, resourceId);
      await assertZone(tx, values.tenantId, settings.timeZone);
      const check = await validateBookingSlot(
        tx,
        {
          tenantId: values.tenantId,
          resourceId,
          date: values.scheduledDate,
          startTime: values.startTime,
          endTime: values.endTime,
          lat,
          lng,
          now,
        },
        drives,
      );
      if (!check.valid) {
        throw new BookingNotBookableError(check.reason ?? "This slot is not bookable", check.code);
      }
      warnings.push(...check.warnings);
      return insert(tx);
    });
  }

  await emitEvents(
    db,
    parsed.tenantId,
    [
      {
        type: visit.status === "confirmed" ? "visit.confirmed" : "visit.requested",
        row: visit,
        actor: options.actor ?? STAFF,
        via: "staff",
        ...(history ? { notify: false, enteredLater: true } : options.notify !== undefined ? { notify: options.notify } : {}),
      },
    ],
    { settings, now, onEvent: options.onEvent, onEventError: options.onEventError },
  );
  return { visit, warnings };
}

/** A staff booking (see `bookVisit`), returning just the visit — 0.3's signature. */
export async function createBooking(
  db: SchedulingDb,
  input: CreateBookingInput,
  options: CreateBookingOptions = {},
): Promise<BookingRow> {
  return (await bookVisit(db, input, options)).visit;
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
  return getBookingRow(db, tenantId, id);
}

// --- Status ------------------------------------------------------------------

export const setBookingStatusSchema = z.object({
  id: z.string().min(1),
  /** Any status staff may set — never `expired`, which only the system writes. */
  status: z.enum(STAFF_SETTABLE_STATUSES),
  /**
   * Why, for a decline, a cancel or a no-show. Up to 500 characters. The
   * customer reads a decline's or a cancel's; a no-show's ("gate locked, nobody
   * home") is kept with the visit for the office.
   */
  reason: z.string().trim().max(500).optional(),
});
export type SetBookingStatusInput = z.input<typeof setBookingStatusSchema>;

export interface SetBookingStatusOptions extends SchedulingWriteOptions {
  /**
   * 0.7, past records (staff and server paths only): the day this really
   * happened — not in the future, not before 2000, not before the visit was
   * booked, and for started, done or no-show not before the visit starts. A
   * day in the business's zone. Its stamp (completed_at, cancelled_at…)
   * carries that day.
   *
   * HISTORY ONLY WHEN THE VISIT IS OVER: then its event carries that day,
   * nobody is told or alerted, and the slot is not re-checked. On a visit
   * still to come the move is checked and announced as usual (putting a
   * cancelled visit back on the calendar re-claims its slot either way).
   */
  occurredAt?: Date | string;
}

/** Statuses that say the visit began: a past date for them is never before it starts. */
const STARTED_STATUSES: readonly string[] = ["in_progress", "completed", "no_show"];

/** The field changes a status move makes, besides the status itself. */
function statusEffects(
  current: BookingRow,
  to: string,
  context: { now: Date; actor: SchedulingActor; reason: string | null; settings: SchedulingSettings; clock?: Date },
): Partial<BookingRow> {
  const { now } = context;
  // A request's new deadline runs from the real clock, never a past record's day.
  const clock = context.clock ?? now;
  const set: Partial<BookingRow> = { status: to, updatedAt: now };
  const restoring = isRevivingMove(current.status, to);
  if (to === "confirmed") {
    set.pendingExpiresAt = null;
  }
  if (restoring) {
    // Back on the calendar: no longer cancelled, and a new version of the visit.
    set.cancelledAt = null;
    set.cancelledBy = null;
    set.cancelReason = null;
    set.sequence = current.sequence + 1;
    if (to === "pending") {
      const { startsAt } = visitInstants(labelOf(current.scheduledDate), current.startTime, current.endTime, context.settings.timeZone);
      set.pendingExpiresAt = pendingDeadline(context.settings, clock, current.startsAt ?? startsAt);
    }
  }
  if (to === "declined" || to === "cancelled") {
    set.cancelledAt = now;
    set.cancelledBy = context.actor.type;
    set.cancelReason = context.reason;
    set.pendingExpiresAt = null;
    set.sequence = current.sequence + 1;
  }
  if (to === "no_show") {
    // What the crew wrote from the truck ("gate locked, nobody home"). Kept in
    // the "why it didn't happen" column cancellations use; cleared on restore.
    set.cancelReason = context.reason;
  }
  if (to === "in_progress") {
    if (!current.startedAt) set.startedAt = now;
    if (current.status === "completed") set.completedAt = null;
  }
  if (to === "completed") {
    set.completedAt = now;
    if (!current.startedAt) set.startedAt = now;
  }
  return set;
}

/** The event a status move emits (section 5), or null for a move nobody needs telling about. */
function statusEvent(from: string, to: string): Pick<EventSpec, "type" | "via"> | null {
  if (to === "confirmed" && from === "pending") return { type: "visit.confirmed", via: "accept" };
  if (to === "confirmed" && !isActiveBookingStatus(from)) return { type: "visit.confirmed", via: "restore" };
  if (to === "declined") return { type: "visit.declined" };
  if (to === "cancelled") return { type: "visit.cancelled" };
  if (to === "in_progress" && from === "confirmed") return { type: "visit.started" };
  if (to === "completed" && (from === "confirmed" || from === "in_progress")) return { type: "visit.completed" };
  return null;
}

/**
 * Move one of this tenant's visits along BOOKING_STATUS_TRANSITIONS.
 *
 * False when the visit is not this tenant's. Re-asserting the current status is
 * a no-op that returns true (and emits nothing). `BookingStatusTransitionError`
 * for a move the table forbids. A move that brings a visit back from an
 * inactive status — or accepts a request whose deadline has already passed,
 * which no longer held its time — re-claims its slot, so the slot is
 * re-validated (hours, overlap, drive buffer, daily cap, a removed crew) first,
 * and a refusal throws `BookingNotBookableError` with the reason and a staff
 * code. The check and the write share one transaction under the crew's lock.
 *
 * Field effects: accepting clears the deadline; a decline or cancel stamps
 * `cancelled_at`/`cancelled_by`/`cancel_reason` and bumps `sequence`; a restore
 * clears them and bumps `sequence`; starting stamps `started_at`; completing
 * stamps `completed_at` (cleared on reopen). Events after commit: see
 * section 5's table.
 */
export async function setBookingStatus(
  db: SchedulingDb,
  tenantId: string,
  input: SetBookingStatusInput,
  options: SetBookingStatusOptions = {},
): Promise<boolean> {
  const parsed = setBookingStatusSchema.parse(input);
  const found = await getBookingRow(db, tenantId, parsed.id);
  if (!found) return false;
  const settings = await settingsFor(db, tenantId, options);
  const enteredAt = options.now ?? new Date();
  const backdated = options.occurredAt !== undefined;
  const span = instantsOf(found, settings.timeZone);
  // Started, done or a no-show can't have happened before the visit began.
  const notBefore =
    STARTED_STATUSES.includes(parsed.status) && span.startsAt.getTime() > found.createdAt.getTime()
      ? { at: span.startsAt, what: "the visit starts" }
      : { at: found.createdAt, what: "the visit was booked" };
  // `stampAt`: when it happened (completed_at, cancelled_at…).
  const stampAt = backdated ? parseHistoryDate(options.occurredAt, enteredAt, "occurredAt", notBefore, settings.timeZone) : enteredAt;
  // A past record only when the visit is over; otherwise checked and told as usual.
  const history = backdated && span.endsAt.getTime() <= enteredAt.getTime();
  const now = history ? stampAt : enteredAt;
  const actor = options.actor ?? STAFF;

  const needsCheck = (row: BookingRow): boolean =>
    !history &&
    row.resourceId !== null &&
    (isRevivingMove(row.status, parsed.status) ||
      (row.status === "pending" && isActiveBookingStatus(parsed.status) && isOverdue(row, enteredAt)));
  const drives =
    needsCheck(found) && found.resourceId
      ? await driveTimesBeforeLock(db, options.maps ?? createHaversineMapsProvider(), {
          tenantId,
          resourceId: found.resourceId,
          date: found.scheduledDate,
          job: found.lat != null && found.lng != null ? { lat: found.lat, lng: found.lng } : null,
          excludeBookingId: found.id,
          now: enteredAt,
        })
      : createHaversineMapsProvider();

  const result = await db.transaction(async (tx) => {
    if (found.resourceId) await lockResource(tx, tenantId, found.resourceId);
    // Re-read under the lock: the status we judge is the one we overwrite.
    const current = await getBookingRow(tx, tenantId, parsed.id);
    if (!current) return { ok: false as const };
    if (current.status === parsed.status) return { ok: true as const, before: null, after: null };
    if (!canTransitionBooking(current.status, parsed.status)) {
      throw new BookingStatusTransitionError(current.status, parsed.status);
    }
    if (current.resourceId && needsCheck(current)) {
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
          now: enteredAt,
        },
        drives,
      );
      if (!check.valid) {
        const what = current.status === "pending" ? "Can't accept this request" : "Can't put this visit back on the calendar";
        throw new BookingNotBookableError(`${what}: ${check.reason ?? "its time is no longer free"}.`, check.code);
      }
    }
    const set = statusEffects(current, parsed.status, { now: stampAt, clock: enteredAt, actor, reason: parsed.reason ?? null, settings });
    const [after] = (await tx
      .update(schedulingBookings)
      .set(set)
      .where(and(eq(schedulingBookings.id, current.id), eq(schedulingBookings.tenantId, tenantId)))
      .returning()) as BookingRow[];
    return { ok: true as const, before: current, after: after as BookingRow };
  });

  if (!result.ok) return false;
  if (result.before && result.after) {
    const event = statusEvent(result.before.status, result.after.status);
    if (event) {
      const spec: EventSpec = {
        ...event,
        row: result.after,
        actor,
        ...(history
          ? { notify: false, enteredLater: true }
          : options.notify !== undefined && event.type !== "visit.started" && event.type !== "visit.completed"
            ? { notify: options.notify }
            : {}),
      };
      if (event.type === "visit.declined" || event.type === "visit.cancelled") spec.reason = parsed.reason ?? null;
      await emitEvents(db, tenantId, [spec], {
        settings,
        now,
        onEvent: options.onEvent,
        onEventError: options.onEventError,
      });
    }
  }
  return true;
}

// --- Moves -----------------------------------------------------------------------

const dateStringSchema = z.string().refine(isValidDateString, "Use a date like 2026-11-02.");

export const rescheduleBookingSchema = z.object({
  id: z.string().min(1).max(200),
  /** The new calendar date in the business's zone. */
  date: dateStringSchema,
  startTime: timeOfDaySchema,
  /** Omitted: start + the visit's length. */
  endTime: endTimeSchema.optional(),
  /** Omitted: the same crew. */
  resourceId: z.string().min(1).max(200).optional(),
});
export type RescheduleBookingInput = z.input<typeof rescheduleBookingSchema>;

export const assignBookingSchema = z.object({
  id: z.string().min(1).max(200),
  resourceId: z.string().min(1).max(200),
});
export type AssignBookingInput = z.input<typeof assignBookingSchema>;

const MOVABLE = new Set(["pending", "confirmed"]);

function notChangeable(status: string): BookingNotBookableError {
  const words: Record<string, string> = {
    in_progress: "in progress",
    no_show: "marked as a no-show",
  };
  return new BookingNotBookableError(`This visit is ${words[status] ?? status.replace(/_/g, " ")}, so it can't be moved.`, "not_changeable");
}

interface MovePlan {
  date: string;
  startTime: string;
  endTime: string;
  resourceId: string | null;
}

/**
 * The shared body of `rescheduleBooking` and `assignBooking`: drive times
 * before the lock, both crews locked in sorted order, the visit re-read and its
 * status checked again, the slot validated against the target crew (unless the
 * visit stays unassigned), then the write and — after commit — the event.
 */
async function moveVisit(
  db: SchedulingDb,
  tenantId: string,
  id: string,
  plan: (current: BookingRow) => MovePlan,
  options: SchedulingWriteOptions,
): Promise<{ visit: BookingRow; warnings: string[] } | null> {
  const found = await getBookingRow(db, tenantId, id);
  if (!found) return null;
  if (!MOVABLE.has(found.status)) throw notChangeable(found.status);
  const settings = await settingsFor(db, tenantId, options);
  const now = options.now ?? new Date();
  const maps = options.maps ?? createHaversineMapsProvider();
  const target = plan(found);
  if (timeToMinutes(target.endTime) <= timeToMinutes(target.startTime)) {
    throw new BookingNotBookableError(
      `The visit has to end after it starts, on the same day (${range12(target.startTime, target.endTime)})`,
      "invalid_window",
    );
  }
  const sameTime =
    target.date === labelOf(found.scheduledDate) && target.startTime === found.startTime && target.endTime === found.endTime;
  if (sameTime && target.resourceId === found.resourceId) return { visit: found, warnings: [] };

  const job: LatLng | null = found.lat != null && found.lng != null ? { lat: found.lat, lng: found.lng } : null;
  const drives = target.resourceId
    ? await driveTimesBeforeLock(db, maps, {
        tenantId,
        resourceId: target.resourceId,
        date: labelDate(target.date),
        job,
        excludeBookingId: found.id,
        now,
      })
    : createHaversineMapsProvider();

  const warnings: string[] = [];
  const moved = await db.transaction(async (tx) => {
    await lockSettingsShared(tx, tenantId);
    await lockResources(tx, tenantId, [found.resourceId, target.resourceId]);
    await assertZone(tx, tenantId, settings.timeZone);
    const current = await getBookingRow(tx, tenantId, id);
    if (!current) return null;
    if (!MOVABLE.has(current.status)) throw notChangeable(current.status);
    if (target.resourceId) {
      const check = await validateBookingSlot(
        tx,
        {
          tenantId,
          resourceId: target.resourceId,
          date: labelDate(target.date),
          startTime: target.startTime,
          endTime: target.endTime,
          lat: current.lat,
          lng: current.lng,
          excludeBookingId: current.id,
          now,
        },
        drives,
      );
      if (!check.valid) throw new BookingNotBookableError(check.reason ?? "This slot is not bookable", check.code);
      warnings.push(...check.warnings);
    }
    const timeChanged =
      target.date !== labelOf(current.scheduledDate) ||
      target.startTime !== current.startTime ||
      target.endTime !== current.endTime;
    const { startsAt, endsAt } = visitInstants(target.date, target.startTime, target.endTime, settings.timeZone);
    const [after] = (await tx
      .update(schedulingBookings)
      .set({
        scheduledDate: labelDate(target.date),
        startTime: target.startTime,
        endTime: target.endTime,
        durationMinutes: timeToMinutes(target.endTime) - timeToMinutes(target.startTime),
        startsAt,
        endsAt,
        resourceId: target.resourceId,
        sequence: timeChanged ? current.sequence + 1 : current.sequence,
        // A request keeps its deadline (pulled in to the new start if that is
        // sooner) — unless the deadline had already passed: then staff moving
        // it are answering it, and it gets a fresh one. Kept, an overdue
        // request moved by staff stayed pending and overdue, holding no time,
        // and the next sweep told the customer it had lapsed.
        pendingExpiresAt:
          current.status === "pending"
            ? isOverdue(current, now)
              ? pendingDeadline(settings, now, startsAt)
              : earliest(current.pendingExpiresAt ?? pendingDeadline(settings, now, startsAt), startsAt)
            : current.pendingExpiresAt,
        updatedAt: now,
      })
      .where(and(eq(schedulingBookings.id, current.id), eq(schedulingBookings.tenantId, tenantId)))
      .returning()) as BookingRow[];
    return { before: current, after: after as BookingRow, timeChanged };
  });
  if (!moved) return null;

  const crewChanged = moved.before.resourceId !== moved.after.resourceId;
  if (moved.timeChanged || crewChanged) {
    await emitEvents(
      db,
      tenantId,
      [
        {
          type: moved.timeChanged ? "visit.rescheduled" : "visit.reassigned",
          row: moved.after,
          previous: moved.before,
          actor: options.actor ?? STAFF,
          ...(options.notify !== undefined ? { notify: options.notify } : {}),
        },
      ],
      { settings, now, onEvent: options.onEvent, onEventError: options.onEventError },
    );
  }
  return { visit: moved.after, warnings };
}

/**
 * Staff move a visit: a new date and start (and end, or the same length), and
 * optionally a new crew. Only `pending` and `confirmed` visits move; anything
 * else is `not_changeable`. The target crew must be active, and the slot is
 * validated against it — hours, overlap ("Overlaps 10:00–12:00"), drive
 * buffer, cap — under the locks of both the old and the new crew. A move of an
 * unassigned visit that names no crew is written unvalidated, as in 0.3.
 *
 * The same visit row moves, so its customer's links keep working. `sequence +
 * 1` when the time changes; a pending visit's deadline is pulled in to its new
 * start if that is sooner. Events after commit: `visit.rescheduled` (with
 * `previous`, including the old crew) when the time changed,
 * `visit.reassigned` when only the crew did, nothing when nothing changed.
 * Null when the visit isn't this tenant's.
 */
export async function rescheduleBooking(
  db: SchedulingDb,
  tenantId: string,
  input: RescheduleBookingInput,
  options: SchedulingWriteOptions = {},
): Promise<{ visit: BookingRow; warnings: string[] } | null> {
  const parsed = rescheduleBookingSchema.parse(input);
  return moveVisit(
    db,
    tenantId,
    parsed.id,
    (current) => {
      const startMinutes = timeToMinutes(parsed.startTime);
      const endMinutes = parsed.endTime !== undefined ? timeToMinutes(parsed.endTime) : startMinutes + current.durationMinutes;
      if (endMinutes > 24 * 60) {
        // Visits never cross midnight; quietly shortening one would be worse.
        throw new BookingNotBookableError(
          `A ${current.durationMinutes}-minute visit starting at ${clock12(parsed.startTime)} would run past midnight`,
          "invalid_window",
        );
      }
      return {
        date: parsed.date,
        startTime: parsed.startTime,
        endTime: minutesToTime(endMinutes),
        resourceId: parsed.resourceId ?? current.resourceId,
      };
    },
    options,
  );
}

/**
 * Staff give a visit to another crew: same time, new crew. The same status
 * rule, locks and validation as `rescheduleBooking`; no `sequence` bump (the
 * customer's calendar entry doesn't change). Emits `visit.reassigned`. Also
 * how an unassigned visit gets a crew, which 0.3 couldn't do. Null when the
 * visit isn't this tenant's.
 */
export async function assignBooking(
  db: SchedulingDb,
  tenantId: string,
  input: AssignBookingInput,
  options: SchedulingWriteOptions = {},
): Promise<{ visit: BookingRow; warnings: string[] } | null> {
  const parsed = assignBookingSchema.parse(input);
  return moveVisit(
    db,
    tenantId,
    parsed.id,
    (current) => ({
      date: labelOf(current.scheduledDate),
      startTime: current.startTime,
      endTime: current.endTime,
      resourceId: parsed.resourceId,
    }),
    options,
  );
}

// --- Details -----------------------------------------------------------------------

const nullableText = (max: number) => z.string().trim().max(max).nullable();
const nullableLine = (max: number) => singleLine(max).nullable();

export const updateBookingDetailsSchema = z.object({
  title: nullableText(200),
  serviceType: z.string().trim().min(1).max(60),
  customerName: nullableLine(200),
  customerEmail: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().email("Enter an email address.").max(320).nullable(),
  ),
  customerPhone: nullableLine(60),
  address: nullableLine(500),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  notes: z.string().max(2000).nullable(),
  estimateId: nullableText(200),
}).partial();
export type UpdateBookingDetailsInput = z.input<typeof updateBookingDetailsSchema>;

/**
 * Staff edit what a visit is and who it is for: title, service, customer
 * name, email and phone, address (and coordinates), notes and the estimate
 * link. Unknown keys are dropped. Any status may be edited.
 *
 * A CORRECTED EMAIL ADDRESS RE-SENDS THE VISIT. The office fixes a typo
 * ("pat@exmaple.com") after the confirmation went nowhere; before, nothing
 * told the real customer, the queued reminder still went to the typo — with a
 * freshly minted key to the visit — and every link already sent there kept
 * working for ever. Now, in the same transaction: every manage link this
 * visit has is revoked (its `scheduling_visit_tokens` rows deleted) and
 * `sequence` goes up, so the old reminder is skipped at send time. After
 * commit, for a request or confirmed visit still to come, the event for its
 * status is emitted again — `visit.requested` or `visit.confirmed`, `via:
 * "contact"` — and the comms listener sends it, with a new link, to the new
 * address and re-queues the reminder there. Name and address edits need no
 * event: the reminder is rendered from the visit as it is at send time.
 *
 * A changed address without coordinates is geocoded before the lock; a
 * failure leaves the coordinates null and adds a warning. With new
 * coordinates on an assigned, active visit, the slot is re-checked under the
 * lock and a failure becomes a WARNING ("Heads up: not enough time to drive
 * from the 09:00 job…") — it NEVER refuses: an address is a fact, and staff
 * must be able to record it. Null when the visit isn't this tenant's.
 */
export async function updateBookingDetails(
  db: SchedulingDb,
  tenantId: string,
  input: { id: string; patch: UpdateBookingDetailsInput },
  options: SchedulingWriteOptions = {},
): Promise<{ visit: BookingRow; warnings: string[] } | null> {
  const id = z.string().min(1).max(200).parse(input.id);
  const patch = updateBookingDetailsSchema.parse(input.patch ?? {});
  const found = await getBookingRow(db, tenantId, id);
  if (!found) return null;
  const now = options.now ?? new Date();
  const maps = options.maps ?? createHaversineMapsProvider();
  const warnings: string[] = [];

  const set: Partial<BookingRow> = { ...patch, updatedAt: now };
  const emailChanged =
    "customerEmail" in patch &&
    (patch.customerEmail ?? null)?.toLowerCase() !== (found.customerEmail ?? null)?.toLowerCase();
  const addressChanged = "address" in patch && patch.address !== found.address;
  const coordsGiven = patch.lat != null && patch.lng != null;
  if (addressChanged && !coordsGiven) {
    if (!patch.address) {
      set.lat = null;
      set.lng = null;
    } else {
      const { coords } = await tryGeocode(maps, patch.address);
      set.lat = coords?.lat ?? null;
      set.lng = coords?.lng ?? null;
      if (!coords && maps.geocodes !== false) warnings.push(GEOCODE_WARNING);
    }
  }
  const newLat = set.lat !== undefined ? set.lat : found.lat;
  const newLng = set.lng !== undefined ? set.lng : found.lng;
  const placeChanged = newLat !== found.lat || newLng !== found.lng;
  const recheck =
    placeChanged &&
    newLat != null &&
    newLng != null &&
    found.resourceId !== null &&
    (found.status === "pending" || found.status === "confirmed" || found.status === "in_progress");

  const drives =
    recheck && found.resourceId
      ? await driveTimesBeforeLock(db, maps, {
          tenantId,
          resourceId: found.resourceId,
          date: found.scheduledDate,
          job: { lat: newLat as number, lng: newLng as number },
          excludeBookingId: found.id,
          now,
        })
      : null;

  const visit = await db.transaction(async (tx) => {
    if (found.resourceId) await lockResource(tx, tenantId, found.resourceId);
    const current = await getBookingRow(tx, tenantId, id);
    if (!current) return null;
    if (recheck && drives && current.resourceId) {
      const check = await validateBookingSlot(
        tx,
        {
          tenantId,
          resourceId: current.resourceId,
          date: current.scheduledDate,
          startTime: current.startTime,
          endTime: current.endTime,
          lat: newLat,
          lng: newLng,
          excludeBookingId: current.id,
          now,
        },
        drives,
      );
      if (!check.valid) {
        warnings.push(`Heads up: ${check.reason ?? "this visit no longer fits the crew's day"}.`);
      } else {
        warnings.push(...check.warnings);
      }
    }
    if (emailChanged) {
      // Every link sent to the old address stops working, and the queued
      // reminder (keyed on the sequence) is skipped when it comes due.
      await tx
        .delete(schedulingVisitTokens)
        .where(and(eq(schedulingVisitTokens.tenantId, tenantId), eq(schedulingVisitTokens.visitId, current.id)));
      set.sequence = current.sequence + 1;
    }
    const [after] = (await tx
      .update(schedulingBookings)
      .set(set)
      .where(and(eq(schedulingBookings.id, current.id), eq(schedulingBookings.tenantId, tenantId)))
      .returning()) as BookingRow[];
    return after as BookingRow;
  });
  if (!visit) return null;

  const stillToCome = (visit.startsAt?.getTime() ?? Number.POSITIVE_INFINITY) > now.getTime();
  if (emailChanged && visit.customerEmail && stillToCome && (visit.status === "pending" || visit.status === "confirmed")) {
    const settings = await settingsFor(db, tenantId, options);
    await emitEvents(
      db,
      tenantId,
      [
        {
          type: visit.status === "confirmed" ? "visit.confirmed" : "visit.requested",
          row: visit,
          actor: options.actor ?? STAFF,
          via: "contact",
          ...(options.notify !== undefined ? { notify: options.notify } : {}),
        },
      ],
      { settings, now, onEvent: options.onEvent, onEventError: options.onEventError },
    );
  }
  return { visit, warnings };
}
