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
    expect(again.sealsApplied).toBe(0);
    expect(again.withdrawn).toEqual([]);
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

  /**
   * THE OTHER DIRECTION (0.4, review): a catalog that takes a key away from a
   * role and SEALS it — a consumers project's team keys, which no role may
   * hold — on a database a business-era seed already wrote. Before, the deny
   * row clashed with the allow row, `on conflict do nothing` kept the allow,
   * and the owner kept inviting.
   */
  it("sealsApplied: a key a system template held, and the catalog now seals against it, turns into deny", async () => {
    await seedPermissionCatalog(t.db, SEED_BOTH);
    expect(await grantsOf("tenant", "owner")).toContainEqual({ permission: "members.invite", effect: "allow" });
    const personal = definePermissions("tenant", {
      ...tenantCatalog.permissions,
      "members.invite": { label: "Invite", sealed: true, defaultFor: [] },
      "tenant.transfer": { label: "Transfer", sealed: true, defaultFor: [] },
    });
    const report = await seedPermissionCatalog(t.db, { tenant: { catalog: personal, templates: TENANT_TEMPLATES } });
    expect(report.sealsApplied).toBe(3);
    expect(report.withdrawn).toEqual(["tenant/admin/members.invite", "tenant/owner/members.invite", "tenant/owner/tenant.transfer"]);
    for (const key of ["owner", "admin", "member", "viewer"]) {
      const grants = await grantsOf("tenant", key);
      expect(grants, key).toContainEqual({ permission: "members.invite", effect: "deny" });
      expect(grants, key).toContainEqual({ permission: "tenant.transfer", effect: "deny" });
    }
    // Untouched: a key the catalog still grants.
    expect(await grantsOf("tenant", "owner")).toContainEqual({ permission: "members.remove", effect: "allow" });
    // And run again: nothing left to take back.
    const again = await seedPermissionCatalog(t.db, { tenant: { catalog: personal, templates: TENANT_TEMPLATES } });
    expect(again.sealsApplied).toBe(0);
  });

  it("NEGATIVE CONTROLS: a key merely dropped from defaultFor keeps its allow row (insert-only), and a customised template keeps a sealed key", async () => {
    await seedPermissionCatalog(t.db, SEED_BOTH);
    // A customised admin template that holds members.invite on purpose.
    await t.db.insert(roleTemplate).values({ scope: "tenant", tenantId: FIRM_WIDE, key: "editor", name: "Our editors", rank: 25, isSystem: false });
    const [editor] = await t.db.select({ id: roleTemplate.id }).from(roleTemplate).where(and(eq(roleTemplate.scope, "tenant"), eq(roleTemplate.key, "editor")));
    await t.db.insert(roleTemplateGrant).values({ templateId: editor!.id, permission: "members.invite", effect: "allow" });
    const dropped = definePermissions("tenant", {
      ...tenantCatalog.permissions,
      // Not sealed: just no longer a default. The seed doesn't revoke.
      "members.remove": { label: "Remove", defaultFor: [] },
      "members.invite": { label: "Invite", sealed: true, defaultFor: [] },
    });
    const report = await seedPermissionCatalog(t.db, {
      tenant: { catalog: dropped, templates: [...TENANT_TEMPLATES, { key: "editor", name: "Editor", rank: 25 }] },
    });
    expect(report.skippedCustomised).toContain("tenant/editor");
    expect(await grantsOf("tenant", "owner")).toContainEqual({ permission: "members.remove", effect: "allow" });
    expect(await grantsOf("tenant", "editor")).toEqual([{ permission: "members.invite", effect: "allow" }]);
    expect(report.withdrawn).toEqual(["tenant/admin/members.invite", "tenant/owner/members.invite"]);
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
