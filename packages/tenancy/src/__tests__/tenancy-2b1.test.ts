import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defineTenantRoles,
  TENANCY_MEMBER_JOINED_KIND,
  TENANCY_MEMBER_LEFT_KIND,
  tenancyAlertKinds,
  tenancyAlertsFor,
  type TenancyAlertDraft,
  type TenancyAlertKinds,
} from "../index.js";
import { DEFAULT_SETTLE_EVENTS_MS, type LogoStore, type TenancyEvent } from "../server.js";
import { call, codeOf, handlersFor, harness, jsonOf, type Harness } from "./harness.js";

/**
 * Tenancy 2b-1 (contract 8, 15.4), on a real Postgres (PGlite): every event
 * has an id and a time, member events name the person, the handlers answer
 * a POST only after its events settled, `listMemberPeople({ holding })`
 * resolves permissions exactly as a request does in three queries for any
 * team, the logo store is told the company, and the alert mapper's table.
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const CREW = { key: "crew", name: "Crew member", description: "Opens their own crew's route for the day.", rank: 5 } as const;
const ROLES = defineTenantRoles([CREW]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function greenAcres() {
  const owner = await h.user("olivia@greenacres.test", { name: "Olivia Owner" });
  const admin = await h.user("ada@greenacres.test", { name: "Ada Admin" });
  const member = await h.user("mo@greenacres.test", { name: "Mo Member" });
  const tenantId = await h.company(owner, "Green Acres", { [admin]: "admin", [member]: "member" });
  return { owner, admin, member, tenantId };
}

/** The listener every suite uses: records, after commit, what it was told. */
function recorder() {
  const events: TenancyEvent[] = [];
  return { events, onEvent: (event: TenancyEvent) => void events.push(event) };
}

// ── 8.1 ids, times, people ─────────────────────────────────────────────────

describe("every event has an id and a time (8.1)", () => {
  it("stamps id (uuidv7, unique) and occurredAt (the service's now) on every kind of event", async () => {
    const rec = recorder();
    h = await harness({ onEvent: rec.onEvent, roles: ROLES });
    const g = await greenAcres();
    const ops = await h.user("ops@platform.test", { name: "Platform Ops" });
    await h.staff(ops, "admin");
    const { company, operator } = handlersFor(h);

    await h.tenancy.updateSettings({ actorUserId: g.owner, tenantId: g.tenantId, section: "company", values: { timeZone: "America/Denver" } });
    await h.tenancy.updateCompanyProfile({ actorUserId: g.owner, tenantId: g.tenantId, name: "Green Acres Lawn" });
    await h.tenancy.updateBranding({ actorUserId: g.owner, tenantId: g.tenantId, brandColor: "#0F766E" });
    h.clock.now = new Date("2026-10-13T09:30:00.000Z");
    const invite = await h.tenancy.sendInvitation({ actorUserId: g.owner, tenantId: g.tenantId, email: "cam@greenacres.test", roleKey: "crew" });
    const cam = await h.user("cam@greenacres.test", { name: "Cam Rivera" });
    await h.tenancy.acceptInvitation({ token: invite.token, userId: cam });
    await h.tenancy.changeMemberRole({ actorUserId: g.owner, tenantId: g.tenantId, targetUserId: g.member, roleKey: "viewer" });
    await h.tenancy.removeMember({ actorUserId: g.owner, tenantId: g.tenantId, targetUserId: g.member });
    await h.tenancy.leaveCompany({ userId: g.admin, tenantId: g.tenantId });
    expect((await call(operator, ops, "POST", `v1/admin/companies/${g.tenantId}/suspend`, { reason: "Test" })).status).toBe(200);
    expect((await call(operator, ops, "POST", `v1/admin/companies/${g.tenantId}/reactivate`, {})).status).toBe(200);
    expect((await call(company, g.owner, "GET", `v1/companies/${g.tenantId}`)).status).toBe(200);
    await h.tenancy.settleEvents();

    const types = rec.events.map((e) => e.type);
    for (const type of [
      "company.created",
      "company.settings.updated",
      "company.profile.updated",
      "company.branding.updated",
      "invitation.sent",
      "member.joined",
      "member.role.changed",
      "member.removed",
      "member.left",
      "company.suspended",
      "company.reactivated",
    ]) {
      expect(types, type).toContain(type);
    }
    for (const event of rec.events) {
      expect(event.id, event.type).toMatch(UUID_V7);
      expect(Number.isNaN(Date.parse(event.occurredAt)), event.type).toBe(false);
    }
    expect(new Set(rec.events.map((e) => e.id)).size).toBe(rec.events.length);
    // The service's own clock, not the wall clock.
    expect(rec.events.find((e) => e.type === "company.created")?.occurredAt).toBe("2026-10-12T15:00:00.000Z");
    expect(rec.events.find((e) => e.type === "member.joined")?.occurredAt).toBe("2026-10-13T09:30:00.000Z");
  });

  it("member events name the person; joined says the role in words", async () => {
    const rec = recorder();
    h = await harness({ onEvent: rec.onEvent, roles: ROLES });
    const g = await greenAcres();
    const invite = await h.tenancy.sendInvitation({ actorUserId: g.owner, tenantId: g.tenantId, email: "cam@greenacres.test", roleKey: "crew" });
    const cam = await h.user("cam@greenacres.test", { name: "Cam Rivera" });
    await h.tenancy.acceptInvitation({ token: invite.token, userId: cam });
    await h.tenancy.removeMember({ actorUserId: g.owner, tenantId: g.tenantId, targetUserId: g.member });
    await h.tenancy.leaveCompany({ userId: g.admin, tenantId: g.tenantId });
    await h.tenancy.settleEvents();

    const joined = rec.events.find((e) => e.type === "member.joined");
    expect(joined).toMatchObject({
      type: "member.joined",
      tenantId: g.tenantId,
      userId: cam,
      via: "invitation",
      person: { name: "Cam Rivera", email: "cam@greenacres.test" },
      roleName: "Crew member",
    });
    expect(rec.events.find((e) => e.type === "member.removed")).toMatchObject({
      userId: g.member,
      by: g.owner,
      person: { name: "Mo Member", email: "mo@greenacres.test" },
    });
    expect(rec.events.find((e) => e.type === "member.left")).toMatchObject({
      userId: g.admin,
      by: g.admin,
      person: { name: "Ada Admin", email: "ada@greenacres.test" },
    });
  });

  it("joining by a verified address names the person and the role too", async () => {
    const rec = recorder();
    h = await harness({ onEvent: rec.onEvent });
    const g = await greenAcres();
    const invite = await h.tenancy.sendInvitation({ actorUserId: g.owner, tenantId: g.tenantId, email: "sam@greenacres.test", roleKey: "member" });
    const sam = await h.user("sam@greenacres.test", { name: "Sam Lee" });
    const out = await h.tenancy.joinInvitation({ invitationId: invite.invitation.id, userId: sam, verifiedEmails: ["sam@greenacres.test"] });
    expect(out.status).toBe("accepted");
    await h.tenancy.settleEvents();
    expect(rec.events.find((e) => e.type === "member.joined")).toMatchObject({
      via: "verified-email",
      person: { name: "Sam Lee", email: "sam@greenacres.test" },
      roleName: "Member",
    });
  });

  it("a deleted user gives { name: null, email: null }", async () => {
    const rec = recorder();
    h = await harness({ onEvent: rec.onEvent });
    const g = await greenAcres();
    await h.db.execute(sql`update users set deleted_at = now() where id = ${g.member}`);
    await h.tenancy.removeMember({ actorUserId: g.owner, tenantId: g.tenantId, targetUserId: g.member });
    await h.tenancy.settleEvents();
    expect(rec.events.find((e) => e.type === "member.removed")).toMatchObject({ person: { name: null, email: null } });
  });

  it("with no listener, nothing is read for the person (one query, only when someone listens)", async () => {
    h = await harness();
    const g = await greenAcres();
    h.t.queries.length = 0;
    await h.tenancy.removeMember({ actorUserId: g.owner, tenantId: g.tenantId, targetUserId: g.member });
    expect(h.t.queries.filter((q) => q.sql.includes("adminigloo:tenancy/event-person"))).toEqual([]);
  });

  it("the person is read in ONE query", async () => {
    const rec = recorder();
    h = await harness({ onEvent: rec.onEvent });
    const g = await greenAcres();
    h.t.queries.length = 0;
    await h.tenancy.removeMember({ actorUserId: g.owner, tenantId: g.tenantId, targetUserId: g.member });
    expect(h.t.queries.filter((q) => q.sql.includes("adminigloo:tenancy/event-person"))).toHaveLength(1);
  });

  it("a failed person read is reported and the event still goes, naming nobody", async () => {
    const rec = recorder();
    const reported: string[] = [];
    h = await harness({ onEvent: rec.onEvent, onEventError: (_e, ev) => void reported.push(ev.type) });
    const g = await greenAcres();
    // The users table is renamed away AFTER the removal commits: only the
    // after-commit read can see it missing.
    const spy = vi.spyOn(h.db, "execute");
    spy.mockImplementation(((original) =>
      function (this: unknown, query: unknown) {
        const text = JSON.stringify(query);
        if (text.includes("adminigloo:tenancy/event-person")) return Promise.reject(new Error("database went away"));
        return (original as (q: unknown) => Promise<unknown>).call(h.db, query);
      })(h.db.execute.bind(h.db)) as typeof h.db.execute);
    await h.tenancy.removeMember({ actorUserId: g.owner, tenantId: g.tenantId, targetUserId: g.member });
    spy.mockRestore();
    await h.tenancy.settleEvents();
    expect(reported).toContain("event.person");
    expect(rec.events.find((e) => e.type === "member.removed")).toMatchObject({ person: { name: null, email: null } });
  });
});

// ── 8.1 settleEvents ───────────────────────────────────────────────────────

describe("settleEvents (8.1)", () => {
  it("waits for a slow listener", async () => {
    let done = false;
    h = await harness({
      onEvent: async (e) => {
        if (e.type !== "company.branding.updated") return;
        await sleep(80);
        done = true;
      },
    });
    const g = await greenAcres();
    await h.tenancy.updateBranding({ actorUserId: g.owner, tenantId: g.tenantId, brandColor: "#0F766E" });
    // emit stays fire-and-forget for a direct caller…
    expect(done).toBe(false);
    // …and settleEvents waits for it.
    await h.tenancy.settleEvents();
    expect(done).toBe(true);
  });

  it("is bounded: a listener that never finishes holds it only as long as asked", async () => {
    h = await harness({
      onEvent: (e) => (e.type === "company.branding.updated" ? new Promise<void>(() => undefined) : undefined),
    });
    const g = await greenAcres();
    await h.tenancy.updateBranding({ actorUserId: g.owner, tenantId: g.tenantId, brandColor: "#0F766E" });
    const started = Date.now();
    await h.tenancy.settleEvents(60);
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(50);
    expect(waited).toBeLessThan(2000);
    expect(DEFAULT_SETTLE_EVENTS_MS).toBe(5000);
  });

  it("never throws: a throwing listener is reported, and nonsense bounds fall back to the default", async () => {
    const reported: unknown[] = [];
    h = await harness({
      onEvent: async (e) => {
        if (e.type === "company.branding.updated") throw new Error("listener blew up");
      },
      onEventError: (error) => void reported.push(error),
    });
    const g = await greenAcres();
    await h.tenancy.updateBranding({ actorUserId: g.owner, tenantId: g.tenantId, brandColor: "#0F766E" });
    await expect(h.tenancy.settleEvents()).resolves.toBeUndefined();
    await expect(h.tenancy.settleEvents(Number.NaN)).resolves.toBeUndefined();
    await expect(h.tenancy.settleEvents(-5)).resolves.toBeUndefined();
    expect(reported.map((e) => (e as Error).message)).toContain("listener blew up");
  });

  it("answers at once with nothing pending", async () => {
    h = await harness();
    const started = Date.now();
    await h.tenancy.settleEvents();
    expect(Date.now() - started).toBeLessThan(50);
  });
});

describe("the handlers answer a POST only after its events settled (8.1)", () => {
  it("company handlers: a listener's write is visible right after the response", async () => {
    const written: string[] = [];
    h = await harness({
      onEvent: async (e) => {
        if (e.type !== "member.removed") return;
        await sleep(60);
        // What notifications' `forget` would do: a write, after a wait.
        await h.db.execute(sql`update users set display_name = 'forgotten' where id = ${e.userId}`);
        written.push(e.userId);
      },
    });
    const g = await greenAcres();
    const { company } = handlersFor(h);
    const res = await call(company, g.owner, "POST", `v1/companies/${g.tenantId}/members/${g.member}/remove`, {});
    expect(res.status).toBe(200);
    expect(written).toEqual([g.member]);
    const row = (await h.db.execute(sql`select display_name from users where id = ${g.member}`)).rows[0] as { display_name: string };
    expect(row.display_name).toBe("forgotten");
  });

  it("company handlers: an invitation accepted over HTTP has told its listener before the answer", async () => {
    const joined: string[] = [];
    h = await harness({
      onEvent: async (e) => {
        if (e.type !== "member.joined") return;
        await sleep(40);
        joined.push(e.person.name ?? "?");
      },
    });
    const g = await greenAcres();
    const invite = await h.tenancy.sendInvitation({ actorUserId: g.owner, tenantId: g.tenantId, email: "cam@greenacres.test", roleKey: "member" });
    const cam = await h.user("cam@greenacres.test", { name: "Cam Rivera" });
    const { company } = handlersFor(h);
    const res = await call(company, cam, "POST", "v1/invitations/accept", { token: invite.token });
    expect((await jsonOf<{ status: string }>(res)).status).toBe("accepted");
    expect(joined).toEqual(["Cam Rivera"]);
  });

  it("operator handlers: suspending waits for its listener too", async () => {
    const told: string[] = [];
    h = await harness({
      onEvent: async (e) => {
        if (e.type !== "company.suspended") return;
        await sleep(40);
        told.push(e.tenantId);
      },
    });
    const g = await greenAcres();
    const ops = await h.user("ops@platform.test");
    await h.staff(ops, "admin");
    const { operator } = handlersFor(h);
    const res = await call(operator, ops, "POST", `v1/admin/companies/${g.tenantId}/suspend`, { reason: "Unpaid" });
    expect(res.status).toBe(200);
    expect(told).toEqual([g.tenantId]);
  });

  it("a GET is not held by a slow listener", async () => {
    let release: () => void = () => undefined;
    h = await harness({
      onEvent: (e) => (e.type === "company.branding.updated" ? new Promise<void>((resolve) => (release = resolve)) : undefined),
    });
    const g = await greenAcres();
    await h.tenancy.updateBranding({ actorUserId: g.owner, tenantId: g.tenantId, brandColor: "#0F766E" });
    const { company } = handlersFor(h);
    const started = Date.now();
    expect((await call(company, g.owner, "GET", `v1/companies/${g.tenantId}`)).status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1000);
    release();
    await h.tenancy.settleEvents();
  });

  it("a host's 0.5-shaped service double without settleEvents is answered as before", async () => {
    h = await harness();
    const g = await greenAcres();
    const { settleEvents: _gone, ...rest } = h.tenancy;
    const { createTenancyHandlers } = await import("../server.js");
    const handlers = createTenancyHandlers({
      tenancy: rest as typeof h.tenancy,
      principal: async () => ({ userId: g.owner, email: null }),
      invitationUrl: (t) => `https://app.test/invite/${t}`,
    });
    const res = await handlers.handle(
      new Request(`https://app.test/api/tenancy/v1/companies/${g.tenantId}/branding`, {
        method: "POST",
        headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
        body: JSON.stringify({ brandColor: "#0F766E" }),
      }),
    );
    expect(res.status).toBe(200);
  });
});

// ── 8.2 listMemberPeople({ holding }) ──────────────────────────────────────

describe("listMemberPeople({ holding }) (8.2)", () => {
  it("resolves grants, an allow override and a deny override exactly as a request does", async () => {
    h = await harness();
    const g = await greenAcres();
    const viewer = await h.user("vi@greenacres.test", { name: "Vi Viewer" });
    await h.db.execute(sql`insert into tenant_members (tenant_id, user_id, status) values (${g.tenantId}, ${viewer}, 'active')`);
    const { assignRoleTemplate } = await import("@adminigloo/permissions/server");
    await assignRoleTemplate(h.db, { scope: "tenant", tenantId: g.tenantId, principalId: viewer, templateKey: "viewer", actor: { system: "test" } });
    // Mo (member) is allowed to invite by an override; Ada (admin) is denied it.
    await h.db.execute(sql`insert into principal_override (principal_id, scope, tenant_id, permission, effect)
      values (${g.member}, 'tenant', ${g.tenantId}, 'members.invite', 'allow')`);
    await h.db.execute(sql`insert into principal_override (principal_id, scope, tenant_id, permission, effect)
      values (${g.admin}, 'tenant', ${g.tenantId}, 'members.invite', 'deny')`);
    // A sealed key: an allow override can't reopen it for the admin.
    await h.db.execute(sql`insert into principal_override (principal_id, scope, tenant_id, permission, effect)
      values (${g.admin}, 'tenant', ${g.tenantId}, 'tenant.transfer', 'allow')`);

    const ids = async (holding: string) => (await h.tenancy.listMemberPeople(g.tenantId, { holding })).map((p) => p.userId).sort();
    expect(await ids("members.invite")).toEqual([g.owner, g.member].sort());
    expect(await ids("tenant.transfer")).toEqual([g.owner]);
    expect(await ids("members.view")).toEqual([g.owner, g.admin, g.member, viewer].sort());
    expect(await ids("no.such.key")).toEqual([]);
    expect(await ids("")).toEqual([]);

    // Parity: for every person and key, the same answer a request resolves.
    for (const key of ["members.invite", "tenant.transfer", "tenant.edit", "members.view", "members.remove"]) {
      const holders = new Set(await ids(key));
      for (const userId of [g.owner, g.admin, g.member, viewer]) {
        expect(holders.has(userId), `${key} ${userId}`).toBe(await h.tenancy.hasPermission({ userId, tenantId: g.tenantId, permission: key }));
      }
    }
  });

  it("only ACTIVE members, of THIS company; the people keep 2a's shape and order", async () => {
    h = await harness();
    const g = await greenAcres();
    await h.db.execute(sql`update tenant_members set status = 'suspended' where tenant_id = ${g.tenantId} and user_id = ${g.admin}`);
    const other = await h.user("x@summit.test", { name: "Xavi Summit" });
    await h.company(other, "Summit");
    const people = await h.tenancy.listMemberPeople(g.tenantId, { holding: "members.view" });
    expect(people).toEqual([
      { userId: g.member, name: "Mo Member", email: "mo@greenacres.test", roleKey: "member", roleName: "Member" },
      { userId: g.owner, name: "Olivia Owner", email: "olivia@greenacres.test", roleKey: "owner", roleName: "Owner" },
    ]);
  });

  it("without `holding`, 2a's behaviour: everyone active, one query", async () => {
    h = await harness();
    const g = await greenAcres();
    h.t.queries.length = 0;
    const people = await h.tenancy.listMemberPeople(g.tenantId);
    expect(people.map((p) => p.userId).sort()).toEqual([g.owner, g.admin, g.member].sort());
    expect(h.t.queries).toHaveLength(1);
  });

  it("three queries for a team of 2 and for a team of 20 (the query log)", async () => {
    h = await harness();
    const small = await h.user("small@x.test", { name: "Small Owner" });
    const helper = await h.user("helper@x.test");
    const smallId = await h.company(small, "Small Co", { [helper]: "admin" });

    const big = await h.user("big@x.test", { name: "Big Owner" });
    const members: Record<string, string> = {};
    for (let i = 0; i < 19; i++) members[await h.user(`crew${i}@big.test`)] = i % 3 === 0 ? "admin" : i % 3 === 1 ? "member" : "viewer";
    const bigId = await h.company(big, "Big Co", members);
    // A few overrides, so the third query has something to read.
    const someone = Object.keys(members)[1]!;
    await h.db.execute(sql`insert into principal_override (principal_id, scope, tenant_id, permission, effect)
      values (${someone}, 'tenant', ${bigId}, 'members.invite', 'allow')`);

    h.t.queries.length = 0;
    const two = await h.tenancy.listMemberPeople(smallId, { holding: "members.invite" });
    const smallQueries = h.t.queries.length;
    h.t.queries.length = 0;
    const twenty = await h.tenancy.listMemberPeople(bigId, { holding: "members.invite" });
    const bigQueries = h.t.queries.length;

    expect(two).toHaveLength(2);
    // The owner, the seven admins (i = 0, 3, …, 18) and the one override.
    expect(twenty).toHaveLength(1 + 7 + 1);
    expect(smallQueries).toBe(3);
    expect(bigQueries).toBe(3);
  });

  it("an unknown company and an empty id answer []", async () => {
    h = await harness();
    expect(await h.tenancy.listMemberPeople("no-such-company", { holding: "members.view" })).toEqual([]);
    expect(await h.tenancy.listMemberPeople("", { holding: "members.view" })).toEqual([]);
  });
});

// ── 8.3 the logo store is told the company ─────────────────────────────────

describe("setLogo and removeLogo pass the company to the store (8.3)", () => {
  it("put gets tenantId; the old logo's delete and the removal's delete get { tenantId }", async () => {
    h = await harness();
    const g = await greenAcres();
    const puts: Parameters<LogoStore["put"]>[0][] = [];
    const deletes: [string, { readonly tenantId: string } | undefined][] = [];
    const originalPut = h.logos.put.bind(h.logos);
    const originalDelete = h.logos.delete.bind(h.logos);
    h.logos.put = async (input) => {
      puts.push(input);
      return originalPut(input);
    };
    h.logos.delete = async (key, context) => {
      deletes.push([key, context]);
      return originalDelete(key, context);
    };
    await h.tenancy.setLogo({ actorUserId: g.owner, tenantId: g.tenantId, file: { bytes: PNG, contentType: "image/png" } });
    await h.tenancy.setLogo({ actorUserId: g.owner, tenantId: g.tenantId, file: { bytes: PNG, contentType: "image/png" } });
    await h.tenancy.removeLogo({ actorUserId: g.owner, tenantId: g.tenantId });

    expect(puts).toHaveLength(2);
    for (const put of puts) expect(put).toMatchObject({ tenantId: g.tenantId, contentType: "image/png" });
    expect(deletes).toEqual([
      [puts[0]!.pathname, { tenantId: g.tenantId }],
      [puts[1]!.pathname, { tenantId: g.tenantId }],
    ]);
  });

  it("a failed save takes the new file back, told the company", async () => {
    h = await harness();
    const g = await greenAcres();
    const deletes: [string, unknown][] = [];
    const originalDelete = h.logos.delete.bind(h.logos);
    h.logos.delete = async (key, context) => {
      deletes.push([key, context]);
      return originalDelete(key, context);
    };
    // The company goes away between the check and the save: the save refuses.
    const originalPut = h.logos.put.bind(h.logos);
    h.logos.put = async (input) => {
      const stored = await originalPut(input);
      await h.db.execute(sql`update tenants set deleted_at = now() where id = ${g.tenantId}`);
      return stored;
    };
    expect(await codeOf(h.tenancy.setLogo({ actorUserId: g.owner, tenantId: g.tenantId, file: { bytes: PNG, contentType: "image/png" } }))).toBe(
      "not_a_member",
    );
    expect(deletes).toEqual([[expect.stringMatching(/^tenancy\/logos\//), { tenantId: g.tenantId }]]);
  });

  it("a 0.5 store that ignores both still works", async () => {
    h = await harness();
    const g = await greenAcres();
    const kept = new Map<string, Uint8Array>();
    const old: LogoStore = {
      put: async ({ pathname, bytes }: { pathname: string; bytes: Uint8Array }) => {
        kept.set(pathname, bytes);
        return { url: `https://old.test/${pathname}`, key: pathname };
      },
      delete: async (key: string) => {
        kept.delete(key);
      },
    } as LogoStore;
    h.logos.put = old.put;
    h.logos.delete = old.delete;
    const view = await h.tenancy.setLogo({ actorUserId: g.owner, tenantId: g.tenantId, file: { bytes: PNG, contentType: "image/png" } });
    expect(view.logoUrl).toMatch(/^https:\/\/old\.test\//);
    await h.tenancy.removeLogo({ actorUserId: g.owner, tenantId: g.tenantId });
    expect(kept.size).toBe(0);
  });
});

// ── 8.4 the alert kinds and the mapper's table ─────────────────────────────

const KIND_KEY = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$/;
const ROUTING_KEY = /^[a-z][a-z0-9-]{1,31}$/;
const HREF = /^\/(?![\/\\])[^\\\s\u0000-\u001f]{0,499}$/;
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

/** 4.2's definition rules, copied (tenancy never imports notifications, 2a D4). */
function fragmentProblems(fragment: TenancyAlertKinds): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  for (const kind of fragment.kinds) {
    if (!KIND_KEY.test(kind.key) || kind.key.length > 64) problems.push(`${kind.key}: key`);
    if (keys.has(kind.key)) problems.push(`${kind.key}: duplicate`);
    keys.add(kind.key);
    if (kind.label.length < 1 || kind.label.length > 80) problems.push(`${kind.key}: label`);
    if (kind.category.length < 1 || kind.category.length > 40) problems.push(`${kind.key}: category`);
    if (kind.description !== undefined && kind.description.length > 200) problems.push(`${kind.key}: description`);
    if (!kind.audience.permission) problems.push(`${kind.key}: permission`);
    if (kind.email === false && kind.defaultChannel === "email") problems.push(`${kind.key}: email default, never emailed`);
    if (kind.email === false && kind.emailBy === "producer") problems.push(`${kind.key}: producer email, never emailed`);
    if (kind.audience.routing && !fragment.routings.some((r) => r.key === kind.audience.routing)) problems.push(`${kind.key}: routing`);
  }
  for (const routing of fragment.routings) if (!ROUTING_KEY.test(routing.key)) problems.push(`${routing.key}: routing key`);
  return problems;
}

/** 3.3's rules for a draft. */
function draftProblems(draft: TenancyAlertDraft): string[] {
  const problems: string[] = [];
  if (draft.title.length < 1 || Array.from(draft.title).length > 200) problems.push("title length");
  if (/[\r\n]/.test(draft.title) || draft.title.includes(LS) || draft.title.includes(PS)) problems.push("title lines");
  if (draft.href !== null && !HREF.test(draft.href)) problems.push("href");
  if (draft.dedupeKey.length < 1 || draft.dedupeKey.length > 200) problems.push("dedupe key");
  if (!KIND_KEY.test(draft.kind)) problems.push("kind");
  return problems;
}

const STAMP = { id: "01990000-0000-7000-8000-00000000abcd", occurredAt: "2026-10-12T15:00:00.000Z" } as const;
const T = "t-green";

describe("tenancyAlertKinds (8.4)", () => {
  it("passes the registry's definition rules (copied)", () => {
    expect(fragmentProblems(tenancyAlertKinds)).toEqual([]);
  });

  it("is 8.4's table", () => {
    expect(tenancyAlertKinds.routings).toEqual([]);
    expect(tenancyAlertKinds.kinds.map((k) => [k.key, k.label, k.category, k.audience.permission, k.defaultChannel, k.email ?? true])).toEqual([
      ["tenancy.member.joined", "Someone joins the team", "Team", "members.invite", "in_app", true],
      ["tenancy.member.left", "Someone leaves the team", "Team", "members.invite", "in_app", true],
    ]);
    expect([TENANCY_MEMBER_JOINED_KIND, TENANCY_MEMBER_LEFT_KIND]).toEqual(["tenancy.member.joined", "tenancy.member.left"]);
    expect(Object.isFrozen(tenancyAlertKinds.kinds)).toBe(true);
  });
});

describe("tenancyAlertsFor: the mapper's table (8.4)", () => {
  const person = { name: "Cam Rivera", email: "cam@greenacres.test" };

  it("member.joined", () => {
    const drafts = tenancyAlertsFor(
      { ...STAMP, type: "member.joined", tenantId: T, userId: "u-cam", via: "invitation", person, roleName: "Crew member" },
      { teamHref: "/settings/team" },
    );
    expect(drafts).toEqual([
      {
        tenantId: T,
        kind: "tenancy.member.joined",
        title: "Cam Rivera joined the team as Crew member",
        body: null,
        href: "/settings/team",
        dedupeKey: `tenancy.member.joined:${STAMP.id}`,
        subject: { type: "tenancy.member", id: "u-cam" },
        actorUserId: "u-cam",
      },
    ]);
    expect(draftProblems(drafts[0]!)).toEqual([]);
  });

  it("member.left", () => {
    const drafts = tenancyAlertsFor({ ...STAMP, type: "member.left", tenantId: T, userId: "u-cam", by: "u-cam", person }, { teamHref: "/settings/team" });
    expect(drafts).toEqual([
      {
        tenantId: T,
        kind: "tenancy.member.left",
        title: "Cam Rivera left the team",
        body: null,
        href: "/settings/team",
        dedupeKey: `tenancy.member.left:${STAMP.id}`,
        subject: { type: "tenancy.member", id: "u-cam" },
        actorUserId: "u-cam",
      },
    ]);
  });

  it("member.removed: the left kind, the remover is the actor", () => {
    const drafts = tenancyAlertsFor({ ...STAMP, type: "member.removed", tenantId: T, userId: "u-cam", by: "u-owner", person }, { teamHref: "/admin/team" });
    expect(drafts).toEqual([
      {
        tenantId: T,
        kind: "tenancy.member.left",
        title: "Cam Rivera was removed from the team",
        body: null,
        href: "/admin/team",
        dedupeKey: `tenancy.member.left:${STAMP.id}`,
        subject: { type: "tenancy.member", id: "u-cam" },
        actorUserId: "u-owner",
      },
    ]);
  });

  it("{name}: the name, else the address, else 'Someone'", () => {
    const left = (p: { name: string | null; email: string | null }) =>
      tenancyAlertsFor({ ...STAMP, type: "member.left", tenantId: T, userId: "u", by: "u", person: p }, { teamHref: "/settings/team" })[0]!.title;
    expect(left({ name: null, email: "cam@greenacres.test" })).toBe("cam@greenacres.test left the team");
    expect(left({ name: "  ", email: null })).toBe("Someone left the team");
    expect(left({ name: null, email: null })).toBe("Someone left the team");
  });

  it("every other event alerts nobody", () => {
    const others: TenancyEvent[] = [
      { ...STAMP, type: "company.created", tenantId: T, userId: "u" },
      { ...STAMP, type: "member.role.changed", tenantId: T, userId: "u", from: "member", to: "admin", by: "o" },
      { ...STAMP, type: "ownership.transferred", tenantId: T, from: "a", to: "b" },
      { ...STAMP, type: "company.suspended", tenantId: T, by: "s" },
      { ...STAMP, type: "company.reactivated", tenantId: T, by: "s" },
      { ...STAMP, type: "invitation.sent", tenantId: T, invitationId: "i", by: "o" },
      { ...STAMP, type: "company.settings.updated", tenantId: T, section: "company", changed: ["timeZone"], by: "o" },
      { ...STAMP, type: "company.profile.updated", tenantId: T, changed: ["name"], by: "o" },
      { ...STAMP, type: "company.branding.updated", tenantId: T, by: "o" },
    ];
    for (const event of others) expect(tenancyAlertsFor(event, { teamHref: "/settings/team" }), event.type).toEqual([]);
  });

  it("a name with line breaks becomes one line, at most 200 characters (D18)", () => {
    const drafts = tenancyAlertsFor(
      {
        ...STAMP,
        type: "member.joined",
        tenantId: T,
        userId: "u",
        via: "invitation",
        person: { name: `Cam\r\nBcc: x@evil.test${LS}${"y".repeat(300)}`, email: null },
        roleName: `Crew${PS}member`,
      },
      { teamHref: "/settings/team" },
    );
    expect(draftProblems(drafts[0]!)).toEqual([]);
    expect(drafts[0]!.title.startsWith("Cam Bcc: x@evil.test")).toBe(true);
  });

  it("opens nothing for an href that isn't a same-site path", () => {
    for (const teamHref of ["//evil.test/team", "https://evil.test", "/\\evil", "/settings/team page"]) {
      expect(
        tenancyAlertsFor({ ...STAMP, type: "member.left", tenantId: T, userId: "u", by: "u", person }, { teamHref })[0]!.href,
        teamHref,
      ).toBeNull();
    }
  });

  it("the same event mapped twice gives the same key (a listener told twice alerts once)", () => {
    const event = { ...STAMP, type: "member.left" as const, tenantId: T, userId: "u", by: "u", person };
    expect(tenancyAlertsFor(event, { teamHref: "/settings/team" })[0]!.dedupeKey).toBe(
      tenancyAlertsFor(event, { teamHref: "/settings/team" })[0]!.dedupeKey,
    );
  });

  it("end to end: a real join maps to 'Cam Rivera joined the team as Crew member'", async () => {
    const drafts: TenancyAlertDraft[] = [];
    h = await harness({ roles: ROLES, onEvent: (e) => void drafts.push(...tenancyAlertsFor(e, { teamHref: "/settings/team" })) });
    const g = await greenAcres();
    const invite = await h.tenancy.sendInvitation({ actorUserId: g.owner, tenantId: g.tenantId, email: "cam@greenacres.test", roleKey: "crew" });
    const cam = await h.user("cam@greenacres.test", { name: "Cam Rivera" });
    await h.tenancy.acceptInvitation({ token: invite.token, userId: cam });
    await h.tenancy.removeMember({ actorUserId: g.owner, tenantId: g.tenantId, targetUserId: cam });
    await h.tenancy.settleEvents();
    await tick();
    expect(drafts.map((d) => [d.kind, d.title, d.actorUserId])).toEqual([
      ["tenancy.member.joined", "Cam Rivera joined the team as Crew member", cam],
      ["tenancy.member.left", "Cam Rivera was removed from the team", g.owner],
    ]);
    expect(new Set(drafts.map((d) => d.dedupeKey)).size).toBe(2);
  });
});
