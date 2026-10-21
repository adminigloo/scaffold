import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { tenancyMembershipGate } from "../server.js";
import { assertOwnerInvariant, codeOf, harness, type Harness } from "./harness.js";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function world() {
  const ava = await h.user("ava@igloo.test", { name: "Ava" });
  await h.staff(ava, "admin");
  const olivia = await h.user("olivia@summit.test", { name: "Olivia" });
  const sam = await h.user("sam@gig.test", { name: "Sam" });
  const summit = await h.company(olivia, "Summit Window Co.", { [sam]: "member" });
  const gig = await h.company(sam, "Side Gig");
  return { ava, olivia, sam, summit, gig };
}

describe("listCompanies (6.11, scenario step 6)", () => {
  it("searches by name, web address, owner email and exact id; escapes % and _", async () => {
    h = await harness();
    const w = await world();
    const names = async (q: string) => (await h.tenancy.listCompanies({ actorUserId: w.ava, q })).companies.map((c) => c.name);
    expect(await names("summit")).toEqual(["Summit Window Co."]);
    expect(await names("side-gig")).toEqual(["Side Gig"]);
    expect(await names("olivia@")).toEqual(["Summit Window Co."]);
    expect(await names(w.gig)).toEqual(["Side Gig"]);
    expect(await names("%")).toEqual([]);
    expect(await names("_")).toEqual([]);
  });

  it("paginates with totals; hides personal workspaces by default; filters by status", async () => {
    h = await harness();
    const w = await world();
    await h.db.execute(sql`insert into tenants (id, kind, slug, name, owner_user_id) values ('ws_x', 'personal', 'ws-x', 'Personal', ${w.sam})`);
    const page1 = await h.tenancy.listCompanies({ actorUserId: w.ava, pageSize: 1 });
    expect(page1).toMatchObject({ total: 2, page: 1, pageSize: 1 });
    expect(page1.companies).toHaveLength(1);
    expect((await h.tenancy.listCompanies({ actorUserId: w.ava, kind: "all" })).total).toBe(3);
    await h.tenancy.suspendCompany({ actorUserId: w.ava, tenantId: w.gig, reason: "Unpaid since August" });
    expect((await h.tenancy.listCompanies({ actorUserId: w.ava, status: "suspended" })).companies.map((c) => c.name)).toEqual(["Side Gig"]);
    expect((await h.tenancy.listCompanies({ actorUserId: w.ava, status: "active" })).companies.map((c) => c.name)).toEqual(["Summit Window Co."]);
  });

  it("non-staff → not_staff; staff without the key → forbidden", async () => {
    h = await harness();
    const w = await world();
    expect(await codeOf(h.tenancy.listCompanies({ actorUserId: w.olivia }))).toBe("not_staff");
    const agent = await h.user("agent@igloo.test");
    await h.staff(agent, "cs_agent");
    expect(await codeOf(h.tenancy.suspendCompany({ actorUserId: agent, tenantId: w.gig, reason: "Testing it" }))).toBe("forbidden");
  });
});

describe("company detail and suspension", () => {
  it("detail: members, the owner, and ownerDeleted after the owner's account is closed", async () => {
    h = await harness();
    const w = await world();
    let d = await h.tenancy.getCompanyDetail({ actorUserId: w.ava, tenantId: w.summit });
    expect(d.company).toMatchObject({ name: "Summit Window Co.", owner: { userId: w.olivia }, ownerDeleted: false, members: 2 });
    expect(d.members.map((m) => [m.name, m.roleKey, m.isOwner])).toEqual([["Olivia", "owner", true], ["Sam", "member", false]]);
    await h.db.execute(sql`update users set deleted_at = now() where id = ${w.olivia}`);
    await h.tenancy.deprovisionUser({ userId: w.olivia });
    d = await h.tenancy.getCompanyDetail({ actorUserId: w.ava, tenantId: w.summit });
    expect(d.company.ownerDeleted).toBe(true);
    expect(d.can).toEqual({ suspend: true, assignOwner: true, releaseAddresses: true, delete: false });
    expect(d.deletion).toEqual({ available: false, stillPaying: null });
  });

  it("suspend: audits; the gate says suspended; slug lookups and accepts stop; the session is 'suspended'; idempotent; reactivate restores", async () => {
    h = await harness();
    const w = await world();
    const inv = await h.tenancy.sendInvitation({ actorUserId: w.sam, tenantId: w.gig, email: "rae@x.test", roleKey: "member" });
    const first = await h.tenancy.suspendCompany({ actorUserId: w.ava, tenantId: w.gig, reason: "Unpaid since August" });
    expect(first.company).toMatchObject({ status: "suspended", suspendedReason: "Unpaid since August", suspendedBy: { userId: w.ava } });
    expect(h.audit.find((a) => a.action === "company.suspended")).toMatchObject({ scope: "staff", actorUserId: w.ava });
    expect(await tenancyMembershipGate(h.db, { userId: w.sam, tenantId: w.gig })).toBe("company-suspended");
    expect(await h.tenancy.resolveCompanyBySlug("side-gig")).toBeNull();
    const rae = await h.user("rae@x.test");
    expect(await h.tenancy.acceptInvitation({ token: inv.token, userId: rae })).toEqual({ status: "company-unavailable" });
    await h.tenancy.setActiveCompany({ userId: w.sam, tenantId: w.gig });
    expect((await h.tenancy.resolveSession({ userId: w.sam })).state).toBe("suspended");
    const again = await h.tenancy.suspendCompany({ actorUserId: w.ava, tenantId: w.gig, reason: "A different reason" });
    expect(again.company.suspendedReason).toBe("Unpaid since August");
    await h.tenancy.reactivateCompany({ actorUserId: w.ava, tenantId: w.gig });
    expect(await tenancyMembershipGate(h.db, { userId: w.sam, tenantId: w.gig })).toBe("member");
    expect((await h.tenancy.resolveSession({ userId: w.sam })).state).toBe("ready");
    expect(await h.tenancy.resolveCompanyBySlug("side-gig")).not.toBeNull();
  });

  it("a reason must be 3–500 characters", async () => {
    h = await harness();
    const w = await world();
    expect(await codeOf(h.tenancy.suspendCompany({ actorUserId: w.ava, tenantId: w.gig, reason: " x " }))).toBe("invalid");
  });
});

describe("change owner from the console (review T1-03)", () => {
  it("the owner closed their account: staff hand the company to an active member; D4 holds; audited at staff scope", async () => {
    h = await harness();
    const w = await world();
    const office = await h.user("office@summit.test");
    await h.db.execute(sql`insert into tenant_members (tenant_id, user_id) values (${w.summit}, ${office})`);
    await h.db.execute(sql`update users set deleted_at = now() where id = ${w.olivia}`);
    await h.tenancy.deprovisionUser({ userId: w.olivia });
    expect(await codeOf(h.tenancy.assignOwner({ actorUserId: w.ava, tenantId: w.summit, toUserId: w.olivia }))).toBe("not_found");
    const d = await h.tenancy.assignOwner({ actorUserId: w.ava, tenantId: w.summit, toUserId: office });
    expect(d.company.owner?.userId).toBe(office);
    expect(d.company.ownerDeleted).toBe(false);
    await assertOwnerInvariant(h.db, w.summit);
    expect(h.audit.find((a) => a.action === "company.ownership.transferred")).toMatchObject({ scope: "staff", actorUserId: w.ava, metadata: { via: "operator" } });
    // The new owner can now do owner-only things.
    expect(await codeOf(h.tenancy.transferOwnership({ actorUserId: office, tenantId: w.summit, toUserId: w.sam, confirmName: "Summit Window Co." }))).toBe("ok");
  });

  it("needs staff.tenants.transfer", async () => {
    h = await harness();
    const w = await world();
    const lead = await h.user("lead@igloo.test");
    await h.staff(lead, "cs_lead");
    expect(await codeOf(h.tenancy.assignOwner({ actorUserId: lead, tenantId: w.summit, toUserId: w.sam }))).toBe("forbidden");
  });
});

describe("release old web addresses (review T1-07)", () => {
  it("frees a company's retired addresses so someone else can claim them", async () => {
    h = await harness();
    const w = await world();
    await h.tenancy.updateCompanyProfile({ actorUserId: w.olivia, tenantId: w.summit, slug: "summit-windows" });
    expect((await h.tenancy.getCompanyDetail({ actorUserId: w.ava, tenantId: w.summit })).retiredAddresses).toEqual(["summit-window-co"]);
    const d = await h.tenancy.releaseRetiredAddresses({ actorUserId: w.ava, tenantId: w.summit });
    expect(d.retiredAddresses).toEqual([]);
    expect(await h.tenancy.resolveCompanyBySlug("summit-window-co")).toBeNull();
    const other = await h.user("other@x.test");
    expect((await h.tenancy.createCompany({ userId: other, name: "Other", slug: "summit-window-co", requestKey: "key-other-co", purpose: "onboarding" })).status).toBe("created");
  });
});

describe("People and staff roles", () => {
  it("lists people with their staff role; a cs_lead can't grant admin; self → self; each change is audited", async () => {
    h = await harness();
    const w = await world();
    const lead = await h.user("lead@igloo.test");
    await h.staff(lead, "cs_lead");
    const people = await h.tenancy.listPeople({ actorUserId: w.ava });
    expect(people.people.find((p) => p.userId === lead)?.staffRole?.key).toBe("cs_lead");
    expect(people.roles.map((r) => [r.key, r.assignable])).toEqual([["admin", true], ["cs_lead", true], ["cs_agent", true]]);
    // cs_lead has no staff.roles.manage by default; give it to prove the RANK guard.
    await h.db.execute(sql`insert into principal_override (principal_id, scope, tenant_id, permission, effect) values (${lead}, 'staff', '*', 'staff.roles.manage', 'allow')`);
    expect(await codeOf(h.tenancy.setStaffRole({ actorUserId: lead, targetUserId: w.olivia, templateKey: "admin" }))).toBe("rank");
    expect(await codeOf(h.tenancy.setStaffRole({ actorUserId: w.ava, targetUserId: w.ava, templateKey: "cs_agent" }))).toBe("self");
    const p = await h.tenancy.setStaffRole({ actorUserId: w.ava, targetUserId: w.olivia, templateKey: "cs_agent" });
    expect(p.staffRole?.key).toBe("cs_agent");
    expect(h.audit.find((a) => a.action === "staff.role.assigned")?.metadata).toMatchObject({ from: null, to: "cs_agent" });
  });

  it("an administrator can make a second administrator from People, and demote one (review T1-09)", async () => {
    h = await harness();
    const w = await world();
    const bo = await h.user("bo@igloo.test");
    expect((await h.tenancy.setStaffRole({ actorUserId: w.ava, targetUserId: bo, templateKey: "admin" })).staffRole?.key).toBe("admin");
    // Bo (now an admin) can demote Ava; Ava then can't touch Bo, and nobody can remove the LAST admin.
    expect((await h.tenancy.setStaffRole({ actorUserId: bo, targetUserId: w.ava, templateKey: null })).staffRole).toBeNull();
    expect(await codeOf(h.tenancy.listPeople({ actorUserId: w.ava }))).toBe("not_staff");
  });

  it("removing the last admin → last_admin (a system path: a script or the bootstrap)", async () => {
    h = await harness();
    const w = await world();
    const { assignRoleTemplate, RoleAssignmentError } = await import("@adminigloo/permissions/server");
    const attempt = await assignRoleTemplate(h.db, { scope: "staff", principalId: w.ava, templateKey: null, actor: { system: "script" }, protectLastKey: "admin" }).catch((e: unknown) => e);
    expect(attempt).toBeInstanceOf(RoleAssignmentError);
    expect((attempt as { code: string }).code).toBe("last-holder");
  });
});

describe("freeing a squatter's address (review R2 SEC-T1-C)", () => {
  it("for a SUSPENDED company, Release frees its current address too; an active company keeps its own", async () => {
    h = await harness();
    const w = await world();
    const squatter = await h.user("squat@evil.test");
    const made = await h.tenancy.createCompany({ userId: squatter, name: "Acme Plumbing", slug: "acme-plumbing", requestKey: "key-squat-1", purpose: "additional" });
    await h.tenancy.updateCompanyProfile({ actorUserId: squatter, tenantId: made.company.id, slug: "acme-plumbing-co" });
    const victim = await h.user("owner@acme.test");
    expect((await h.tenancy.checkSlug({ actorUserId: victim, slug: "acme-plumbing-co" })).available).toBe(false);

    // Active: only the old ones go.
    await h.tenancy.releaseRetiredAddresses({ actorUserId: w.ava, tenantId: made.company.id });
    expect((await h.tenancy.checkSlug({ actorUserId: victim, slug: "acme-plumbing" })).available).toBe(true);
    expect((await h.tenancy.checkSlug({ actorUserId: victim, slug: "acme-plumbing-co" })).available).toBe(false);

    // Suspended: the current one goes too, and the company keeps a neutral address.
    await h.tenancy.suspendCompany({ actorUserId: w.ava, tenantId: made.company.id, reason: "squatting a business name" });
    const detail = await h.tenancy.releaseRetiredAddresses({ actorUserId: w.ava, tenantId: made.company.id });
    expect((await h.tenancy.checkSlug({ actorUserId: victim, slug: "acme-plumbing-co" })).available).toBe(true);
    expect(detail.company.slug).not.toBe("acme-plumbing-co");
    expect(h.audit.filter((a) => a.action === "company.addresses.released").at(-1)?.metadata).toMatchObject({ current: { from: "acme-plumbing-co" } });
    const real = await h.tenancy.createCompany({ userId: victim, name: "Acme Plumbing", slug: "acme-plumbing-co", requestKey: "key-real-1", purpose: "onboarding" });
    expect(real.company.slug).toBe("acme-plumbing-co");
  });
});

describe("support can find a team member's companies (review R2 T1BO-09)", () => {
  it("console search matches MEMBER emails too; company detail lists pending invitations by address", async () => {
    h = await harness();
    const w = await world();
    const names = async (q: string) => (await h.tenancy.listCompanies({ actorUserId: w.ava, q })).companies.map((c) => c.name).sort();
    // Sam owns Side Gig and is a member of Summit.
    expect(await names("sam@gig.test")).toEqual(["Side Gig", "Summit Window Co."]);
    await h.tenancy.sendInvitation({ actorUserId: w.olivia, tenantId: w.summit, email: "crew@summit.test", roleKey: "member" });
    const detail = await h.tenancy.getCompanyDetail({ actorUserId: w.ava, tenantId: w.summit });
    expect(detail.invitations.map((i) => [i.email, i.roleName])).toEqual([["crew@summit.test", "Member"]]);
    expect(detail.invitations[0]?.invitedBy).toBe("Olivia");
  });
});
