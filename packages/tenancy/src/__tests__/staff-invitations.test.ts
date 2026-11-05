import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { STAFF_INVITATION_DAYS, STAFF_INVITATION_EMAIL_COOLDOWN_MINUTES } from "../server.js";
import { codeOf, harness, type Harness } from "./harness.js";

/**
 * STAFF INVITATIONS AND NAMES (tenancy 0.9), from People: invite someone to a
 * staff role by address; their first sign-in (provisioning, or the /admin
 * gate) takes it up on their verified address; a person's name, your own or
 * anyone's as an administrator, written to the identity provider first.
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function world() {
  const ava = await h.user("ava@igloo.test", { name: "Ava" });
  await h.staff(ava, "admin");
  const olivia = await h.user("olivia@summit.test", { name: "Olivia" });
  return { ava, olivia };
}

const roleOf = async (userId: string) =>
  (await h.tenancy.listPeople({ actorUserId: (await h.db.execute(sql`select id from users where email = 'ava@igloo.test'`)).rows[0]!["id"] as string })).people.find(
    (p) => p.userId === userId,
  )?.staffRole?.key ?? null;

describe("inviting someone to a staff role", () => {
  it("an address with no account waits; its first sign-in takes up the role, audited", async () => {
    h = await harness();
    const w = await world();
    const sent = await h.tenancy.inviteStaff({ actorUserId: w.ava, email: "  New.Hire@Igloo.test ", templateKey: "cs_agent" });
    expect(sent.kind).toBe("invited");
    if (sent.kind !== "invited") return;
    expect(sent.sendEmail).toBe(true);
    expect(sent.invitation).toMatchObject({ email: "new.hire@igloo.test", role: { key: "cs_agent" }, invitedBy: "Ava", expired: false, canRevoke: true });
    expect(sent.invitation.expiresAt.getTime() - h.clock.now.getTime()).toBe(STAFF_INVITATION_DAYS * 86_400_000);
    expect((await h.tenancy.listStaffInvitations({ actorUserId: w.ava })).map((i) => i.email)).toEqual(["new.hire@igloo.test"]);

    const hire = await h.user("new.hire@igloo.test");
    expect(await roleOf(hire)).toBe("cs_agent");
    expect(await h.tenancy.listStaffInvitations({ actorUserId: w.ava })).toEqual([]);
    expect(h.audit.map((a) => a.action)).toEqual(expect.arrayContaining(["staff.invitation.sent", "staff.invitation.claimed"]));
  });

  it("an address that already has an account gets the role at once, under setStaffRole's rules", async () => {
    h = await harness();
    const w = await world();
    const result = await h.tenancy.inviteStaff({ actorUserId: w.ava, email: "olivia@summit.test", templateKey: "cs_lead" });
    expect(result.kind).toBe("granted");
    expect(result.kind === "granted" ? result.person.staffRole?.key : null).toBe("cs_lead");
    expect(await h.tenancy.listStaffInvitations({ actorUserId: w.ava })).toEqual([]);
  });

  it("inviting again replaces the role and restarts the clock, and emails an address once per cooldown", async () => {
    h = await harness();
    const w = await world();
    const first = await h.tenancy.inviteStaff({ actorUserId: w.ava, email: "x@igloo.test", templateKey: "cs_agent" });
    const again = await h.tenancy.inviteStaff({ actorUserId: w.ava, email: "x@igloo.test", templateKey: "cs_lead" });
    expect(first.kind === "invited" && first.sendEmail).toBe(true);
    expect(again.kind === "invited" ? [again.sendEmail, again.invitation.role.key, again.invitation.id] : null).toEqual([
      false,
      "cs_lead",
      first.kind === "invited" ? first.invitation.id : "",
    ]);
    h.clock.now = new Date(h.clock.now.getTime() + (STAFF_INVITATION_EMAIL_COOLDOWN_MINUTES + 1) * 60_000);
    const later = await h.tenancy.inviteStaff({ actorUserId: w.ava, email: "x@igloo.test", templateKey: "cs_lead" });
    expect(later.kind === "invited" && later.sendEmail).toBe(true);
    expect(await h.tenancy.listStaffInvitations({ actorUserId: w.ava })).toHaveLength(1);
  });

  it("refuses a role above your own, and anyone without staff.roles.manage", async () => {
    h = await harness();
    const w = await world();
    const lead = await h.user("lead@igloo.test");
    await h.staff(lead, "cs_lead");
    await h.db.execute(sql`insert into principal_override (principal_id, scope, tenant_id, permission, effect) values (${lead}, 'staff', '*', 'staff.roles.manage', 'allow')`);
    expect(await codeOf(h.tenancy.inviteStaff({ actorUserId: lead, email: "boss@igloo.test", templateKey: "admin" }))).toBe("rank");
    const agent = await h.user("agent@igloo.test");
    await h.staff(agent, "cs_agent");
    expect(await codeOf(h.tenancy.inviteStaff({ actorUserId: agent, email: "z@igloo.test", templateKey: "cs_agent" }))).toBe("forbidden");
    expect(await codeOf(h.tenancy.inviteStaff({ actorUserId: w.olivia, email: "z@igloo.test", templateKey: "cs_agent" }))).toBe("not_staff");
    expect(await codeOf(h.tenancy.inviteStaff({ actorUserId: w.ava, email: "not-an-address", templateKey: "cs_agent" }))).toBe("invalid");
  });

  it("a withdrawn or expired invitation is never taken up", async () => {
    h = await harness();
    const w = await world();
    const withdrawn = await h.tenancy.inviteStaff({ actorUserId: w.ava, email: "gone@igloo.test", templateKey: "cs_agent" });
    if (withdrawn.kind !== "invited") throw new Error("expected an invitation");
    await h.tenancy.revokeStaffInvitation({ actorUserId: w.ava, invitationId: withdrawn.invitation.id });
    await h.tenancy.revokeStaffInvitation({ actorUserId: w.ava, invitationId: withdrawn.invitation.id }); // idempotent
    expect(await roleOf(await h.user("gone@igloo.test"))).toBeNull();

    await h.tenancy.inviteStaff({ actorUserId: w.ava, email: "late@igloo.test", templateKey: "cs_agent" });
    h.clock.now = new Date(h.clock.now.getTime() + (STAFF_INVITATION_DAYS + 1) * 86_400_000);
    expect((await h.tenancy.listStaffInvitations({ actorUserId: w.ava }))[0]?.expired).toBe(true);
    expect(await roleOf(await h.user("late@igloo.test"))).toBeNull();
    expect(h.audit.filter((a) => a.action === "staff.invitation.revoked")).toHaveLength(1);
  });

  it("the /admin gate takes it up for an account made before anything claimed it (a webhook that came first)", async () => {
    h = await harness();
    const w = await world();
    await h.tenancy.inviteStaff({ actorUserId: w.ava, email: "early@igloo.test", templateKey: "cs_lead" });
    // A row written without provisioning, the way an older webhook left it.
    const early = await h.user("early@igloo.test", { provision: false });
    expect(await roleOf(early)).toBeNull();
    expect(await h.tenancy.ensureStaffAccess({ userId: early, email: "early@igloo.test" })).toEqual({ granted: true, via: "invitation" });
    expect(await roleOf(early)).toBe("cs_lead");
    // Nothing left to take up: the next visit is a plain refusal, not an error.
    const stranger = await h.user("stranger@elsewhere.test");
    expect((await h.tenancy.ensureStaffAccess({ userId: stranger, email: "stranger@elsewhere.test" })).granted).toBe(false);
  });

  it("is its inviter's authority: an inviter who lost their rank can't hand it out, and the invitation stays open", async () => {
    h = await harness();
    const w = await world();
    const lead = await h.user("lead@igloo.test");
    await h.staff(lead, "cs_lead");
    await h.db.execute(sql`insert into principal_override (principal_id, scope, tenant_id, permission, effect) values (${lead}, 'staff', '*', 'staff.roles.manage', 'allow')`);
    await h.tenancy.inviteStaff({ actorUserId: lead, email: "proxy@igloo.test", templateKey: "cs_agent" });
    await h.tenancy.setStaffRole({ actorUserId: w.ava, targetUserId: lead, templateKey: null });
    expect(await roleOf(await h.user("proxy@igloo.test"))).toBeNull();
    expect(await h.tenancy.listStaffInvitations({ actorUserId: w.ava })).toHaveLength(1);
  });

  it("never demotes: a higher role someone already holds is kept, and the invitation is spent", async () => {
    h = await harness();
    const w = await world();
    await h.tenancy.inviteStaff({ actorUserId: w.ava, email: "boss@igloo.test", templateKey: "cs_agent" });
    const boss = await h.user("boss@igloo.test", { provision: false });
    await h.staff(boss, "admin");
    await h.tenancy.provisionUser({ userId: boss, email: "boss@igloo.test" });
    expect(await roleOf(boss)).toBe("admin");
    expect(await h.tenancy.listStaffInvitations({ actorUserId: w.ava })).toEqual([]);
    expect(h.audit.find((a) => a.action === "staff.invitation.claimed")?.metadata).toMatchObject({ kept: "admin" });
  });
});

describe("a person's name", () => {
  it("your own with any staff role; anyone's as an administrator; written to the identity provider first, then shown", async () => {
    const renamed: unknown[] = [];
    h = await harness({ identity: { updateName: async (input) => void renamed.push(input) } });
    const w = await world();
    const agent = await h.user("agent@igloo.test");
    await h.staff(agent, "cs_agent");

    const self = await h.tenancy.setPersonName({ actorUserId: agent, targetUserId: agent, firstName: " Ann ", lastName: "Agent" });
    expect(self.name).toBe("Ann Agent");
    expect(await codeOf(h.tenancy.setPersonName({ actorUserId: agent, targetUserId: w.olivia, firstName: "No", lastName: "" }))).toBe("forbidden");

    const other = await h.tenancy.setPersonName({ actorUserId: w.ava, targetUserId: w.olivia, firstName: "Olivia", lastName: "Stone" });
    expect([other.name, other.canRename]).toEqual(["Olivia Stone", true]);
    expect(renamed).toEqual([
      { userId: agent, externalId: `user_${agent}`, firstName: "Ann", lastName: "Agent" },
      { userId: w.olivia, externalId: `user_${w.olivia}`, firstName: "Olivia", lastName: "Stone" },
    ]);
    expect(await codeOf(h.tenancy.setPersonName({ actorUserId: w.ava, targetUserId: w.olivia, firstName: " ", lastName: "" }))).toBe("invalid");
    expect(h.audit.filter((a) => a.action === "person.renamed")).toHaveLength(2);
    const people = await h.tenancy.listPeople({ actorUserId: agent }).catch(() => null);
    expect(people === null || people.people.every((p) => p.canRename === p.isYou)).toBe(true);
  });

  it("a provider that refuses the name leaves the local one as it was", async () => {
    h = await harness({ identity: { updateName: async () => Promise.reject(new Error("provider down")) } });
    const w = await world();
    await expect(h.tenancy.setPersonName({ actorUserId: w.ava, targetUserId: w.olivia, firstName: "Changed", lastName: "" })).rejects.toThrow("provider down");
    const rows = await h.db.execute(sql`select display_name from users where id = ${w.olivia}`);
    expect(rows.rows[0]?.["display_name"]).toBe("Olivia");
  });
});
