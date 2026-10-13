import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { definePermissions } from "../catalog.js";
import { FIRM_WIDE } from "../constants.js";
import { STAFF_ROLE_TEMPLATES } from "../roles.js";
import { roleTemplate, roleTemplateGrant } from "../schema.js";
import { seedPermissionCatalog } from "../server.js";
import type { TestDb } from "./pglite.js";
import { freshDb, SEED_BOTH, TENANT_TEMPLATES, tenantCatalog } from "./server-helpers.js";

let t: TestDb;
beforeEach(async () => {
  t = await freshDb();
});
afterEach(async () => {
  await t.close();
});

async function grantsOf(scope: "staff" | "tenant", key: string) {
  return t.db
    .select({ permission: roleTemplateGrant.permission, effect: roleTemplateGrant.effect })
    .from(roleTemplateGrant)
    .innerJoin(roleTemplate, eq(roleTemplate.id, roleTemplateGrant.templateId))
    .where(and(eq(roleTemplate.scope, scope), eq(roleTemplate.key, key)));
}

describe("seedPermissionCatalog (PC-09: the seed every deploy runs)", () => {
  it("first run: creates the system templates, grants every defaultFor, seals sealed keys elsewhere", async () => {
    const report = await seedPermissionCatalog(t.db, SEED_BOTH);
    expect([...report.created].sort()).toEqual(
      ["staff/admin", "staff/cs_agent", "staff/cs_lead", "tenant/admin", "tenant/member", "tenant/owner", "tenant/viewer"].sort(),
    );
    const owner = await grantsOf("tenant", "owner");
    expect(owner.filter((g: { effect: string }) => g.effect === "allow").map((g: { permission: string }) => g.permission).sort()).toEqual(
      [...tenantCatalog.defaultsFor("owner")].sort(),
    );
    // tenant.transfer is sealed and only owner gets it: every other template carries a deny row.
    const admin = await grantsOf("tenant", "admin");
    expect(admin).toContainEqual({ permission: "tenant.transfer", effect: "deny" });
    expect(report.sealsAdded).toBeGreaterThan(0);
    const templates = await t.db.select().from(roleTemplate);
    expect(templates.every((row: { isSystem: boolean; tenantId: string }) => row.isSystem && row.tenantId === FIRM_WIDE)).toBe(true);
  });

  it("a second run is a no-op", async () => {
    await seedPermissionCatalog(t.db, SEED_BOTH);
    const again = await seedPermissionCatalog(t.db, SEED_BOTH);
    expect(again.created).toEqual([]);
    expect(again.grantsAdded).toBe(0);
    expect(again.sealsAdded).toBe(0);
    expect(again.sealsLifted).toBe(0);
  });

  it("never touches a customised (non-system) template under a shipped key, and reports it", async () => {
    await t.db.insert(roleTemplate).values({ scope: "tenant", tenantId: FIRM_WIDE, key: "admin", name: "Our admins", rank: 30, isSystem: false });
    const report = await seedPermissionCatalog(t.db, SEED_BOTH);
    expect(report.skippedCustomised).toContain("tenant/admin");
    expect(await grantsOf("tenant", "admin")).toEqual([]);
  });

  it("a key newly added to the catalog reaches the system templates on the next run", async () => {
    await seedPermissionCatalog(t.db, SEED_BOTH);
    const grown = definePermissions("tenant", {
      ...tenantCatalog.permissions,
      "schedule.view": { label: "See the schedule", defaultFor: ["owner", "admin", "member"] },
    });
    const report = await seedPermissionCatalog(t.db, { tenant: { catalog: grown, templates: TENANT_TEMPLATES } });
    expect(report.grantsAdded).toBe(3);
    expect(await grantsOf("tenant", "member")).toContainEqual({ permission: "schedule.view", effect: "allow" });
  });

  it("sealsLifted: a key that was sealed and is now a default turns into allow", async () => {
    await seedPermissionCatalog(t.db, SEED_BOTH);
    expect(await grantsOf("tenant", "admin")).toContainEqual({ permission: "tenant.transfer", effect: "deny" });
    const changed = definePermissions("tenant", {
      ...tenantCatalog.permissions,
      "tenant.transfer": { label: "Transfer", sealed: true, defaultFor: ["owner", "admin"] },
    });
    const report = await seedPermissionCatalog(t.db, { tenant: { catalog: changed, templates: TENANT_TEMPLATES } });
    expect(report.sealsLifted).toBe(1);
    expect(await grantsOf("tenant", "admin")).toContainEqual({ permission: "tenant.transfer", effect: "allow" });
  });

  it("ungrantedKeys lists keys no template holds", async () => {
    const report = await seedPermissionCatalog(t.db, SEED_BOTH);
    expect(report.ungrantedKeys).toEqual([{ scope: "staff", key: "staff.tenants.impersonate" }]);
  });

  it("is idempotent back to back, and takes the advisory lock first", async () => {
    t.queries.length = 0;
    await Promise.all([seedPermissionCatalog(t.db, SEED_BOTH), seedPermissionCatalog(t.db, SEED_BOTH)]);
    const templates = await t.db.select().from(roleTemplate);
    expect(templates).toHaveLength(STAFF_ROLE_TEMPLATES.length + TENANT_TEMPLATES.length);
    expect(t.queries[0]?.sql).toContain("pg_advisory_xact_lock(hashtextextended(");
    expect(t.queries[0]?.params).toEqual(["adminigloo:permissions:seed"]);
  });

  it("refuses a catalog given for the wrong scope", async () => {
    await expect(
      seedPermissionCatalog(t.db, { staff: { catalog: tenantCatalog, templates: STAFF_ROLE_TEMPLATES } }),
    ).rejects.toThrow(/tenant catalog for the staff scope/);
  });
});
