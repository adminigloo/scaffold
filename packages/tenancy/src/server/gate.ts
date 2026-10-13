import type { MembershipGate, MembershipVerdict } from "@adminigloo/permissions/server";
import { sql } from "drizzle-orm";
import { dateOrNull, q } from "./db.js";

/**
 * Is this person an active member of this company, and is the company usable?
 * (decision D15: suspension is enforced in ONE place, here.)
 *
 *   no row, a deleted company, or a membership that isn't active → not-a-member
 *   the company is suspended                                      → company-suspended
 *   otherwise                                                     → member
 *
 * One query, run through the handle given (a transaction gets read-your-writes).
 *
 * Hand it to `createDrizzlePermissionLoaders(db, { membership })`: then every
 * tRPC tenant procedure, every company route and every page gate refuses a
 * removed member and a suspended company on their very next request, with no
 * session to invalidate.
 *
 * It does NOT filter on `kind`. For authorisation a personal workspace is a
 * tenant like any other; decision D6 only shapes how the session is resolved.
 */
export const tenancyMembershipGate: MembershipGate = async (db, input): Promise<MembershipVerdict> => {
  const rows = await q(
    db,
    sql`/* adminigloo:tenancy/membership-gate */
      select m.status as member_status, t.suspended_at, t.deleted_at
      from tenant_members m join tenants t on t.id = m.tenant_id
      where m.tenant_id = ${input.tenantId} and m.user_id = ${input.userId}
      limit 1`,
  );
  const row = rows[0];
  if (!row || dateOrNull(row["deleted_at"]) !== null || row["member_status"] !== "active") return "not-a-member";
  if (dateOrNull(row["suspended_at"]) !== null) return "company-suspended";
  return "member";
};
