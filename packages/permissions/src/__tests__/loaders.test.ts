import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIRM_WIDE } from "../constants.js";
import { principalOverride, principalRole, roleTemplate } from "../schema.js";
import {
  assignRoleTemplate,
  createDrizzlePermissionLoaders,
  seedPermissionCatalog,
  type MembershipGate,
  type MembershipVerdict,
} from "../server.js";
import type { TestDb } from "./pglite.js";
import { freshDb, SEED_BOTH } from "./server-helpers.js";

let t: TestDb;
const verdicts = new Map<string, MembershipVerdict>();
const gate: MembershipGate = async (_db, { userId, tenantId }) => verdicts.get(`${userId}@${tenantId}`) ?? "not-a-member";

beforeEach(async () => {
  t = await freshDb();
  verdicts.clear();
  await seedPermissionCatalog(t.db, SEED_BOTH);
});
afterEach(async () => {
  await t.close();
});

const principal = (userId: string) => ({ principal: { userId } });

describe("createDrizzlePermissionLoaders: the membership gate", () => {
  it("not-a-member → null, even with a stray role row", async () => {
    await assignRoleTemplate(t.db, { scope: "tenant", tenantId: "A", principalId: "u", templateKey: "admin", actor: { system: "t" } });
    const loaders = createDrizzlePermissionLoaders(t.db, { membership: gate });
    expect(await loaders.loadTenantPermissions({ ...principal("u"), tenantId: "A" })).toBeNull();
    expect(await loaders.explainTenantDenial({ ...principal("u"), tenantId: "A" })).toBe("not-a-member");
  });

  it("company-suspended → null, and explainTenantDenial says suspended", async () => {
    verdicts.set("u@A", "company-suspended");
    await assignRoleTemplate(t.db, { scope: "tenant", tenantId: "A", principalId: "u", templateKey: "admin", actor: { system: "t" } });
    const loaders = createDrizzlePermissionLoaders(t.db, { membership: gate });
    expect(await loaders.loadTenantPermissions({ ...principal("u"), tenantId: "A" })).toBeNull();
    expect(await loaders.explainTenantDenial({ ...principal("u"), tenantId: "A" })).toBe("company-suspended");
  });

  it("member → the role's grants", async () => {
    verdicts.set("u@A", "member");
    await assignRoleTemplate(t.db, { scope: "tenant", tenantId: "A", principalId: "u", templateKey: "member", actor: { system: "t" } });
    const set = await createDrizzlePermissionLoaders(t.db, { membership: gate }).loadTenantPermissions({ ...principal("u"), tenantId: "A" });
    expect([...(set?.toArray() ?? [])].sort()).toEqual(["members.view", "tenant.view"]);
  });

  it("refuses to be built without a gate", () => {
    // @ts-expect-error the gate is required on purpose
    expect(() => createDrizzlePermissionLoaders(t.db, {})).toThrow(/membership gate/);
  });
});

describe("overrides and seals", () => {
  beforeEach(async () => {
    verdicts.set("u@A", "member");
    await assignRoleTemplate(t.db, { scope: "tenant", tenantId: "A", principalId: "u", templateKey: "member", actor: { system: "t" } });
  });
  const load = () => createDrizzlePermissionLoaders(t.db, { membership: gate }).loadTenantPermissions({ ...principal("u"), tenantId: "A" });

  it("an allow override adds a key", async () => {
    await t.db.insert(principalOverride).values({ principalId: "u", scope: "tenant", tenantId: "A", permission: "tenant.edit", effect: "allow" });
    expect((await load())?.can("tenant.edit")).toBe(true);
  });

  it("a deny override removes a key", async () => {
    await t.db.insert(principalOverride).values({ principalId: "u", scope: "tenant", tenantId: "A", permission: "tenant.view", effect: "deny" });
    expect((await load())?.can("tenant.view")).toBe(false);
  });

  it("a sealed key stays denied despite an allow override", async () => {
    await t.db.insert(principalOverride).values({ principalId: "u", scope: "tenant", tenantId: "A", permission: "tenant.transfer", effect: "allow" });
    expect((await load())?.can("tenant.transfer")).toBe(false);
  });
});

describe("staff", () => {
  it("a staff row at a real tenant id is NOT staff (the FIRM_WIDE predicate)", async () => {
    const [admin] = await t.db
      .select({ id: roleTemplate.id })
      .from(roleTemplate)
      .where(and(eq(roleTemplate.scope, "staff"), eq(roleTemplate.key, "admin")));
    await t.db.insert(principalRole).values({ principalId: "s", scope: "staff", tenantId: "A", templateId: admin.id });
    expect(await createDrizzlePermissionLoaders(t.db, { membership: gate }).loadStaffPermissions(principal("s"))).toBeNull();
  });

  it("a staff row at * is staff", async () => {
    await assignRoleTemplate(t.db, { scope: "staff", tenantId: FIRM_WIDE, principalId: "s", templateKey: "cs_agent", actor: { system: "t" } });
    const set = await createDrizzlePermissionLoaders(t.db, { membership: gate }).loadStaffPermissions(principal("s"));
    expect(set?.toArray()).toEqual(["staff.tenants.view"]);
  });
});

describe("every query goes through the handle given", () => {
  it("a transaction sees its own uncommitted role row", async () => {
    verdicts.set("u@A", "member");
    await t.db
      .transaction(async (tx: TestDb["db"]) => {
        await assignRoleTemplate(tx, { scope: "tenant", tenantId: "A", principalId: "u", templateKey: "admin", actor: { system: "t" } });
        const set = await createDrizzlePermissionLoaders(tx, { membership: gate }).loadTenantPermissions({ ...principal("u"), tenantId: "A" });
        expect(set?.can("members.invite")).toBe(true);
        throw new Error("rollback");
      })
      .catch(() => undefined);
    const after = await createDrizzlePermissionLoaders(t.db, { membership: gate }).loadTenantPermissions({ ...principal("u"), tenantId: "A" });
    expect(after?.toArray()).toEqual([]);
  });
});
