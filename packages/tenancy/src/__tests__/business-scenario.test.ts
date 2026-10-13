import { authSchema } from "@adminigloo/auth/schema";
import { definePermissions, STAFF_ROLE_TEMPLATES } from "@adminigloo/permissions";
import { permissionsSchema } from "@adminigloo/permissions/schema";
import { seedPermissionCatalog } from "@adminigloo/permissions/server";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenancySchema } from "../schema.js";
import { TENANT_ROLE_TEMPLATES } from "../templates.js";
import {
  createTenancyHandlers,
  createTenancyOperatorHandlers,
  createTenancyService,
  type TenancyAuditEvent,
} from "../server.js";
import { assertOwnerInvariant, staffCatalog, tenantCatalog } from "./harness.js";
import { createTestDb, type TestDb } from "./pglite.js";

/**
 * THE ACCEPTANCE TEST (contract 13.4): Igloo Back Office, companies mode,
 * driven through the HANDLERS with Request objects, the way the widget drives
 * them. It starts with an EMPTY catalog on purpose: the tenant templates arrive
 * through D10's self-seed in step 1, the staff templates through the seed in
 * step 6. The steps run in order and share one database.
 */

let t: TestDb;
const audit: TenancyAuditEvent[] = [];
let seatLimit: number | null = null;
let tenancy: ReturnType<typeof createTenancyService>;
let api: ReturnType<typeof createTenancyHandlers>;
let admin: ReturnType<typeof createTenancyOperatorHandlers>;
const ids: Record<string, string> = {};

async function userRow(id: string, email: string, name: string) {
  await t.db.execute(sql`insert into users (id, identity_provider, external_id, email, display_name) values (${id}, 'clerk', ${`user_${id}`}, ${email}, ${name})`);
}

/** The page path's principal: mirror a missing row is the host's job; here the row exists and provisioning runs when the stamp is null. */
async function principalFor(req: Request) {
  const id = req.headers.get("x-user");
  if (!id) return null;
  const row = (await t.db.execute(sql`select email, provisioned_at from users where id = ${id} and deleted_at is null`)).rows[0] as
    | { email: string; provisioned_at: unknown }
    | undefined;
  if (!row) return null;
  if (row.provisioned_at === null) await tenancy.provisionUser({ userId: id, email: row.email });
  return { userId: id, email: row.email };
}

async function req(handler: { handle(r: Request): Promise<Response> }, user: string, method: "GET" | "POST", path: string, body?: unknown) {
  const base = handler === admin ? "https://igloo.test/api/admin/tenancy/" : "https://igloo.test/api/tenancy/";
  const res = await handler.handle(
    new Request(base + path, {
      method,
      headers: { "x-user": user, ...(method === "POST" ? { "content-type": "application/json", "sec-fetch-site": "same-origin" } : {}) },
      ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

beforeAll(async () => {
  t = await createTestDb({ ...authSchema, ...tenancySchema, ...permissionsSchema });
  tenancy = createTenancyService({
    db: t.db,
    mode: "companies",
    tenantCatalog,
    bootstrap: { mode: "email", email: "ava@igloo.test" },
    seats: { limitFor: async () => seatLimit, upgradeHref: "/billing" },
    audit: async (_tx, e) => void audit.push(e),
  });
  api = createTenancyHandlers({
    tenancy,
    principal: principalFor,
    verifiedEmails: async (r) => {
      const p = await principalFor(r);
      return p?.email ? [p.email] : [];
    },
    invitationUrl: (token) => `https://igloo.test/invite/${token}`,
  });
  admin = createTenancyOperatorHandlers({ tenancy, principal: principalFor });
});

afterAll(async () => {
  await t.close();
});

describe("13.4 — Igloo Back Office, end to end", () => {
  describe("step 1: the owner signs up (webhook first) and names her company", () => {
    it("webhook first → needs-onboarding; the slug is suggested; reserved is refused; create twice → created then replayed", async () => {
      await userRow("olivia", "olivia@summitwindows.test", "Olivia");
      await tenancy.provisionUser({ userId: "olivia", email: "olivia@summitwindows.test" });
      expect((await req(api, "olivia", "GET", "v1/session")).body.state).toBe("needs-onboarding");
      const slug = await req(api, "olivia", "GET", `v1/slug?name=${encodeURIComponent("Summit Window Co.")}`);
      expect(slug.body).toMatchObject({ slug: "summit-window-co", available: true });
      const reserved = await req(api, "olivia", "POST", "v1/companies", { name: "Summit Window Co.", slug: "admin", requestKey: "key-olivia-1" });
      expect(reserved.status).toBe(422);
      expect(reserved.body.error).toMatchObject({ code: "slug_reserved", suggestion: expect.any(String) });
      const first = await req(api, "olivia", "POST", "v1/companies", { name: "Summit Window Co.", requestKey: "key-olivia-K" });
      const second = await req(api, "olivia", "POST", "v1/companies", { name: "Summit Window Co.", requestKey: "key-olivia-K" });
      expect([first.body.status, second.body.status]).toEqual(["created", "replayed"]);
      expect(second.body.company.id).toBe(first.body.company.id);
      ids.summit = first.body.company.id;
      const session = await req(api, "olivia", "GET", "v1/session");
      expect(session.body).toMatchObject({ state: "ready", company: { id: ids.summit, isOwner: true, role: "owner" } });
      await assertOwnerInvariant(t.db, ids.summit!);
    });
  });

  describe("step 2: the checklist", () => {
    it("3 items, 0 done", async () => {
      const list = await req(api, "olivia", "GET", `v1/companies/${ids.summit}/checklist`);
      expect(list.body).toMatchObject({ total: 3, done: 0 });
    });
  });

  describe("step 3: settings and branding", () => {
    it("time zone and contact saved; a readable brand colour with white text; 2 of 3 done", async () => {
      const s = await req(api, "olivia", "POST", `v1/companies/${ids.summit}/settings/company`, {
        values: { timeZone: "America/Denver", contactEmail: "office@summitwindows.test", contactPhone: "(303) 555-0100" },
      });
      expect(s.status).toBe(200);
      const b = await req(api, "olivia", "POST", `v1/companies/${ids.summit}/branding`, { brandColor: "#0f766e" });
      expect(b.body.brand).toMatchObject({ textOnColor: "#ffffff", readable: true });
      expect((await req(api, "olivia", "GET", `v1/companies/${ids.summit}/checklist`)).body.done).toBe(2);
    });
  });

  describe("step 4: the team", () => {
    it("invite Sam; he signs up page-first and accepts; lands in Summit; 3/3", async () => {
      const inv = await req(api, "olivia", "POST", `v1/companies/${ids.summit}/invitations`, { email: "sam@summitwindows.test", roleKey: "member" });
      expect(inv.body).toMatchObject({ delivery: "skipped", link: expect.stringMatching(/^https:\/\/igloo\.test\/invite\//) });
      await userRow("sam", "sam@summitwindows.test", "Sam"); // page-first: no webhook, stamp null
      const token = String(inv.body.link).split("/").pop();
      const accepted = await req(api, "sam", "POST", "v1/invitations/accept", { token });
      expect(accepted.body).toMatchObject({ status: "accepted", company: { id: ids.summit } });
      const session = await req(api, "sam", "GET", "v1/session");
      expect(session.body).toMatchObject({ state: "ready", company: { id: ids.summit } });
      expect((await req(api, "olivia", "GET", `v1/companies/${ids.summit}/checklist`)).body.done).toBe(3);
    });

    it("Olivia promotes Sam; Sam can't invite an Admin but can invite a Viewer", async () => {
      expect((await req(api, "olivia", "POST", `v1/companies/${ids.summit}/members/sam/role`, { roleKey: "admin" })).body.member.roleKey).toBe("admin");
      const asAdmin = await req(api, "sam", "POST", `v1/companies/${ids.summit}/invitations`, { email: "x@summit.test", roleKey: "admin" });
      expect(asAdmin.status).toBe(403);
      expect(asAdmin.body.error.code).toBe("rank");
      expect((await req(api, "sam", "POST", `v1/companies/${ids.summit}/invitations`, { email: "viewer@summit.test", roleKey: "viewer" })).status).toBe(200);
    });

    it("Olivia removes Sam: his next request is refused; his session needs onboarding (and says where he was)", async () => {
      expect((await req(api, "olivia", "POST", `v1/companies/${ids.summit}/members/sam/remove`)).status).toBe(200);
      const next = await req(api, "sam", "GET", `v1/companies/${ids.summit}/members`);
      expect(next.status).toBe(403);
      expect(next.body.error.code).toBe("not_a_member");
      expect((await req(api, "sam", "GET", "v1/session")).body).toMatchObject({ state: "needs-onboarding", formerCompany: "Summit Window Co." });
    });

    it("re-invited, he accepts; he leaves; re-invited again, he accepts", async () => {
      for (const round of [1, 2]) {
        const inv = await req(api, "olivia", "POST", `v1/companies/${ids.summit}/invitations`, { email: "sam@summitwindows.test", roleKey: "member" });
        const token = String(inv.body.link).split("/").pop();
        expect((await req(api, "sam", "POST", "v1/invitations/accept", { token })).body.status).toBe("accepted");
        if (round === 1) expect((await req(api, "sam", "POST", `v1/companies/${ids.summit}/leave`)).status).toBe(200);
      }
    });

    it("transfer with a wrong name → 422; with the right name Sam owns it and Olivia is an admin", async () => {
      expect((await req(api, "olivia", "POST", `v1/companies/${ids.summit}/transfer`, { toUserId: "sam", confirmName: "Summit" })).status).toBe(422);
      const done = await req(api, "olivia", "POST", `v1/companies/${ids.summit}/transfer`, { toUserId: "sam", confirmName: "summit window co." });
      expect(done.status).toBe(200);
      expect(done.body.you).toMatchObject({ roleKey: "admin", isOwner: false });
      await assertOwnerInvariant(t.db, ids.summit!);
    });

    it("Olivia leaves; Sam leaving → 409 last_owner", async () => {
      expect((await req(api, "olivia", "POST", `v1/companies/${ids.summit}/leave`)).status).toBe(200);
      const sam = await req(api, "sam", "POST", `v1/companies/${ids.summit}/leave`);
      expect(sam.status).toBe(409);
      expect(sam.body.error.code).toBe("last_owner");
    });

    it("seats: a limit of 1 with Sam alone → inviting anyone is 409 seats_full, naming 1", async () => {
      // Clear the open viewer invitation so Sam is alone.
      const open = await req(api, "sam", "GET", `v1/companies/${ids.summit}/invitations`);
      for (const i of open.body.invitations) await req(api, "sam", "POST", `v1/companies/${ids.summit}/invitations/${i.id}/revoke`);
      seatLimit = 1;
      const full = await req(api, "sam", "POST", `v1/companies/${ids.summit}/invitations`, { email: "new@summit.test", roleKey: "member" });
      expect(full.status).toBe(409);
      expect(full.body.error).toMatchObject({ code: "seats_full", upgradeHref: "/billing" });
      expect(full.body.error.message).toContain("1");
      seatLimit = null;
    });
  });

  describe("step 5: two companies", () => {
    it("Sam creates a side gig; the session lists both; each team shows only its own people", async () => {
      const gig = await req(api, "sam", "POST", "v1/companies", { name: "Sam's Side Gig", requestKey: "key-sam-gig-1", purpose: "additional" });
      expect(gig.body.status).toBe("created");
      ids.gig = gig.body.company.id;
      expect((await req(api, "sam", "GET", "v1/session")).body.companies).toHaveLength(2);
      expect((await req(api, "sam", "POST", "v1/active", { tenantId: ids.summit })).status).toBe(200);
      const summitTeam = await req(api, "sam", "GET", `v1/companies/${ids.summit}/members`);
      const gigTeam = await req(api, "sam", "GET", `v1/companies/${ids.gig}/members`);
      expect(summitTeam.body.company.id).toBe(ids.summit);
      expect(gigTeam.body.company.id).toBe(ids.gig);
    });

    it("Rae joins both; her pointer is on the gig; removed from the gig, her next session falls back to Summit", async () => {
      await userRow("rae", "rae@x.test", "Rae");
      for (const company of [ids.summit, ids.gig]) {
        const inv = await req(api, "sam", "POST", `v1/companies/${company}/invitations`, { email: "rae@x.test", roleKey: "member" });
        const token = String(inv.body.link).split("/").pop();
        expect((await req(api, "rae", "POST", "v1/invitations/accept", { token })).body.status).toBe("accepted");
      }
      expect((await req(api, "rae", "GET", "v1/session")).body.company.id).toBe(ids.gig);
      await req(api, "sam", "POST", `v1/companies/${ids.gig}/members/rae/remove`);
      expect((await req(api, "rae", "GET", "v1/session")).body.company.id).toBe(ids.summit);
      const pointer = (await t.db.execute(sql`select active_tenant_id from users where id = 'rae'`)).rows[0] as { active_tenant_id: string };
      expect(pointer.active_tenant_id).toBe(ids.summit);
    });
  });

  describe("step 6: the operator", () => {
    it("Ava signs in before the seed: not staff. Seed. Her /admin self-heal makes her admin.", async () => {
      await userRow("ava", "ava@igloo.test", "Ava");
      expect((await req(admin, "ava", "GET", "v1/admin/companies")).body.error.code).toBe("not_staff");
      await seedPermissionCatalog(t.db, {
        staff: { catalog: staffCatalog, templates: STAFF_ROLE_TEMPLATES },
        tenant: { catalog: tenantCatalog, templates: TENANT_ROLE_TEMPLATES },
      });
      expect(await tenancy.ensureBootstrapAdmin({ userId: "ava", email: "ava@igloo.test" })).toEqual({ granted: true });
    });

    it("the companies list hides personal workspaces; Summit's detail has its members, created, status", async () => {
      const list = await req(admin, "ava", "GET", "v1/admin/companies");
      expect(list.body.companies.map((c: { name: string }) => c.name).sort()).toEqual(["Sam's Side Gig", "Summit Window Co."]);
      const detail = await req(admin, "ava", "GET", `v1/admin/companies/${ids.summit}`);
      expect(detail.body.company).toMatchObject({ status: "active", createdBy: { userId: "olivia" } });
      expect(detail.body.members.length).toBeGreaterThan(0);
    });

    it("Ava suspends the gig: its members are refused and see 'suspended'; its address stops resolving; reactivate restores", async () => {
      expect((await req(admin, "ava", "POST", `v1/admin/companies/${ids.gig}/suspend`, { reason: "Unpaid since August" })).status).toBe(200);
      const refused = await req(api, "sam", "GET", `v1/companies/${ids.gig}`);
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe("company_suspended");
      await req(api, "sam", "POST", "v1/active", { tenantId: ids.gig });
      expect((await req(api, "sam", "GET", "v1/session")).body.state).toBe("suspended");
      expect(await tenancy.resolveCompanyBySlug("sams-side-gig")).toBeNull();
      await req(admin, "ava", "POST", `v1/admin/companies/${ids.gig}/reactivate`);
      expect((await req(api, "sam", "GET", "v1/session")).body.state).toBe("ready");
    });

    it("Ava gives Olivia cs_agent on People; Olivia, as a cs_agent, can't change Ava", async () => {
      expect((await req(admin, "ava", "POST", "v1/admin/people/olivia/staff-role", { templateKey: "cs_agent" })).body.person.staffRole.key).toBe("cs_agent");
      const attempt = await req(admin, "olivia", "POST", "v1/admin/people/ava/staff-role", { templateKey: null });
      expect(attempt.status).toBe(403);
    });
  });

  describe("step 7: the first run", () => {
    it("the seed twice is idempotent; a new catalog key reaches the owner template; D4 held throughout", async () => {
      const again = await seedPermissionCatalog(t.db, { tenant: { catalog: tenantCatalog, templates: TENANT_ROLE_TEMPLATES } });
      expect(again).toMatchObject({ created: [], grantsAdded: 0 });
      const grown = definePermissions("tenant", { ...tenantCatalog.permissions, "schedule.view": { label: "See the schedule", defaultFor: ["owner", "admin", "member"] } });
      const next = await seedPermissionCatalog(t.db, { tenant: { catalog: grown, templates: TENANT_ROLE_TEMPLATES } });
      expect(next.grantsAdded).toBe(3);
      for (const id of [ids.summit!, ids.gig!]) await assertOwnerInvariant(t.db, id);
      expect(audit.some((a) => a.action === "company.ownership.transferred")).toBe(true);
    });
  });
});
