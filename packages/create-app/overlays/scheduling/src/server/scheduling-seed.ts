import { sql } from "drizzle-orm";
import { createResource, listResources } from "__SCOPE__/scheduling";
import { db as sharedDb } from "@/db";

/**
 * A demo scheduling resource, seeded on first read (the same pattern the
 * feedback board uses) so the booking flow offers slots on every environment
 * with no deploy-time seed. A resource with no explicit availability falls back
 * to Mon–Fri work hours, so one seeded crew is enough. Delete this and seed your
 * real crews from the admin once you have them.
 */
export const SCHEDULING_TENANT = "primary";

let seededThisProcess = false;

export async function ensureSchedulingDemo(db = sharedDb): Promise<void> {
  if (seededThisProcess) return;
  const existing = await listResources(db, SCHEDULING_TENANT);
  if (existing.length > 0) {
    seededThisProcess = true;
    return;
  }
  await db.transaction(async (tx) => {
    // Serialize concurrent cold-start seeders: the advisory lock + re-check
    // means only the first request seeds the demo crew.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`scheduling-seed:${SCHEDULING_TENANT}`}))`);
    const again = await listResources(tx, SCHEDULING_TENANT);
    if (again.length > 0) return;
    await createResource(tx, {
      tenantId: SCHEDULING_TENANT,
      name: "Field crew",
      workStartTime: "08:00",
      workEndTime: "17:00",
      maxJobsPerDay: 6,
    });
  });
  seededThisProcess = true;
}
