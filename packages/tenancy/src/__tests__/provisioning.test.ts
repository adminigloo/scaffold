import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { tenancyMembershipGate } from "../server.js";
import { personalWorkspaceId } from "../workspace.js";
import { assertOwnerInvariant, harness, type Harness } from "./harness.js";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function row(db: Harness["db"], q: ReturnType<typeof sql>) {
  return ((await db.execute(q)).rows[0] ?? null) as Record<string, unknown> | null;
}

describe("provisioning (6.2, D8): webhook first, page first, both at once", () => {
  it("companies mode, webhook first: stamped, no tenant; the page request then does nothing new", async () => {
    h = await harness();
    const id = await h.user("olivia@summitwindows.test", { provision: false });
    const first = await h.tenancy.provisionUser({ userId: id, email: "olivia@summitwindows.test" });
    expect(first.stamped).toBe(true);
    expect(first.personalWorkspaceId).toBeNull();
    const again = await h.tenancy.provisionUser({ userId: id, email: "olivia@summitwindows.test" });
    expect(again.stamped).toBe(false);
    expect((await h.db.execute(sql`select count(*)::int as n from tenants`)).rows[0]).toEqual({ n: 0 });
    const session = await h.tenancy.resolveSession({ userId: id });
    expect(session.state).toBe("needs-onboarding");
  });

  it("personal mode: workspace, membership, owner role and pointer; named after the person (TB-DEPLOY-10)", async () => {
    h = await harness({ mode: "personal" });
    const id = await h.user("sam@lee.test", { name: "Sam Lee" });
    const ws = personalWorkspaceId(id);
    expect(await row(h.db, sql`select name, kind, owner_user_id from tenants where id = ${ws}`)).toEqual({
      name: "Sam Lee's workspace",
      kind: "personal",
      owner_user_id: id,
    });
    expect(await row(h.db, sql`select active_tenant_id from users where id = ${id}`)).toEqual({ active_tenant_id: ws });
    await assertOwnerInvariant(h.db, ws);
  });

  it("personal mode: a 0.3 workspace still called 'Personal' is renamed after its owner", async () => {
    h = await harness({ mode: "personal" });
    const id = await h.user("kim@park.test", { name: "Kim Park", provision: false });
    await h.db.execute(sql`insert into tenants (id, kind, slug, name, owner_user_id) values (${personalWorkspaceId(id)}, 'personal', 'ws-kim', 'Personal', ${id})`);
    await h.tenancy.provisionUser({ userId: id, email: "kim@park.test" });
    expect((await row(h.db, sql`select name from tenants where id = ${personalWorkspaceId(id)}`))?.["name"]).toBe("Kim Park's workspace");
  });

  it("both at once (Promise.all of the webhook path and the page path): one workspace, one role, one stamp", async () => {
    h = await harness({ mode: "personal" });
    const id = await h.user("both@race.test", { provision: false });
    const results = await Promise.all([
      h.tenancy.provisionUser({ userId: id, email: "both@race.test" }),
      h.tenancy.provisionUser({ userId: id, email: "both@race.test" }),
    ]);
    expect(results.filter((r) => r.stamped)).toHaveLength(1);
    expect((await h.db.execute(sql`select count(*)::int as n from tenants`)).rows[0]).toEqual({ n: 1 });
    expect((await h.db.execute(sql`select count(*)::int as n from principal_role where principal_id = ${id}`)).rows[0]).toEqual({ n: 1 });
  });

  it("a crash before the stamp (a failing audit sink on the bootstrap) leaves it null; the next call stamps", async () => {
    let fail = true;
    h = await harness({
      bootstrap: { mode: "first-user" },
      audit: async () => {
        if (fail) throw new Error("audit down");
      },
    });
    const id = await h.user("first@site.test", { provision: false });
    await expect(h.tenancy.provisionUser({ userId: id, email: "first@site.test" })).rejects.toThrow(/audit down/);
    expect(await row(h.db, sql`select provisioned_at from users where id = ${id}`)).toEqual({ provisioned_at: null });
    fail = false;
    const out = await h.tenancy.provisionUser({ userId: id, email: "first@site.test" });
    expect(out.stamped).toBe(true);
    expect(out.bootstrap).toEqual({ granted: true });
  });

  it("a 0.21 user (row present, stamp null, no workspace) is repaired on the next request (PC-01)", async () => {
    h = await harness({ mode: "personal" });
    const id = await h.user("old@user.test", { provision: false });
    const session = await h.tenancy.resolveSession({ userId: id });
    expect(session.state).toBe("ready");
    if (session.state !== "needs-onboarding") expect(session.company.id).toBe(personalWorkspaceId(id));
  });
});

describe("deprovisionUser (PC-20)", () => {
  it("removes staff roles, suspends memberships, clears the pointer, lists owned companies, withdraws their invitations", async () => {
    h = await harness();
    const olivia = await h.user("olivia@summit.test");
    const sam = await h.user("sam@summit.test");
    const summit = await h.company(olivia, "Summit Window Co.", { [sam]: "admin" });
    await h.staff(olivia, "cs_agent");
    await h.tenancy.sendInvitation({ actorUserId: olivia, tenantId: summit, email: "new@summit.test", roleKey: "member" });

    const out = await h.tenancy.deprovisionUser({ userId: olivia });
    expect(out.staffRolesRemoved).toBe(1);
    expect(out.membershipsSuspended).toBe(1);
    expect(out.invitationsRevoked).toBe(1);
    expect(out.ownedCompanies).toEqual([summit]);
    expect(await tenancyMembershipGate(h.db, { userId: olivia, tenantId: summit })).toBe("not-a-member");
    expect(await row(h.db, sql`select active_tenant_id from users where id = ${olivia}`)).toEqual({ active_tenant_id: null });
    expect(h.audit.map((a) => a.action)).toContain("staff.role.removed");
  });
});

describe("the bootstrap admin, end to end (D9)", () => {
  it("signs in before the seed (not granted); after the seed the /admin self-heal grants; the seed's backfill grants too", async () => {
    h = await harness({ seed: false, bootstrap: { mode: "email", email: "ava@igloo.test" } });
    const ava = await h.user("ava@igloo.test");
    expect((await h.tenancy.ensureBootstrapAdmin({ userId: ava, email: "ava@igloo.test" })).granted).toBe(false);
    await h.seed();
    expect(await h.tenancy.ensureBootstrapAdmin({ userId: ava, email: "ava@igloo.test" })).toEqual({ granted: true });
    expect(h.audit.find((a) => a.action === "staff.bootstrap.granted")?.resourceId).toBe(ava);
  });

  it("ensureBootstrapAdminFor (the seed's backfill) grants by email when nobody is admin", async () => {
    h = await harness({ bootstrap: { mode: "off" } });
    const ava = await h.user("ava@igloo.test");
    const out = await h.tenancy.ensureBootstrapAdminFor({ email: "AVA@igloo.test" });
    expect(out).toMatchObject({ granted: true, userId: ava });
  });

  it("refuses an ambiguous address: two accounts carrying it grant nobody (review T1-02)", async () => {
    h = await harness({ bootstrap: { mode: "off" } });
    const a = await h.user("founder@site.test");
    const b = await h.user("founder@site.test");
    const out = await h.tenancy.ensureBootstrapAdminFor({ email: "founder@site.test" });
    expect(out.granted).toBe(false);
    expect(out.userId).toBeNull();
    expect([...(out.ambiguous ?? [])].sort()).toEqual([a, b].sort());
  });

  it("a deleted admin doesn't count, so the founder's new account is healed in", async () => {
    h = await harness({ bootstrap: { mode: "email", email: "ava@igloo.test" } });
    const old = await h.user("ava@igloo.test", { provision: false });
    expect((await h.tenancy.ensureBootstrapAdmin({ userId: old, email: "ava@igloo.test" })).granted).toBe(true);
    const second = await h.user("someone@else.test");
    expect(await h.tenancy.ensureBootstrapAdmin({ userId: second, email: "someone@else.test" })).toEqual({ granted: false, reason: "not-eligible" });
    await h.db.execute(sql`update users set deleted_at = now() where id = ${old}`);
    const fresh = await h.user("ava@igloo.test", { provision: false });
    expect(await h.tenancy.ensureBootstrapAdmin({ userId: fresh, email: "ava@igloo.test" })).toEqual({ granted: true });
  });
});

/**
 * Review round 2, SEC-T1-A / F1: in single-business mode a workspace can be
 * handed over (Transfer, or staff "Change owner"). Provisioning used to treat
 * `ws_<user>` as theirs for good and re-add them, WITH the owner role, on
 * their next page view or Clerk profile change — after the new owner had
 * removed them. Two owner-role holders, and a removal that never stuck.
 */
describe("personal mode: a workspace that was handed over stays handed over (review R2 SEC-T1-A)", () => {
  async function handedOver(via: "transfer" | "staff") {
    const ann = await h.user("ann@ws.test", { name: "Ann" });
    const bob = await h.user("bob@ws.test", { name: "Bob" });
    const cy = await h.user("cy@ws.test", { name: "Cy" });
    const wsA = personalWorkspaceId(ann);
    for (const [who, email, role] of [[bob, "bob@ws.test", "admin"], [cy, "cy@ws.test", "member"]] as const) {
      const inv = await h.tenancy.sendInvitation({ actorUserId: ann, tenantId: wsA, email, roleKey: role });
      expect((await h.tenancy.acceptInvitation({ token: inv.token, userId: who })).status).toBe("accepted");
    }
    if (via === "transfer") {
      const name = (await h.tenancy.getCompany({ actorUserId: ann, tenantId: wsA })).company.name;
      await h.tenancy.transferOwnership({ actorUserId: ann, tenantId: wsA, toUserId: bob, confirmName: name });
    } else {
      const ops = await h.user("ops@platform.test");
      await h.staff(ops, "admin");
      await h.tenancy.assignOwner({ actorUserId: ops, tenantId: wsA, toUserId: bob });
    }
    return { ann, bob, cy, wsA };
  }

  for (const via of ["transfer", "staff"] as const) {
    it(`${via}: removed by the new owner, the former owner's next page view gives them a NEW workspace, never Bob's back`, async () => {
      h = await harness({ mode: "personal" });
      const w = await handedOver(via);
      await h.tenancy.removeMember({ actorUserId: w.bob, tenantId: w.wsA, targetUserId: w.ann });

      const session = await h.tenancy.resolveSession({ userId: w.ann });
      expect(session.state).toBe("ready");
      if (session.state === "needs-onboarding") throw new Error("unreachable");
      expect(session.company.id).not.toBe(w.wsA);
      expect(session.company.isOwner).toBe(true);
      expect(await tenancyMembershipGate(h.db, { userId: w.ann, tenantId: w.wsA })).toBe("not-a-member");
      await assertOwnerInvariant(h.db, w.wsA);
      await assertOwnerInvariant(h.db, session.company.id);

      // The webhook runs provisionUser on every user.updated: still out.
      await h.tenancy.provisionUser({ userId: w.ann, email: "ann@ws.test" });
      expect(await tenancyMembershipGate(h.db, { userId: w.ann, tenantId: w.wsA })).toBe("not-a-member");
      await assertOwnerInvariant(h.db, w.wsA);
      // And the next session is the same new workspace, not a third one.
      const again = await h.tenancy.resolveSession({ userId: w.ann });
      expect(again.state !== "needs-onboarding" && again.company.id).toBe(session.company.id);
      expect(Number(((await h.db.execute(sql`select count(*)::int as n from tenants where owner_user_id = ${w.ann}`)).rows[0] as { n: number }).n)).toBe(1);
    });
  }

  it("leaving after a hand-over sticks too", async () => {
    h = await harness({ mode: "personal" });
    const w = await handedOver("transfer");
    await h.tenancy.leaveCompany({ userId: w.ann, tenantId: w.wsA });
    await h.tenancy.resolveSession({ userId: w.ann });
    expect(await tenancyMembershipGate(h.db, { userId: w.ann, tenantId: w.wsA })).toBe("not-a-member");
    await assertOwnerInvariant(h.db, w.wsA);
  });

  it("someone still in another workspace isn't re-added by a webhook's provisionUser either", async () => {
    h = await harness({ mode: "personal" });
    const w = await handedOver("transfer");
    const inv = await h.tenancy.sendInvitation({ actorUserId: w.cy, tenantId: personalWorkspaceId(w.cy), email: "ann@ws.test", roleKey: "member" });
    await h.tenancy.acceptInvitation({ token: inv.token, userId: w.ann });
    await h.tenancy.removeMember({ actorUserId: w.bob, tenantId: w.wsA, targetUserId: w.ann });
    await h.tenancy.provisionUser({ userId: w.ann, email: "ann@ws.test" });
    expect(await tenancyMembershipGate(h.db, { userId: w.ann, tenantId: w.wsA })).toBe("not-a-member");
    await assertOwnerInvariant(h.db, w.wsA);
  });

  it("an owner still missing their role (a 0.3 workspace) is still repaired", async () => {
    h = await harness({ mode: "personal" });
    const id = await h.user("kim@park.test", { name: "Kim", provision: false });
    const ws = personalWorkspaceId(id);
    await h.db.execute(sql`insert into tenants (id, kind, slug, name, owner_user_id) values (${ws}, 'personal', 'ws-kim', 'Personal', ${id})`);
    await h.tenancy.provisionUser({ userId: id, email: "kim@park.test" });
    expect(await tenancyMembershipGate(h.db, { userId: id, tenantId: ws })).toBe("member");
    await assertOwnerInvariant(h.db, ws);
  });
});
