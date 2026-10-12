import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { emitEvents, type SchedulingActor } from "./events.js";
import { earliest, labelDate, labelOf, visitInstants } from "./instants.js";
import {
  assertZone,
  driveTimesBeforeLock,
  getBookingRow,
  lockResource,
  lockResources,
  lockSettingsShared,
} from "./internal.js";
import { createHaversineMapsProvider } from "./maps.js";
import { minutesToTime, timeToMinutes } from "./math.js";
import { publicOffer, type PublicOfferQuery } from "./offer.js";
import { decodeSlotId } from "./public.js";
import { schedulingBookings } from "./schema.js";
import { findService } from "./services.js";
import { getSchedulingSettings, publicPolicyFor, type SchedulingSettings } from "./settings.js";
import { changeWindow, isOverdueRequest, toPublicVisit } from "./snapshot.js";
import {
  BookingNotBookableError,
  SLOT_UNAVAILABLE,
  type BookingRow,
  type SchedulingDb,
  type SchedulingWriteOptions,
} from "./types.js";
import { validateBookingSlot } from "./validate.js";
import { openVisitByToken } from "./visit-tokens.js";
import type { PublicVisit } from "./wire.js";

/**
 * The customer's own visit, opened by the link in their email: view it, move
 * it, cancel it — up to the business's cutoff, with no account.
 *
 * Every miss is null: a malformed token, an unknown one, another tenant's, a
 * deleted visit. The handlers answer every null with the same `not_found`, so
 * nothing says which.
 */

const CUSTOMER: SchedulingActor = { type: "customer", id: null };

const DAY_MS = 24 * 60 * 60 * 1000;

function cutoffText(hours: number): string {
  if (hours <= 0) return "";
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/** "Call us at (801) 555-0143." / "Email us at …" / "" */
function contactSentence(settings: Pick<SchedulingSettings, "contactPhone" | "contactEmail">): string {
  if (settings.contactPhone) return ` Call us at ${settings.contactPhone}.`;
  if (settings.contactEmail) return ` Email us at ${settings.contactEmail}.`;
  return "";
}

/**
 * The `too_late` refusal, in the business's voice, with its phone number:
 * "This visit starts within 24 hours, so it can't be changed online. Call us
 * at (801) 555-0143." A crew plans its day the evening before, and a business
 * would rather take that call than lose the slot.
 */
// CONTRACT: past the start, or for a visit that is no longer pending or
// confirmed, the message reads "This visit can't be changed online any more."
// — "starts within 24 hours" would be untrue. A request whose deadline passed
// unanswered says so: it lapsed, it wasn't "too close".
function tooLate(row: BookingRow, settings: SchedulingSettings, now: Date): BookingNotBookableError {
  if (isOverdueRequest(row, now)) {
    return new BookingNotBookableError(
      `This request wasn't confirmed in time, so it can't be changed online. Please book a new time.${contactSentence(settings)}`,
      "too_late",
    );
  }
  const window = changeWindow(row, settings, now);
  const open = row.status === "pending" || row.status === "confirmed";
  const startsInFuture = window.startsAt.getTime() > now.getTime();
  const lead =
    open && startsInFuture && settings.cancelCutoffHours > 0
      ? `This visit starts within ${cutoffText(settings.cancelCutoffHours)}, so it can't be changed online.`
      : "This visit can't be changed online any more.";
  return new BookingNotBookableError(`${lead}${contactSentence(settings)}`, "too_late");
}

async function settingsFor(db: SchedulingDb, tenantId: string, options: { settings?: SchedulingSettings }) {
  return options.settings ?? (await getSchedulingSettings(db, tenantId));
}

/** The visit a manage token opens, as its customer sees it; null for every miss. */
export async function getVisitByToken(
  db: SchedulingDb,
  tenantId: string,
  token: string,
  options: { now?: Date; settings?: SchedulingSettings } = {},
): Promise<PublicVisit | null> {
  const row = await openVisitByToken(db, tenantId, token);
  if (!row) return null;
  const settings = await settingsFor(db, tenantId, options);
  return toPublicVisit(row, settings, { now: options.now ?? new Date() });
}

export const rescheduleVisitByTokenSchema = z.object({ slotId: z.string().min(1).max(500) });
export const cancelVisitByTokenSchema = z.object({
  reason: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(500).optional(),
  ),
});

/**
 * The customer moves their visit to a slot from `findPublicSlots({
 * manageToken })`, where their own visit didn't count as busy.
 *
 * The new time must be in the public offer, worked out again under the locks
 * of the old crew and the new crew (keys sorted), and the real drive must fit.
 * The SAME visit row moves — the crew may change — with `sequence + 1`, and the
 * status stays as it was: a request moved is still a request (its deadline is
 * pulled in to the new start if that is sooner). Emits `visit.rescheduled`
 * (actor customer, with `previous`).
 *
 * Refusals: `too_late` (inside the cutoff, or not pending/confirmed),
 * `booking_closed` (online booking is off), `slot_unavailable` (not in the
 * offer, or the drive doesn't fit), `too_soon`, `too_far`. Null for a token
 * that opens nothing. Picking the visit's own time is a no-op.
 */
export async function rescheduleVisitByToken(
  db: SchedulingDb,
  tenantId: string,
  token: string,
  input: { slotId: string },
  options: SchedulingWriteOptions = {},
): Promise<PublicVisit | null> {
  const parsed = rescheduleVisitByTokenSchema.parse(input);
  const found = await openVisitByToken(db, tenantId, token);
  if (!found) return null;
  const settings = await settingsFor(db, tenantId, options);
  const now = options.now ?? new Date();
  if (!changeWindow(found, settings, now).changeable) throw tooLate(found, settings, now);
  if (!settings.publicBookingEnabled) {
    throw new BookingNotBookableError(
      `Online booking is closed right now, so this visit can't be moved online.${contactSentence(settings)}`,
      "booking_closed",
    );
  }

  const slot = decodeSlotId(parsed.slotId);
  if (!slot) throw new BookingNotBookableError(SLOT_UNAVAILABLE);
  const policy = publicPolicyFor(settings, undefined);
  const zone = settings.timeZone;
  const startMinutes = timeToMinutes(slot.startTime);
  if (startMinutes + found.durationMinutes > 24 * 60) throw new BookingNotBookableError(SLOT_UNAVAILABLE);
  const endTime = minutesToTime(startMinutes + found.durationMinutes);
  const { startsAt, endsAt } = visitInstants(slot.date, slot.startTime, endTime, zone);
  const earliestStart = new Date(now.getTime() + policy.minNoticeMinutes * 60_000);
  const latestStart = new Date(now.getTime() + policy.horizonDays * DAY_MS);
  if (startsAt.getTime() < earliestStart.getTime()) {
    throw new BookingNotBookableError("That time is too soon to book online. Please pick a later one.", "too_soon");
  }
  if (startsAt.getTime() > latestStart.getTime()) {
    throw new BookingNotBookableError("That date is too far ahead to book online.", "too_far");
  }
  if (slot.date === labelOf(found.scheduledDate) && slot.startTime === found.startTime) {
    return toPublicVisit(found, settings, { now });
  }

  const service = findService(settings.services, found.serviceType);
  const query: PublicOfferQuery = {
    tenantId,
    durationMinutes: found.durationMinutes,
    requiredSkill: service?.requiredSkill ?? null,
    firstDay: slot.date,
    lastDay: slot.date,
    policy,
    timeZone: zone,
    earliestStart,
    latestStart,
    now,
    excludeBookingId: found.id,
  };
  const chosen = (await publicOffer(db, query)).find((s) => s.startTime === slot.startTime);
  if (!chosen) throw new BookingNotBookableError(SLOT_UNAVAILABLE);
  const drives = await driveTimesBeforeLock(db, options.maps ?? createHaversineMapsProvider(), {
    tenantId,
    resourceId: chosen.resourceId,
    date: labelDate(slot.date),
    job: found.lat != null && found.lng != null ? { lat: found.lat, lng: found.lng } : null,
    excludeBookingId: found.id,
    now,
  });

  const moved = await db.transaction(async (tx) => {
    await lockSettingsShared(tx, tenantId);
    await lockResources(tx, tenantId, [found.resourceId, chosen.resourceId]);
    await assertZone(tx, tenantId, zone);
    const current = await getBookingRow(tx, tenantId, found.id);
    if (!current) return null;
    if (!changeWindow(current, settings, now).changeable) throw tooLate(current, settings, now);
    const still = (await publicOffer(tx, query)).find((s) => s.startTime === slot.startTime);
    if (!still || still.resourceId !== chosen.resourceId) throw new BookingNotBookableError(SLOT_UNAVAILABLE);
    const check = await validateBookingSlot(
      tx,
      {
        tenantId,
        resourceId: chosen.resourceId,
        date: labelDate(slot.date),
        startTime: slot.startTime,
        endTime,
        lat: current.lat,
        lng: current.lng,
        excludeBookingId: current.id,
        now,
      },
      drives,
    );
    if (!check.valid) throw new BookingNotBookableError(SLOT_UNAVAILABLE);
    const [after] = (await tx
      .update(schedulingBookings)
      .set({
        scheduledDate: labelDate(slot.date),
        startTime: slot.startTime,
        endTime,
        startsAt,
        endsAt,
        resourceId: chosen.resourceId,
        sequence: current.sequence + 1,
        pendingExpiresAt: current.status === "pending" ? earliest(current.pendingExpiresAt, startsAt) : current.pendingExpiresAt,
        updatedAt: now,
      })
      .where(and(eq(schedulingBookings.id, current.id), eq(schedulingBookings.tenantId, tenantId)))
      .returning()) as BookingRow[];
    return { before: current, after: after as BookingRow };
  });
  if (!moved) return null;

  await emitEvents(
    db,
    tenantId,
    [
      {
        type: "visit.rescheduled",
        row: moved.after,
        previous: moved.before,
        actor: options.actor ?? CUSTOMER,
        ...(options.notify !== undefined ? { notify: options.notify } : {}),
      },
    ],
    { settings, now, onEvent: options.onEvent, onEventError: options.onEventError },
  );
  return toPublicVisit(moved.after, settings, { now });
}

/**
 * The customer cancels their visit. A changeable visit (pending or confirmed,
 * before the cutoff) moves to `cancelled`, stamped `cancelled_by: customer`
 * with their reason. Cancelling one already cancelled returns it unchanged,
 * with no event (a double click). Anything else is `too_late`, with the
 * business's phone number. Works while online booking is off: closing the
 * booking page must not trap a customer into a visit. Emits `visit.cancelled`
 * (actor customer). Null for a token that opens nothing.
 */
export async function cancelVisitByToken(
  db: SchedulingDb,
  tenantId: string,
  token: string,
  input: { reason?: string | null },
  options: SchedulingWriteOptions = {},
): Promise<PublicVisit | null> {
  const parsed = cancelVisitByTokenSchema.parse({ reason: input?.reason ?? undefined });
  const found = await openVisitByToken(db, tenantId, token);
  if (!found) return null;
  const settings = await settingsFor(db, tenantId, options);
  const now = options.now ?? new Date();
  if (found.status === "cancelled") return toPublicVisit(found, settings, { now });
  if (!changeWindow(found, settings, now).changeable) throw tooLate(found, settings, now);
  const actor = options.actor ?? CUSTOMER;

  const result = await db.transaction(async (tx) => {
    if (found.resourceId) await lockResource(tx, tenantId, found.resourceId);
    const current = await getBookingRow(tx, tenantId, found.id);
    if (!current) return null;
    if (current.status === "cancelled") return { after: current, changed: false };
    if (!changeWindow(current, settings, now).changeable) throw tooLate(current, settings, now);
    const [after] = (await tx
      .update(schedulingBookings)
      .set({
        status: "cancelled",
        cancelledAt: now,
        cancelledBy: actor.type,
        cancelReason: parsed.reason ?? null,
        pendingExpiresAt: null,
        sequence: current.sequence + 1,
        updatedAt: now,
      })
      .where(and(eq(schedulingBookings.id, current.id), eq(schedulingBookings.tenantId, tenantId)))
      .returning()) as BookingRow[];
    return { after: after as BookingRow, changed: true };
  });
  if (!result) return null;
  if (result.changed) {
    await emitEvents(
      db,
      tenantId,
      [
        {
          type: "visit.cancelled",
          row: result.after,
          actor,
          reason: parsed.reason ?? null,
          ...(options.notify !== undefined ? { notify: options.notify } : {}),
        },
      ],
      { settings, now, onEvent: options.onEvent, onEventError: options.onEventError },
    );
  }
  return toPublicVisit(result.after, settings, { now });
}

/** The visit a token opens, as a row: for the `.ics` route, which needs its id and sequence. */
export async function visitRowByToken(db: SchedulingDb, tenantId: string, token: string): Promise<BookingRow | null> {
  return openVisitByToken(db, tenantId, token);
}
