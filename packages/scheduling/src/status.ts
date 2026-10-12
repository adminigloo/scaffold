/**
 * The visit lifecycle, pure — no DB. `setBookingStatus` enforces it under the
 * resource lock; a staff UI reads `nextBookingStatuses` to offer only the moves
 * that will be accepted.
 *
 * 0.2 let any status be written over any other from one dropdown. The costly
 * misclick was un-cancelling: a cancelled visit frees its slot (the finder and
 * the validator both ignore inactive rows), somebody else books it, and
 * flipping the old visit back to `confirmed` put two confirmed visits in one
 * slot with no warning. Completed visits could also drift back to `pending`.
 * Now every move is named here, and a move that brings a visit back from an
 * inactive status re-validates its slot before it is written.
 *
 * 0.4 adds two statuses a customer needs told apart from "cancelled":
 * `declined` (staff said no to a request) and `expired` (nobody answered it in
 * time, so the system released it). Neither holds time.
 */

export const BOOKING_STATUSES = [
  "pending",
  "confirmed",
  "in_progress",
  "completed",
  "cancelled",
  "declined",
  "expired",
  "no_show",
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/**
 * The statuses staff may set. `expired` is the system's word, written only by
 * `expirePendingRequests` when a request's deadline passes: a person who
 * wants a request gone declines it, and the customer reads why.
 */
export const STAFF_SETTABLE_STATUSES = [
  "pending",
  "confirmed",
  "in_progress",
  "completed",
  "cancelled",
  "declined",
  "no_show",
] as const satisfies readonly BookingStatus[];
export type StaffSettableStatus = (typeof STAFF_SETTABLE_STATUSES)[number];

/**
 * pending → confirmed | declined | cancelled | expired (the system only);
 * confirmed → in_progress | completed | cancelled | no_show; in_progress →
 * confirmed (started by mistake) | completed | cancelled | no_show (the crew
 * got there and couldn't do it: a locked gate, nobody home); completed →
 * in_progress (reopened: the crew has to go back); cancelled → pending |
 * confirmed, declined → confirmed, expired → confirmed and no_show →
 * confirmed | cancelled — the moves back onto the calendar, re-validated (see
 * `isRevivingMove`).
 *
 * Nothing goes back to `pending` except a revived cancellation: pending means
 * "a request nobody has accepted yet", and a visit staff have already worked
 * on is not one.
 */
export const BOOKING_STATUS_TRANSITIONS: Readonly<Record<BookingStatus, readonly BookingStatus[]>> = {
  pending: ["confirmed", "declined", "cancelled", "expired"],
  confirmed: ["in_progress", "completed", "cancelled", "no_show"],
  in_progress: ["confirmed", "completed", "cancelled", "no_show"],
  completed: ["in_progress"],
  cancelled: ["pending", "confirmed"],
  declined: ["confirmed"],
  expired: ["confirmed"],
  no_show: ["confirmed", "cancelled"],
};

/** The statuses whose visits hold no time on the calendar. */
export const INACTIVE_BOOKING_STATUSES: readonly BookingStatus[] = ["cancelled", "declined", "expired", "no_show"];

export function isActiveBookingStatus(status: string): boolean {
  return !(INACTIVE_BOOKING_STATUSES as readonly string[]).includes(status);
}

/**
 * Whether a move is allowed. Re-asserting the current status is an allowed
 * no-op, so a retried request (a double click, a refetch race) never errors.
 */
export function canTransitionBooking(from: string, to: string): boolean {
  if (from === to) return true;
  const allowed = (BOOKING_STATUS_TRANSITIONS as Record<string, readonly string[] | undefined>)[from];
  return allowed !== undefined && allowed.includes(to);
}

/**
 * The statuses a staff UI should offer from `status` (excluding itself).
 * Never `expired`: staff can't set it.
 */
export function nextBookingStatuses(status: string): readonly BookingStatus[] {
  const allowed = (BOOKING_STATUS_TRANSITIONS as Record<string, readonly BookingStatus[] | undefined>)[status] ?? [];
  return allowed.filter((next) => next !== "expired");
}

/**
 * A move from a status that holds no time back to one that does — the visit
 * reclaims a slot somebody else may have taken since, so it must be checked
 * like a new booking before it is written.
 */
export function isRevivingMove(from: string, to: string): boolean {
  return !isActiveBookingStatus(from) && isActiveBookingStatus(to);
}
