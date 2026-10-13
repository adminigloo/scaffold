import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { tenancyMembershipGate } from "../server.js";
import { codeOf, harness, type Harness } from "./harness.js";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function setup() {
  const owner = await h.user("owner@summit.test", { name: "Olivia" });
  const admin = await h.user("admin@summit.test", { name: "Ada" });
  const tenantId = await h.company(owner, "Summit", { [admin]: "admin" });
  return { owner, admin, tenantId };
}

describe("sending (6.9)", () => {
  it("the rank guard: an owner can invite an admin, an admin can't; owner → owner_must_transfer", async () => {
    h = await harness();
    const s = await setup();
    expect(await codeOf(h.tenancy.sendInvitation({ actorUserId: s.owner, tenantId: s.tenantId, email: "a@x.test", roleKey: "admin" }))).toBe("ok");
    expect(await codeOf(h.tenancy.sendInvitation({ actorUserId: s.admin, tenantId: s.tenantId, email: "b@x.test", roleKey: "admin" }))).toBe("rank");
    expect(await codeOf(h.tenancy.sendInvitation({ actorUserId: s.owner, tenantId: s.tenantId, email: "c@x.test", roleKey: "owner" }))).toBe("owner_must_transfer");
  });

  it("refusals: already a member, a personal workspace in companies mode, a suspended company", async () => {
    h = await harness();
    const s = await setup();
    expect(await codeOf(h.tenancy.sendInvitation({ actorUserId: s.owner, tenantId: s.tenantId, email: "ADMIN@summit.test", roleKey: "member" }))).toBe("already_member");
    await h.db.execute(sql`insert into tenants (id, kind, slug, name, owner_user_id) values ('ws_x', 'personal', 'ws-x', 'Personal', ${s.owner})`);
    await h.db.execute(sql`insert into tenant_members (tenant_id, user_id) values ('ws_x', ${s.owner})`);
    expect(await codeOf(h.tenancy.sendInvitation({ actorUserId: s.owner, tenantId: "ws_x", email: "a@x.test", roleKey: "member" }))).toBe("personal_workspace");
    await h.db.execute(sql`update tenants set suspended_at = now() where id = ${s.tenantId}`);
    expect(await codeOf(h.tenancy.sendInvitation({ actorUserId: s.owner, tenantId: s.tenantId, email: "a@x.test", roleKey: "member" }))).toBe("company_suspended");
  });

  it("a lower inviter can't quietly overwrite (and kill) a higher inviter's open invitation (review T1-04)", async () => {
    h = await harness();
    const s = await setup();
    const owners = await h.tenancy.sendInvitation({ actorUserId: s.owner, tenantId: s.tenantId, email: "office@x.test", roleKey: "admin" });
    const attempt = await h.tenancy.sendInvitation({ actorUserId: s.admin, tenantId: s.tenantId, email: "office@x.test", roleKey: "viewer" }).catch((e: unknown) => e);
    expect(attempt).toMatchObject({ code: "rank", message: expect.stringMatching(/already an invitation/) });
    const row = (await h.db.execute(sql`select invited_by, (select key from role_template where id = template_id) as role from tenant_invitations where id = ${owners.invitation.id}`)).rows[0];
    expect(row).toEqual({ invited_by: s.owner, role: "admin" });
    // The owner's emailed link still works.
    const office = await h.user("office@x.test");
    expect((await h.tenancy.acceptInvitation({ token: owners.token, userId: office })).status).toBe("accepted");
  });

  it("re-sending replaces the open invitation, says so, and the FIRST email's link keeps working (review T1-06)", async () => {
    h = await harness();
    const s = await setup();
    const first = await h.tenancy.sendInvitation({ actorUserId: s.owner, tenantId: s.tenantId, email: "crew@x.test", roleKey: "member" });
    expect(first.replaced).toBe(false);
    const resent = await h.tenancy.resendInvitation({ actorUserId: s.owner, tenantId: s.tenantId, invitationId: first.invitation.id });
    expect(resent.replaced).toBe(true);
    expect(resent.token).not.toBe(first.token);
    const crew = await h.user("crew@x.test");
    // The crew lead finds the FIRST email in spam and clicks it.
    expect((await h.tenancy.acceptInvitation({ token: first.token, userId: crew })).status).toBe("accepted");
    // …and the newer link is now spent too (one row, single use).
    const again = await h.tenancy.acceptInvitation({ token: resent.token, userId: crew });
    expect(again.status).toBe("already-a-member");
  });
});

describe("seats (D16)", () => {
  it("invitations until full → seats_full with the numbers; a resend doesn't count twice; two accepts for the last seat (either order) take one", async () => {
    let limit: number | null = 3;
    h = await harness({ seats: { limitFor: async () => limit, upgradeHref: "/billing" } });
    const s = await setup();
    const one = await h.tenancy.sendInvitation({ actorUserId: s.owner, tenantId: s.tenantId, email: "one@x.test", roleKey: "member" });
    const full = await h.tenancy.sendInvitation({ actorUserId: s.owner, tenantId: s.tenantId, email: "two@x.test", roleKey: "member" }).catch((e: unknown) => e);
    expect(full).toMatchObject({ code: "seats_full", details: { upgradeHref: "/billing" } });
    expect((full as Error).message).toContain("includes 3 people and 3 are on the team or invited");
    expect(await codeOf(h.tenancy.resendInvitation({ actorUserId: s.owner, tenantId: s.tenantId, invitationId: one.invitation.id }))).toBe("ok");

    limit = 4;
    const two = await h.tenancy.sendInvitation({ actorUserId: s.owner, tenantId: s.tenantId, email: "two@x.test", roleKey: "member" });
    limit = 3; // now only one of the two can join
    const u1 = await h.user("one@x.test");
    const u2 = await h.user("two@x.test");
    const [a, b] = await Promise.all([
      h.tenancy.acceptInvitation({ token: one.token, userId: u1 }),
      h.tenancy.acceptInvitation({ token: two.token, userId: u2 }),
    ]);
    expect([a.status, b.status].sort()).toEqual(["accepted", "seats-full"]);
    // Nothing was consumed for the loser: its invitation is still open.
    const loser = a.status === "seats-full" ? one : two;
    const open = await h.db.execute(sql`select accepted_at from tenant_invitations where id = ${loser.invitation.id}`);
    expect(open.rows[0]).toEqual({ accepted_at: null });
  });
});

describe("accepting", () => {
  it("sets the pointer, audits with the invitee as actor, and lands in the inviting company (never onboarding)", async () => {
    h = await harness();
    const s = await setup();
    const inv = await h.tenancy.sendInvitation({ actorUserId: s.owner, tenantId: s.tenantId, email: "sam@x.test", roleKey: "member" });
    const sam = await h.user("sam@x.test");
    expect(await h.tenancy.acceptInvitation({ token: inv.token, userId: sam })).toEqual({ status: "accepted", company: { id: s.tenantId, name: "Summit" } });
    const session = await h.tenancy.resolveSession({ userId: sam });
    expect(session.state).toBe("ready");
    expect(session.state !== "needs-onboarding" && session.company.id).toBe(s.tenantId);
    const audit = h.audit.find((a) => a.action === "invitation.accepted");
    expect(audit).toMatchObject({ actorUserId: sam, tenantId: s.tenantId });
  });

  it("accept while removed: accept, remove, accept again → unknown, and the membership is not re-created", async () => {
    h = await harness();
    const s = await setup();
    const inv = await h.tenancy.sendInvitation({ actorUserId: s.owner, tenantId: s.tenantId, email: "sam@x.test", roleKey: "member" });
    const sam = await h.user("sam@x.test");
    await h.tenancy.acceptInvitation({ token: inv.token, userId: sam });
    await h.tenancy.removeMember({ actorUserId: s.owner, tenantId: s.tenantId, targetUserId: sam });
    expect(await h.tenancy.acceptInvitation({ token: inv.token, userId: sam })).toEqual({ status: "unknown" });
    expect(await tenancyMembershipGate(h.db, { userId: sam, tenantId: s.tenantId })).toBe("not-a-member");
  });

  it("revoke against accept, both orders", async () => {
    h = await harness();
    const s = await setup();
    const a = await h.tenancy.sendInvitation({ actorUserId: s.owner, tenantId: s.tenantId, email: "a@x.test", roleKey: "member" });
    await h.tenancy.revokeInvitation({ actorUserId: s.owner, tenantId: s.tenantId, invitationId: a.invitation.id });
    const ua = await h.user("a@x.test");
    expect(await h.tenancy.acceptInvitation({ token: a.token, userId: ua })).toEqual({ status: "revoked" });

    const b = await h.tenancy.sendInvitation({ actorUserId: s.owner, tenantId: s.tenantId, email: "b@x.test", roleKey: "member" });
    const ub = await h.user("b@x.test");
    await h.tenancy.acceptInvitation({ token: b.token, userId: ub });
    // The accepted invitation is no longer open: revoking it is "not found",
    // and the member remains.
    expect(await codeOf(h.tenancy.revokeInvitation({ actorUserId: s.owner, tenantId: s.tenantId, invitationId: b.invitation.id }))).toBe("not_found");
    expect(await tenancyMembershipGate(h.db, { userId: ub, tenantId: s.tenantId })).toBe("member");
  });

  it("a suspended company: the right person is told it's unavailable; someone else only that it wasn't for them (review T1-11)", async () => {
    h = await harness();
    const s = await setup();
    const inv = await h.tenancy.sendInvitation({ actorUserId: s.owner, tenantId: s.tenantId, email: "sam@x.test", roleKey: "member" });
    await h.db.execute(sql`update tenants set suspended_at = now() where id = ${s.tenantId}`);
    const stranger = await h.user("forwarded@x.test");
    expect(await h.tenancy.acceptInvitation({ token: inv.token, userId: stranger })).toEqual({ status: "wrong-email" });
    const sam = await h.user("sam@x.test");
    expect(await h.tenancy.acceptInvitation({ token: inv.token, userId: sam })).toEqual({ status: "company-unavailable" });
  });

  it("joinInvitation needs the invited address among the VERIFIED ones; otherwise behaves like accept", async () => {
    h = await harness();
    const s = await setup();
    const inv = await h.tenancy.sendInvitation({ actorUserId: s.owner, tenantId: s.tenantId, email: "sam@x.test", roleKey: "member" });
    const sam = await h.user("sam@other.test");
    expect(await h.tenancy.joinInvitation({ invitationId: inv.invitation.id, userId: sam, verifiedEmails: ["sam@other.test"] })).toEqual({ status: "wrong-email" });
    expect(await h.tenancy.joinInvitation({ invitationId: inv.invitation.id, userId: sam, verifiedEmails: ["sam@other.test", "SAM@x.test"] })).toEqual({
      status: "accepted",
      company: { id: s.tenantId, name: "Summit" },
    });
  });

  it("lock order: the unlocked lookup, then the company FOR UPDATE, then the invitation FOR UPDATE", async () => {
    h = await harness();
    const s = await setup();
    const inv = await h.tenancy.sendInvitation({ actorUserId: s.owner, tenantId: s.tenantId, email: "sam@x.test", roleKey: "member" });
    const sam = await h.user("sam@x.test");
    h.t.queries.length = 0;
    await h.tenancy.acceptInvitation({ token: inv.token, userId: sam });
    const tags = h.t.queries.map((q) => /adminigloo:([\w/-]+)/.exec(q.sql)?.[1]).filter(Boolean);
    expect(tags.slice(0, 3)).toEqual(["tenancy/accept-find", "tenancy/lock-company", "invitations/lock-by-token"]);
  });

  it("IDOR: resending or revoking another company's invitation id → not_found", async () => {
    h = await harness();
    const s = await setup();
    const other = await h.user("other@x.test");
    const theirs = await h.company(other, "Theirs");
    const inv = await h.tenancy.sendInvitation({ actorUserId: other, tenantId: theirs, email: "z@x.test", roleKey: "member" });
    expect(await codeOf(h.tenancy.resendInvitation({ actorUserId: s.owner, tenantId: s.tenantId, invitationId: inv.invitation.id }))).toBe("not_found");
    expect(await codeOf(h.tenancy.revokeInvitation({ actorUserId: s.owner, tenantId: s.tenantId, invitationId: inv.invitation.id }))).toBe("not_found");
  });
});

describe("previewInvitation (review T1-07)", () => {
  it("says which company, which role and who sent it — and nothing for a used, withdrawn or suspended one", async () => {
    h = await harness();
    const s = await setup();
    const inv = await h.tenancy.sendInvitation({ actorUserId: s.owner, tenantId: s.tenantId, email: "sam@x.test", roleKey: "member" });
    expect(await h.tenancy.previewInvitation({ token: inv.token })).toEqual({
      found: true,
      companyName: "Summit",
      roleName: "Member",
      invitedBy: "Olivia",
      addressMatches: null,
      sentTo: null,
      signedInAs: null,
    });
    expect((await h.tenancy.previewInvitation({ token: "not-a-token" })).found).toBe(false);
    await h.db.execute(sql`update tenants set suspended_at = now() where id = ${s.tenantId}`);
    expect((await h.tenancy.previewInvitation({ token: inv.token })).found).toBe(false);
  });
});

const roleKeyIn = async (userId: string, tenantId: string) =>
  ((await h.db.execute(sql`select rt.key from principal_role pr join role_template rt on rt.id = pr.template_id
    where pr.principal_id = ${userId} and pr.scope = 'tenant' and pr.tenant_id = ${tenantId}`)).rows[0] as { key?: string } | undefined)?.key ?? null;

describe("joining starts clean (review R2 SEC-T1-E, F3)", () => {
  it("a stray role and overrides left by an out-of-band delete don't come back: invited as viewer → viewer", async () => {
    h = await harness();
    const s = await setup();
    // Support deletes Ada's membership row by hand; her admin role and two
    // per-person overrides stay behind (the isolation test's worst case).
    await h.db.execute(sql`insert into principal_override (principal_id, scope, tenant_id, permission, effect)
      values (${s.admin}, 'tenant', ${s.tenantId}, 'tenant.transfer', 'deny'), (${s.admin}, 'tenant', ${s.tenantId}, 'members.invite', 'allow')`);
    await h.db.execute(sql`delete from tenant_members where tenant_id = ${s.tenantId} and user_id = ${s.admin}`);
    const inv = await h.tenancy.sendInvitation({ actorUserId: s.owner, tenantId: s.tenantId, email: "admin@summit.test", roleKey: "viewer" });
    expect((await h.tenancy.acceptInvitation({ token: inv.token, userId: s.admin })).status).toBe("accepted");
    expect(await roleKeyIn(s.admin, s.tenantId)).toBe("viewer");
    const can = (await h.tenancy.getCompany({ actorUserId: s.admin, tenantId: s.tenantId })).can;
    expect(can).not.toContain("members.invite");
    expect((await h.db.execute(sql`select count(*)::int as n from principal_override where principal_id = ${s.admin} and tenant_id = ${s.tenantId}`)).rows[0]).toEqual({ n: 0 });
    // The trail says what was replaced.
    expect(h.audit.find((a) => a.action === "invitation.accepted")?.metadata).toMatchObject({
      replacedRole: "admin",
      clearedOverrides: ["members.invite", "tenant.transfer"],
    });
  });

  it("an override a staff edit wrote after the removal is cleared when they rejoin (F3)", async () => {
    h = await harness();
    const s = await setup();
    const mia = await h.user("mia@summit.test");
    await h.db.execute(sql`insert into tenant_members (tenant_id, user_id) values (${s.tenantId}, ${mia})`);
    await h.tenancy.removeMember({ actorUserId: s.owner, tenantId: s.tenantId, targetUserId: mia });
    await h.db.execute(sql`insert into principal_override (principal_id, scope, tenant_id, permission, effect) values (${mia}, 'tenant', ${s.tenantId}, 'tenant.edit', 'allow')`);
    const inv = await h.tenancy.sendInvitation({ actorUserId: s.owner, tenantId: s.tenantId, email: "mia@summit.test", roleKey: "viewer" });
    await h.tenancy.acceptInvitation({ token: inv.token, userId: mia });
    expect((await h.tenancy.getCompany({ actorUserId: mia, tenantId: s.tenantId })).can).not.toContain("tenant.edit");
  });
});

describe("an invitation is its sender's authority (review R2 SEC-T1-F, F4)", () => {
  it("an admin demoted to Member (who can't invite at all) loses even their viewer invitations", async () => {
    h = await harness();
    const s = await setup();
    const inv = await h.tenancy.sendInvitation({ actorUserId: s.admin, tenantId: s.tenantId, email: "alt@elsewhere.test", roleKey: "viewer" });
    await h.tenancy.changeMemberRole({ actorUserId: s.owner, tenantId: s.tenantId, targetUserId: s.admin, roleKey: "member" });
    const row = (await h.db.execute(sql`select revoked_at from tenant_invitations where id = ${inv.invitation.id}`)).rows[0] as { revoked_at: unknown };
    expect(row.revoked_at).not.toBeNull();
    const alt = await h.user("alt@elsewhere.test");
    expect((await h.tenancy.acceptInvitation({ token: inv.token, userId: alt })).status).toBe("revoked");
  });

  it("whatever took their invite permission away (a staff deny override), their open invitations stop working", async () => {
    h = await harness();
    const s = await setup();
    const inv = await h.tenancy.sendInvitation({ actorUserId: s.admin, tenantId: s.tenantId, email: "alt@elsewhere.test", roleKey: "member" });
    await h.db.execute(sql`insert into principal_override (principal_id, scope, tenant_id, permission, effect) values (${s.admin}, 'tenant', ${s.tenantId}, 'members.invite', 'deny')`);
    const alt = await h.user("alt@elsewhere.test");
    expect((await h.tenancy.acceptInvitation({ token: inv.token, userId: alt })).status).toBe("revoked");
    expect(await tenancyMembershipGate(h.db, { userId: alt, tenantId: s.tenantId })).toBe("not-a-member");
  });

  it("a hand-over keeps the previous owner's invitations (they stay an admin who may invite)", async () => {
    h = await harness();
    const s = await setup();
    const inv = await h.tenancy.sendInvitation({ actorUserId: s.owner, tenantId: s.tenantId, email: "crew@x.test", roleKey: "member" });
    await h.tenancy.transferOwnership({ actorUserId: s.owner, tenantId: s.tenantId, toUserId: s.admin, confirmName: "Summit" });
    const crew = await h.user("crew@x.test");
    expect((await h.tenancy.acceptInvitation({ token: inv.token, userId: crew })).status).toBe("accepted");
  });
});

describe("every emailed link keeps working (review R2 T1BO-02, F7)", () => {
  it("after a double-clicked Resend and a re-invite from the form, the FIRST email's link still joins", async () => {
    h = await harness();
    const s = await setup();
    const first = await h.tenancy.sendInvitation({ actorUserId: s.owner, tenantId: s.tenantId, email: "office@x.test", roleKey: "member" });
    const second = await h.tenancy.resendInvitation({ actorUserId: s.owner, tenantId: s.tenantId, invitationId: first.invitation.id });
    await h.tenancy.resendInvitation({ actorUserId: s.owner, tenantId: s.tenantId, invitationId: first.invitation.id });
    await h.tenancy.sendInvitation({ actorUserId: s.owner, tenantId: s.tenantId, email: "office@x.test", roleKey: "member" });
    expect((await h.tenancy.previewInvitation({ token: first.token })).found).toBe(true);
    const office = await h.user("office@x.test");
    expect((await h.tenancy.acceptInvitation({ token: first.token, userId: office })).status).toBe("accepted");
    expect((await h.tenancy.acceptInvitation({ token: second.token, userId: office })).status).toBe("already-a-member");
  });
});

describe("the address the invitation was sent to (review R2 TB2-10, T1BO-07)", () => {
  it("accepting by link counts every VERIFIED address, not only the primary one", async () => {
    h = await harness();
    const s = await setup();
    const inv = await h.tenancy.sendInvitation({ actorUserId: s.owner, tenantId: s.tenantId, email: "carl@work.test", roleKey: "member" });
    const carl = await h.user("carl@home.test");
    expect((await h.tenancy.acceptInvitation({ token: inv.token, userId: carl, verifiedEmails: ["carl@home.test"] })).status).toBe("wrong-email");
    expect((await h.tenancy.acceptInvitation({ token: inv.token, userId: carl, verifiedEmails: ["carl@home.test", "Carl@Work.test"] })).status).toBe(
      "accepted",
    );
  });

  it("the preview says, BEFORE Accept, that the link is for another address (masked) and who you're signed in as", async () => {
    h = await harness();
    const s = await setup();
    const inv = await h.tenancy.sendInvitation({ actorUserId: s.owner, tenantId: s.tenantId, email: "carl.crew@greenblade.test", roleKey: "member" });
    const carl = await h.user("carl.crew77@gmail.test");
    expect(await h.tenancy.previewInvitation({ token: inv.token, userId: carl, verifiedEmails: ["carl.crew77@gmail.test"] })).toMatchObject({
      found: true,
      addressMatches: false,
      sentTo: "c•••@greenblade.test",
      signedInAs: "carl.crew77@gmail.test",
    });
    const right = await h.user("carl.crew@greenblade.test");
    expect(await h.tenancy.previewInvitation({ token: inv.token, userId: right, verifiedEmails: ["carl.crew@greenblade.test"] })).toMatchObject({
      found: true,
      addressMatches: true,
      sentTo: null,
    });
  });
});
