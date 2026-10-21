import { eq, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { schedulingAvailability, schedulingBookings, schedulingResources, schedulingSettings, schedulingVisitTokens } from "./schema.js";

/**
 * FORGET ONE COMPANY (create-app's "delete a company"): every row scheduling
 * keeps for `tenantId` — its visits and their customer links, crews and their
 * hours, and its settings — children first, each statement filtered by the
 * company's id. Run it on the deletion's transaction.
 *
 * THE DRIVE-TIME CACHE has no company column (one drive between two points
 * is the same drive for everyone), but its points are rounded to about 11 m:
 * a customer's job address, near enough. So every cached drive that starts
 * or ends within about 110 m of one of the company's visits or crews' home
 * bases goes too (`scheduling_drive_cache`), read before those rows go. A
 * neighbour's drive caught by the same point is only fetched again.
 *
 * Returns how many rows went from each table. Refuses an empty id and the
 * site's own ("*").
 */
export async function forgetTenant(db: PgDatabase<any, any, any>, tenantId: string): Promise<Readonly<Record<string, number>>> {
  if (typeof tenantId !== "string" || tenantId.trim() === "" || tenantId === "*") {
    throw new Error("forgetTenant needs one company's id; the site's own rows (\"*\") are never forgotten.");
  }
  const one = { one: sql<number>`1` };
  const counts: Record<string, number> = {};
  counts["scheduling_drive_cache"] = await forgetDrivesNear(db, tenantId);
  counts["scheduling_visit_tokens"] = (await db.delete(schedulingVisitTokens).where(eq(schedulingVisitTokens.tenantId, tenantId)).returning(one)).length;
  counts["scheduling_bookings"] = (await db.delete(schedulingBookings).where(eq(schedulingBookings.tenantId, tenantId)).returning(one)).length;
  counts["scheduling_availability"] = (await db.delete(schedulingAvailability).where(eq(schedulingAvailability.tenantId, tenantId)).returning(one)).length;
  counts["scheduling_resources"] = (await db.delete(schedulingResources).where(eq(schedulingResources.tenantId, tenantId)).returning(one)).length;
  counts["scheduling_settings"] = (await db.delete(schedulingSettings).where(eq(schedulingSettings.tenantId, tenantId)).returning(one)).length;
  return counts;
}

/**
 * About 110 m in degrees of latitude: wider than the cache's rounding at any
 * precision it is built with (4 places, ~11 m, by default; 3, ~110 m, at the
 * coarsest worth using), so a rounded point always falls inside it.
 */
const NEAR_DEGREES = 0.001;

/** Delete the cached drives touching the company's points (its visits and crews' home bases). */
async function forgetDrivesNear(db: PgDatabase<any, any, any>, tenantId: string): Promise<number> {
  const gone = await db.execute(sql`/* adminigloo:scheduling/forget-drive-cache */
    with pts as (
      select lat, lng from scheduling_bookings where tenant_id = ${tenantId} and lat is not null and lng is not null
      union
      select home_base_lat, home_base_lng from scheduling_resources where tenant_id = ${tenantId} and home_base_lat is not null and home_base_lng is not null
    ),
    gone as (
      delete from scheduling_drive_cache c
      where exists (
        select 1 from pts p
        where (abs(c.origin_lat - p.lat) <= ${NEAR_DEGREES} and abs(c.origin_lng - p.lng) <= ${NEAR_DEGREES})
           or (abs(c.dest_lat - p.lat) <= ${NEAR_DEGREES} and abs(c.dest_lng - p.lng) <= ${NEAR_DEGREES})
      )
      returning 1
    )
    select count(*)::int as n from gone`);
  const rows = (Array.isArray(gone) ? gone : ((gone as { rows?: unknown[] }).rows ?? [])) as Array<{ n?: unknown }>;
  return Number(rows[0]?.n ?? 0);
}
