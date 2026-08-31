import { and, eq } from "drizzle-orm";
import {
  createPermissionSet,
  FIRM_WIDE,
  resolvePermissionSet,
  type PermissionSet,
} from "__SCOPE__/permissions";
import {
  principalOverride,
  principalRole,
  roleTemplateGrant,
} from "__SCOPE__/permissions/schema";
import { tenantMembers } from "__SCOPE__/tenancy/schema";
import type { Principal } from "__SCOPE__/auth";
import { db } from "@/db";

/**
 * Resolve a principal's grants in a tenant, or NULL if they are not a member.
 *
 * THE NULL MATTERS. Returning an empty set for a tenant the caller has nothing
 * to do with is indistinguishable from "a member who has been granted
 * nothing", and the tenant rung would then admit any signed-in user to any
 * tenant id they typed. Membership is checked first, separately.
 */
export async function loadTenantPermissions(input: {
  principal: Principal;
  tenantId: string;
}): Promise<PermissionSet | null> {
  const membership = await db.query.tenantMembers.findFirst({
    where: and(
      eq(tenantMembers.tenantId, input.tenantId),
      eq(tenantMembers.userId, input.principal.userId),
      eq(tenantMembers.status, "active"),
    ),
  });
  if (!membership) return null;

  return resolveFor(input.principal.userId, "tenant", input.tenantId);
}

/**
 * Resolve staff grants, or NULL if this principal holds no FIRM-WIDE staff role.
 *
 * The qualifier is the whole of it. NULL means "not staff" and every caller
 * reads it that way — `staffProcedure` throws `notStaff()`, the admin layout
 * renders "you are not staff" — while a non-null set is admission to the panel,
 * empty or not. So the question this asks has to be the same question
 * `resolveFor` answers, or a row that can grant nothing still opens the door.
 */
export async function loadStaffPermissions(input: {
  principal: Principal;
}): Promise<PermissionSet | null> {
  // The tenant predicate is NOT optional here, even though staff rows are
  // supposed to live at FIRM_WIDE.
  //
  // Without it this gate and `resolveFor` disagree: the gate matched any staff
  // row, `resolveFor` re-queried pinned to '*', and a staff row written with a
  // real tenant id — the column is plain text, nothing stops it — passed the
  // gate and then resolved to an EMPTY SET. The caller was told "staff who
  // holds no permissions" when the truth is "not staff at all", and those two
  // answers take different branches everywhere: one shows an empty admin panel,
  // the other sends you away. Asking the same question twice, two ways, is how
  // that gap opens.
  const assignment = await db.query.principalRole.findFirst({
    where: and(
      eq(principalRole.principalId, input.principal.userId),
      eq(principalRole.scope, "staff"),
      eq(principalRole.tenantId, FIRM_WIDE),
    ),
  });
  if (!assignment) return null;

  return resolveFor(input.principal.userId, "staff", FIRM_WIDE);
}

/**
 * Two queries, merged in memory. Never a round trip per permission check — the
 * tRPC layer resolves once per request and hands the set down.
 */
async function resolveFor(
  principalId: string,
  scope: "staff" | "tenant",
  tenantId: string,
): Promise<PermissionSet> {
  const assignment = await db.query.principalRole.findFirst({
    where: and(
      eq(principalRole.principalId, principalId),
      eq(principalRole.scope, scope),
      eq(principalRole.tenantId, tenantId),
    ),
  });

  const templateGrants = assignment
    ? await db
        .select({
          permission: roleTemplateGrant.permission,
          effect: roleTemplateGrant.effect,
        })
        .from(roleTemplateGrant)
        .where(eq(roleTemplateGrant.templateId, assignment.templateId))
    : [];

  const overrides = await db
    .select({
      permission: principalOverride.permission,
      effect: principalOverride.effect,
    })
    .from(principalOverride)
    .where(
      and(
        eq(principalOverride.principalId, principalId),
        eq(principalOverride.scope, scope),
        eq(principalOverride.tenantId, tenantId),
      ),
    );

  return createPermissionSet(resolvePermissionSet({ templateGrants, overrides }));
}
