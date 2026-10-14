import { seedPermissionCatalog } from "@adminigloo/permissions/server";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { companySettings, defineSettingsFragment, defineTenantSettings, defineTenantRoles, DEFAULT_TENANT_ROLES, InvalidTenantRoleError } from "../index.js";
import {
  createCompanyRouteSeams,
  createPublicCompanySeams,
  publicCompanyToWire,
  runForEachCompany,
  type TenancyEvent,
  type TenancyService,
} from "../server.js";
import { rotationStart } from "../server/company-runs.js";
import { TENANT_ROLE_TEMPLATES } from "../templates.js";
import { call, codeOf, handlersFor, harness, jsonOf, tenantCatalog, type Harness } from "./harness.js";

/**
 * Tenancy 2a (contract 13.1): the roles a project composes, the public lookup
 * with status, the company profile the feature packages read, the cron
 * walker, the route seams, and the three new events.
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const CREW = { key: "crew", name: "Crew member", description: "Opens their own crew's route for the day.", rank: 5 } as const;
const ROLES = defineTenantRoles([CREW]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error;

async function summit() {
  const owner = await h.user("owner@summit.test", { name: "Olivia Owner" });
  const admin = await h.user("admin@summit.test", { name: "Ada Admin" });
  const member = await h.user("member@summit.test", { name: "Mo Member" });
  const tenantId = await h.company(owner, "Summit Window Co", { [admin]: "admin", [member]: "member" });
  return { owner, admin, member, tenantId };
}

async function slugOf(tenantId: string): Promise<string> {
  const r = await h.db.execute(sql`select slug from tenants where id = ${tenantId}`);
  return (r.rows[0] as { slug: string }).slug;
}

// ── roles ──────────────────────────────────────────────────────────────────

describe("defineTenantRoles (4.1)", () => {
  const ok = { key: "crew", name: "Crew", description: "Opens a route.", rank: 5 };
  it.each([
    ["a bad key", { ...ok, key: "Crew!" }],
    ["a one-letter key", { ...ok, key: "c" }],
    ["a core key", { ...ok, key: "admin" }],
    ["rank 0", { ...ok, rank: 0 }],
    ["rank 30 (admin's)", { ...ok, rank: 30 }],
    ["rank 10 (a core rank)", { ...ok, rank: 10 }],
    ["rank 20 (a core rank)", { ...ok, rank: 20 }],
    ["a fractional rank", { ...ok, rank: 5.5 }],
    ["an empty name", { ...ok, name: "  " }],
    ["a long name", { ...ok, name: "x".repeat(41) }],
    ["an empty description", { ...ok, description: "" }],
    ["a long description", { ...ok, description: "x".repeat(201) }],
  ])("refuses %s", (_label, spec) => {
    expect(() => defineTenantRoles([spec])).toThrow(InvalidTenantRoleError);
  });

  it("refuses a duplicate key and a tied rank between extras", () => {
    expect(() => defineTenantRoles([ok, ok])).toThrow(/listed twice/);
    expect(() => defineTenantRoles([ok, { ...ok, key: "helper" }])).toThrow(/share rank 5/);
  });

  it("orders highest first; assignable is all but owner; canManage by rank, unknown keys deny", () => {
    expect(ROLES.keys).toEqual(["owner", "admin", "member", "viewer", "crew"]);
    expect(ROLES.assignable).toEqual(["admin", "member", "viewer", "crew"]);
    expect(ROLES.has("crew")).toBe(true);
    expect(ROLES.rankOf("crew")).toBe(5);
    expect(ROLES.canManage("admin", "crew")).toBe(true);
    expect(ROLES.canManage("viewer", "crew")).toBe(true);
    expect(ROLES.canManage("crew", "viewer")).toBe(false);
    expect(ROLES.canManage("crew", "crew")).toBe(false);
    expect(ROLES.canManage("admin", "foreman")).toBe(false);
    expect(DEFAULT_TENANT_ROLES.keys).toEqual(TENANT_ROLE_TEMPLATES.map((t) => t.key).sort((a, b) => ROLES.rankOf(b)! - ROLES.rankOf(a)!));
  });
});

describe("a service with Crew (D9)", () => {
  it("an owner invites as Crew; the invitee accepts and holds crew; the team page offers Crew", async () => {
    h = await harness({ roles: ROLES });
    const s = await summit();
    expect(h.tenancy.roles.keys).toContain("crew");
    const issued = await h.tenancy.sendInvitation({ actorUserId: s.owner, tenantId: s.tenantId, email: "carl@crew.test", roleKey: "crew" });
    const carl = await h.user("carl@crew.test", { name: "Carl Crew" });
    expect((await h.tenancy.acceptInvitation({ token: issued.token, userId: carl })).status).toBe("accepted");
    const team = await h.tenancy.getTeam({ actorUserId: s.owner, tenantId: s.tenantId });
    const row = team.members.find((m) => m.userId === carl);
    expect(row).toMatchObject({ roleKey: "crew", roleName: "Crew member" });
    expect(team.members.find((m) => m.userId === s.member)?.actions.roles).toContain("crew");
    expect(team.roles.map((o) => o.key)).toEqual(["owner", "admin", "member", "viewer", "crew"]);
  });

  it("an admin changes a member to crew and back; a crew member can't invite or change anyone", async () => {
    h = await harness({ roles: ROLES });
    const s = await summit();
    expect((await h.tenancy.changeMemberRole({ actorUserId: s.admin, tenantId: s.tenantId, targetUserId: s.member, roleKey: "crew" })).roleKey).toBe("crew");
    expect((await h.tenancy.changeMemberRole({ actorUserId: s.admin, tenantId: s.tenantId, targetUserId: s.member, roleKey: "member" })).roleKey).toBe("member");
    const carl = await h.user("carl@crew.test");
    await h.db.execute(sql`insert into tenant_members (tenant_id, user_id, status) values (${s.tenantId}, ${carl}, 'active')`);
    await h.tenancy.changeMemberRole({ actorUserId: s.owner, tenantId: s.tenantId, targetUserId: carl, roleKey: "crew" });
    expect(await codeOf(h.tenancy.sendInvitation({ actorUserId: carl, tenantId: s.tenantId, email: "x@x.test", roleKey: "crew" }))).toBe("forbidden");
    expect(await codeOf(h.tenancy.changeMemberRole({ actorUserId: carl, tenantId: s.tenantId, targetUserId: s.member, roleKey: "crew" }))).toBe("forbidden");
  });

  it("over HTTP: an unknown or malformed key → 400 invalid on roleKey; owner → owner_must_transfer", async () => {
    h = await harness({ roles: ROLES });
    const s = await summit();
    const { company } = handlersFor(h);
    for (const roleKey of ["foreman", "Crew!"]) {
      const res = await call(company, s.owner, "POST", `v1/companies/${s.tenantId}/invitations`, { email: "x@x.test", roleKey });
      expect(res.status).toBe(400);
      const body = await jsonOf<{ error: { code: string; issues: { path: string[]; message: string }[] } }>(res);
      expect(body.error.code).toBe("invalid");
      expect(body.error.issues[0]).toEqual({ path: ["roleKey"], message: "Pick one of the roles listed." });
    }
    const owner = await call(company, s.owner, "POST", `v1/companies/${s.tenantId}/invitations`, { email: "x@x.test", roleKey: "owner" });
    expect((await jsonOf<{ error: { code: string } }>(owner)).error.code).toBe("owner_must_transfer");
    const crew = await call(company, s.owner, "POST", `v1/companies/${s.tenantId}/members/${s.member}/role`, { roleKey: "crew" });
    expect(crew.status).toBe(200);
    // The service holds the same rule for a host calling it directly.
    expect(await codeOf(h.tenancy.sendInvitation({ actorUserId: s.owner, tenantId: s.tenantId, email: "y@x.test", roleKey: "foreman" }))).toBe("invalid");
  });

  it("without `roles`, Crew is unknown: the four core roles only", async () => {
    h = await harness();
    const s = await summit();
    expect(h.tenancy.roles.keys).toEqual(["owner", "admin", "member", "viewer"]);
    expect(await codeOf(h.tenancy.sendInvitation({ actorUserId: s.owner, tenantId: s.tenantId, email: "x@x.test", roleKey: "crew" }))).toBe("invalid");
  });

  it("createCompany on an empty catalog seeds Crew too; a catalog seeded before Crew existed gets it on the next company (D10)", async () => {
    h = await harness({ roles: ROLES, seed: false });
    const owner = await h.user("owner@summit.test");
    await h.company(owner, "Summit Window Co");
    const keys = async () =>
      (await h.db.execute(sql`select key from role_template where scope = 'tenant' and deleted_at is null order by rank desc`)).rows.map(
        (r: unknown) => (r as { key: string }).key,
      );
    expect(await keys()).toEqual(["owner", "admin", "member", "viewer", "crew"]);
    await h.close();

    h = await harness({ roles: ROLES, seed: false });
    await seedPermissionCatalog(h.db, { tenant: { catalog: tenantCatalog, templates: TENANT_ROLE_TEMPLATES } });
    expect(await keys()).not.toContain("crew");
    const olivia = await h.user("olivia@summit.test");
    await h.company(olivia, "Green Acres");
    expect(await keys()).toContain("crew");
  });
});

// ── public lookup ──────────────────────────────────────────────────────────

describe("resolvePublicCompany (4.2)", () => {
  it("active and suspended (with status), through a current and a retired address; personal and deleted → null", async () => {
    h = await harness();
    const s = await summit();
    await h.tenancy.updateSettings({ actorUserId: s.owner, tenantId: s.tenantId, section: "company", values: { timeZone: "America/Denver", contactPhone: "555 0100" } });
    const old = await slugOf(s.tenantId);
    const active = await h.tenancy.resolvePublicCompany(old);
    expect(active).toMatchObject({ status: "active", retiredSlug: null, company: { id: s.tenantId, name: "Summit Window Co", timeZone: "America/Denver", contactPhone: "555 0100" } });

    await h.tenancy.updateCompanyProfile({ actorUserId: s.owner, tenantId: s.tenantId, slug: "summit-windows" });
    expect(await h.tenancy.resolvePublicCompany(old)).toMatchObject({ status: "active", retiredSlug: old, company: { slug: "summit-windows" } });

    await h.db.execute(sql`update tenants set suspended_at = now() where id = ${s.tenantId}`);
    expect(await h.tenancy.resolvePublicCompany("summit-windows")).toMatchObject({ status: "suspended", retiredSlug: null });
    expect(await h.tenancy.resolvePublicCompany(old.toUpperCase())).toMatchObject({ status: "suspended", retiredSlug: old });
    // Tenancy 1's lookup still hides a suspended company.
    expect(await h.tenancy.resolveCompanyBySlug("summit-windows")).toBeNull();

    await h.db.execute(sql`insert into tenants (id, kind, slug, name, owner_user_id) values ('ws_x', 'personal', 'ws-olivia', 'Personal', ${s.owner})`);
    expect(await h.tenancy.resolvePublicCompany("ws-olivia")).toBeNull();
    await h.db.execute(sql`update tenants set deleted_at = now() where id = ${s.tenantId}`);
    expect(await h.tenancy.resolvePublicCompany("summit-windows")).toBeNull();
    expect(await h.tenancy.resolvePublicCompany(old)).toBeNull();
    expect(await h.tenancy.resolvePublicCompany("nobody-here")).toBeNull();
  });

  it("publicCompanyToWire: the public face, never the id", async () => {
    h = await harness();
    const s = await summit();
    const found = (await h.tenancy.resolvePublicCompany(await slugOf(s.tenantId)))!;
    const wire = publicCompanyToWire(found);
    expect(Object.keys(wire).sort()).toEqual(
      ["brandColor", "contactEmail", "contactPhone", "logoUrl", "name", "onBrandColor", "publicPath", "slug", "status"].sort(),
    );
    expect(wire.publicPath).toBe(`/t/${found.company.slug}`);
    expect(JSON.stringify(wire)).not.toContain(s.tenantId);
  });
});

// ── the company profile ────────────────────────────────────────────────────

describe("companyProfile (4.3)", () => {
  const invoicing = defineSettingsFragment({
    key: "invoicing",
    label: "Invoices",
    order: 40,
    schema: z.object({ paymentInstructions: z.string().max(500).default("") }),
    fields: [{ key: "paymentInstructions", kind: "text", label: "How customers pay you" }],
  });

  it("every field, every fragment's values, in ONE query", async () => {
    h = await harness({ settings: defineTenantSettings([companySettings, invoicing]) });
    const s = await summit();
    await h.tenancy.updateSettings({
      actorUserId: s.owner,
      tenantId: s.tenantId,
      section: "company",
      values: {
        timeZone: "America/Denver",
        contactEmail: "office@summit.test",
        contactPhone: "555 0100",
        addressLine1: "1 Main St",
        city: "Provo",
        region: "UT",
        postalCode: "84601",
        country: "USA",
      },
    });
    await h.tenancy.updateSettings({ actorUserId: s.owner, tenantId: s.tenantId, section: "invoicing", values: { paymentInstructions: "Zelle to office@summit.test" } });
    await h.tenancy.updateBranding({ actorUserId: s.owner, tenantId: s.tenantId, brandColor: "#0F766E" });
    await h.tenancy.setLogo({ actorUserId: s.owner, tenantId: s.tenantId, file: { bytes: PNG, contentType: "image/png" } });

    h.t.queries.length = 0;
    const p = (await h.tenancy.companyProfile(s.tenantId))!;
    expect(h.t.queries).toHaveLength(1);
    expect(p).toMatchObject({
      id: s.tenantId,
      name: "Summit Window Co",
      publicPath: `/t/${p.slug}`,
      kind: "org",
      status: "active",
      timeZone: "America/Denver",
      contactEmail: "office@summit.test",
      contactPhone: "555 0100",
      address: { line1: "1 Main St", line2: null, city: "Provo", region: "UT", postalCode: "84601", country: "USA" },
      brandColor: "#0f766e",
      onBrandColor: "#ffffff",
      replyTo: "office@summit.test",
      inbox: ["office@summit.test"],
    });
    expect(p.logoUrl).toMatch(/^https:\/\/blob\.test\//);
    expect(p.settings["invoicing"]).toEqual({ paymentInstructions: "Zelle to office@summit.test" });
    expect(p.settings["company"]?.["timeZone"]).toBe("America/Denver");
    // When it was made (review SEC-2A-03: a new company's sending allowance is lower).
    expect(p.createdAt).toBeInstanceOf(Date);
    expect(Math.abs(p.createdAt.getTime() - Date.now())).toBeLessThan(60 * 60_000);
  });

  it("no contact email: replies go to the owner; a deleted owner: null and []; suspended says so; unknown/deleted → null", async () => {
    h = await harness();
    const s = await summit();
    expect(await h.tenancy.companyProfile(s.tenantId)).toMatchObject({ contactEmail: null, replyTo: "owner@summit.test", inbox: ["owner@summit.test"], timeZone: null });
    await h.db.execute(sql`update users set deleted_at = now() where id = ${s.owner}`);
    expect(await h.tenancy.companyProfile(s.tenantId)).toMatchObject({ replyTo: null, inbox: [] });
    await h.db.execute(sql`update tenants set suspended_at = now() where id = ${s.tenantId}`);
    expect((await h.tenancy.companyProfile(s.tenantId))?.status).toBe("suspended");
    expect(await h.tenancy.companyProfile("t_nope")).toBeNull();
    await h.db.execute(sql`update tenants set deleted_at = now() where id = ${s.tenantId}`);
    expect(await h.tenancy.companyProfile(s.tenantId)).toBeNull();
  });

  it("a stored value that no longer parses is reported, never thrown", async () => {
    const reported: unknown[] = [];
    h = await harness({ onEventError: (e) => reported.push(e) });
    const s = await summit();
    await h.db.execute(sql`update tenants set settings = ${JSON.stringify({ company: { timeZone: "Mars/Olympus", contactEmail: "office@summit.test" } })}::jsonb where id = ${s.tenantId}`);
    const p = (await h.tenancy.companyProfile(s.tenantId))!;
    expect(p.timeZone).toBeNull();
    expect(p.contactEmail).toBe("office@summit.test");
    expect(reported.length).toBeGreaterThan(0);
  });
});

describe("listMemberPeople (4.4)", () => {
  it("only this company's ACTIVE members, by name then email, with their role", async () => {
    h = await harness({ roles: ROLES });
    const s = await summit();
    const carl = await h.user("carl@crew.test", { name: "Carl Crew" });
    const gone = await h.user("gone@summit.test", { name: "Gina Gone" });
    await h.db.execute(sql`insert into tenant_members (tenant_id, user_id, status) values (${s.tenantId}, ${carl}, 'active')`);
    await h.tenancy.changeMemberRole({ actorUserId: s.owner, tenantId: s.tenantId, targetUserId: carl, roleKey: "crew" });
    await h.db.execute(sql`insert into tenant_members (tenant_id, user_id, status) values (${s.tenantId}, ${gone}, 'suspended')`);
    const other = await h.user("other@green.test", { name: "Aaron Other" });
    await h.company(other, "Green Acres");

    const people = await h.tenancy.listMemberPeople(s.tenantId);
    expect(people.map((p) => p.name)).toEqual(["Ada Admin", "Carl Crew", "Mo Member", "Olivia Owner"]);
    expect(people.find((p) => p.userId === carl)).toEqual({ userId: carl, name: "Carl Crew", email: "carl@crew.test", roleKey: "crew", roleName: "Crew member" });
    expect(people.find((p) => p.userId === s.owner)?.roleKey).toBe("owner");
    expect(await h.tenancy.listMemberPeople("t_nope")).toEqual([]);
  });
});

// ── every company, for crons ───────────────────────────────────────────────

describe("activeCompanyIds and runForEachCompany (4.5)", () => {
  it("excludes suspended, deleted and personal; ordered by id", async () => {
    h = await harness();
    const owner = await h.user("owner@summit.test");
    const ids = [];
    for (const name of ["Alpha Co", "Bravo Co", "Charlie Co", "Delta Co"]) ids.push(await h.company(owner, name));
    await h.db.execute(sql`update tenants set suspended_at = now() where id = ${ids[1]!}`);
    await h.db.execute(sql`update tenants set deleted_at = now() where id = ${ids[2]!}`);
    await h.db.execute(sql`insert into tenants (id, kind, slug, name, owner_user_id) values ('ws_x', 'personal', 'ws-x', 'Personal', ${owner})`);
    expect(await h.tenancy.activeCompanyIds()).toEqual([ids[0]!, ids[3]!].sort());
  });

  const fake = (ids: string[]): Pick<TenancyService, "activeCompanyIds"> => ({ activeCompanyIds: async () => ids });
  const IDS = ["a", "b", "c", "d", "e"];

  it("a throw for one company is in `failed` (message only, 300 chars) and the next company ran", async () => {
    const errors: string[] = [];
    const report = await runForEachCompany(
      fake(IDS),
      async (id) => {
        if (id === "b") throw new Error(`b's settings are broken ${"x".repeat(400)}`);
        if (id === "d") throw "plain string";
        return id.toUpperCase();
      },
      { now: () => new Date(0), onError: (_e, id) => errors.push(id) },
    );
    expect(report.companies).toBe(5);
    expect(report.ran).toEqual([
      { tenantId: "a", result: "A" },
      { tenantId: "c", result: "C" },
      { tenantId: "e", result: "E" },
    ]);
    expect(report.failed.map((f) => f.tenantId)).toEqual(["b", "d"]);
    expect(report.failed[0]!.error).toHaveLength(300);
    expect(report.failed[1]!.error).toBe("plain string");
    expect(errors.sort()).toEqual(["b", "d"]);
    expect(report.deferred).toEqual([]);
  });

  it("concurrency is respected (default 4, or the option)", async () => {
    for (const [concurrency, expected] of [[undefined, 4], [2, 2], [1, 1]] as const) {
      let inFlight = 0;
      let most = 0;
      await runForEachCompany(
        fake(["a", "b", "c", "d", "e", "f", "g", "h"]),
        async () => {
          inFlight += 1;
          most = Math.max(most, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight -= 1;
        },
        { ...(concurrency ? { concurrency } : {}), now: () => new Date(0) },
      );
      expect(most).toBe(expected);
    }
  });

  it("rotates: the run starts at rotationStart(now, n), wrapping round", async () => {
    const at = Date.UTC(2026, 9, 13, 13, 0);
    const start = rotationStart(at, IDS.length);
    const order: string[] = [];
    await runForEachCompany(fake(IDS), async (id) => void order.push(id), { concurrency: 1, now: () => new Date(at) });
    expect(order).toEqual([...IDS.slice(start), ...IDS.slice(0, start)]);
    expect(rotationStart(at, 1)).toBe(0);
    expect(rotationStart(at, 0)).toBe(0);
  });

  it("on a DAILY cron, a time budget doesn't leave out the same companies every day (review SEC-2A-06 / TB-7)", async () => {
    // Four companies (a count that divides 24, where the hourly rotation
    // started at the same company every day), a budget that fits two, the
    // cron at 13:00 UTC for thirty days running.
    const ids = ["c1", "c2", "c3", "c4"];
    const day0 = Date.UTC(2026, 9, 13, 13, 0);
    const deferredByDay: string[] = [];
    const ranDays = new Map<string, number>();
    for (let day = 0; day < 30; day++) {
      let clock = day0 + day * 86_400_000;
      const report = await runForEachCompany(
        fake(ids),
        async (id) => {
          clock += 1000;
          return id;
        },
        { concurrency: 1, timeBudgetMs: 1500, now: () => new Date(clock) },
      );
      expect(report.ran).toHaveLength(2);
      deferredByDay.push([...report.deferred].sort().join(","));
      for (const { tenantId } of report.ran) ranDays.set(tenantId, (ranDays.get(tenantId) ?? 0) + 1);
    }
    // Not the same two companies left out every day…
    expect(new Set(deferredByDay).size).toBeGreaterThan(1);
    // …and every company got its turn on plenty of days.
    for (const id of ids) expect(ranDays.get(id) ?? 0, id).toBeGreaterThanOrEqual(8);
    // Every count that divides 24 starts at more than one company over a month of daily runs.
    for (const n of [2, 3, 4, 6, 8, 12, 24]) {
      const starts = new Set(Array.from({ length: 30 }, (_, day) => rotationStart(day0 + day * 86_400_000, n)));
      expect(starts.size, `n=${n}`).toBeGreaterThanOrEqual(Math.min(n, 2));
    }
  });

  it("the time budget stops STARTING companies; the rest are deferred", async () => {
    let clock = 0;
    const report = await runForEachCompany(
      fake(IDS),
      async (id) => {
        clock += 1000;
        return id;
      },
      { concurrency: 1, timeBudgetMs: 2500, now: () => new Date(clock) },
    );
    expect(report.ran.map((r) => r.tenantId)).toEqual(["a", "b", "c"]);
    expect(report.deferred).toEqual(["d", "e"]);
  });

  it("a failing company list rejects the whole run", async () => {
    await expect(runForEachCompany({ activeCompanyIds: () => Promise.reject(new Error("database down")) }, async () => 1)).rejects.toThrow(/database down/);
  });
});

// ── the seams ──────────────────────────────────────────────────────────────

describe("createCompanyRouteSeams (4.6)", () => {
  const req = (tenantId: string, userId: string | null) =>
    new Request(`https://app.test/api/app/${tenantId}/schedule/settings`, { headers: userId ? { "x-test-user": userId } : {} });
  const seamsFor = () =>
    createCompanyRouteSeams({
      tenancy: h.tenancy,
      principal: async (r) => {
        const userId = r.headers.get("x-test-user");
        return userId ? { userId } : null;
      },
    });

  it("resolveTenant: the id after the prefix when it has the shape of one; never a query", async () => {
    h = await harness();
    const seams = seamsFor();
    h.t.queries.length = 0;
    expect(seams.resolveTenant(req("t_abc-123", null))).toBe("t_abc-123");
    expect(seams.resolveTenant(new Request("https://app.test/api/app/bad%20id/x"))).toBeNull();
    expect(seams.resolveTenant(new Request("https://app.test/api/app/%E0%A4%A/x"))).toBeNull();
    expect(seams.resolveTenant(new Request(`https://app.test/api/app/${"x".repeat(129)}/x`))).toBeNull();
    expect(seams.resolveTenant(new Request("https://app.test/api/other/t_abc"))).toBeNull();
    expect(h.t.queries).toHaveLength(0);
  });

  it("signed out 401; stranger 403 'not part of'; suspended 403 'suspended'; no key → false; key → { userId }", async () => {
    h = await harness();
    const s = await summit();
    const stranger = await h.user("stranger@else.test");
    const viewer = await h.user("viewer@summit.test");
    await h.db.execute(sql`insert into tenant_members (tenant_id, user_id, status) values (${s.tenantId}, ${viewer}, 'active')`);
    await h.tenancy.changeMemberRole({ actorUserId: s.owner, tenantId: s.tenantId, targetUserId: viewer, roleKey: "viewer" });
    const seams = seamsFor();

    const out = await seams.authorize(req(s.tenantId, null), "tenant.edit", s.tenantId);
    expect(out).toBeInstanceOf(Response);
    const signedOut = out as Response;
    expect(signedOut.status).toBe(401);
    expect(signedOut.headers.get("cache-control")).toBe("no-store");
    expect(await signedOut.json()).toEqual({ error: { code: "forbidden", message: "You've been signed out. Sign in again to keep working." } });

    const notPart = (await seams.authorize(req(s.tenantId, stranger), "tenant.edit", s.tenantId)) as Response;
    expect(notPart.status).toBe(403);
    expect((await errorOf(notPart)).message).toBe("You're not part of this company.");
    const madeUp = (await seams.authorize(req("t_nope", s.owner), "tenant.edit", "t_nope")) as Response;
    expect((await errorOf(madeUp)).message).toBe("You're not part of this company.");

    expect(await seams.authorize(req(s.tenantId, viewer), "tenant.edit", s.tenantId)).toBe(false);
    expect(await seams.authorize(req(s.tenantId, s.owner), "tenant.edit", s.tenantId)).toEqual({ userId: s.owner });

    await h.db.execute(sql`update tenants set suspended_at = now() where id = ${s.tenantId}`);
    const suspended = (await seams.authorize(req(s.tenantId, s.owner), "tenant.edit", s.tenantId)) as Response;
    expect(suspended.status).toBe(403);
    expect(await errorOf(suspended)).toEqual({ code: "forbidden", message: "This company is suspended. Contact support to restore it." });
  });

  it("two asks in one request cost one resolution; each refusal is a fresh Response; a malformed id costs no query", async () => {
    h = await harness();
    const s = await summit();
    const seams = seamsFor();
    const one = req(s.tenantId, s.member);
    h.t.queries.length = 0;
    expect(await seams.authorize(one, "tenant.view", s.tenantId)).toEqual({ userId: s.member });
    const first = h.t.queries.length;
    expect(first).toBeGreaterThan(0);
    expect(await seams.authorize(one, "tenant.edit", s.tenantId)).toBe(false);
    expect(h.t.queries.length).toBe(first);

    const signedOut = req(s.tenantId, null);
    const a = (await seams.authorize(signedOut, "tenant.view", s.tenantId)) as Response;
    const b = (await seams.authorize(signedOut, "tenant.view", s.tenantId)) as Response;
    expect(a).not.toBe(b);
    expect((await errorOf(a)).code).toBe("forbidden");
    expect((await errorOf(b)).code).toBe("forbidden");

    h.t.queries.length = 0;
    const bad = (await seams.authorize(req("bad id", s.owner), "tenant.view", "bad id")) as Response;
    expect(bad.status).toBe(403);
    expect(h.t.queries).toHaveLength(0);
  });

  it("works on a copy of the service too (the public membership and permission checks)", async () => {
    h = await harness();
    const s = await summit();
    const seams = createCompanyRouteSeams({ tenancy: { ...h.tenancy }, principal: async (r) => ({ userId: r.headers.get("x-test-user")! }) });
    expect(await seams.authorize(req(s.tenantId, s.member), "tenant.view", s.tenantId)).toEqual({ userId: s.member });
    expect(await seams.authorize(req(s.tenantId, s.member), "tenant.edit", s.tenantId)).toBe(false);
  });
});

describe("createPublicCompanySeams (4.7)", () => {
  const req = (slug: string) => new Request(`https://app.test/api/t/${slug}/booking/slots`);

  it("unknown → null; a malformed address → null with no query", async () => {
    h = await harness();
    const seams = createPublicCompanySeams({ tenancy: h.tenancy });
    expect(await seams.resolveTenant(req("nobody-here"))).toBeNull();
    h.t.queries.length = 0;
    expect(await seams.resolveTenant(req("not%20a%20slug"))).toBeNull();
    expect(await seams.resolveTenant(new Request("https://app.test/api/t/"))).toBeNull();
    expect(h.t.queries).toHaveLength(0);
  });

  it("an active company: its id, then admit open, for ONE query in all", async () => {
    h = await harness();
    const s = await summit();
    const seams = createPublicCompanySeams({ tenancy: h.tenancy });
    const r = req((await slugOf(s.tenantId)).toUpperCase());
    h.t.queries.length = 0;
    expect(await seams.resolveTenant(r)).toBe(s.tenantId);
    expect(await seams.admit(s.tenantId, r)).toEqual({ open: true });
    expect(h.t.queries).toHaveLength(1);
  });

  it("suspended: the id, then closed with the name and how to reach them; a retired address resolves too", async () => {
    h = await harness();
    const s = await summit();
    const old = await slugOf(s.tenantId);
    await h.tenancy.updateSettings({ actorUserId: s.owner, tenantId: s.tenantId, section: "company", values: { contactPhone: "555 0100", contactEmail: "office@summit.test" } });
    await h.tenancy.updateCompanyProfile({ actorUserId: s.owner, tenantId: s.tenantId, slug: "summit-windows" });
    await h.db.execute(sql`update tenants set suspended_at = now() where id = ${s.tenantId}`);
    const seams = createPublicCompanySeams({ tenancy: h.tenancy });
    for (const slug of ["summit-windows", old]) {
      const r = req(slug);
      expect(await seams.resolveTenant(r)).toBe(s.tenantId);
      expect(await seams.admit(s.tenantId, r)).toEqual({
        open: false,
        message: "Summit Window Co isn't taking requests online right now. Call 555 0100 or email office@summit.test.",
      });
    }
  });

  it("an embed-key tenant (no slug on the request): its own lookup; unknown is closed", async () => {
    h = await harness();
    const s = await summit();
    const seams = createPublicCompanySeams({ tenancy: h.tenancy });
    const embed = new Request("https://app.test/api/estimator/estimates");
    h.t.queries.length = 0;
    expect(await seams.admit(s.tenantId, embed)).toEqual({ open: true });
    expect(h.t.queries).toHaveLength(1);
    expect(await seams.admit("t_nope", embed)).toEqual({ open: false, message: "This business isn't taking requests online right now." });
    await h.db.execute(sql`update tenants set suspended_at = now() where id = ${s.tenantId}`);
    // No contact saved, and the owner's sign-in address is not a public contact.
    expect(await seams.admit(s.tenantId, new Request("https://app.test/api/estimator/estimates"))).toEqual({
      open: false,
      message: "Summit Window Co isn't taking requests online right now.",
    });
  });
});

// ── events ─────────────────────────────────────────────────────────────────

describe("the three new events (4.8)", () => {
  it("fire after commit, with the same `changed` as the audit row; nothing when nothing changed", async () => {
    const events: TenancyEvent[] = [];
    const committed: unknown[] = [];
    h = await harness({
      onEvent: async (e) => {
        if (!e.type.startsWith("company.") || e.type === "company.created") return;
        events.push(e);
        if (e.type === "company.settings.updated") {
          // After commit: a fresh connection already sees the new value.
          const r = await h.db.execute(sql`select settings -> 'company' ->> 'timeZone' as tz from tenants where id = ${e.tenantId}`);
          committed.push((r.rows[0] as { tz: string | null }).tz);
        }
      },
    });
    const s = await summit();
    await h.tenancy.updateSettings({ actorUserId: s.owner, tenantId: s.tenantId, section: "company", values: { timeZone: "America/Denver", contactPhone: "555 0100" } });
    await h.tenancy.updateCompanyProfile({ actorUserId: s.owner, tenantId: s.tenantId, name: "Summit Windows" });
    await h.tenancy.updateCompanyProfile({ actorUserId: s.owner, tenantId: s.tenantId, name: "Summit Windows" });
    await h.tenancy.updateCompanyProfile({ actorUserId: s.owner, tenantId: s.tenantId, name: "Summit Glass", slug: "summit-glass" });
    await h.tenancy.updateBranding({ actorUserId: s.owner, tenantId: s.tenantId, brandColor: "#0F766E" });
    await h.tenancy.setLogo({ actorUserId: s.owner, tenantId: s.tenantId, file: { bytes: PNG, contentType: "image/png" } });
    await h.tenancy.removeLogo({ actorUserId: s.owner, tenantId: s.tenantId });
    await vi.waitFor(() => expect(committed).toHaveLength(1));
    await settle();

    expect(events).toEqual([
      { type: "company.settings.updated", tenantId: s.tenantId, section: "company", changed: ["timeZone", "contactPhone"], by: s.owner },
      { type: "company.profile.updated", tenantId: s.tenantId, changed: ["name"], by: s.owner },
      { type: "company.profile.updated", tenantId: s.tenantId, changed: ["name", "slug"], by: s.owner },
      { type: "company.branding.updated", tenantId: s.tenantId, by: s.owner },
      { type: "company.branding.updated", tenantId: s.tenantId, by: s.owner },
      { type: "company.branding.updated", tenantId: s.tenantId, by: s.owner },
    ]);
    expect(committed).toEqual(["America/Denver"]);
    const audited = h.audit.find((a) => a.action === "company.settings.updated");
    expect(audited?.metadata).toEqual({ section: "company", changed: ["timeZone", "contactPhone"] });
  });

  it("a refused change emits nothing", async () => {
    const events: TenancyEvent[] = [];
    h = await harness({ onEvent: (e) => void events.push(e) });
    const s = await summit();
    events.length = 0;
    await codeOf(h.tenancy.updateSettings({ actorUserId: s.member, tenantId: s.tenantId, section: "company", values: { timeZone: "America/Denver" } }));
    await codeOf(h.tenancy.updateBranding({ actorUserId: s.member, tenantId: s.tenantId, brandColor: "#000000" }));
    await settle();
    expect(events.filter((e) => e.type.startsWith("company.settings") || e.type.startsWith("company.branding"))).toEqual([]);
  });
});
