import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIRM_WIDE } from "../constants.js";
import { principalOverride } from "../schema.js";
import { assignRoleTemplate, listRoleTemplates, RoleAssignmentError, roleOf, seedPermissionCatalog } from "../server.js";
import type { TestDb } from "./pglite.js";
import { freshDb, SEED_BOTH } from "./server-helpers.js";

let t: TestDb;
const T = "tenant-a";
beforeEach(async () => {
  t = await freshDb();
  await seedPermissionCatalog(t.db, SEED_BOTH);
});
afterEach(async () => {
  await t.close();
});

const sys = { system: "test" } as const;
async function give(principalId: string, templateKey: string | null, scope: "staff" | "tenant" = "tenant") {
  return assignRoleTemplate(t.db, { scope, tenantId: scope === "tenant" ? T : FIRM_WIDE, principalId, templateKey, actor: sys });
}
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (error) {
    if (error instanceof RoleAssignmentError) return error.code;
    throw error;
  }
}

describe("assignRoleTemplate: the rank guard", () => {
  it("the actor must strictly outrank both the target's current role and the new one", async () => {
    await give("owner", "owner");
    await give("admin", "admin");
    await give("m", "member");
    const as = (actor: string, target: string, key: string | null) =>
      codeOf(assignRoleTemplate(t.db, { scope: "tenant", tenantId: T, principalId: target, templateKey: key, actor: { principalId: actor } }));
    expect(await as("owner", "m", "admin")).toBe("ok");
    expect(await as("admin", "m", "admin")).toBe("rank"); // m is admin now: equal rank
    expect(await as("admin", "newbie", "admin")).toBe("rank"); // new role not below the actor
    expect(await as("admin", "newbie", "viewer")).toBe("ok");
  });

  it("an actor with no role is refused", async () => {
    await give("m", "member");
    expect(await codeOf(assignRoleTemplate(t.db, { scope: "tenant", tenantId: T, principalId: "m", templateKey: "viewer", actor: { principalId: "stranger" } }))).toBe("rank");
  });

  it("changing yourself → self", async () => {
    await give("owner", "owner");
    expect(await codeOf(assignRoleTemplate(t.db, { scope: "tenant", tenantId: T, principalId: "owner", templateKey: "admin", actor: { principalId: "owner" } }))).toBe("self");
  });

  it("an unknown key → unknown-template", async () => {
    expect(await codeOf(give("x", "wizard"))).toBe("unknown-template");
  });

  it("a system actor bypasses the rank guard", async () => {
    expect(await codeOf(give("x", "owner"))).toBe("ok");
    expect((await roleOf(t.db, { principalId: "x", scope: "tenant", tenantId: T }))?.key).toBe("owner");
  });

  it("re-assigning the same template is a no-op", async () => {
    await give("x", "member");
    const again = await give("x", "member");
    expect(again.changed).toBe(false);
  });
});

describe("protectLastKey", () => {
  it("refuses to demote or remove the only admin (last-holder), and allows it when a second admin exists", async () => {
    await give("a1", "admin", "staff");
    const demote = (who: string, key: string | null) =>
      codeOf(assignRoleTemplate(t.db, { scope: "staff", principalId: who, templateKey: key, actor: sys, protectLastKey: "admin" }));
    expect(await demote("a1", "cs_lead")).toBe("last-holder");
    expect(await demote("a1", null)).toBe("last-holder");
    await give("a2", "admin", "staff");
    expect(await demote("a1", null)).toBe("ok");
  });
});

describe("topRankPeers (review T1-09): a second administrator from the People screen", () => {
  it("an admin can make someone admin, and demote another admin, but never themselves", async () => {
    await give("ava", "admin", "staff");
    const asAva = (target: string, key: string | null) =>
      codeOf(
        assignRoleTemplate(t.db, {
          scope: "staff",
          principalId: target,
          templateKey: key,
          actor: { principalId: "ava" },
          protectLastKey: "admin",
          topRankPeers: true,
        }),
      );
    expect(await asAva("bo", "admin")).toBe("ok");
    expect(await asAva("bo", "cs_lead")).toBe("ok");
    expect(await asAva("ava", "cs_lead")).toBe("self");
  });

  it("without the option (and below the top), equal ranks still can't manage each other", async () => {
    await give("ava", "admin", "staff");
    await give("lee", "cs_lead", "staff");
    await give("kim", "cs_lead", "staff");
    expect(await codeOf(assignRoleTemplate(t.db, { scope: "staff", principalId: "bo", templateKey: "admin", actor: { principalId: "ava" } }))).toBe("rank");
    expect(
      await codeOf(assignRoleTemplate(t.db, { scope: "staff", principalId: "kim", templateKey: "cs_agent", actor: { principalId: "lee" }, topRankPeers: true })),
    ).toBe("rank");
    expect(
      await codeOf(assignRoleTemplate(t.db, { scope: "staff", principalId: "bo", templateKey: "admin", actor: { principalId: "lee" }, topRankPeers: true })),
    ).toBe("rank");
  });
});

describe("clearOverrides", () => {
  async function override(principalId: string, scope: "staff" | "tenant", tenantId: string, permission: string) {
    await t.db.insert(principalOverride).values({ principalId, scope, tenantId, permission, effect: "allow" });
  }
  async function overridesOf(principalId: string, tenantId: string) {
    return (await t.db.select().from(principalOverride).where(and(eq(principalOverride.principalId, principalId), eq(principalOverride.tenantId, tenantId)))).map(
      (o: { permission: string }) => o.permission,
    );
  }

  it('"on-change" clears the overrides in that scope and tenant only, and reports them', async () => {
    await give("m", "admin");
    await override("m", "tenant", T, "tenant.edit");
    await override("m", "tenant", "other-tenant", "tenant.edit");
    const out = await assignRoleTemplate(t.db, { scope: "tenant", tenantId: T, principalId: "m", templateKey: "member", actor: sys, clearOverrides: "on-change" });
    expect(out.clearedOverrides).toEqual(["tenant.edit"]);
    expect(await overridesOf("m", T)).toEqual([]);
    expect(await overridesOf("m", "other-tenant")).toEqual(["tenant.edit"]);
  });

  it('"on-removal" leaves them on a change and clears them on a removal', async () => {
    await give("s", "cs_lead", "staff");
    await override("s", "staff", FIRM_WIDE, "staff.people.view");
    await assignRoleTemplate(t.db, { scope: "staff", principalId: "s", templateKey: "cs_agent", actor: sys, clearOverrides: "on-removal" });
    expect(await overridesOf("s", FIRM_WIDE)).toEqual(["staff.people.view"]);
    const out = await assignRoleTemplate(t.db, { scope: "staff", principalId: "s", templateKey: null, actor: sys, clearOverrides: "on-removal" });
    expect(out.clearedOverrides).toEqual(["staff.people.view"]);
    expect(await overridesOf("s", FIRM_WIDE)).toEqual([]);
  });
});

describe("lookups", () => {
  it("listRoleTemplates: highest rank first; roleOf reads one role", async () => {
    const staff = await listRoleTemplates(t.db, { scope: "staff" });
    expect(staff.map((r) => r.key)).toEqual(["admin", "cs_lead", "cs_agent"]);
    await give("x", "viewer");
    expect(await roleOf(t.db, { principalId: "x", scope: "tenant", tenantId: T })).toMatchObject({ key: "viewer", name: "Viewer", rank: 10 });
    expect(await roleOf(t.db, { principalId: "x", scope: "staff" })).toBeNull();
  });

  it("the role lock is the first statement, keyed by scope and tenant", async () => {
    t.queries.length = 0;
    await give("x", "viewer");
    expect(t.queries[0]?.sql).toContain("pg_advisory_xact_lock(hashtextextended(");
    expect(t.queries[0]?.params).toEqual([`adminigloo:roles:tenant:${T}`]);
  });
});
