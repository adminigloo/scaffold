import { z } from "zod";
import {
  BookingNotBookableError,
  BookingStatusTransitionError,
  createBooking,
  createBookingSchema,
  createHaversineMapsProvider,
  createResource,
  createResourceSchema,
  deactivateResource,
  endTimeSchema,
  findPublicSlots,
  listAvailability,
  listBookings,
  listResources,
  nextBookingStatuses,
  requestPublicBooking,
  setAvailability,
  setAvailabilitySchema,
  setBookingStatus,
  setBookingStatusSchema,
  timeOfDaySchema,
  updateResource,
  updateResourceSchema,
  validateBookingSlot,
} from "__SCOPE__/scheduling";
import { db } from "@/db";
import { limiter } from "@/server/rate-limit";
import { SCHEDULING_TENANT, ensureSchedulingDemo } from "@/server/scheduling-seed";
import {
  PUBLIC_POLICY,
  REQUEST_RATE_LIMIT,
  publicRequestInput,
  publicSlotsInput,
} from "@/server/scheduling-policy";
import { createTRPCRouter, publicProcedure, requireStaff, TRPCError } from "../trpc";

/**
 * Scheduling, from __SCOPE__/scheduling (0.3). A fixed tenant is injected
 * server-side on every call (single-tenant to start), and the package filters
 * every by-id read and write by it, so an id from another workspace is "not
 * found", never an edit. The maps provider is the keyless Haversine default: it
 * estimates drive times between coordinates but can't geocode, so addresses
 * are stored as typed and drive checks apply only between visits that already
 * have coordinates. Inject a real provider (wrapped in
 * `createCachedMapsProvider`) to turn on geocoding and traffic-aware drive
 * times. The demo crew seeds on first read of a tenant that has never had a
 * crew, so slots exist on every environment.
 *
 * PUBLIC PROCEDURES (slots, requestBooking) power the online booking flow, and
 * they only ever speak in `PublicSlot`s: a slot id, a date, a start and an end.
 * No crew, no score, no other customer's address — the staff
 * `findAvailableSlots` carries the previous job's street address and must
 * never be returned from a public route. The list is the same for every
 * visitor: it doesn't take an address, and keeps a fixed travel buffer around
 * each booked visit. A request sends back the slot id and a visit length from
 * PUBLIC_POLICY (scheduling-policy.ts); the package works out the times, picks
 * the crew, geocodes the address itself, re-checks the slot under the crew's
 * lock and writes the visit as `pending` for staff to accept.
 *
 * WHAT STOPS SOMEBODY FILLING THE CALENDAR WITH JUNK. A pending request holds
 * its time until staff act on it. `requestBooking` is limited to
 * REQUEST_RATE_LIMIT per caller, and the package refuses a caller who already
 * has PUBLIC_POLICY.maxOpenRequestsPerRequester requests waiting — counted in
 * the database, so it holds across serverless instances where the in-memory
 * limiter doesn't. The caller is their IP (`ctx.ipAddress`); on a laptop with
 * no proxy there is none, and neither limit applies. Staff free the time by
 * declining junk from /admin/schedule.
 *
 * STAFF PROCEDURES run the calendar, crews and hours. They are gated on
 * `staff.dashboard.view` like the rest of the field-service suite; the package
 * now ships `schedulingPermissions` (schedule.view / schedule.manage /
 * schedule.resources.manage) for when this router moves onto per-tenant
 * permissions.
 *
 * CONFIRMATIONS ARE YOURS TO WIRE. A request lands `pending`, so what the
 * customer is owed straight away is an ACKNOWLEDGEMENT ("we got your request
 * for Wed 10:00"), and the confirmation comes when staff accept it (move it to
 * `confirmed`). On the dogfood site that goes through __SCOPE__/comms; it is
 * deliberately left out here so scheduling stands alone. Add `--comms`, then:
 *
 *   - In `requestBooking`, after the write, SEND the acknowledgement in the
 *     request — `sendNow(db, {...}, commsSenders)`. Queued with sendAt = now it
 *     waits for the next cron drain (a day, on a Hobby-plan schedule), which a
 *     customer reads as "it didn't work".
 *   - In `setBookingStatus`, when a visit becomes `confirmed`, send the
 *     confirmation and QUEUE the reminder with `enqueueMessage(db, { ...,
 *     sendAt, refType: "booking", refId: booking.id })` — tagged so cancelling
 *     or moving the visit can `cancelScheduled(db, { tenantId, refType:
 *     "booking", refId })` first. A reminder whose moment has passed (a visit
 *     tomorrow) is skipped rather than sent late. Otherwise a cancelled visit
 *     still gets its "see you tomorrow".
 *
 * Set `requestStatus: "confirmed"` in PUBLIC_POLICY to book straight into the
 * calendar instead; then the confirmation belongs in `requestBooking`.
 */
const maps = createHaversineMapsProvider();

/**
 * A refusal from the package is the caller's problem, not an outage.
 * `slot_unavailable` means another visit is in the way (the public request
 * says it for every "not this time"; staff calls only when a visit clashes or
 * the day is full) — a 409 the form recovers from by refetching the times.
 * `too_many_requests` is a 429. Anything else is a 400 with its reason: outside
 * the hours, an end before the start, a removed crew, a length the policy
 * doesn't offer, an address the maps provider can't place — refetching won't
 * change those, so a 409 there would loop.
 */
async function refusalsAsClientErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof BookingNotBookableError) {
      throw new TRPCError({
        code:
          error.code === "slot_unavailable"
            ? "CONFLICT"
            : error.code === "too_many_requests"
              ? "TOO_MANY_REQUESTS"
              : "BAD_REQUEST",
        message: error.message,
        cause: error,
      });
    }
    if (error instanceof BookingStatusTransitionError) {
      throw new TRPCError({ code: "BAD_REQUEST", message: error.message, cause: error });
    }
    throw error;
  }
}

export const schedulingRouter = createTRPCRouter({
  // --- Public: online booking ------------------------------------------------

  /** Open start times for a visit of this length — `PublicSlot`s only, the same for every visitor. */
  slots: publicProcedure
    .meta({ scope: "public" })
    .input(publicSlotsInput)
    .query(async ({ input }) => {
      await ensureSchedulingDemo(db);
      return refusalsAsClientErrors(() =>
        findPublicSlots(
          db,
          { tenantId: SCHEDULING_TENANT, durationMinutes: input.durationMinutes, days: input.daysAhead },
          { policy: PUBLIC_POLICY },
        ),
      );
    }),

  /** A visitor asks for one of those slots. Lands pending; the server picks the times and the crew. */
  requestBooking: publicProcedure
    .meta({ scope: "public" })
    .input(publicRequestInput)
    .mutation(async ({ ctx, input }) => {
      const requester = ctx.ipAddress ? `ip:${ctx.ipAddress}` : null;
      if (requester) {
        const verdict = await limiter.limit({
          key: `scheduling.requestBooking:${requester}`,
          policy: REQUEST_RATE_LIMIT,
        });
        if (!verdict.allowed) {
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: "Too many booking requests from here. Please try again later.",
          });
        }
      }
      await ensureSchedulingDemo(db);
      const receipt = await refusalsAsClientErrors(() =>
        requestPublicBooking(
          db,
          { ...input, tenantId: SCHEDULING_TENANT },
          { maps, policy: PUBLIC_POLICY, requesterKey: requester },
        ),
      );
      // Send the acknowledgement here with --comms (see the file header).
      return receipt;
    }),

  // --- Staff: calendar, resources, availability ----------------------------

  /** The calendar, each visit with the status moves it can make next. */
  bookings: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ from: z.coerce.date(), to: z.coerce.date() }))
    .query(async ({ input }) => {
      await ensureSchedulingDemo(db);
      const rows = await listBookings(db, SCHEDULING_TENANT, { from: input.from, to: input.to });
      return rows.map((b) => ({ ...b, nextStatuses: nextBookingStatuses(b.status) }));
    }),

  setBookingStatus: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(setBookingStatusSchema)
    .mutation(async ({ input }) => ({
      // Un-cancelling re-checks the slot, so a visit somebody has since taken
      // the time of comes back as a 409 rather than a double booking.
      ok: await refusalsAsClientErrors(() => setBookingStatus(db, SCHEDULING_TENANT, input, { maps })),
    })),

  createBooking: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(createBookingSchema.omit({ tenantId: true }))
    .mutation(({ input }) =>
      refusalsAsClientErrors(() => createBooking(db, { ...input, tenantId: SCHEDULING_TENANT }, { maps })),
    ),

  validate: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(
      z.object({
        resourceId: z.string().min(1),
        date: z.coerce.date(),
        startTime: timeOfDaySchema,
        endTime: endTimeSchema,
        lat: z.number().nullish(),
        lng: z.number().nullish(),
      }),
    )
    .mutation(({ input }) =>
      validateBookingSlot(db, { ...input, tenantId: SCHEDULING_TENANT }, maps),
    ),

  /**
   * The crews, each with how many weekdays it works. A crew whose saved week
   * is empty is off every day, and its work hours alone would say otherwise.
   * One query per crew; a business has a handful.
   */
  resources: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .query(async () => {
      await ensureSchedulingDemo(db);
      const crews = await listResources(db, SCHEDULING_TENANT);
      return Promise.all(
        crews.map(async (crew) => ({
          ...crew,
          weeklyDays: (await listAvailability(db, SCHEDULING_TENANT, crew.id)).filter(
            (row) => row.specificDate === null && row.isAvailable,
          ).length,
        })),
      );
    }),

  createResource: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(createResourceSchema.omit({ tenantId: true }))
    .mutation(({ input }) => createResource(db, { ...input, tenantId: SCHEDULING_TENANT })),

  /** Edit a crew — including pausing its online booking (`acceptsPublicBookings`). Null: not this workspace's. */
  updateResource: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ id: z.string().min(1), patch: updateResourceSchema }))
    .mutation(({ input }) => updateResource(db, SCHEDULING_TENANT, input.id, input.patch)),

  /** Take a crew off the schedule: nothing offers it and nobody can book it. Its visits stay as they are. */
  deactivateResource: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => ({ ok: await deactivateResource(db, SCHEDULING_TENANT, input.id) })),

  availability: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ resourceId: z.string().min(1) }))
    .query(({ input }) => listAvailability(db, SCHEDULING_TENANT, input.resourceId)),

  /** Full-replace a crew's hours. An empty week turns it off every day — it no longer snaps back to Mon–Fri. */
  setAvailability: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(setAvailabilitySchema.omit({ tenantId: true }))
    .mutation(async ({ input }) => ({
      ok: await setAvailability(db, { ...input, tenantId: SCHEDULING_TENANT }),
    })),
});
