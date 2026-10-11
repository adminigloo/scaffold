/**
 * The visit lifecycle, pure — no DB. `setBookingStatus` enforces it under the
 * resource lock; a staff UI reads `nextBookingStatuses` to offer only the moves
 * that will be accepted.
 *
 * 0.2 let any status be written over any other from one dropdown. The costly
 * misclick was un-cancelling: a cancelled visit frees its slot (the finder and
 * the validator both ignore cancelled and no-show rows), somebody else books
 * it, and flipping the old visit back to `confirmed` put two confirmed visits
 * in one slot with no warning. Completed visits could also drift back to
 * `pending`. Now every move is named here, and a move that brings a visit back
 * from `cancelled` or `no_show` re-validates its slot before it is written.
 */

export const BOOKING_STATUSES = [
  "pending",
  "confirmed",
  "in_progress",
  "completed",
  "cancelled",
  "no_show",
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/**
 * pending → confirmed | cancelled; confirmed → in_progress | completed |
 * cancelled | no_show; in_progress → confirmed (started by mistake) |
 * completed | cancelled; completed → in_progress (reopened: the crew has to go
 * back); cancelled → pending | confirmed and no_show → confirmed | cancelled,
 * the moves back onto the calendar re-validated (see `isRevivingMove`).
 *
 * Nothing goes back to `pending` except a revived cancellation: pending means
 * "a request nobody has accepted yet", and a visit staff have already worked
 * on is not one.
 */
export const BOOKING_STATUS_TRANSITIONS: Readonly<Record<BookingStatus, readonly BookingStatus[]>> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["in_progress", "completed", "cancelled", "no_show"],
  in_progress: ["confirmed", "completed", "cancelled"],
  completed: ["in_progress"],
  cancelled: ["pending", "confirmed"],
  no_show: ["confirmed", "cancelled"],
};

/** The statuses whose visits hold no time on the calendar. */
export const INACTIVE_BOOKING_STATUSES: readonly BookingStatus[] = ["cancelled", "no_show"];

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

/** The statuses a staff UI should offer from `status` (excluding itself). */
export function nextBookingStatuses(status: string): readonly BookingStatus[] {
  return (BOOKING_STATUS_TRANSITIONS as Record<string, readonly BookingStatus[] | undefined>)[status] ?? [];
}

/**
 * A move from a status that holds no time back to one that does — the visit
 * reclaims a slot somebody else may have taken since, so it must be checked
 * like a new booking before it is written.
 */
export function isRevivingMove(from: string, to: string): boolean {
  return !isActiveBookingStatus(from) && isActiveBookingStatus(to);
}
