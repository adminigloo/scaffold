import { FIRM_WIDE } from "@adminigloo/permissions";
import {
  ensureBootstrapAdmin as ensureBootstrapAdminGrant,
  seedPermissionCatalog,
  type BootstrapOutcome,
} from "@adminigloo/permissions/server";
import type { BootstrapPolicy } from "@adminigloo/permissions";
import { sql } from "drizzle-orm";
import { grantTenantOwnerRole } from "../ownership.js";

import { personalWorkspaceId, personalWorkspaceSlug } from "../workspace.js";
import type { Ctx } from "./context.js";
import { lockCompany, q, str, strOrNull } from "./db.js";
import { revokeOpenInvitationsBy } from "./invitation-rules.js";
import type {
  BootstrapForEmailOutcome,
  DeprovisionResult,
  ProvisionResult,
  TenancyAuditSink,
  TenancyDb,
} from "./types.js";

/**
 * PROVISIONING IS A STATE MACHINE WITH ONE STAMP (decision D8, contract 6.2).
 *
 *   S0  no `users` row for this identity
 *   S1  a row exists, `provisioned_at` is null
 *   S2  provisioned
 *   SX  soft-deleted
 *
 * Two paths provision: the Clerk webhook (W, after it writes the row) and the
 * first page or API request (P, `currentPrincipal`, after it mirrors the row).
 * They race freely, because every write below is safe to repeat: inserts are
 * `on conflict do nothing`, the pointer write is conditional, the bootstrap
 * runs under its own advisory lock, and the stamp is written LAST, so a crash
 * halfway leaves S1 and the next request finishes the job.
 *
 * THIS IS THE FIX FOR PC-01. In 0.3 the page path provisioned only when IT
 * created the row; when the webhook created it first (on a deployed site, most
 * sign-ups) provisioning was skipped for good and the user had no workspace and
 * no owner role. Now the stamp, not "who wrote the row", decides — and a 0.3
 * user with a null stamp is repaired on their next request.
 *
 * The steps deliberately don't share one transaction: each is idempotent, and
 * the bootstrap has its own transaction and lock.
 */
export async function provisionUser(ctx: Ctx, input: { readonly userId: string; readonly email: string | null }): Promise<ProvisionResult> {
  const { db } = ctx;
  let workspace: string | null = null;

  if (ctx.mode === "personal") {
    // D10: a workspace owner must hold the owner role even on a database
    // nobody has seeded yet.
    await ensureTenantTemplates(ctx, db);
    const own = personalWorkspaceId(input.userId);
    const name = await personalWorkspaceName(db, input.userId, input.email);
    await db.execute(sql`/* adminigloo:tenancy/personal-workspace */
      insert into tenants (id, kind, slug, name, owner_user_id, created_by)
      values (${own}, 'personal', ${personalWorkspaceSlug(input.userId)}, ${name}, ${input.userId}, ${input.userId})
      on conflict do nothing`);
    workspace = (await settleOwnWorkspace(ctx, own, input.userId, name)) ? own : null;
  }
  // Companies mode: nothing tenant-shaped. Onboarding creates the company, and
  // invitations are NEVER auto-accepted (D19): an account must not join a
  // company as a side effect of signing in.

  const bootstrap = await bootstrapWithAudit(db, {
    userId: input.userId,
    email: input.email,
    policy: ctx.bootstrap,
    audit: (tx, event) => ctx.audit(tx, event),
  });

  const stamped = await q(
    db,
    sql`/* adminigloo:tenancy/provision-stamp */
      update users set provisioned_at = ${ctx.now()} where id = ${input.userId} and provisioned_at is null returning id`,
  );
  return { personalWorkspaceId: workspace, bootstrap, stamped: stamped.length > 0 };
}

/**
 * The owner's own rows in a personal workspace — ONLY WHILE IT IS STILL
 * THEIRS (review R2 SEC-T1-A).
 *
 * A personal workspace can be handed over: Transfer, or staff "Change owner".
 * `ws_<user>` keeps its id, but it belongs to the new owner from then on. This
 * used to re-insert the old owner's membership and owner role whenever it ran
 * — on their next page view (the session heal) and on every Clerk
 * `user.updated` — so a former owner whom the new owner had removed came
 * straight back holding the owner template: two owner-role holders (D4
 * broken) and a removal that never stuck. Now, under the company lock (D7),
 * the membership, the owner role, the default-name fix and the pointer are
 * written only while `owner_user_id` is this person. That still repairs what
 * it was for: a 0.3 owner with no membership or no role (PC-01). Returns
 * whether they own it.
 */
async function settleOwnWorkspace(ctx: Ctx, tenantId: string, userId: string, name: string): Promise<boolean> {
  return ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as TenancyDb;
    const company = await lockCompany(tx, tenantId);
    if (!company || company.deletedAt !== null || company.ownerUserId !== userId) return false;
    // A 0.3 workspace is called "Personal"; with two of them in one menu (an
    // invited person sees theirs and the inviter's) nobody can tell them apart
    // (TB-DEPLOY-10). Rename only the untouched default.
    await tx.execute(sql`/* adminigloo:tenancy/personal-workspace-name */
      update tenants set name = ${name}, updated_at = now() where id = ${tenantId} and name = 'Personal'`);
    await tx.execute(sql`/* adminigloo:tenancy/personal-membership */
      insert into tenant_members (tenant_id, user_id, status) values (${tenantId}, ${userId}, 'active')
      on conflict (tenant_id, user_id) do nothing`);
    await grantTenantOwnerRole(tx, { tenantId, userId });
    await tx.execute(sql`/* adminigloo:tenancy/personal-pointer */
      update users set active_tenant_id = ${tenantId} where id = ${userId} and active_tenant_id is null`);
    return true;
  });
}

/**
 * Single-business mode promises every person a workspace of their own (D6).
 * Someone who handed theirs over and was then removed from it (or left) has
 * none, and `ws_<user>` is someone else's now — so they get a NEW, empty one
 * under the next free id (`ws_<user>.2`, `.3`, …) instead of being put back
 * into the one they gave away (review R2 SEC-T1-A). Under the per-user create
 * lock, so two page views at once make one. Reuses a live personal workspace
 * they already own. Returns its id.
 */
export async function ensureFreshPersonalWorkspace(
  ctx: Ctx,
  input: { readonly userId: string; readonly email: string | null },
): Promise<string> {
  await ensureTenantTemplates(ctx, ctx.db);
  const name = await personalWorkspaceName(ctx.db, input.userId, input.email);
  return ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as TenancyDb;
    await tx.execute(sql`/* adminigloo:tenancy/create-lock */
      select pg_advisory_xact_lock(hashtextextended(${`adminigloo:tenancy:create:${input.userId}`}, 0))`);
    const owned = await q(
      tx,
      sql`/* adminigloo:tenancy/personal-owned */
        select id from tenants where owner_user_id = ${input.userId} and kind = 'personal' and deleted_at is null
        order by created_at, id limit 1`,
    );
    let id = strOrNull(owned[0]?.["id"]);
    const base = personalWorkspaceId(input.userId);
    const slugBase = personalWorkspaceSlug(input.userId);
    for (let n = 2; n <= 50 && id === null; n += 1) {
      const inserted = await q(
        tx,
        sql`/* adminigloo:tenancy/personal-workspace-fresh */
          insert into tenants (id, kind, slug, name, owner_user_id, created_by)
          values (${`${base}.${n}`}, 'personal', ${`${slugBase}-${n}`}, ${name}, ${input.userId}, ${input.userId})
          on conflict do nothing returning id`,
      );
      id = strOrNull(inserted[0]?.["id"]);
    }
    if (id === null) throw ctx.fail("internal");
    await lockCompany(tx, id);
    await tx.execute(sql`/* adminigloo:tenancy/personal-membership */
      insert into tenant_members (tenant_id, user_id, status) values (${id}, ${input.userId}, 'active')
      on conflict (tenant_id, user_id) do nothing`);
    await grantTenantOwnerRole(tx, { tenantId: id, userId: input.userId });
    await tx.execute(sql`/* adminigloo:tenancy/personal-pointer */
      update users set active_tenant_id = ${id} where id = ${input.userId}`);
    return id;
  });
}

/** "Sam Lee's workspace", or the address's, or a plain fallback (TB-DEPLOY-10). */
async function personalWorkspaceName(db: TenancyDb, userId: string, email: string | null): Promise<string> {
  const rows = await q(db, sql`/* adminigloo:tenancy/user-name */ select display_name, email from users where id = ${userId}`);
  const who = strOrNull(rows[0]?.["display_name"]) ?? email ?? strOrNull(rows[0]?.["email"]);
  return who ? `${who.slice(0, 60)}'s workspace` : "Personal workspace";
}

/**
 * D10: if any of the project's tenant templates is missing, seed the tenant
 * scope from the project's catalog (under the seed's advisory lock, in the
 * caller's transaction). Without this the owner of the first company on a
 * fresh database would hold nothing in it.
 *
 * Tenancy 2a: the PROJECT's role set (`ctx.roles.templates`: the core four
 * plus extras like Crew), not the shipped four, and missing means "any of
 * them": a database seeded before Crew existed gets Crew on the next company
 * created, instead of an invitation to a role that grants nothing.
 */
export async function ensureTenantTemplates(ctx: Ctx, tx: TenancyDb): Promise<void> {
  const keys = ctx.roles.keys;
  const rows = await q(
    tx,
    sql`/* adminigloo:tenancy/owner-template */
      select count(distinct key) as n from role_template
      where scope = 'tenant' and tenant_id = ${FIRM_WIDE} and deleted_at is null
        and key in (${sql.join(keys.map((key) => sql`${key}`), sql`, `)})`,
  );
  if (Number(rows[0]?.["n"] ?? 0) >= keys.length) return;
  await seedPermissionCatalog(tx, { tenant: { catalog: ctx.tenantCatalog, templates: ctx.roles.templates } });
}

function bootstrapEligible(policy: BootstrapPolicy, email: string | null): BootstrapOutcome | null {
  if (policy.mode === "off") return { granted: false, reason: "off" };
  if (policy.mode === "email") {
    const want = policy.email.trim().toLowerCase();
    const have = email?.trim().toLowerCase() ?? "";
    if (!want || !have || want !== have) return { granted: false, reason: "not-eligible" };
  }
  return null;
}

const isActiveUser = async (tx: TenancyDb, principalId: string): Promise<boolean> =>
  (await q(tx, sql`/* adminigloo:tenancy/user-active */ select 1 from users where id = ${principalId} and deleted_at is null`)).length > 0;

/**
 * `ensureBootstrapAdmin` plus its audit row, in ONE transaction: the grant and
 * `staff.bootstrap.granted` commit together or not at all (a failing sink rolls
 * the grant back, and provisioning then leaves the stamp null for a retry).
 * The eligibility check runs first, so a non-matching visitor costs no query.
 */
async function bootstrapWithAudit(
  db: TenancyDb,
  input: { userId: string; email: string | null; policy: BootstrapPolicy; audit?: TenancyAuditSink },
): Promise<BootstrapOutcome> {
  const early = bootstrapEligible(input.policy, input.email);
  if (early) return early;
  return db.transaction(async (raw) => {
    const tx = raw as unknown as TenancyDb;
    const outcome = await ensureBootstrapAdminGrant(tx, {
      principalId: input.userId,
      email: input.email,
      policy: input.policy,
      isActivePrincipal: isActiveUser,
    });
    if (outcome.granted && input.audit) {
      await input.audit(tx, {
        action: "staff.bootstrap.granted",
        actorUserId: null,
        scope: "staff",
        tenantId: null,
        resourceType: "staff_role",
        resourceId: input.userId,
        metadata: { templateKey: "admin", policy: input.policy.mode },
        request: null,
      });
    }
    return outcome;
  });
}

/** The /admin layout's self-heal (D9): retried whenever a non-staff person opens /admin. */
export function ensureBootstrapAdmin(ctx: Ctx, input: { readonly userId: string; readonly email: string | null }): Promise<BootstrapOutcome> {
  return bootstrapWithAudit(ctx.db, { userId: input.userId, email: input.email, policy: ctx.bootstrap, audit: (tx, e) => ctx.audit(tx, e) });
}

/**
 * The seed's backfill: make the BOOTSTRAP_ADMIN_EMAIL person an administrator
 * when no admin exists, from a script that has no service (and must not import
 * the app's env).
 *
 * AMBIGUITY IS REFUSED (review T1-02). `users.email` isn't unique: two
 * accounts can carry the same verified address at different times. Picking
 * one would make the grant depend on row order — and could pick an attacker's
 * account. So more than one match grants nobody and names the ids, for a
 * person to sort out with `admin:grant`.
 */
export async function ensureBootstrapAdminForEmail(
  db: TenancyDb,
  input: { readonly email: string; readonly audit?: TenancyAuditSink },
): Promise<BootstrapForEmailOutcome> {
  const email = input.email.trim().toLowerCase();
  if (!email) return { granted: false, reason: "not-eligible", userId: null };
  const rows = await q(
    db,
    sql`/* adminigloo:tenancy/user-by-email */
      select id from users where lower(email) = ${email} and deleted_at is null order by created_at, id`,
  );
  if (rows.length === 0) return { granted: false, reason: "not-eligible", userId: null };
  if (rows.length > 1) {
    return { granted: false, reason: "not-eligible", userId: null, ambiguous: rows.map((r) => str(r["id"])) };
  }
  const userId = str(rows[0]?.["id"]);
  const outcome = await bootstrapWithAudit(db, {
    userId,
    email,
    policy: { mode: "email", email },
    ...(input.audit ? { audit: input.audit } : {}),
  });
  return { ...outcome, userId };
}

/**
 * A user deleted at the identity provider (webhook `user.deleted`, after the
 * soft delete). In one transaction:
 *
 *   - their staff roles and staff overrides are deleted (audited);
 *   - their memberships become `suspended`, so rosters keep the name ("Account
 *     closed") and the gate refuses them;
 *   - the open invitations they sent are withdrawn (review T1-03: an
 *     invitation is the inviter's authority, and that authority just ended);
 *   - their pointer is cleared.
 *
 * Ownership is never moved automatically. The companies they still own are
 * returned, and the operator console offers "Change owner" for them.
 */
export async function deprovisionUser(ctx: Ctx, input: { readonly userId: string }): Promise<DeprovisionResult> {
  return ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as TenancyDb;
    // D7's lock order: company rows FIRST (sorted, so two deprovisions can't
    // cross), then everything that hangs off them. Updating a membership row
    // before its company would deadlock against a removeMember that took the
    // company lock first.
    await tx.execute(sql`/* adminigloo:tenancy/deprovision-lock-companies */
      select id from tenants
      where id in (
        select tenant_id from tenant_members where user_id = ${input.userId}
        union
        select tenant_id from tenant_invitations where invited_by = ${input.userId} and accepted_at is null and revoked_at is null
      )
      order by id
      for update`);
    const staff = await q(
      tx,
      sql`/* adminigloo:tenancy/deprovision-staff */
        delete from principal_role where principal_id = ${input.userId} and scope = 'staff' returning tenant_id, template_id`,
    );
    await tx.execute(sql`/* adminigloo:tenancy/deprovision-staff-overrides */
      delete from principal_override where principal_id = ${input.userId} and scope = 'staff'`);
    for (const row of staff) {
      await ctx.audit(tx, {
        action: "staff.role.removed",
        actorUserId: null,
        scope: "staff",
        tenantId: null,
        resourceType: "staff_role",
        resourceId: input.userId,
        metadata: { via: "account.deleted", templateId: str(row["template_id"]) },
      });
    }
    const memberships = await q(
      tx,
      sql`/* adminigloo:tenancy/deprovision-memberships */
        update tenant_members set status = 'suspended', updated_at = now()
        where user_id = ${input.userId} and status <> 'suspended' returning tenant_id`,
    );
    let invitationsRevoked = 0;
    const sentIn = await q(
      tx,
      sql`/* adminigloo:tenancy/deprovision-invited-tenants */
        select distinct tenant_id from tenant_invitations
        where invited_by = ${input.userId} and accepted_at is null and revoked_at is null`,
    );
    for (const row of sentIn) {
      invitationsRevoked += await revokeOpenInvitationsBy(ctx, tx, {
        tenantId: str(row["tenant_id"]),
        inviterUserId: input.userId,
        minRank: 0,
        via: "account.deleted",
      });
    }
    await tx.execute(sql`/* adminigloo:tenancy/deprovision-pointer */
      update users set active_tenant_id = null where id = ${input.userId}`);
    const owned = await q(
      tx,
      sql`/* adminigloo:tenancy/deprovision-owned */
        select id from tenants where owner_user_id = ${input.userId} and kind = 'org' and deleted_at is null order by created_at`,
    );
    return {
      staffRolesRemoved: staff.length,
      membershipsSuspended: memberships.length,
      invitationsRevoked,
      ownedCompanies: owned.map((r) => str(r["id"])),
    };
  });
}
