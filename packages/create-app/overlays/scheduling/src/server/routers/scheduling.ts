import { z } from "zod";
import {
  createBooking,
  createBookingSchema,
  createHaversineMapsProvider,
  createResource,
  createResourceSchema,
  deactivateResource,
  findAvailableSlots,
  listAvailability,
  listBookings,
  listResources,
  setAvailability,
  setAvailabilitySchema,
  setBookingStatus,
  setBookingStatusSchema,
  updateResource,
  validateBookingSlot,
} from "__SCOPE__/scheduling";
import { db } from "@/db";
import { SCHEDULING_TENANT, ensureSchedulingDemo } from "@/server/scheduling-seed";
import { createTRPCRouter, publicProcedure, requireStaff } from "../trpc";

/**
 * Drive-time-aware scheduling, from __SCOPE__/scheduling. A fixed tenant is
 * injected on every write (single-tenant to start). The maps provider is the
 * keyless Haversine default — set a maps key and inject a real provider to turn
 * on geocoding and traffic-aware drive times. The demo crew seeds on first read
 * so slots exist on every environment.
 *
 * Public procedures (slots, requestBooking) power the estimate → book-a-visit
 * flow; staff procedures run the calendar, resources and availability.
 *
 * BOOKING CONFIRMATIONS ARE YOURS TO WIRE. On the dogfood site a confirmed
 * booking queues a confirmation and a day-before reminder through __SCOPE__/comms.
 * That coupling is deliberately left out here so scheduling stands alone: add
 * `--comms`, then in `requestBooking` call `enqueueMessage(db, {...})` after the
 * write — the same shape notifications' producers follow.
 */
const maps = createHaversineMapsProvider();

function nextDays(daysAhead: number): { startDate: Date; endDate: Date } {
  const now = Date.now();
  return {
    startDate: new Date(now + 24 * 60 * 60 * 1000),
    endDate: new Date(now + daysAhead * 24 * 60 * 60 * 1000),
  };
}

export const schedulingRouter = createTRPCRouter({
  // --- Public: the estimate → book-a-visit flow ----------------------------

  slots: publicProcedure
    .meta({ scope: "public" })
    .input(
      z.object({
        durationMinutes: z.number().int().min(15).max(480).default(60),
        daysAhead: z.number().int().min(1).max(60).default(14),
        jobAddress: z.string().max(500).optional(),
      }),
    )
    .query(async ({ input }) => {
      await ensureSchedulingDemo(db);
      const { startDate, endDate } = nextDays(input.daysAhead);
      const slots = await findAvailableSlots(
        db,
        {
          tenantId: SCHEDULING_TENANT,
          durationMinutes: input.durationMinutes,
          startDate,
          endDate,
          jobAddress: input.jobAddress ?? null,
        },
        maps,
      );
      return slots.slice(0, 12);
    }),

  requestBooking: publicProcedure
    .meta({ scope: "public" })
    .input(createBookingSchema.omit({ tenantId: true, status: true }))
    .mutation(async ({ input }) => {
      await ensureSchedulingDemo(db);
      // A public caller must not be able to confirm an arbitrary, overlapping,
      // or cross-tenant booking. Require a resource that belongs to this tenant,
      // then validate the slot server-side (overlap + drive-time) before writing.
      if (!input.resourceId) throw new Error("Please choose an available time.");
      const resources = await listResources(db, SCHEDULING_TENANT);
      if (!resources.some((r) => r.id === input.resourceId)) {
        throw new Error("That time is no longer available.");
      }
      const check = await validateBookingSlot(
        db,
        {
          tenantId: SCHEDULING_TENANT,
          resourceId: input.resourceId,
          date: input.scheduledDate,
          startTime: input.startTime,
          endTime: input.endTime,
          lat: input.lat ?? null,
          lng: input.lng ?? null,
        },
        maps,
      );
      if (!check.valid) throw new Error(check.reason ?? "That time is no longer available.");

      const booking = await createBooking(db, {
        ...input,
        tenantId: SCHEDULING_TENANT,
        status: "confirmed",
      });
      // Wire a confirmation here with --comms (see the file header).
      return { id: booking.id, scheduledDate: booking.scheduledDate, startTime: booking.startTime };
    }),

  // --- Staff: calendar, resources, availability ----------------------------

  bookings: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ from: z.coerce.date(), to: z.coerce.date() }))
    .query(async ({ input }) => {
      await ensureSchedulingDemo(db);
      return listBookings(db, SCHEDULING_TENANT, { from: input.from, to: input.to });
    }),

  setBookingStatus: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(setBookingStatusSchema)
    .mutation(async ({ input }) => ({ ok: await setBookingStatus(db, input) })),

  createBooking: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(createBookingSchema.omit({ tenantId: true }))
    .mutation(({ input }) => createBooking(db, { ...input, tenantId: SCHEDULING_TENANT })),

  validate: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(
      z.object({
        resourceId: z.string().min(1),
        date: z.coerce.date(),
        startTime: z.string().regex(/^\d{2}:\d{2}$/),
        endTime: z.string().regex(/^\d{2}:\d{2}$/),
        lat: z.number().nullish(),
        lng: z.number().nullish(),
      }),
    )
    .mutation(({ input }) =>
      validateBookingSlot(db, { ...input, tenantId: SCHEDULING_TENANT }, maps),
    ),

  resources: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .query(async () => {
      await ensureSchedulingDemo(db);
      return listResources(db, SCHEDULING_TENANT);
    }),

  createResource: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(createResourceSchema.omit({ tenantId: true }))
    .mutation(({ input }) => createResource(db, { ...input, tenantId: SCHEDULING_TENANT })),

  updateResource: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ id: z.string().min(1), patch: createResourceSchema.omit({ tenantId: true }).partial() }))
    .mutation(({ input }) => updateResource(db, input.id, input.patch)),

  deactivateResource: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => ({ ok: await deactivateResource(db, input.id) })),

  availability: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ resourceId: z.string().min(1) }))
    .query(({ input }) => listAvailability(db, input.resourceId)),

  setAvailability: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(setAvailabilitySchema.omit({ tenantId: true }))
    .mutation(async ({ input }) => {
      await setAvailability(db, { ...input, tenantId: SCHEDULING_TENANT });
      return { ok: true };
    }),
});
