import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIRM_WIDE } from "../constants.js";
import { principalRole, roleTemplate } from "../schema.js";
import { assignRoleTemplate, ensureBootstrapAdmin, seedPermissionCatalog } from "../server.js";
import type { TestDb } from "./pglite.js";
import { freshDb, SEED_BOTH } from "./server-helpers.js";

let t: TestDb;
beforeEach(async () => {
  t = await freshDb();
});
afterEach(async () => {
  await t.close();
});

async function staffKeyOf(principalId: string): Promise<string | null> {
  const rows = await t.db
    .select({ key: roleTemplate.key, scope: roleTemplate.scope })
    .from(principalRole)
    .innerJoin(roleTemplate, eq(roleTemplate.id, principalRole.templateId))
    .where(and(eq(principalRole.principalId, principalId), eq(principalRole.scope, "staff"), eq(principalRole.tenantId, FIRM_WIDE)));
  // The template a staff row points at must itself be a STAFF template (T1-10).
  if (rows[0]) expect(rows[0].scope).toBe("staff");
  return rows[0]?.key ?? null;
}

describe("ensureBootstrapAdmin (D9)", () => {
  it("policy off → off, with zero queries", async () => {
    t.queries.length = 0;
    expect(await ensureBootstrapAdmin(t.db, { principalId: "u1", email: "a@b.test", policy: { mode: "off" } })).toEqual({
      granted: false,
      reason: "off",
    });
    expect(t.queries).toHaveLength(0);
  });

  it("a non-matching (or missing) email → not-eligible, with zero queries", async () => {
    t.queries.length = 0;
    const policy = { mode: "email", email: "Founder@Site.test" } as const;
    expect(await ensureBootstrapAdmin(t.db, { principalId: "u1", email: "someone@else.test", policy })).toEqual({ granted: false, reason: "not-eligible" });
    expect(await ensureBootstrapAdmin(t.db, { principalId: "u1", email: null, policy })).toEqual({ granted: false, reason: "not-eligible" });
    expect(t.queries).toHaveLength(0);
  });

  it("no admin template yet → templates-missing", async () => {
    expect(await ensureBootstrapAdmin(t.db, { principalId: "u1", email: null, policy: { mode: "first-user" } })).toEqual({
      granted: false,
      reason: "templates-missing",
    });
  });

  it("the matching email (case and spaces ignored) gets admin", async () => {
    await seedPermissionCatalog(t.db, SEED_BOTH);
    const out = await ensureBootstrapAdmin(t.db, { principalId: "ava", email: " founder@site.test ", policy: { mode: "email", email: "Founder@Site.test" } });
    expect(out).toEqual({ granted: true });
    expect(await staffKeyOf("ava")).toBe("admin");
  });

  it("first-user grants the first caller only; the second gets admin-exists", async () => {
    await seedPermissionCatalog(t.db, SEED_BOTH);
    expect(await ensureBootstrapAdmin(t.db, { principalId: "first", email: null, policy: { mode: "first-user" } })).toEqual({ granted: true });
    expect(await ensureBootstrapAdmin(t.db, { principalId: "second", email: null, policy: { mode: "first-user" } })).toEqual({
      granted: false,
      reason: "admin-exists",
    });
    expect(await staffKeyOf("second")).toBeNull();
  });

  it("an admin rejected by isActivePrincipal (a deleted user) doesn't count", async () => {
    await seedPermissionCatalog(t.db, SEED_BOTH);
    await ensureBootstrapAdmin(t.db, { principalId: "old-founder", email: null, policy: { mode: "first-user" } });
    const deleted = new Set(["old-founder"]);
    const out = await ensureBootstrapAdmin(t.db, {
      principalId: "new-founder",
      email: "founder@site.test",
      policy: { mode: "email", email: "founder@site.test" },
      isActivePrincipal: async (_tx, id) => !deleted.has(id),
    });
    expect(out).toEqual({ granted: true });
    expect(await staffKeyOf("new-founder")).toBe("admin");
  });

  it("a cs_agent holder is promoted to admin when no admin exists", async () => {
    await seedPermissionCatalog(t.db, SEED_BOTH);
    await assignRoleTemplate(t.db, { scope: "staff", principalId: "agent", templateKey: "cs_agent", actor: { system: "test" } });
    expect(await ensureBootstrapAdmin(t.db, { principalId: "agent", email: null, policy: { mode: "first-user" } })).toEqual({ granted: true });
    expect(await staffKeyOf("agent")).toBe("admin");
  });

  it("the lock key is 8140231 and it is the first statement", async () => {
    await seedPermissionCatalog(t.db, SEED_BOTH);
    t.queries.length = 0;
    await ensureBootstrapAdmin(t.db, { principalId: "u", email: null, policy: { mode: "first-user" } });
    expect(t.queries[0]?.sql).toContain("pg_advisory_xact_lock(");
    expect(t.queries[0]?.params).toEqual([8140231]);
  });

  it("PC-V1 end to end: sign-in before the seed → templates-missing; seed; again → granted", async () => {
    const policy = { mode: "email", email: "ava@igloo.test" } as const;
    expect(await ensureBootstrapAdmin(t.db, { principalId: "ava", email: "ava@igloo.test", policy })).toEqual({
      granted: false,
      reason: "templates-missing",
    });
    await seedPermissionCatalog(t.db, SEED_BOTH);
    expect(await ensureBootstrapAdmin(t.db, { principalId: "ava", email: "ava@igloo.test", policy })).toEqual({ granted: true });
  });

  it("uses the STAFF admin template, never the company 'admin' seeded at the same tenant id (T1-10)", async () => {
    // Seed the TENANT templates first so the company "admin" row is the older
    // one: a lookup by key and FIRM_WIDE alone would find it.
    await seedPermissionCatalog(t.db, { tenant: SEED_BOTH.tenant });
    await seedPermissionCatalog(t.db, { staff: SEED_BOTH.staff });
    const admins = await t.db.select({ scope: roleTemplate.scope }).from(roleTemplate).where(and(eq(roleTemplate.key, "admin"), eq(roleTemplate.tenantId, FIRM_WIDE)));
    expect(admins.map((a: { scope: string }) => a.scope).sort()).toEqual(["staff", "tenant"]);
    expect(await ensureBootstrapAdmin(t.db, { principalId: "ava", email: null, policy: { mode: "first-user" } })).toEqual({ granted: true });
    expect(await staffKeyOf("ava")).toBe("admin");
  });
});
