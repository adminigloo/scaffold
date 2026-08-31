/**
 * Seed the role templates and their grants.
 *
 * Idempotent: safe to re-run after adding a permission to the catalog. It only
 * ever touches templates marked `is_system`, never one a client has
 * customised — a catalog upgrade that rewrote a hand-edited template would
 * silently revoke access somebody deliberately granted.
 *
 *   pnpm tsx scripts/seed-roles.ts
 */
import { and, eq } from "drizzle-orm";
import { FIRM_WIDE } from "__SCOPE__/permissions";
import { roleTemplate, roleTemplateGrant } from "__SCOPE__/permissions/schema";
import { backfillTenantOwnerRoles, TENANT_ROLE_TEMPLATES } from "__SCOPE__/tenancy";
import { db } from "../src/db";
import { staffCatalog, tenantCatalog } from "../src/permissions/catalog";

/** The internal ladder. Rank drives the privilege-escalation guards. */
const STAFF_TEMPLATES = [
  { key: "admin", name: "Administrator", rank: 30 },
  { key: "cs_lead", name: "Customer service lead", rank: 20 },
  { key: "cs_agent", name: "Customer service agent", rank: 10 },
] as const;

async function upsertTemplate(input: {
  scope: "staff" | "tenant";
  key: string;
  name: string;
  rank: number;
}) {
  const existing = await db.query.roleTemplate.findFirst({
    where: and(
      eq(roleTemplate.scope, input.scope),
      eq(roleTemplate.tenantId, FIRM_WIDE),
      eq(roleTemplate.key, input.key),
    ),
  });

  if (existing) {
    if (!existing.isSystem) {
      console.log(`  skip ${input.scope}/${input.key} — customised, not touching it`);
      return null;
    }
    return existing.id;
  }

  const [created] = await db
    .insert(roleTemplate)
    .values({ ...input, tenantId: FIRM_WIDE, isSystem: true })
    .returning({ id: roleTemplate.id });

  return created?.id ?? null;
}

async function applyDefaults(
  templateId: string,
  keys: readonly string[],
  sealedKeys: readonly string[],
) {
  for (const permission of keys) {
    await db
      .insert(roleTemplateGrant)
      .values({ templateId, permission, effect: "allow" })
      .onConflictDoNothing();
  }
  // A sealed permission gets an explicit deny row. Since omission already
  // denies, a deny row means something stronger: an override cannot reopen it.
  for (const permission of sealedKeys) {
    await db
      .insert(roleTemplateGrant)
      .values({ templateId, permission, effect: "deny" })
      .onConflictDoNothing();
  }
}

async function main() {
  console.log("Seeding tenant role templates…");
  for (const template of TENANT_ROLE_TEMPLATES) {
    const id = await upsertTemplate({ scope: "tenant", ...template });
    if (!id) continue;
    const sealed = tenantCatalog.keys.filter(
      (k) => tenantCatalog.isSealed(k) && !tenantCatalog.defaultsFor(template.key).includes(k),
    );
    await applyDefaults(id, tenantCatalog.defaultsFor(template.key), sealed);
    console.log(`  ${template.key}: ${tenantCatalog.defaultsFor(template.key).length} granted`);
  }

  console.log("Seeding staff role templates…");
  for (const template of STAFF_TEMPLATES) {
    const id = await upsertTemplate({ scope: "staff", ...template });
    if (!id) continue;
    const sealed = staffCatalog.keys.filter(
      (k) => staffCatalog.isSealed(k) && !staffCatalog.defaultsFor(template.key).includes(k),
    );
    await applyDefaults(id, staffCatalog.defaultsFor(template.key), sealed);
    console.log(`  ${template.key}: ${staffCatalog.defaultsFor(template.key).length} granted`);
  }

  // AFTER the templates exist, because the backfill resolves the owner template
  // by key and writes nothing when it is absent.
  //
  // WHY A BACKFILL BELONGS IN THE SEED SCRIPT. Owners are given their role at
  // workspace creation, and that repairs nobody who has already signed up:
  // `ensurePersonalWorkspace` runs on a user's FIRST sign-in only, so every
  // account that existed before the fix keeps holding nothing in its own
  // workspace forever. This is the one script that is already documented as
  // safe to re-run after a permission change, already idempotent, and already
  // in the deploy path — which makes it the place the repair actually happens
  // rather than the place it is written down.
  console.log("Backfilling owner roles…");
  const granted = await backfillTenantOwnerRoles(db);
  console.log(
    granted === 0
      ? "  every tenant owner already holds a role"
      : `  ${granted} owner${granted === 1 ? "" : "s"} granted the owner role`,
  );

  console.log("Done.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
