import { and, eq, sql } from "drizzle-orm";
import { FIRM_WIDE } from "__SCOPE__/permissions";
import { principalRole, roleTemplate } from "__SCOPE__/permissions/schema";
import { resolveAppEnv } from "__SCOPE__/env";
import { db } from "@/db";
import { env } from "@/env";

/**
 * Make the first person through the door a full administrator.
 *
 * Without this, a fresh install has nobody who can grant anybody anything: the
 * permission model is deny-by-default all the way down, so `/admin` is
 * unreachable by every user including the person who deployed it, and the only
 * way in is hand-writing a row with a database client. That is a bad first ten
 * minutes and it is the reason this function exists.
 *
 * WHO QUALIFIES DEPENDS ON WHERE YOU ARE RUNNING, and the difference is not
 * pedantry:
 *
 *   local       the first user to sign in. Your laptop, your database.
 *
 *   deployed    the first user WHOSE EMAIL MATCHES `BOOTSTRAP_ADMIN_EMAIL`.
 *               "Whoever signs in first" is a race against the public internet.
 *               A marketing site is reachable the moment it deploys, and if a
 *               stranger creates an account before you do, they own your admin
 *               panel — your customer list, your audit log, impersonation. The
 *               window is small and the loss is total, which is exactly the
 *               shape of bug that gets shipped because it seemed unlikely.
 *               With no `BOOTSTRAP_ADMIN_EMAIL` set, a deployment grants
 *               nothing automatically and you assign the first role by hand.
 *
 * SERIALISED BY AN ADVISORY LOCK, and the reason is worth reading before anyone
 * "simplifies" it away.
 *
 * This used to be a bare `INSERT … SELECT … WHERE NOT EXISTS`, with a comment
 * claiming that made it atomic. It does not. Under READ COMMITTED the NOT
 * EXISTS subquery neither sees nor waits on another transaction's uncommitted
 * INSERT, and `principal_role`'s primary key is (principal_id, scope,
 * tenant_id) — so two different user ids collide on nothing and
 * `ON CONFLICT DO NOTHING` has no constraint to fire against. An integration
 * test firing two concurrent sign-ins on separate connections got TWO
 * administrators. On a public deployment that is two strangers, not one.
 *
 * There is no index that expresses "at most one staff row", so the fix is a
 * lock rather than a constraint. `pg_advisory_xact_lock` serialises the check
 * and the insert against every other backend, and releases on commit or
 * rollback with no cleanup path to forget. It costs one round trip, once, on
 * the first sign-in of a deployment's life.
 */
/**
 * Advisory-lock key. Arbitrary, but must be stable: two deployments of the same
 * app share a database only if they share this number, and changing it would
 * silently stop excluding an older running instance mid-rollout.
 */
const BOOTSTRAP_LOCK_KEY = 8_140_231;

export async function grantBootstrapAdminIfFirst(
  userId: string,
  email: string | null,
): Promise<boolean> {
  const appEnv = resolveAppEnv();

  if (appEnv !== "local") {
    const expected = env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
    if (!expected) return false;
    if (!email || email.trim().toLowerCase() !== expected) return false;
  }

  const template = await db.query.roleTemplate.findFirst({
    where: and(
      eq(roleTemplate.scope, "staff"),
      eq(roleTemplate.key, "admin"),
      eq(roleTemplate.tenantId, FIRM_WIDE),
    ),
  });

  // No templates seeded yet (`pnpm db:seed`). Nothing to grant, and inventing a
  // template here would create one that the seed then duplicates.
  if (!template) return false;

  const granted = await db.transaction(async (tx) => {
    // Serialise every caller of this function, across every connection. The key
    // is an arbitrary constant — any two backends using the same number
    // exclude each other, and nothing else in this app takes an advisory lock.
    await tx.execute(sql`select pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`);

    const inserted = await tx.execute(sql`
      insert into principal_role (principal_id, scope, tenant_id, template_id)
      select ${userId}, 'staff', ${FIRM_WIDE}, ${template.id}
      where not exists (
        select 1 from principal_role where scope = 'staff'
      )
      on conflict do nothing
      returning principal_id
    `);

    return (inserted as unknown as { rows: unknown[] }).rows.length > 0;
  });

  if (granted) {
    console.info(
      `[bootstrap] granted staff:admin to ${email ?? userId} — first staff user. ` +
        `Every later staff role is assigned from /admin.`,
    );
  }

  return granted;
}
