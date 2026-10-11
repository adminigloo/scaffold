import { sql } from "drizzle-orm";
import { createResource, listResources } from "__SCOPE__/scheduling";
import { db as sharedDb } from "@/db";

/**
 * A demo scheduling resource, seeded on first read (the same pattern the
 * feedback board uses) so the booking flow offers slots on every environment
 * with no deploy-time seed. A resource whose hours were never saved works
 * Mon–Fri on its own work hours, so one seeded crew is enough. Delete this and
 * seed your real crews from the admin once you have them.
 *
 * ONLY A TENANT THAT HAS NEVER HAD A CREW IS SEEDED — removed crews count. The
 * check used to ask for ACTIVE crews, and "Remove" deactivates, so a business
 * that removed every crew (to stop online booking, say) got a brand-new "Field
 * crew" working Mon–Fri on the next cold start, and the public flow started
 * taking visits against it. To stop customers booking a crew online, use its
 * "Pause online booking" button in /admin/schedule; to stop a crew working,
 * untick its days and save.
 */
export const SCHEDULING_TENANT = "primary";

let seededThisProcess = false;

export async function ensureSchedulingDemo(db = sharedDb): Promise<void> {
  if (seededThisProcess) return;
  const existing = await listResources(db, SCHEDULING_TENANT, { includeInactive: true });
  if (existing.length > 0) {
    seededThisProcess = true;
    return;
  }
  await db.transaction(async (tx) => {
    // Serialize concurrent cold-start seeders: the advisory lock + re-check
    // means only the first request seeds the demo crew.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`scheduling-seed:${SCHEDULING_TENANT}`}))`);
    const again = await listResources(tx, SCHEDULING_TENANT, { includeInactive: true });
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
