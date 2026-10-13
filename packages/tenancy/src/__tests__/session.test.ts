import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { codeOf, harness, type Harness } from "./harness.js";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function pointer(userId: string): Promise<string | null> {
  return ((await h.db.execute(sql`select active_tenant_id from users where id = ${userId}`)).rows[0] as { active_tenant_id: string | null }).active_tenant_id;
}

async function companyOf(userId: string): Promise<string | null> {
  const s = await h.tenancy.resolveSession({ userId });
  return s.state === "needs-onboarding" ? null : s.company.id;
}

describe("resolveSession (6.3, scenario step 4)", () => {
  it("honours a valid pointer", async () => {
    h = await harness();
    const sam = await h.user("sam@x.test");
    const a = await h.company(sam, "A Co");
    const b = await h.company(sam, "B Co");
    await h.tenancy.setActiveCompany({ userId: sam, tenantId: a });
    expect(await companyOf(sam)).toBe(a);
    await h.tenancy.setActiveCompany({ userId: sam, tenantId: b });
    expect(await companyOf(sam)).toBe(b);
  });

  it("a stale pointer (removed) falls back to the next company and is rewritten", async () => {
    h = await harness();
    const owner = await h.user("o@x.test");
    const rae = await h.user("rae@x.test");
    const summit = await h.company(owner, "Summit", { [rae]: "member" });
    const gig = await h.company(owner, "Gig", { [rae]: "member" });
    await h.tenancy.setActiveCompany({ userId: rae, tenantId: gig });
    await h.tenancy.removeMember({ actorUserId: owner, tenantId: gig, targetUserId: rae });
    expect(await companyOf(rae)).toBe(summit);
    expect(await pointer(rae)).toBe(summit);
  });

  it("a stale pointer (company deleted) falls back", async () => {
    h = await harness();
    const sam = await h.user("sam@x.test");
    const a = await h.company(sam, "A Co");
    const b = await h.company(sam, "B Co");
    await h.tenancy.setActiveCompany({ userId: sam, tenantId: b });
    await h.db.execute(sql`update tenants set deleted_at = now() where id = ${b}`);
    expect(await companyOf(sam)).toBe(a);
  });

  it("the fallback order is deterministic: same-millisecond joins by id; usable before suspended", async () => {
    h = await harness();
    const sam = await h.user("sam@x.test");
    const a = await h.company(sam, "A Co");
    const b = await h.company(sam, "B Co");
    await h.db.execute(sql`update tenant_members set created_at = '2026-01-01T00:00:00Z' where user_id = ${sam}`);
    await h.db.execute(sql`update users set active_tenant_id = null where id = ${sam}`);
    expect(await companyOf(sam)).toBe([a, b].sort()[0]);
    await h.db.execute(sql`update tenants set suspended_at = now() where id = ${[a, b].sort()[0]!}`);
    await h.db.execute(sql`update users set active_tenant_id = null where id = ${sam}`);
    expect(await companyOf(sam)).toBe([a, b].sort()[1]);
  });

  it("a suspended active company → suspended, listing the others with their status", async () => {
    h = await harness();
    const sam = await h.user("sam@x.test");
    const a = await h.company(sam, "A Co");
    const b = await h.company(sam, "B Co");
    await h.tenancy.setActiveCompany({ userId: sam, tenantId: b });
    await h.db.execute(sql`update tenants set suspended_at = now() where id = ${b}`);
    const s = await h.tenancy.resolveSession({ userId: sam });
    expect(s.state).toBe("suspended");
    if (s.state === "suspended") {
      expect(s.company.id).toBe(b);
      expect(s.companies.map((c) => [c.id, c.status])).toEqual(expect.arrayContaining([[a, "active"], [b, "suspended"]]));
    }
  });

  it("every membership suspended → suspended on the first", async () => {
    h = await harness();
    const sam = await h.user("sam@x.test");
    const a = await h.company(sam, "A Co");
    await h.db.execute(sql`update tenants set suspended_at = now() where id = ${a}`);
    expect((await h.tenancy.resolveSession({ userId: sam })).state).toBe("suspended");
  });

  it("companies mode with only a legacy personal workspace → needs-onboarding", async () => {
    h = await harness();
    const sam = await h.user("sam@x.test");
    await h.db.execute(sql`insert into tenants (id, kind, slug, name, owner_user_id) values ('ws_legacy', 'personal', 'ws-legacy', 'Personal', ${sam})`);
    await h.db.execute(sql`insert into tenant_members (tenant_id, user_id) values ('ws_legacy', ${sam})`);
    await h.db.execute(sql`update users set active_tenant_id = 'ws_legacy' where id = ${sam}`);
    const s = await h.tenancy.resolveSession({ userId: sam });
    expect(s.state).toBe("needs-onboarding");
    // A legacy personal pointer is not "a company you were removed from".
    if (s.state === "needs-onboarding") expect(s.formerCompany).toBeNull();
  });

  it("needs-onboarding lists invitations for VERIFIED emails only: no unverified, suspended or expired", async () => {
    h = await harness();
    const owner = await h.user("o@x.test");
    const live = await h.company(owner, "Live Co");
    const sus = await h.company(owner, "Sus Co");
    const old = await h.company(owner, "Old Co");
    for (const t of [live, sus, old]) await h.tenancy.sendInvitation({ actorUserId: owner, tenantId: t, email: "new@x.test", roleKey: "member" });
    await h.db.execute(sql`update tenants set suspended_at = now() where id = ${sus}`);
    await h.db.execute(sql`update tenant_invitations set expires_at = '2020-01-01T00:00:00Z' where tenant_id = ${old}`);
    const sam = await h.user("new@x.test");
    const none = await h.tenancy.resolveSession({ userId: sam });
    expect(none.state === "needs-onboarding" && none.invitations).toEqual([]);
    const s = await h.tenancy.resolveSession({ userId: sam, verifiedEmails: ["New@X.test"] });
    expect(s.state === "needs-onboarding" && s.invitations.map((i) => i.companyName)).toEqual(["Live Co"]);
  });

  it("a removed member lands on onboarding with the company named (review T1-09)", async () => {
    h = await harness();
    const owner = await h.user("o@x.test");
    const crew = await h.user("crew@x.test");
    const green = await h.company(owner, "Green Acres", { [crew]: "member" });
    await h.tenancy.setActiveCompany({ userId: crew, tenantId: green });
    await h.tenancy.removeMember({ actorUserId: owner, tenantId: green, targetUserId: crew });
    const s = await h.tenancy.resolveSession({ userId: crew });
    expect(s).toMatchObject({ state: "needs-onboarding", formerCompany: "Green Acres" });
    // Still said on the next render (the onboarding page after the redirect).
    expect(await h.tenancy.resolveSession({ userId: crew })).toMatchObject({ formerCompany: "Green Acres" });
    // A person who never had a company hears nothing of the kind.
    const fresh = await h.user("fresh@x.test");
    expect(await h.tenancy.resolveSession({ userId: fresh })).toMatchObject({ state: "needs-onboarding", formerCompany: null });
  });
});

describe("setActiveCompany", () => {
  it("a foreign company, or one you were removed from → not_found; a suspended one is allowed", async () => {
    h = await harness();
    const owner = await h.user("o@x.test");
    const sam = await h.user("sam@x.test");
    const theirs = await h.company(owner, "Theirs");
    const shared = await h.company(owner, "Shared", { [sam]: "member" });
    expect(await codeOf(h.tenancy.setActiveCompany({ userId: sam, tenantId: theirs }))).toBe("not_found");
    await h.db.execute(sql`update tenants set suspended_at = now() where id = ${shared}`);
    expect((await h.tenancy.setActiveCompany({ userId: sam, tenantId: shared })).status).toBe("suspended");
    await h.tenancy.reactivateCompany({ actorUserId: owner, tenantId: shared }).catch(() => undefined);
    await h.db.execute(sql`update tenants set suspended_at = null where id = ${shared}`);
    await h.tenancy.removeMember({ actorUserId: owner, tenantId: shared, targetUserId: sam });
    expect(await codeOf(h.tenancy.setActiveCompany({ userId: sam, tenantId: shared }))).toBe("not_found");
  });
});
