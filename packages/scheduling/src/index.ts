import { and, asc, eq, gte, isNull, lte } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  findFreeSlots,
  scoreSlot,
  sortScoredSlots,
  timeToMinutes,
  windowsOverlap,
  type BookingWindow,
  type ScoredSlot,
} from "./math.js";
import { createHaversineMapsProvider, type DriveTime, type LatLng, type MapsProvider } from "./maps.js";
import {
  schedulingAvailability,
  schedulingBookings,
  schedulingDriveCache,
  schedulingResources,
} from "./schema.js";

export * from "./math.js";
export * from "./maps.js";
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

const ACTIVE_STATUSES_EXCLUDED = ["cancelled", "no_show"];

// --- Resources -------------------------------------------------------------

export const createResourceSchema = z.object({
  tenantId: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  userId: z.string().max(200).nullish(),
  homeBaseAddress: z.string().max(500).nullish(),
  homeBaseLat: z.number().nullish(),
  homeBaseLng: z.number().nullish(),
  skills: z.array(z.string().max(60)).max(50).default([]),
  workStartTime: z.string().regex(/^\d{2}:\d{2}$/).default("08:00"),
  workEndTime: z.string().regex(/^\d{2}:\d{2}$/).default("17:00"),
  maxJobsPerDay: z.number().int().min(1).max(50).default(6),
});
export type CreateResourceInput = z.input<typeof createResourceSchema>;

export async function createResource(db: SchedulingDb, input: CreateResourceInput): Promise<ResourceRow> {
  const values = createResourceSchema.parse(input);
  const [row] = await db.insert(schedulingResources).values(values).returning();
  return row as ResourceRow;
}

export async function updateResource(
  db: SchedulingDb,
  id: string,
  patch: Partial<CreateResourceInput>,
): Promise<ResourceRow | null> {
  const [row] = await db
    .update(schedulingResources)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schedulingResources.id, id))
    .returning();
  return (row as ResourceRow) ?? null;
}

export async function deactivateResource(db: SchedulingDb, id: string): Promise<boolean> {
  const [row] = await db
    .update(schedulingResources)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(schedulingResources.id, id))
    .returning({ id: schedulingResources.id });
  return row !== undefined;
}

export async function listResources(db: SchedulingDb, tenantId: string): Promise<ResourceRow[]> {
  return (await db
    .select()
    .from(schedulingResources)
    .where(and(eq(schedulingResources.tenantId, tenantId), eq(schedulingResources.isActive, true)))
    .orderBy(asc(schedulingResources.name))) as ResourceRow[];
}

// --- Availability ----------------------------------------------------------

export const availabilityBlockSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6).nullish(),
  specificDate: z.coerce.date().nullish(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  isAvailable: z.boolean().default(true),
  note: z.string().max(300).nullish(),
});

export const setAvailabilitySchema = z.object({
  tenantId: z.string().min(1),
  resourceId: z.string().min(1),
  blocks: z.array(availabilityBlockSchema).max(200),
});

/** Full-replace a resource's availability (weekly rows + dated exceptions). */
export async function setAvailability(
  db: SchedulingDb,
  input: z.input<typeof setAvailabilitySchema>,
): Promise<void> {
  const parsed = setAvailabilitySchema.parse(input);
  await db.delete(schedulingAvailability).where(eq(schedulingAvailability.resourceId, parsed.resourceId));
  if (parsed.blocks.length === 0) return;
  await db.insert(schedulingAvailability).values(
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

export async function listAvailability(db: SchedulingDb, resourceId: string): Promise<AvailabilityRow[]> {
  return (await db
    .select()
    .from(schedulingAvailability)
    .where(eq(schedulingAvailability.resourceId, resourceId))) as AvailabilityRow[];
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
 * recurring row for that weekday; else — if the resource has no availability
 * rows at all — a Mon–Fri fallback to its own work hours, so a freshly created
 * resource is immediately bookable.
 */
export function resolveDayWindow(
  rows: AvailabilityRow[],
  resource: ResourceRow,
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
  if (rows.length === 0) {
    const dow = date.getUTCDay();
    if (dow >= 1 && dow <= 5) return { start: resource.workStartTime, end: resource.workEndTime };
  }
  return null;
}

// --- Drive-time cache wrapper ----------------------------------------------

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

// --- The orchestrator: find scored slots -----------------------------------

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
}

function dayBounds(date: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59));
  return { start, end };
}

/**
 * The whole point of the package: open slots across every resource, scored by
 * drive time from the previous job (via the injected maps provider), best
 * first. Falls back to the keyless Haversine provider if none is given.
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
    if (options.requiredSkill && r.skills.length > 0 && !r.skills.includes(options.requiredSkill)) return false;
    return true;
  });
  if (resources.length === 0) return [];

  // A resource's weekly availability is identical for every day in the range,
  // so fetch it ONCE per resource here instead of re-querying inside the day
  // loop (14 days × N resources = 14N round-trips on the public slots path).
  const availabilityByResource = new Map<string, Awaited<ReturnType<typeof listAvailability>>>();
  for (const resource of resources) {
    availabilityByResource.set(resource.id, await listAvailability(db, resource.id));
  }

  const scored: ScoredSlot[] = [];

  for (
    let day = new Date(options.startDate);
    day.getTime() <= options.endDate.getTime();
    day = new Date(day.getTime() + 24 * 60 * 60 * 1000)
  ) {
    const iso = day.toISOString().slice(0, 10);
    for (const resource of resources) {
      const rows = availabilityByResource.get(resource.id) ?? [];
      const window = resolveDayWindow(rows, resource, day);
      if (!window) continue;

      const { start, end } = dayBounds(day);
      const dayBookings = (await db
        .select()
        .from(schedulingBookings)
        .where(
          and(
            eq(schedulingBookings.resourceId, resource.id),
            gte(schedulingBookings.scheduledDate, start),
            lte(schedulingBookings.scheduledDate, end),
          ),
        )) as BookingRow[];

      const active = dayBookings.filter((b) => !ACTIVE_STATUSES_EXCLUDED.includes(b.status));

      // Don't offer a crew more jobs than its per-day cap. What's already booked
      // counts against it, so a full day yields no slots.
      const remaining = Math.max(0, resource.maxJobsPerDay - active.length);
      if (remaining === 0) continue;

      const windows: BookingWindow[] = active.map((b) => ({
        start: b.startTime,
        end: b.endTime,
        lat: b.lat,
        lng: b.lng,
        address: b.address ?? "",
      }));

      const free = findFreeSlots(window.start, window.end, windows, options.durationMinutes).slice(0, remaining);

      for (const slot of free) {
        let driveMinutes: number | null = null;
        let homeBaseDrive: number | null = null;
        if (slot.previousJob?.lat != null && slot.previousJob.lng != null && jobCoords) {
          const dt = await maps.driveTime({ lat: slot.previousJob.lat, lng: slot.previousJob.lng }, jobCoords);
          driveMinutes = dt?.durationMinutes ?? null;
        } else if (!slot.previousJob && resource.homeBaseLat != null && resource.homeBaseLng != null && jobCoords) {
          const dt = await maps.driveTime({ lat: resource.homeBaseLat, lng: resource.homeBaseLng }, jobCoords);
          homeBaseDrive = dt?.durationMinutes ?? null;
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
            isPreferredResource: options.preferredResourceId === resource.id,
          }),
        });
      }
    }
  }

  return sortScoredSlots(scored);
}

// --- Bookings --------------------------------------------------------------

export const createBookingSchema = z.object({
  tenantId: z.string().min(1),
  resourceId: z.string().nullish(),
  serviceType: z.string().max(60).default("visit"),
  title: z.string().max(200).nullish(),
  customerName: z.string().max(200).nullish(),
  customerEmail: z.string().max(320).nullish(),
  customerPhone: z.string().max(60).nullish(),
  address: z.string().max(500).nullish(),
  lat: z.number().nullish(),
  lng: z.number().nullish(),
  scheduledDate: z.coerce.date(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  durationMinutes: z.number().int().min(1).max(1440).default(120),
  estimateId: z.string().nullish(),
  notes: z.string().max(2000).nullish(),
  // Staff bookings land confirmed; a public self-service request can ask for
  // "pending" so a human reviews it. Callers choose — the DB no longer forces it.
  status: z.enum(["pending", "confirmed"]).default("confirmed"),
});
export type CreateBookingInput = z.input<typeof createBookingSchema>;

export async function createBooking(db: SchedulingDb, input: CreateBookingInput): Promise<BookingRow> {
  const values = createBookingSchema.parse(input);
  const [row] = await db.insert(schedulingBookings).values(values).returning();
  return row as BookingRow;
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

const BOOKING_STATUSES = [
  "pending",
  "confirmed",
  "in_progress",
  "completed",
  "cancelled",
  "no_show",
] as const;

export const setBookingStatusSchema = z.object({
  id: z.string().min(1),
  status: z.enum(BOOKING_STATUSES),
});

export async function setBookingStatus(
  db: SchedulingDb,
  input: z.infer<typeof setBookingStatusSchema>,
): Promise<boolean> {
  const parsed = setBookingStatusSchema.parse(input);
  const [row] = await db
    .update(schedulingBookings)
    .set({ status: parsed.status, updatedAt: new Date() })
    .where(eq(schedulingBookings.id, parsed.id))
    .returning({ id: schedulingBookings.id });
  return row !== undefined;
}

// --- Validate a booking (overlap + travel buffer) --------------------------

export interface ValidateBookingInput {
  tenantId: string;
  resourceId: string;
  date: Date;
  startTime: string;
  endTime: string;
  lat?: number | null;
  lng?: number | null;
}

export interface ValidateBookingResult {
  valid: boolean;
  reason?: string;
  warnings: string[];
}

/**
 * Refuse a booking that overlaps an existing one, or that leaves too little time
 * to drive between jobs; warn when the buffer is tight. Mirrors SG Glass's
 * guard, generalized and with the maps provider injected.
 */
export async function validateBookingSlot(
  db: SchedulingDb,
  input: ValidateBookingInput,
  maps: MapsProvider = createHaversineMapsProvider(),
): Promise<ValidateBookingResult> {
  const warnings: string[] = [];
  const { start, end } = dayBounds(input.date);
  const dayBookings = (await db
    .select()
    .from(schedulingBookings)
    .where(
      and(
        eq(schedulingBookings.resourceId, input.resourceId),
        gte(schedulingBookings.scheduledDate, start),
        lte(schedulingBookings.scheduledDate, end),
      ),
    )) as BookingRow[];

  const active = dayBookings.filter((b) => !ACTIVE_STATUSES_EXCLUDED.includes(b.status));

  for (const b of active) {
    if (windowsOverlap(input.startTime, input.endTime, b.startTime, b.endTime)) {
      return { valid: false, reason: `Overlaps ${b.startTime}–${b.endTime}`, warnings };
    }
  }

  const job = input.lat != null && input.lng != null ? { lat: input.lat, lng: input.lng } : null;
  if (job) {
    for (const b of active) {
      if (b.lat == null || b.lng == null) continue;
      const dt = await maps.driveTime({ lat: b.lat, lng: b.lng }, job);
      if (!dt) continue;
      // Existing job ends before the new one starts: is there time to drive over?
      if (timeToMinutes(b.endTime) <= timeToMinutes(input.startTime)) {
        const buffer = timeToMinutes(input.startTime) - timeToMinutes(b.endTime);
        if (dt.durationMinutes > buffer) {
          return { valid: false, reason: `Not enough time to drive from the ${b.startTime} job (${dt.durationMinutes} min drive, ${buffer} min gap)`, warnings };
        }
        if (dt.durationMinutes > buffer - 15) {
          warnings.push(`Tight schedule: ${dt.durationMinutes} min drive into a ${buffer} min gap`);
        }
      } else if (timeToMinutes(b.startTime) >= timeToMinutes(input.endTime)) {
        const buffer = timeToMinutes(b.startTime) - timeToMinutes(input.endTime);
        if (dt.durationMinutes > buffer) {
          return { valid: false, reason: `Not enough time to drive to the ${b.startTime} job afterward`, warnings };
        }
      }
    }
  }

  return { valid: true, warnings };
}
