import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AUDIENCE_ADMIN_ROUTES,
  AUDIENCE_ROUTE_PERMISSIONS,
  audiencePermissions,
  COMPANY_RULE_KINDS,
  createAudienceAdminHandlers,
  createAudienceRegistry,
  createAudiences,
  createDrizzleAudienceStore,
  type AudienceSettingsWire,
  type AudienceUser,
} from "../index.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * ONE AUDIENCE PER COMPANY (0.2), on real Postgres: two companies on one
 * store and one secret never see each other's rules, marks or run history;
 * a rule id of company A's is "not found" through company B's instance and
 * through B's routes; the handlers' route table is exactly what the router
 * matches; and a row source can filter on a NULL column (analytics 0.3's
 * "the company's own pages here").
 */

const SECRET = "test-secret-0123456789-abcdefghijklmnopqrstuvwxyz";
const NOW = new Date("2026-10-08T12:00:00Z");

interface Member extends AudienceUser {
  companies: string[];
}

let tdb: TestDb;
beforeAll(async () => {
  tdb = await createTestDb();
  await tdb.client.exec(`CREATE TABLE site_sessions (id text PRIMARY KEY, tenant_id text NOT NULL, site_id text, visitor_key text NOT NULL, started_at timestamptz NOT NULL)`);
});
afterAll(async () => {
  await tdb?.close();
});

let sessionCounter = 0;
async function session(tenantId: string, visitor: string, siteId: string | null): Promise<string> {
  sessionCounter += 1;
  const id = `ses_${sessionCounter}`;
  await tdb.client.query(`INSERT INTO site_sessions (id, tenant_id, site_id, visitor_key, started_at) VALUES ($1, $2, $3, $4, $5)`, [id, tenantId, siteId, visitor, new Date(NOW.getTime() - 3_600_000)]);
  return id;
}

function audiencesOver(members: Member[]) {
  return createAudiences<Member>({
    store: createDrizzleAudienceStore({ db: tdb.db }),
    secret: SECRET,
    visitorIds: "rotating",
    link: "pseudonymous",
    now: () => NOW,
    forTenant: (tenantId) => ({
      // A company's own team is "internal" to THAT company only.
      isInternal: (user) => (user.companies.includes(tenantId) ? "team" : false),
      codeRule: "Everyone on your team",
      getUser: async (id) => members.find((member) => member.id === id) ?? null,
      listUsers: async () => members.filter((member) => member.companies.includes(tenantId)),
      sessions: { table: "site_sessions", visitor: "visitor_key", time: "started_at", id: "id", where: { tenant_id: tenantId } },
    }),
  });
}

describe("createAudienceRegistry", () => {
  it("builds one instance per tenant, keeps it, and lets the least recently used go past max", () => {
    const built: string[] = [];
    const registry = createAudienceRegistry((tenantId) => {
      built.push(tenantId);
      return { tenantId };
    }, { max: 2 });
    const a = registry.for("a");
    expect(registry.for("a")).toBe(a);
    registry.for("b");
    registry.for("a"); // a is now the most recent
    registry.for("c"); // b goes
    expect(registry.size).toBe(2);
    registry.for("b");
    expect(built).toEqual(["a", "b", "c", "b"]);
    registry.invalidate();
    expect(registry.size).toBe(0);
    expect(() => registry.for("")).toThrow(/tenant/);
  });
});

describe("two companies on one store", () => {
  it("keep their own rules, marks and history, and B can't remove A's rule", async () => {
    const greenAcres = tenant("green");
    const summit = tenant("summit");
    const audiences = audiencesOver([
      { id: "u_ann", email: "ann@greenacreslawn.com", companies: [greenAcres] },
      { id: "u_sam", email: "sam@summitlawn.com", companies: [summit] },
    ]);
    const a = audiences.for(greenAcres);
    const b = audiences.for(summit);
    expect(a.tenantId).toBe(greenAcres);
    expect(b.tenantId).toBe(summit);

    // A's own team member browses: marked in A only.
    await session(greenAcres, "vis_ann", null);
    await a.observe({ visitorId: "vis_ann", userId: "u_ann", headers: {} as never, privacyOptOut: false });
    // Ann is nobody to Summit: the same person on Summit's site counts there.
    // (Real-looking addresses on purpose: the package's defaults leave out
    // made-up domains like *.test.)
    await session(summit, "vis_ann_on_summit", null);
    await b.observe({ visitorId: "vis_ann_on_summit", userId: "u_ann", privacyOptOut: false });

    const rule = await a.addRule({ kind: "email_domain", value: "greenacreslawn.com", reasonLabel: "Our team" }, { by: "u_ann" });
    expect((await a.viewModel({ canSeeEmails: true })).rules.map((r) => r.id)).toEqual([rule.rule.id]);
    expect((await b.viewModel({ canSeeEmails: true })).rules).toEqual([]);
    expect((await b.runs()).length).toBe(0);

    // A's rule id through B's instance: "not found", and A's rule stays.
    await expect(b.remove(rule.rule.id, { by: "u_sam" })).rejects.toMatchObject({ code: "not_found" });
    expect((await a.rules()).map((r) => r.id)).toEqual([rule.rule.id]);

    const window = { from: new Date(NOW.getTime() - 86_400_000), to: new Date(NOW.getTime() + 1) };
    const excludedA = await a.excludedBreakdown(window);
    const excludedB = await b.excludedBreakdown(window);
    expect(excludedA.total).toBe(1);
    expect(excludedB.total).toBe(0);
  });

  it("a row source can say IS NULL: only the company's own pages here", async () => {
    const company = tenant("pages");
    const audiences = audiencesOver([{ id: "u_pat", email: "pat@pagesco.com", companies: [company] }]);
    const audience = audiences.for(company);
    const onPages = await session(company, "vis_pat", null);
    await session(company, "vis_pat", "site_1");
    await audience.mark({ subjectKind: "visitor", subjectId: "vis_pat", reason: "device", by: "u_pat" });
    const window = { from: new Date(NOW.getTime() - 86_400_000), to: new Date(NOW.getTime() + 1) };
    const base = { table: "site_sessions", visitor: "visitor_key", time: "started_at", id: "id" };
    expect((await audience.excludedBreakdown(window, { rows: { ...base, where: { tenant_id: company } } })).total).toBe(2);
    expect((await audience.excludedBreakdown(window, { rows: { ...base, where: { tenant_id: company, site_id: null } } })).total).toBe(1);
    expect((await audience.excludedBreakdown(window, { rows: { ...base, where: { tenant_id: company, site_id: "site_1" } } })).total).toBe(1);
    expect(onPages).toMatch(/^ses_/);
  });
});

describe("the company handlers", () => {
  const host = "https://app.example";
  const request = (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    new Request(`${host}${path}`, {
      method: init.method ?? "GET",
      headers: { "sec-fetch-site": "same-origin", ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...init.headers },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });

  function handlersFor(audiences: ReturnType<typeof audiencesOver>, verdict: (tenantId: string, permission: string) => unknown = () => ({ userId: "u_owner" })) {
    const asked: string[] = [];
    const handlers = createAudienceAdminHandlers({
      audienceFor: (tenantId) => audiences.for(tenantId),
      resolveTenant: (req) => new URL(req.url).pathname.split("/")[3] ?? null,
      authorize: (_req, permission, tenantId) => {
        asked.push(permission);
        return verdict(tenantId, permission) as never;
      },
    });
    return { handlers, asked };
  }

  it("the route table is the router: every row is matched (authorize asked once, for its permission)", async () => {
    const company = tenant("routes");
    const audiences = audiencesOver([]);
    const { handlers, asked } = handlersFor(audiences);
    const rule = await audiences.for(company).addRule({ kind: "email", value: "probe@routes.test" });
    for (const route of AUDIENCE_ADMIN_ROUTES) {
      asked.length = 0;
      const path = `/api/app/${company}/audience/${route.path.replace("{rule}", rule.rule.id)}`;
      const res = await handlers.handle(request(path, { method: route.method, ...(route.method === "POST" ? { body: route.body ?? {} } : {}) }));
      expect(asked, route.kind).toEqual([route.permission]);
      expect(res.status, `${route.kind}: ${await res.clone().text()}`).toBeLessThan(500);
      expect(AUDIENCE_ROUTE_PERMISSIONS[route.kind]).toBe(route.permission);
      expect(route.permission! in audiencePermissions).toBe(true);
    }
    // An unknown path is "not found" before anyone is asked.
    asked.length = 0;
    expect((await handlers.handle(request(`/api/app/${company}/audience/v1/nothing`))).status).toBe(404);
    expect(asked).toEqual([]);
  });

  it("lists, previews, adds and removes a company's rules; another company's rule is not found", async () => {
    const a = tenant("ha");
    const b = tenant("hb");
    const audiences = audiencesOver([]);
    const { handlers } = handlersFor(audiences);
    const added = await handlers.handle(request(`/api/app/${a}/audience/v1/rules`, { method: "POST", body: { kind: "email", value: "rachel@gmail.com", reasonLabel: "Our client" } }));
    expect(added.status).toBe(201);
    const listed = (await (await handlers.handle(request(`/api/app/${a}/audience/v1/rules`))).json()) as AudienceSettingsWire;
    expect(listed.rules).toHaveLength(1);
    expect(listed.rules[0]).toMatchObject({ kind: "email", value: "rachel@gmail.com", reasonLabel: "Our client" });
    expect(typeof listed.rules[0]!.createdAt).toBe("string");
    expect(listed.kinds).toEqual(COMPANY_RULE_KINDS);
    expect(listed.visitorIds).toBe("rotating");
    const ruleId = listed.rules[0]!.id;

    // B, in B's own company, with A's rule id: not found, and nothing of A's in the answer.
    const asB = await handlers.handle(request(`/api/app/${b}/audience/v1/rules/${ruleId}/remove`, { method: "POST", body: {} }));
    expect(asB.status).toBe(404);
    expect(await asB.text()).not.toContain("rachel");
    const bList = (await (await handlers.handle(request(`/api/app/${b}/audience/v1/rules`))).json()) as AudienceSettingsWire;
    expect(bList.rules).toEqual([]);
    expect((await audiences.for(a).rules()).map((rule) => rule.id)).toEqual([ruleId]);

    const preview = await handlers.handle(request(`/api/app/${a}/audience/v1/rules/preview`, { method: "POST", body: { kind: "email_domain", value: "gmail.com" } }));
    expect(preview.status).toBe(200);
    expect(((await preview.json()) as { windows: unknown[] }).windows).toHaveLength(3);

    const removed = await handlers.handle(request(`/api/app/${a}/audience/v1/rules/${ruleId}/remove`, { method: "POST", body: {} }));
    expect(removed.status).toBe(200);
    expect(await audiences.for(a).rules()).toEqual([]);
  });

  it("a preview naming one person never says whether that person has an account — a domain's counts only the company's own people", async () => {
    const a = tenant("who");
    const b = tenant("who-b");
    // A's member; B's own list (scoped, as the README asks) never returns her.
    const audiences = audiencesOver([{ id: "u_ada", email: "ada@alpha.test", companies: [a] }]);
    const { handlers } = handlersFor(audiences);
    const preview = async (company: string, body: unknown) =>
      (await (await handlers.handle(request(`/api/app/${company}/audience/v1/rules/preview`, { method: "POST", body }))).json()) as { subjects: { users: number } };
    // One person's email: no account count either way, in A (where she is) or in B.
    expect((await preview(a, { kind: "email", value: "ada@alpha.test" })).subjects.users).toBe(0);
    expect((await preview(b, { kind: "email", value: "ada@alpha.test" })).subjects.users).toBe(0);
    // A domain counts the company's own people: A's member in A, nobody in B.
    expect((await preview(a, { kind: "email_domain", value: "alpha.test" })).subjects.users).toBe(1);
    expect((await preview(b, { kind: "email_domain", value: "alpha.test" })).subjects.users).toBe(0);
  });

  it("refuses: a kind not offered, a bad value, a duplicate, another site, no permission, and passes a Response through", async () => {
    const company = tenant("refuse");
    const audiences = audiencesOver([]);
    const { handlers } = handlersFor(audiences, (_tenantId, permission) => (permission === "audience.manage" ? { userId: "u" } : false));
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      handlers.handle(request(`/api/app/${company}/audience/v1/rules`, { method: "POST", body, headers }));
    expect((await post({ kind: "visitor", value: "abc" })).status).toBe(400);
    expect((await post({ kind: "user", value: "user_2abc" })).status).toBe(400);
    expect((await post({ kind: "email", value: "not an email" })).status).toBe(400);
    expect((await post({ kind: "email", value: "pat@gmail.com" })).status).toBe(201);
    expect((await post({ kind: "email", value: "pat@gmail.com" })).status).toBe(409);
    expect((await post({ kind: "email", value: "x@gmail.com" }, { "sec-fetch-site": "cross-site" })).status).toBe(403);

    const denied = handlersFor(audiences, () => false).handlers;
    const res = await denied.handle(request(`/api/app/${company}/audience/v1/rules`));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("forbidden");

    const signedOut = handlersFor(audiences, () => new Response("signed out", { status: 401 })).handlers;
    expect((await signedOut.handle(request(`/api/app/${company}/audience/v1/rules`))).status).toBe(401);
  });
});
