import { sql, type SQL } from "drizzle-orm";

/**
 * The owner of a tenant holds the owner role in it.
 *
 * *** WITHOUT THIS, A TENANT OWNER HOLDS NOTHING IN THEIR OWN WORKSPACE. ***
 *
 * `tenants.owner_user_id` records who a tenant belongs to and `tenant_members`
 * records that they are in it. Neither is a permission. @adminigloo/permissions
 * is deny-by-default all the way down and grants NOTHING implicitly — a
 * principal's rights are the union of one `principal_role` row and their
 * per-person overrides, and an owner who has neither has none. So a customer
 * who signed up, was given a personal workspace, and bought something held zero
 * permissions in the only tenant they belonged to: `/account/billing` told them
 * the renewal amount is "shown to whoever holds subscriptions.view — normally
 * its owner" while they WERE the owner, `account.billingPortal` answered
 * FORBIDDEN, and inviting anybody was refused because they had no rank to
 * compare an invitation against. Nothing errored anywhere; the product simply
 * behaved as though the customer were a stranger in their own account.
 *
 * WHY A ROW AND NOT A RULE IN THE RESOLVER. The obvious alternative is to teach
 * `resolvePermissionSet` that an owner implicitly holds the owner template. It
 * is fewer lines and it repairs every existing tenant with no migration, and it
 * is the wrong answer, because it costs the one property the permission model
 * is built on: everything a principal can do is a row you can read, join, diff
 * and audit. An implicit grant appears in no table. The admin checklist could
 * not render it, `explainPermission` could not attribute it, revoking it would
 * mean special-casing the owner pointer, and the answer to "why can this person
 * refund" would live in a resolver's source rather than in the database. The
 * scaffold already refuses that trade elsewhere — `tenant_members` deliberately
 * has no role column so that there is exactly one place a role is written — and
 * accepting it here would put a second, invisible source of authority beside
 * the visible one.
 *
 * The cost of choosing rows is that existing tenants need backfilling, which is
 * `backfillTenantOwnerRoles` below, and that is a cost paid once by a script
 * anybody can read the output of.
 *
 * IT NEVER THROWS AND IT NEVER PROMOTES. Both statements are a single
 * `insert … select` against `role_template`, so a database whose templates have
 * not been seeded yet inserts zero rows and reports zero rather than failing:
 * `ensurePersonalWorkspace` runs inside a user's first sign-in, and an
 * unseeded `role_template` table must not turn that into a 500. And both carry
 * `on conflict do nothing` against `principal_role`'s primary key, so an owner
 * who has deliberately been assigned a LOWER template — a founder who handed
 * day-to-day control over and kept only the ownership pointer — is never
 * silently promoted back.
 *
 * NO TABLE OBJECTS, NO `drizzle-orm/pg-core`, for the reason `service.ts` gives
 * at length: this package's root is imported by client components for
 * `TENANT_ROLE_TEMPLATES`, and importing the schema would drag the query
 * builder into every one of those bundles. The statements are written as SQL
 * against an `execute`-shaped handle, which is also what lets a transaction or
 * a test double satisfy the dependency with no cast at the call site.
 */

/**
 * The template key an owner is given.
 *
 * A constant rather than the string, because it has to agree with
 * `TENANT_ROLE_TEMPLATES` in templates.ts, with every `defaultFor: ["owner"]`
 * in every package's catalog fragment, and with the row `scripts/seed-roles.ts`
 * writes. Four spellings of one word, and the day one of them drifts the owner
 * silently goes back to holding nothing.
 */
export const TENANT_OWNER_TEMPLATE_KEY = "owner";

/**
 * The sentinel tenant that firm-wide rows use, mirroring `FIRM_WIDE` from
 * @adminigloo/permissions. Copied rather than imported for the bundle reason
 * above; a test that DOES import it pins the two together.
 */
const FIRM_WIDE_TENANT = "*";

/** The narrowest handle these statements need. A `db` or a `tx` both satisfy it. */
export interface OwnerRoleDb {
  execute(query: SQL): PromiseLike<unknown>;
}

function rowCount(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  if (typeof result === "object" && result !== null) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows.length;
  }
  // Unreadable is not zero. A driver shape this cannot count from would make
  // "granted nothing" and "granted something we could not see" the same
  // answer, and the caller logs one of those and not the other.
  return -1;
}

/**
 * Give one tenant's owner the owner role in it. Returns whether a row was
 * written — false when they already hold a role, or when the templates have not
 * been seeded.
 *
 * Called at workspace creation, where it is the difference between a new
 * customer being able to see their own billing and not.
 */
export async function grantTenantOwnerRole(
  db: OwnerRoleDb,
  input: { readonly tenantId: string; readonly userId: string },
): Promise<boolean> {
  const result = await db.execute(
    sql`/* adminigloo:tenancy/grant-owner-role */
      insert into principal_role (principal_id, scope, tenant_id, template_id)
      select ${input.userId}, 'tenant', ${input.tenantId}, t.id
      from role_template t
      where t.scope = 'tenant'
        and t.tenant_id = ${FIRM_WIDE_TENANT}
        and t.key = ${TENANT_OWNER_TEMPLATE_KEY}
        and t.deleted_at is null
      on conflict (principal_id, scope, tenant_id) do nothing
      returning principal_id`,
  );
  return rowCount(result) > 0;
}

/**
 * Give every tenant's owner the owner role, where they hold no role already.
 * Returns how many rows were written.
 *
 * THE REPAIR FOR WORKSPACES THAT ALREADY EXIST, and it is needed because
 * `ensurePersonalWorkspace` only ever runs on a user's FIRST sign-in — the
 * mirror path that calls it is skipped the moment a `users` row exists. So
 * fixing creation fixes nobody who has already signed up, and every existing
 * customer would stay locked out of their own billing for as long as their
 * account lives. Run from `scripts/seed-roles.ts`, which is already the
 * documented "re-run me after the catalog changes" script and is already
 * idempotent.
 *
 * Covers organisations as well as personal workspaces. The defect is not
 * special to `ensurePersonalWorkspace`: any tenant created with an
 * `owner_user_id` and no role row has it, and an org whose founder cannot open
 * the billing portal is the same ticket.
 *
 * Soft-deleted tenants are skipped — resurrecting authority in a tenant
 * somebody deleted is not a repair — and so is an owner who is not an active
 * member, because a suspended owner is a suspension somebody performed on
 * purpose and this must not quietly reverse it.
 */
export async function backfillTenantOwnerRoles(db: OwnerRoleDb): Promise<number> {
  const result = await db.execute(
    sql`/* adminigloo:tenancy/backfill-owner-roles */
      insert into principal_role (principal_id, scope, tenant_id, template_id)
      select tn.owner_user_id, 'tenant', tn.id, t.id
      from tenants tn
      join tenant_members m
        on m.tenant_id = tn.id
       and m.user_id = tn.owner_user_id
       and m.status = 'active'
      join role_template t
        on t.scope = 'tenant'
       and t.tenant_id = ${FIRM_WIDE_TENANT}
       and t.key = ${TENANT_OWNER_TEMPLATE_KEY}
       and t.deleted_at is null
      where tn.owner_user_id is not null
        and tn.deleted_at is null
      on conflict (principal_id, scope, tenant_id) do nothing
      returning principal_id`,
  );
  const written = rowCount(result);
  return written < 0 ? 0 : written;
}
