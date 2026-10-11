import { z } from "zod";
import { requestPublicBookingSchema, type PublicBookingPolicy } from "__SCOPE__/scheduling";

/**
 * What an anonymous visitor may ask the scheduler for, and the inputs the two
 * public procedures accept — in one module with no database import, so the
 * agreement between them is tested on its own (src/server/__tests__).
 *
 * WHY THE INPUTS ARE DERIVED FROM THE POLICY. The router's header promised that
 * one policy object meant "what is offered and what is accepted cannot
 * disagree", while `slots` took any length from 15 to 480 minutes and
 * `requestBooking` anything from 1 to 1440. The package refused the rest, so
 * nothing unsafe got through — but a picker built from those types offered
 * lengths the server then turned away. The list below is now the one place a
 * visit length is decided.
 */

/** The visit lengths the public form offers, in minutes. */
export const PUBLIC_VISIT_LENGTHS = [30, 60, 90, 120, 180, 240] as const;

/**
 * The rules for anonymous booking. The SAME object goes to both public
 * procedures, so what is offered and what is accepted agree.
 */
export const PUBLIC_POLICY = {
  // No same-day surprises: the earliest online start is a day out.
  minNoticeMinutes: 24 * 60,
  horizonDays: 30,
  slotStepMinutes: 30,
  // A list, so nobody books a whole day with one request.
  durationsMinutes: PUBLIC_VISIT_LENGTHS,
  // Kept clear around every booked visit in the public list, for the crew to
  // drive. The same for every visitor, so the list never depends on the
  // address somebody types (that was a way to locate other customers).
  travelBufferMinutes: 30,
  // A person accepts each web request from /admin/schedule.
  requestStatus: "pending",
  // One caller (by IP, see the router) may have this many requests waiting
  // at once. Each pending request holds its time until staff act on it.
  maxOpenRequestsPerRequester: 3,
} as const satisfies PublicBookingPolicy;

/**
 * Booking requests one caller may make per hour, on top of the ladder's
 * anonymous floor (60 a minute). The open-request cap above bounds how many
 * hold time; this bounds how fast a script can try.
 */
export const REQUEST_RATE_LIMIT = { limit: 5, windowMs: 60 * 60 * 1000 } as const;

const visitLength = z
  .number()
  .int()
  .refine(
    (minutes) => (PUBLIC_VISIT_LENGTHS as readonly number[]).includes(minutes),
    `Visits can be booked online for ${PUBLIC_VISIT_LENGTHS.join(", ")} minutes.`,
  );

/** `scheduling.slots`: a visit length from the list, and how many days to show (up to the horizon). */
export const publicSlotsInput = z.object({
  durationMinutes: visitLength.default(60),
  daysAhead: z.number().int().min(1).max(PUBLIC_POLICY.horizonDays).default(14),
});

/**
 * `scheduling.requestBooking`: the package's request schema without the two
 * fields the server decides — the tenant, and the skill the service needs —
 * and with a visit length from the list.
 */
export const publicRequestInput = requestPublicBookingSchema
  .omit({ tenantId: true, requiredSkill: true })
  .extend({ durationMinutes: visitLength });
