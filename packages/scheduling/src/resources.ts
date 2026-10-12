import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { getResourceRow, tryGeocode } from "./internal.js";
import type { MapsProvider } from "./maps.js";
import { schedulingResources } from "./schema.js";
import { endTimeSchema, timeOfDaySchema, type ResourceRow, type SchedulingDb } from "./types.js";
import type { AdminResource } from "./wire.js";

/** The editable fields of a resource, with no defaults (see the two schemas below). */
const resourceShape = {
  name: z.string().trim().min(1).max(200),
  userId: z.string().max(200).nullish(),
  homeBaseAddress: z.string().max(500).nullish(),
  homeBaseLat: z.number().nullish(),
  homeBaseLng: z.number().nullish(),
  skills: z.array(z.string().max(60)).max(50),
  workStartTime: timeOfDaySchema,
  workEndTime: endTimeSchema,
  maxJobsPerDay: z.number().int().min(1).max(50),
  acceptsPublicBookings: z.boolean(),
};

export const createResourceSchema = z.object({
  tenantId: z.string().min(1).max(200),
  ...resourceShape,
  skills: resourceShape.skills.default([]),
  workStartTime: resourceShape.workStartTime.default("08:00"),
  workEndTime: resourceShape.workEndTime.default("17:00"),
  maxJobsPerDay: resourceShape.maxJobsPerDay.default(6),
  acceptsPublicBookings: resourceShape.acceptsPublicBookings.default(true),
});
export type CreateResourceInput = z.input<typeof createResourceSchema>;

/**
 * A partial resource edit. No `tenantId` and no `id` — a patch cannot move a
 * crew to another workspace. No `hoursConfigured` (only `setAvailability`
 * sets it) and no `isActive` (`deactivateResource` / `reactivateResource`).
 * No defaults either, so an omitted field stays as it is. Unknown keys are
 * dropped.
 */
export const updateResourceSchema = z.object(resourceShape).partial();
export type UpdateResourceInput = z.input<typeof updateResourceSchema>;

export interface ResourceWriteOptions {
  /**
   * Geocodes a home base given without coordinates, when the provider can
   * (Google). Default: the keyless Haversine provider, which can't, so the
   * coordinates stay as given. 0.3 never turned `homeBaseAddress` into
   * coordinates, so drive-from-home scoring silently never ran (SB-04).
   */
  maps?: MapsProvider;
}

const blank = (value: string | null | undefined): boolean => !value || value.trim() === "";

/**
 * A new crew. A `homeBaseAddress` without coordinates is geocoded first when
 * the provider geocodes; an error or "no such place" leaves the coordinates
 * null, and the crew is still created.
 */
export async function createResource(
  db: SchedulingDb,
  input: CreateResourceInput,
  options: ResourceWriteOptions = {},
): Promise<ResourceRow> {
  const values = createResourceSchema.parse(input);
  if (
    options.maps &&
    !blank(values.homeBaseAddress) &&
    (values.homeBaseLat == null || values.homeBaseLng == null)
  ) {
    const { coords } = await tryGeocode(options.maps, values.homeBaseAddress);
    values.homeBaseLat = coords?.lat ?? null;
    values.homeBaseLng = coords?.lng ?? null;
  }
  const [row] = await db.insert(schedulingResources).values(values).returning();
  return row as ResourceRow;
}

/**
 * Edit one of this tenant's resources; null when the id is not theirs. A new
 * `homeBaseAddress` without coordinates is geocoded (an error leaves them
 * null); an address cleared to null clears them. An unchanged address keeps
 * the coordinates it has.
 */
export async function updateResource(
  db: SchedulingDb,
  tenantId: string,
  id: string,
  patch: UpdateResourceInput,
  options: ResourceWriteOptions = {},
): Promise<ResourceRow | null> {
  const parsed = updateResourceSchema.parse(patch);
  const set: Record<string, unknown> = { ...parsed };
  if ("homeBaseAddress" in parsed) {
    const coordsGiven = parsed.homeBaseLat != null && parsed.homeBaseLng != null;
    if (blank(parsed.homeBaseAddress)) {
      if (!coordsGiven) {
        set["homeBaseLat"] = null;
        set["homeBaseLng"] = null;
      }
    } else if (!coordsGiven && options.maps && options.maps.geocodes !== false) {
      const current = await getResourceRow(db, tenantId, id);
      if (!current) return null;
      const changed = current.homeBaseAddress !== parsed.homeBaseAddress;
      if (changed || current.homeBaseLat == null || current.homeBaseLng == null) {
        const { coords } = await tryGeocode(options.maps, parsed.homeBaseAddress);
        set["homeBaseLat"] = coords?.lat ?? null;
        set["homeBaseLng"] = coords?.lng ?? null;
      }
    }
  }
  const [row] = await db
    .update(schedulingResources)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(schedulingResources.id, id), eq(schedulingResources.tenantId, tenantId)))
    .returning();
  return (row as ResourceRow) ?? null;
}

/**
 * Take one of this tenant's resources off the schedule; false when the id is
 * not theirs. The finders stop offering it, `listResources` stops listing it
 * (ask with `includeInactive`), and a staff booking, a move or an un-cancel
 * onto it is refused (`resource_unavailable`). Its existing visits are left as
 * they are — nothing reassigns them. `reactivateResource` puts it back.
 */
export async function deactivateResource(db: SchedulingDb, tenantId: string, id: string): Promise<boolean> {
  return setResourceActive(db, tenantId, id, false);
}

/**
 * Put one of this tenant's removed resources back on the schedule, with the
 * hours and online-booking switch it had; false when the id is not theirs.
 */
export async function reactivateResource(db: SchedulingDb, tenantId: string, id: string): Promise<boolean> {
  return setResourceActive(db, tenantId, id, true);
}

async function setResourceActive(db: SchedulingDb, tenantId: string, id: string, isActive: boolean): Promise<boolean> {
  const [row] = await db
    .update(schedulingResources)
    .set({ isActive, updatedAt: new Date() })
    .where(and(eq(schedulingResources.id, id), eq(schedulingResources.tenantId, tenantId)))
    .returning({ id: schedulingResources.id });
  return row !== undefined;
}

export interface ListResourcesOptions {
  /**
   * Include deactivated resources. A seed asks this way: "does this tenant
   * have ANY crews" is a different question from "which crews are working",
   * and asking the second one is how a removed crew's demo replacement kept
   * coming back.
   */
  includeInactive?: boolean;
}

/**
 * This tenant's resources, by name. The id breaks a tie between two crews with
 * one name, so the order — and with it which crew the public offer gives a
 * shared time to — is the same on every call.
 */
export async function listResources(
  db: SchedulingDb,
  tenantId: string,
  options: ListResourcesOptions = {},
): Promise<ResourceRow[]> {
  return (await db
    .select()
    .from(schedulingResources)
    .where(
      options.includeInactive
        ? eq(schedulingResources.tenantId, tenantId)
        : and(eq(schedulingResources.tenantId, tenantId), eq(schedulingResources.isActive, true)),
    )
    .orderBy(asc(schedulingResources.name), asc(schedulingResources.id))) as ResourceRow[];
}

/** A resource row → the wire (`AdminResource`). */
export function toAdminResource(row: ResourceRow): AdminResource {
  return {
    id: row.id,
    name: row.name,
    userId: row.userId,
    homeBaseAddress: row.homeBaseAddress,
    homeBaseLat: row.homeBaseLat,
    homeBaseLng: row.homeBaseLng,
    skills: [...row.skills],
    workStartTime: row.workStartTime,
    workEndTime: row.workEndTime,
    maxJobsPerDay: row.maxJobsPerDay,
    hoursConfigured: row.hoursConfigured,
    acceptsPublicBookings: row.acceptsPublicBookings,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
