import { eq } from "drizzle-orm";
import { notify, type NotifyInput } from "__SCOPE__/notifications";
import { principalRole } from "__SCOPE__/permissions/schema";
import { db } from "@/db";

/**
 * Fan an event out to everyone holding ANY staff role.
 *
 * The recipient question is answered here, at write time, from the same
 * table `loadStaffPermissions` reads — not inside @__SCOPE_NAME__/notifications,
 * which refuses to know what "staff" means, and not at read time, where a
 * role change would rewrite history. Coarse on purpose for a firm this
 * size; the day notifications need routing by permission key, this is the
 * one function that learns it.
 */
export async function notifyStaff(input: Omit<NotifyInput, "recipientIds">): Promise<void> {
  const staff = await db
    .selectDistinct({ principalId: principalRole.principalId })
    .from(principalRole)
    .where(eq(principalRole.scope, "staff"));
  if (staff.length === 0) return;
  await notify(db, { ...input, recipientIds: staff.map((row) => row.principalId) });
}
