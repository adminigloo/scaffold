import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createDrizzlePermissionLoaders } from "@adminigloo/permissions/server";
import type { RoleKey } from "../wire.js";
import { tenancyMembershipGate } from "../server.js";
import { assertOwnerInvariant, call, codeOf, handlersFor, harness, type Harness } from "./harness.js";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

/** A company with one person at each role, plus someone with no role. */
async function roster() {
  const owner = await h.user("owner@x.test", { name: "Olivia" });
  const admin = await h.user("admin@x.test", { name: "Ada" });
  const member = await h.user("member@x.test", { name: "Mo" });
  const viewer = await h.user("viewer@x.test", { name: "Vi" });
  const norole = await h.user("norole@x.test", { name: "Nora" });
  const tenantId = await h.company(owner, "Summit", { [admin]: "admin", [member]: "member", [viewer]: "viewer" });
  await h.db.execute(sql`insert into tenant_members (tenant_id, user_id) values (${tenantId}, ${norole})`);
  return { owner, admin, member, viewer, norole, tenantId };
}

describe("the role matrix (6.8, D5): every actor × target × role", () => {
  it("only strictly-greater ranks change roles; owner is never given; the owner and yourself are never changed", async () => {
    h = await harness();
    const r = await roster();
    const actors = { owner: r.owner, admin: r.admin, member: r.member, viewer: r.viewer } as const;
    const targets = { owner: r.owner, admin: r.admin, member: r.member, viewer: r.viewer, norole: r.norole } as const;
    const rank: Record<string, number> = { owner: 40, admin: 30, member: 20, viewer: 10, norole: 0 };
    const roles: RoleKey[] = ["admin", "member", "viewer", "owner"];
    for (const [actorName, actor] of Object.entries(actors)) {
      for (const [targetName, target] of Object.entries(targets)) {
        for (const role of roles) {
          // Fresh roster state for each cell: restore everyone's role first.
          for (const [name, id] of Object.entries(targets)) {
            if (name === "owner" || name === "norole") continue;
            await h.db.execute(sql`update principal_role set template_id = (select id from role_template where scope = 'tenant' and key = ${name})
              where principal_id = ${id} and tenant_id = ${r.tenantId}`);
          }
          await h.db.execute(sql`delete from principal_role where principal_id = ${r.norole} and tenant_id = ${r.tenantId}`);
          const got = await codeOf(h.tenancy.changeMemberRole({ actorUserId: actor, tenantId: r.tenantId, targetUserId: target, roleKey: role }));
          let want: string;
          const canChange = actorName === "owner" || actorName === "admin";
          if (!canChange) want = "forbidden";
          else if (role === "owner") want = "owner_must_transfer";
          else if (actor === target) want = "self";
          else if (targetName === "owner") want = "owner_protected";
          else if (rank[actorName]! > rank[targetName]! && rank[actorName]! > rank[role]!) want = "ok";
          else want = "rank";
          expect(got, `${actorName} → ${targetName} as ${role}`).toBe(want);
        }
      }
    }
    await assertOwnerInvariant(h.db, r.tenantId);
  });
});

describe("role changes (D12)", () => {
  it("clear the target's overrides in that company only, and the audit lists them; a demoted admin loses an allow override", async () => {
    h = await harness();
    const r = await roster();
    const other = await h.company(r.owner, "Other", { [r.admin]: "admin" });
    for (const t of [r.tenantId, other]) {
      await h.db.execute(sql`insert into principal_override (principal_id, scope, tenant_id, permission, effect)
        values (${r.admin}, 'tenant', ${t}, 'tenant.transfer', 'allow'), (${r.admin}, 'tenant', ${t}, 'members.remove', 'allow')`);
    }
    await h.tenancy.changeMemberRole({ actorUserId: r.owner, tenantId: r.tenantId, targetUserId: r.admin, roleKey: "member" });
    const loaders = createDrizzlePermissionLoaders(h.db, { membership: tenancyMembershipGate });
    const set = await loaders.loadTenantPermissions({ principal: { userId: r.admin }, tenantId: r.tenantId });
    expect(set?.can("members.remove")).toBe(false);
    const left = await h.db.execute(sql`select tenant_id from principal_override where principal_id = ${r.admin}`);
    expect(left.rows.map((x: unknown) => (x as { tenant_id: string }).tenant_id)).toEqual([other, other]);
    const audit = h.audit.find((a) => a.action === "member.role.changed");
    expect(audit?.metadata).toMatchObject({ from: "admin", to: "member", clearedOverrides: ["members.remove", "tenant.transfer"], member: "Ada" });
  });

  it("getTeam actions agree with what the mutations accept (every row × every role)", async () => {
    h = await harness();
    const r = await roster();
    for (const caller of [r.owner, r.admin, r.member]) {
      const team = await h.tenancy.getTeam({ actorUserId: caller, tenantId: r.tenantId });
      for (const row of team.members) {
        for (const role of ["admin", "member", "viewer"] as const) {
          if (row.roleKey === role) continue;
          const offered = row.actions.roles.includes(role);
          const outcome = await codeOf(
            h.tenancy.changeMemberRole({ actorUserId: caller, tenantId: r.tenantId, targetUserId: row.userId, roleKey: role }),
          );
          // Put the roster back by hand when it applied, so the next cell
          // starts from the same state the actions were computed on.
          if (outcome === "ok") {
            const back = row.roleKey;
            await h.db.execute(sql`delete from principal_role where principal_id = ${row.userId} and tenant_id = ${r.tenantId}`);
            if (back) {
              await h.db.execute(sql`insert into principal_role (principal_id, scope, tenant_id, template_id)
                select ${row.userId}, 'tenant', ${r.tenantId}, id from role_template where scope = 'tenant' and key = ${back}`);
            }
          }
          expect(outcome === "ok", `${caller} → ${row.userId} as ${role}`).toBe(offered);
        }
      }
    }
  });
});

describe("removal (D11, scenario step 3: access ends on the very next request)", () => {
  it("deletes the membership, role and overrides; the next load is null, the session falls back, a handler call is 403", async () => {
    h = await harness();
    const r = await roster();
    await h.db.execute(sql`insert into principal_override (principal_id, scope, tenant_id, permission, effect) values (${r.member}, 'tenant', ${r.tenantId}, 'tenant.edit', 'allow')`);
    await h.tenancy.removeMember({ actorUserId: r.admin, tenantId: r.tenantId, targetUserId: r.member });
    for (const table of ["tenant_members", "principal_override"]) {
      const n = await h.db.execute(sql`select count(*)::int as n from ${sql.raw(table)} where tenant_id = ${r.tenantId} and ${sql.raw(table === "tenant_members" ? "user_id" : "principal_id")} = ${r.member}`);
      expect((n.rows[0] as { n: number }).n, table).toBe(0);
    }
    const loaders = createDrizzlePermissionLoaders(h.db, { membership: tenancyMembershipGate });
    expect(await loaders.loadTenantPermissions({ principal: { userId: r.member }, tenantId: r.tenantId })).toBeNull();
    expect((await h.tenancy.resolveSession({ userId: r.member })).state).toBe("needs-onboarding");
    const { company } = handlersFor(h);
    const res = await call(company, r.member, "GET", `v1/companies/${r.tenantId}/members`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_a_member");
  });

  it("refusals: yourself → self; the owner → owner_protected; an admin removing an admin → rank; a no-role member can be removed by an admin", async () => {
    h = await harness();
    const r = await roster();
    const admin2 = await h.user("admin2@x.test");
    await h.db.execute(sql`insert into tenant_members (tenant_id, user_id) values (${r.tenantId}, ${admin2})`);
    await h.db.execute(sql`insert into principal_role (principal_id, scope, tenant_id, template_id) select ${admin2}, 'tenant', ${r.tenantId}, id from role_template where scope = 'tenant' and key = 'admin'`);
    expect(await codeOf(h.tenancy.removeMember({ actorUserId: r.admin, tenantId: r.tenantId, targetUserId: r.admin }))).toBe("self");
    expect(await codeOf(h.tenancy.removeMember({ actorUserId: r.admin, tenantId: r.tenantId, targetUserId: r.owner }))).toBe("owner_protected");
    expect(await codeOf(h.tenancy.removeMember({ actorUserId: r.admin, tenantId: r.tenantId, targetUserId: admin2 }))).toBe("rank");
    expect(await codeOf(h.tenancy.removeMember({ actorUserId: r.admin, tenantId: r.tenantId, targetUserId: r.norole }))).toBe("ok");
    await assertOwnerInvariant(h.db, r.tenantId);
  });

  it("withdraws the invitations the removed person sent (review T1-03): their alt address can't rejoin", async () => {
    h = await harness();
    const r = await roster();
    const sent = await h.tenancy.sendInvitation({ actorUserId: r.admin, tenantId: r.tenantId, email: "mallory.alt@gmail.test", roleKey: "member" });
    await h.tenancy.removeMember({ actorUserId: r.owner, tenantId: r.tenantId, targetUserId: r.admin });
    const alt = await h.user("mallory.alt@gmail.test");
    expect(await h.tenancy.acceptInvitation({ token: sent.token, userId: alt })).toEqual({ status: "revoked" });
    expect(await tenancyMembershipGate(h.db, { userId: alt, tenantId: r.tenantId })).toBe("not-a-member");
    expect(h.audit.filter((a) => a.action === "invitation.revoked").map((a) => a.metadata["via"])).toEqual(["member.removed"]);
  });

  it("a demotion to a role that can't invite withdraws EVERY invitation they sent (review R2 SEC-T1-F)", async () => {
    h = await harness();
    const r = await roster();
    const promoted = await h.user("p@x.test");
    await h.db.execute(sql`insert into tenant_members (tenant_id, user_id) values (${r.tenantId}, ${promoted})`);
    await h.tenancy.changeMemberRole({ actorUserId: r.owner, tenantId: r.tenantId, targetUserId: promoted, roleKey: "admin" });
    const asMember = await h.tenancy.sendInvitation({ actorUserId: promoted, tenantId: r.tenantId, email: "m@x.test", roleKey: "member" });
    const asViewer = await h.tenancy.sendInvitation({ actorUserId: promoted, tenantId: r.tenantId, email: "v@x.test", roleKey: "viewer" });
    // Member holds no members.invite: nothing they sent as an admin survives.
    await h.tenancy.changeMemberRole({ actorUserId: r.owner, tenantId: r.tenantId, targetUserId: promoted, roleKey: "member" });
    const open = (await h.tenancy.listInvitations({ actorUserId: r.owner, tenantId: r.tenantId })).map((i) => i.id);
    expect(open).not.toContain(asViewer.invitation.id);
    expect(open).not.toContain(asMember.invitation.id);
  });

  it("a demotion to a role that CAN still invite withdraws only what it can't send, and keeps the rest", async () => {
    h = await harness();
    const r = await roster();
    // This project lets Members invite (a template grant), so a Member may send Viewer invitations.
    await h.db.execute(sql`insert into role_template_grant (template_id, permission, effect)
      select id, 'members.invite', 'allow' from role_template where scope = 'tenant' and key = 'member'`);
    const promoted = await h.user("p@x.test");
    await h.db.execute(sql`insert into tenant_members (tenant_id, user_id) values (${r.tenantId}, ${promoted})`);
    await h.tenancy.changeMemberRole({ actorUserId: r.owner, tenantId: r.tenantId, targetUserId: promoted, roleKey: "admin" });
    const asMember = await h.tenancy.sendInvitation({ actorUserId: promoted, tenantId: r.tenantId, email: "m@x.test", roleKey: "member" });
    const asViewer = await h.tenancy.sendInvitation({ actorUserId: promoted, tenantId: r.tenantId, email: "v@x.test", roleKey: "viewer" });
    await h.tenancy.changeMemberRole({ actorUserId: r.owner, tenantId: r.tenantId, targetUserId: promoted, roleKey: "member" });
    const open = (await h.tenancy.listInvitations({ actorUserId: r.owner, tenantId: r.tenantId })).map((i) => i.id);
    expect(open).toContain(asViewer.invitation.id);
    expect(open).not.toContain(asMember.invitation.id);
  });
});

describe("leaving", () => {
  it("works for a member, refuses the owner (last_owner), and works in a suspended company", async () => {
    h = await harness();
    const r = await roster();
    expect(await codeOf(h.tenancy.leaveCompany({ userId: r.viewer, tenantId: r.tenantId }))).toBe("ok");
    expect(await codeOf(h.tenancy.leaveCompany({ userId: r.owner, tenantId: r.tenantId }))).toBe("last_owner");
    await h.db.execute(sql`update tenants set suspended_at = now() where id = ${r.tenantId}`);
    expect(await codeOf(h.tenancy.leaveCompany({ userId: r.member, tenantId: r.tenantId }))).toBe("ok");
  });
});

describe("transfer (D4)", () => {
  it("a wrong confirmation → confirmation_mismatch; case and spacing don't matter", async () => {
    h = await harness();
    const r = await roster();
    expect(await codeOf(h.tenancy.transferOwnership({ actorUserId: r.owner, tenantId: r.tenantId, toUserId: r.admin, confirmName: "Summitt" }))).toBe("confirmation_mismatch");
    expect(await codeOf(h.tenancy.transferOwnership({ actorUserId: r.owner, tenantId: r.tenantId, toUserId: r.admin, confirmName: "  sUMMIT " }))).toBe("ok");
    await assertOwnerInvariant(h.db, r.tenantId);
  });

  it("a non-owner admin → forbidden; an owner whose tenant.transfer is denied by an override is still forbidden (sealed)", async () => {
    h = await harness();
    const r = await roster();
    expect(await codeOf(h.tenancy.transferOwnership({ actorUserId: r.admin, tenantId: r.tenantId, toUserId: r.member, confirmName: "Summit" }))).toBe("forbidden");
    await h.db.execute(sql`insert into principal_override (principal_id, scope, tenant_id, permission, effect) values (${r.owner}, 'tenant', ${r.tenantId}, 'tenant.transfer', 'deny')`);
    expect(await codeOf(h.tenancy.transferOwnership({ actorUserId: r.owner, tenantId: r.tenantId, toUserId: r.member, confirmName: "Summit" }))).toBe("forbidden");
  });

  it("a successful transfer swaps the roles, writes a sensitive audit row and keeps D4; the old owner can then leave", async () => {
    h = await harness();
    const r = await roster();
    const team = await h.tenancy.transferOwnership({ actorUserId: r.owner, tenantId: r.tenantId, toUserId: r.member, confirmName: "Summit" });
    expect(team.you).toMatchObject({ roleKey: "admin", isOwner: false, canLeave: true });
    expect(team.members.find((m) => m.userId === r.member)).toMatchObject({ isOwner: true, roleKey: "owner" });
    expect(h.audit.find((a) => a.action === "company.ownership.transferred")?.metadata).toMatchObject({ from: r.owner, to: r.member });
    await assertOwnerInvariant(h.db, r.tenantId);
  });
});

describe("races (D7), each in both orders", () => {
  it("transfer to B against removing B", async () => {
    // Removal first: the transfer then finds B gone.
    h = await harness();
    let r = await roster();
    await h.tenancy.removeMember({ actorUserId: r.owner, tenantId: r.tenantId, targetUserId: r.member });
    expect(await codeOf(h.tenancy.transferOwnership({ actorUserId: r.owner, tenantId: r.tenantId, toUserId: r.member, confirmName: "Summit" }))).toBe("not_found");
    await assertOwnerInvariant(h.db, r.tenantId);
    await h.close();
    // Transfer first: the removal then finds B is the owner.
    h = await harness();
    r = await roster();
    await h.tenancy.transferOwnership({ actorUserId: r.owner, tenantId: r.tenantId, toUserId: r.member, confirmName: "Summit" });
    expect(await codeOf(h.tenancy.removeMember({ actorUserId: r.owner, tenantId: r.tenantId, targetUserId: r.member }))).toBe("owner_protected");
    await assertOwnerInvariant(h.db, r.tenantId);
  });

  it("transfer against the actor losing ownership (a second transfer runs first) → forbidden", async () => {
    h = await harness();
    const r = await roster();
    await h.tenancy.transferOwnership({ actorUserId: r.owner, tenantId: r.tenantId, toUserId: r.admin, confirmName: "Summit" });
    expect(await codeOf(h.tenancy.transferOwnership({ actorUserId: r.owner, tenantId: r.tenantId, toUserId: r.member, confirmName: "Summit" }))).toBe("forbidden");
    await assertOwnerInvariant(h.db, r.tenantId);
  });

  it("a role change by an actor demoted just before → forbidden or rank", async () => {
    h = await harness();
    const r = await roster();
    await h.tenancy.changeMemberRole({ actorUserId: r.owner, tenantId: r.tenantId, targetUserId: r.admin, roleKey: "viewer" });
    expect(["forbidden", "rank"]).toContain(
      await codeOf(h.tenancy.changeMemberRole({ actorUserId: r.admin, tenantId: r.tenantId, targetUserId: r.member, roleKey: "viewer" })),
    );
  });

  it("two calls fired together leave one consistent owner (PGlite runs them in turn: a serial-order check; the lock itself is proved below)", async () => {
    h = await harness();
    const r = await roster();
    const [a, b] = await Promise.all([
      codeOf(h.tenancy.transferOwnership({ actorUserId: r.owner, tenantId: r.tenantId, toUserId: r.member, confirmName: "Summit" })),
      codeOf(h.tenancy.removeMember({ actorUserId: r.owner, tenantId: r.tenantId, targetUserId: r.member })),
    ]);
    expect([a, b].filter((x) => x === "ok")).toHaveLength(1);
    await assertOwnerInvariant(h.db, r.tenantId);
  });

  it("the company-row FOR UPDATE is the first statement of every mutation's transaction", async () => {
    h = await harness();
    const r = await roster();
    const mutations: [string, () => Promise<unknown>][] = [
      ["role", () => h.tenancy.changeMemberRole({ actorUserId: r.owner, tenantId: r.tenantId, targetUserId: r.viewer, roleKey: "member" })],
      ["remove", () => h.tenancy.removeMember({ actorUserId: r.owner, tenantId: r.tenantId, targetUserId: r.norole })],
      ["leave", () => h.tenancy.leaveCompany({ userId: r.viewer, tenantId: r.tenantId })],
      ["invite", () => h.tenancy.sendInvitation({ actorUserId: r.owner, tenantId: r.tenantId, email: "q@x.test", roleKey: "member" })],
      ["profile", () => h.tenancy.updateCompanyProfile({ actorUserId: r.owner, tenantId: r.tenantId, name: "Summit Windows" })],
      ["settings", () => h.tenancy.updateSettings({ actorUserId: r.owner, tenantId: r.tenantId, section: "company", values: { contactPhone: "555" } })],
      ["transfer", () => h.tenancy.transferOwnership({ actorUserId: r.owner, tenantId: r.tenantId, toUserId: r.admin, confirmName: "Summit Windows" })],
    ];
    for (const [name, run] of mutations) {
      h.t.queries.length = 0;
      await run();
      expect(h.t.queries[0]?.sql, name).toContain("adminigloo:tenancy/lock-company");
      expect(h.t.queries[0]?.sql, name).toContain("for update");
    }
  });
});

/**
 * WHAT THESE TESTS CAN AND CAN'T PROVE (review R2 F2). PGlite is one
 * connection: `Promise.all` over two transactions runs them one after the
 * other, so the "fired together" tests above prove that each SERIAL order
 * leaves the right answer — they would still pass with every lock deleted.
 * What makes the real interleavings safe is that each lock is taken, first,
 * on the right row or key. That is checked HERE, from the SQL each call
 * actually sends (the lock clause itself, not just the statement's tag), so
 * deleting a `for update` or an advisory lock fails a test. A real-Postgres
 * concurrency job is still owed (no database is available to these suites).
 */
describe("every lock the lifecycle relies on is in the SQL it sends (review R2 F2)", () => {
  const sent = () => h.t.queries.map((q) => q.sql);
  const tagged = (sqls: string[], tag: string) => sqls.filter((s) => s.includes(`adminigloo:${tag}`));

  it("company row, invitation row, per-user create lock, role lock and bootstrap lock, each with its lock clause", async () => {
    h = await harness({ bootstrap: { mode: "email", email: "boss@x.test" } });
    const r = await roster();

    h.t.queries.length = 0;
    const fresh = await h.user("newco@x.test");
    h.t.queries.length = 0;
    await h.tenancy.createCompany({ userId: fresh, name: "Fresh Co", requestKey: "key-fresh-co-1", purpose: "onboarding" });
    expect(sent()[0]).toMatch(/adminigloo:tenancy\/create-lock \*\/\s*select pg_advisory_xact_lock\(hashtextextended\(/);

    const inv = await h.tenancy.sendInvitation({ actorUserId: r.owner, tenantId: r.tenantId, email: "sam@x.test", roleKey: "member" });
    const sam = await h.user("sam@x.test");
    h.t.queries.length = 0;
    await h.tenancy.acceptInvitation({ token: inv.token, userId: sam });
    expect(tagged(sent(), "tenancy/lock-company")[0]).toMatch(/for update/);
    expect(tagged(sent(), "invitations/lock-by-token")[0]).toMatch(/for update/);

    const inv2 = await h.tenancy.sendInvitation({ actorUserId: r.owner, tenantId: r.tenantId, email: "kim@x.test", roleKey: "member" });
    const kim = await h.user("kim@x.test");
    h.t.queries.length = 0;
    await h.tenancy.joinInvitation({ invitationId: inv2.invitation.id, userId: kim, verifiedEmails: ["kim@x.test"] });
    expect(tagged(sent(), "tenancy/lock-company")[0]).toMatch(/for update/);
    expect(tagged(sent(), "invitations/lock-by-id")[0]).toMatch(/for update/);

    h.t.queries.length = 0;
    await h.tenancy.changeMemberRole({ actorUserId: r.owner, tenantId: r.tenantId, targetUserId: r.member, roleKey: "viewer" });
    const role = sent();
    expect(role[0]).toMatch(/adminigloo:tenancy\/lock-company .*for update/s);
    expect(tagged(role, "permissions/role-lock")[0]).toMatch(/pg_advisory_xact_lock\(/);

    h.t.queries.length = 0;
    await h.user("boss@x.test");
    expect(tagged(sent(), "permissions/bootstrap-lock")[0]).toMatch(/pg_advisory_xact_lock\(/);
  });

  it("personal mode: settling your own workspace locks it; a new one is made under the per-user create lock", async () => {
    h = await harness({ mode: "personal" });
    h.t.queries.length = 0;
    const ann = await h.user("ann@ws.test");
    expect(tagged(sent(), "tenancy/lock-company")[0]).toMatch(/for update/);
    await h.db.execute(sql`delete from tenant_members where user_id = ${ann}`);
    await h.db.execute(sql`update tenants set owner_user_id = 'someone-else' where owner_user_id = ${ann}`);
    h.t.queries.length = 0;
    await h.tenancy.resolveSession({ userId: ann });
    expect(tagged(sent(), "tenancy/create-lock")[0]).toMatch(/pg_advisory_xact_lock\(/);
  });
});
