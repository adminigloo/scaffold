import { and, eq, isNull, sql } from "drizzle-orm";
import { FIRM_WIDE } from "../constants.js";
import type { BootstrapPolicy } from "../roles.js";
import { principalRole, roleTemplate } from "../schema.js";
import { inTransaction, type PermissionsDb } from "./db.js";

/**
 * Advisory-lock key. Arbitrary, but must be stable: it is the number
 * create-app's template used before this moved here, kept so a mixed-version
 * rollout (an old instance and a new one on one database) still excludes
 * itself, and two deployments of the same app share a database only if they
 * share this number.
 */
export const BOOTSTRAP_ADMIN_LOCK_KEY = 8_140_231;

export type BootstrapOutcome =
  | { readonly granted: true }
  | { readonly granted: false; readonly reason: "off" | "not-eligible" | "admin-exists" | "templates-missing" };

export interface EnsureBootstrapAdminInput {
  readonly principalId: string;
  /**
   * The person's VERIFIED address (what `@adminigloo/auth` mirrors into
   * `users.email`, which never holds an unverified one). In email mode this is
   * the whole security story: an address the identity provider never verified
   * must not be passed here, or whoever typed the founder's address into their
   * profile becomes platform admin.
   */
  readonly email: string | null;
  readonly policy: BootstrapPolicy;
  /** Default "admin". */
  readonly adminTemplateKey?: string;
  /**
   * Does this principal still exist? Tenancy passes a users-table check, so a
   * deleted user's leftover admin row doesn't count as "an admin exists" —
   * which is exactly the case the self-heal is for (a founder who closed and
   * recreated their account).
   */
  readonly isActivePrincipal?: (tx: PermissionsDb, principalId: string) => Promise<boolean>;
}

/**
 * Make the BOOTSTRAP person a platform administrator, whenever no
 * administrator exists (decision D9) — not only on that person's first
 * sign-in. Retried from every place it can matter: provisioning, the /admin
 * layout's self-heal, both seeds. `admin:grant` is the manual recovery.
 *
 * WHO QUALIFIES DEPENDS ON WHERE YOU ARE RUNNING, and the difference is not
 * pedantry:
 *
 *   first-user  local development: the first person to arrive while no admin
 *               exists. Your laptop, your database.
 *
 *   email       a deployment: only the person whose VERIFIED address matches
 *               BOOTSTRAP_ADMIN_EMAIL. "Whoever signs in first" is a race
 *               against the public internet: a marketing site is reachable
 *               the moment it deploys, and a stranger who creates an account
 *               before you would own your admin panel. The window is small
 *               and the loss is total.
 *
 *   off         a deployment with no BOOTSTRAP_ADMIN_EMAIL grants nobody;
 *               the first role is given with `pnpm admin:grant`.
 *
 * THE POLICY CHECK RUNS BEFORE ANY QUERY, so a non-matching person visiting
 * /admin (the layout calls this for every non-staff visitor) costs nothing.
 *
 * SERIALISED BY AN ADVISORY LOCK, and the reason is worth reading before
 * anyone "simplifies" it away. A bare `INSERT … WHERE NOT EXISTS` is not
 * atomic under READ COMMITTED: the subquery neither sees nor waits on another
 * transaction's uncommitted insert, and `principal_role`'s primary key is
 * (principal_id, scope, tenant_id), so two different people collide on
 * nothing. An integration test firing two concurrent sign-ins on separate
 * connections once got TWO administrators. There is no index that expresses
 * "at most one admin", so the fix is a lock, taken first in the transaction.
 *
 * SELF-HOSTED DEPLOYMENTS: the caller decides first-user vs email from the
 * app environment (`resolveAppEnv()`), which recognises every host; an
 * unlabelled host is not "local", so it never hands admin to the first
 * stranger.
 *
 * STAFF SCOPE ONLY. Tenant templates are seeded at the same FIRM_WIDE tenant
 * id and a company role is ALSO called "admin". Every lookup here is pinned to
 * scope = 'staff': picking the company "admin" template would give the founder
 * a staff row that admits them to /admin with no staff permissions, after
 * which every call answers admin-exists and they're locked out for good.
 */
export async function ensureBootstrapAdmin(
  db: PermissionsDb,
  input: EnsureBootstrapAdminInput,
): Promise<BootstrapOutcome> {
  const policy = input.policy;
  if (policy.mode === "off") return { granted: false, reason: "off" };
  if (policy.mode === "email") {
    const wanted = policy.email.trim().toLowerCase();
    const have = input.email?.trim().toLowerCase() ?? "";
    if (wanted === "" || have === "" || have !== wanted) return { granted: false, reason: "not-eligible" };
  }
  const adminKey = input.adminTemplateKey ?? "admin";

  return inTransaction(db, async (tx) => {
    await tx.execute(
      sql`/* adminigloo:permissions/bootstrap-lock */ select pg_advisory_xact_lock(${BOOTSTRAP_ADMIN_LOCK_KEY})`,
    );

    const templates = await tx
      .select({ id: roleTemplate.id })
      .from(roleTemplate)
      .where(
        and(
          eq(roleTemplate.scope, "staff"),
          eq(roleTemplate.tenantId, FIRM_WIDE),
          eq(roleTemplate.key, adminKey),
          isNull(roleTemplate.deletedAt),
        ),
      )
      .limit(1);
    const template = templates[0];
    // Not seeded yet. Nothing to grant, and inventing a template here would
    // create one the seed then refuses to touch (it isn't is_system).
    if (!template) return { granted: false, reason: "templates-missing" };

    const holders = await tx
      .select({ principalId: principalRole.principalId })
      .from(principalRole)
      .where(
        and(
          eq(principalRole.scope, "staff"),
          eq(principalRole.tenantId, FIRM_WIDE),
          eq(principalRole.templateId, template.id),
        ),
      );
    for (const holder of holders) {
      if (!input.isActivePrincipal || (await input.isActivePrincipal(tx, holder.principalId))) {
        return { granted: false, reason: "admin-exists" };
      }
    }

    // Upsert: a crew-only or cs_agent staff row is PROMOTED. When no admin
    // exists, the bootstrap person must become one; leaving them at a lower
    // rung would leave the platform with nobody who can hire anybody.
    await tx
      .insert(principalRole)
      .values({ principalId: input.principalId, scope: "staff", tenantId: FIRM_WIDE, templateId: template.id })
      .onConflictDoUpdate({
        target: [principalRole.principalId, principalRole.scope, principalRole.tenantId],
        set: { templateId: template.id, updatedAt: sql`now()` },
      });
    return { granted: true };
  });
}
