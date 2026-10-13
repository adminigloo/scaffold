import { and, eq } from "drizzle-orm";
import { FIRM_WIDE } from "../constants.js";
import { createPermissionSet, resolvePermissionSet, type PermissionSet } from "../resolve.js";
import type { Scope } from "../catalog.js";
import { principalOverride, principalRole, roleTemplateGrant } from "../schema.js";
import type { PermissionsDb } from "./db.js";

export type MembershipVerdict = "member" | "not-a-member" | "company-suspended";

/**
 * Is this person an active member of this tenant, and is the tenant usable?
 *
 * SUPPLIED BY THE HOST (`@adminigloo/tenancy/server` exports
 * `tenancyMembershipGate`). Permissions knows no membership table, and must
 * not: a project with its own idea of membership supplies its own gate.
 */
export type MembershipGate = (
  db: PermissionsDb,
  input: { readonly userId: string; readonly tenantId: string },
) => Promise<MembershipVerdict>;

export interface DrizzlePermissionLoaders {
  /**
   * The principal's grants in this tenant, or NULL if they may not act in it
   * (not a member, or the company is suspended).
   *
   * THE NULL IS LOAD-BEARING. Returning an empty set for a tenant the caller
   * has nothing to do with is indistinguishable from "a member who has been
   * granted nothing", and the tenant rung would then admit any signed-in user
   * to any tenant id they typed. Membership is checked first, separately.
   */
  loadTenantPermissions(input: {
    readonly principal: { readonly userId: string };
    readonly tenantId: string;
  }): Promise<PermissionSet | null>;
  /** Staff grants, or NULL if this principal holds no FIRM-WIDE staff role. */
  loadStaffPermissions(input: { readonly principal: { readonly userId: string } }): Promise<PermissionSet | null>;
  /** Why `loadTenantPermissions` answered null: lets the tRPC rung say "suspended" plainly. */
  explainTenantDenial(input: {
    readonly principal: { readonly userId: string };
    readonly tenantId: string;
  }): Promise<"not-a-member" | "company-suspended">;
}

/**
 * The permission loaders, moved here from create-app's emitted
 * `src/server/permissions.ts` so a fix reaches every project by npm (PC-07).
 *
 * THE MEMBERSHIP GATE IS REQUIRED. A loader with no membership check admits
 * anyone to any tenant who holds a stray role row there, so there is no
 * default: the type makes the host say who counts as a member.
 *
 * QUERY BUILDER, NEVER `db.query.*`. The relational API needs the schema
 * registered on the handle, and a package cannot assume the host did that
 * (nor that the tsup CJS build's copy of the table objects is the one the
 * host registered).
 */
export function createDrizzlePermissionLoaders(
  db: PermissionsDb,
  options: { readonly membership: MembershipGate },
): DrizzlePermissionLoaders {
  if (typeof options?.membership !== "function") {
    throw new TypeError(
      "createDrizzlePermissionLoaders needs a membership gate (`{ membership }`). Without one, a stray " +
        "role row would admit someone to a tenant they don't belong to. @adminigloo/tenancy/server " +
        "exports tenancyMembershipGate.",
    );
  }
  const membership = options.membership;

  return {
    async loadTenantPermissions({ principal, tenantId }) {
      const verdict = await membership(db, { userId: principal.userId, tenantId });
      if (verdict !== "member") return null;
      return resolvePermissionsFor(db, { principalId: principal.userId, scope: "tenant", tenantId });
    },

    async loadStaffPermissions({ principal }) {
      // The tenant predicate is NOT optional here, even though staff rows are
      // supposed to live at FIRM_WIDE.
      //
      // Without it this gate and the resolver disagree: the gate matched any
      // staff row, the resolver re-queried pinned to '*', and a staff row
      // written with a real tenant id — the column is plain text, nothing stops
      // it — passed the gate and then resolved to an EMPTY SET. The caller was
      // told "staff who holds no permissions" when the truth is "not staff at
      // all", and those two answers take different branches everywhere: one
      // shows an empty admin panel, the other sends you away. Asking the same
      // question twice, two ways, is how that gap opens.
      const assignment = await db
        .select({ templateId: principalRole.templateId })
        .from(principalRole)
        .where(
          and(
            eq(principalRole.principalId, principal.userId),
            eq(principalRole.scope, "staff"),
            eq(principalRole.tenantId, FIRM_WIDE),
          ),
        )
        .limit(1);
      if (assignment.length === 0) return null;
      return resolvePermissionsFor(db, { principalId: principal.userId, scope: "staff", tenantId: FIRM_WIDE });
    },

    async explainTenantDenial({ principal, tenantId }) {
      const verdict = await membership(db, { userId: principal.userId, tenantId });
      // "member" can't reach here in practice (the loader would have answered
      // a set); reporting it as not-a-member keeps the refusal closed.
      return verdict === "company-suspended" ? "company-suspended" : "not-a-member";
    },
  };
}

/**
 * Two queries, merged in memory: the template's grants and the principal's
 * overrides. Never a round trip per permission check — the caller resolves
 * once per request and hands the set down.
 */
export async function resolvePermissionsFor(
  db: PermissionsDb,
  input: { readonly principalId: string; readonly scope: Scope; readonly tenantId: string },
): Promise<PermissionSet> {
  const assignment = await db
    .select({ templateId: principalRole.templateId })
    .from(principalRole)
    .where(
      and(
        eq(principalRole.principalId, input.principalId),
        eq(principalRole.scope, input.scope),
        eq(principalRole.tenantId, input.tenantId),
      ),
    )
    .limit(1);

  const templateId = assignment[0]?.templateId;
  const templateGrants = templateId
    ? await db
        .select({ permission: roleTemplateGrant.permission, effect: roleTemplateGrant.effect })
        .from(roleTemplateGrant)
        .where(eq(roleTemplateGrant.templateId, templateId))
    : [];

  const overrides = await db
    .select({ permission: principalOverride.permission, effect: principalOverride.effect })
    .from(principalOverride)
    .where(
      and(
        eq(principalOverride.principalId, input.principalId),
        eq(principalOverride.scope, input.scope),
        eq(principalOverride.tenantId, input.tenantId),
      ),
    );

  return createPermissionSet(resolvePermissionSet({ templateGrants, overrides }));
}
