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

/** Resolve staff grants, or NULL if this principal holds no staff role. */
export async function loadStaffPermissions(input: {
  principal: Principal;
}): Promise<PermissionSet | null> {
  const assignment = await db.query.principalRole.findFirst({
    where: and(
      eq(principalRole.principalId, input.principal.userId),
      eq(principalRole.scope, "staff"),
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
