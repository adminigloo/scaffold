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
 * Atomic by construction. The grant is one INSERT…SELECT…WHERE NOT EXISTS, so
 * two simultaneous first sign-ins cannot both win — the second sees the first's
 * row and inserts nothing. A read-then-write would hand admin to both.
 */
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

  const result = await db.execute(sql`
    insert into principal_role (principal_id, scope, tenant_id, template_id)
    select ${userId}, 'staff', ${FIRM_WIDE}, ${template.id}
    where not exists (
      select 1 from principal_role where scope = 'staff'
    )
    on conflict do nothing
    returning principal_id
  `);

  const granted =
    (result as unknown as { rows: unknown[] }).rows.length > 0;

  if (granted) {
    console.info(
      `[bootstrap] granted staff:admin to ${email ?? userId} — first staff user. ` +
        `Every later staff role is assigned from /admin.`,
    );
  }

  return granted;
}
