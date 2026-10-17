import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAudiences, createDrizzleAudienceStore, type AudienceUser } from "@adminigloo/audience";
import { createAnalyticsAdminHandlers, type CreateAnalyticsAdminHandlersOptions } from "../admin-handlers.js";
import { audienceSessionsSource } from "../context.js";
import { createAnalytics, type Analytics } from "../instance.js";
import { analyticsPermissions } from "../permissions.js";
import { createAnalyticsPublicHandlers } from "../public-handlers.js";
import { ANALYTICS_ADMIN_ROUTE_PERMISSIONS, ANALYTICS_ADMIN_ROUTES, ANALYTICS_PUBLIC_ROUTES } from "../routes.js";
import type { WebsiteReportWire, WebsitesWire, WebsiteWire } from "../wire.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";
import type { AnalyticsTables } from "../schema.js";

/**
 * The company handlers (0.3), as a companies project mounts them: the id in
 * the path decides the company, `authorize` is asked for the route's one
 * permission, and everything after that is that company's own. The route
 * tables are exactly what the routers match.
 */

const SECRET = "test-secret-0123456789-abcdefghijklmnopqrstuvwxyz";
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const HOST = "https://app.lawnco.com";
const SCRIPT = `${HOST}/api/w/v1/beacon.js`;

let tdb: TestDb & { tables: AnalyticsTables[] };
let analytics: Analytics;
let bare: Analytics;
beforeAll(async () => {
  tdb = await createTestDb();
  const t = tdb.tables[0]!;
  const audiences = createAudiences<AudienceUser>({
    store: createDrizzleAudienceStore({ db: tdb.db }),
    secret: SECRET,
    visitorIds: "rotating",
    forTenant: (tenantId) => ({ sessions: audienceSessionsSource({ tenantId, tables: t }) }),
  });
  analytics = createAnalytics({ db: tdb.db, tables: t, audience: (tenantId) => audiences.for(tenantId) });
  bare = createAnalytics({ db: tdb.db, tables: t });
});
afterAll(async () => {
  await tdb?.close();
});

type Verdict = Awaited<ReturnType<CreateAnalyticsAdminHandlersOptions["authorize"]>>;

function handlers(options: { verdict?: (permission: string, tenantId: string) => Verdict; on?: Analytics; limit?: number | null } = {}) {
  const asked: string[] = [];
  const errors: unknown[] = [];
  const built = createAnalyticsAdminHandlers({
    analytics: options.on ?? analytics,
    resolveTenant: (req) => decodeURIComponent(new URL(req.url).pathname.split("/")[3] ?? ""),
    authorize: (_req, permission, tenantId) => {
      asked.push(permission);
      return options.verdict ? options.verdict(permission, tenantId) : { userId: "u_owner" };
    },
    scriptUrl: SCRIPT,
    websiteLimit: () => options.limit ?? null,
    ownPages: () => ({ label: "Your pages on Lawnco", url: `${HOST}/t/green-acres` }),
    clientIp: (req) => req.headers.get("x-forwarded-for"),
    onError: (error) => errors.push(error),
  });
  return { ...built, asked, errors };
}

function request(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Request {
  return new Request(`${HOST}${path}`, {
    method: init.method ?? "GET",
    headers: {
      "sec-fetch-site": "same-origin",
      "user-agent": CHROME,
      "x-forwarded-for": "203.0.113.50",
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

const base = (tenantId: string) => `/api/app/${tenantId}/website/`;

describe("the route tables are the routers", () => {
  it("every private row is matched: authorize is asked once, for exactly its permission", async () => {
    const company = tenant("routes");
    const h = handlers();
    const site = await analytics.addWebsite({ tenantId: company, name: "Probe", domains: "probe-lawn.com" });
    for (const route of ANALYTICS_ADMIN_ROUTES) {
      h.asked.length = 0;
      const path = base(company) + route.path.replace("{website}", site.id);
      const query = new URLSearchParams(route.query ?? {}).toString();
      const res = await h.handle(request(query ? `${path}?${query}` : path, { method: route.method, ...(route.method === "POST" ? { body: route.body ?? {} } : {}) }));
      expect(h.asked, route.kind).toEqual([route.permission, ...(route.kind === "websites" ? ["analytics.manage"] : [])]);
      expect(res.status, `${route.kind}: ${await res.clone().text()}`).toBeLessThan(500);
      expect(ANALYTICS_ADMIN_ROUTE_PERMISSIONS[route.kind]).toBe(route.permission);
      expect(route.permission! in analyticsPermissions, route.kind).toBe(true);
    }
    h.asked.length = 0;
    expect((await h.handle(request(`${base(company)}v1/nothing`))).status).toBe(404);
    expect(h.asked).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it("every public row is matched: the beacon answers 204, the script is JavaScript, anything else is not found", async () => {
    const company = tenant("public");
    const open = createAnalyticsPublicHandlers({
      analytics,
      resolveSite: () => ({ tenantId: company, siteId: null, allowedHosts: ["app.lawnco.com"] }),
      clientIp: () => "203.0.113.51",
    });
    const kinds: string[] = [];
    for (const route of ANALYTICS_PUBLIC_ROUTES) {
      const req = new Request(`${HOST}/api/t/green-acres/website/${route.path}`, {
        method: route.method,
        headers: { origin: HOST, "user-agent": CHROME },
        ...(route.method === "POST" ? { body: JSON.stringify(route.body) } : {}),
      });
      const res = await open.handle(req);
      if (route.kind === "collect") expect(res.status).toBe(204);
      if (route.kind === "script") {
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("javascript");
        expect(await res.text()).toContain("collect?site=");
      }
      kinds.push(route.kind);
      expect(route.permission).toBeNull();
    }
    expect(kinds.sort()).toEqual(["collect", "script"]);
    expect((await open.handle(new Request(`${HOST}/api/t/x/website/v1/other`))).status).toBe(404);
    // The beacon from the probe body landed: the public route reaches the write.
    expect((await analytics.getOverview({ tenantId: company, from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 60_000) })).visits.current).toBe(1);
  });
});

describe("a company's websites through its routes", () => {
  it("adds one with its snippet, lists it, and another company with its id gets not found every time", async () => {
    const a = tenant("acres");
    const b = tenant("summit");
    const h = handlers();
    const added = await h.handle(request(`${base(a)}v1/websites`, { method: "POST", body: { name: "Our website", domains: ["greenacres.com"] } }));
    expect(added.status).toBe(201);
    const website = ((await added.json()) as { website: WebsiteWire }).website;
    expect(website.snippet).toBe(`<script async src="${SCRIPT}" data-site="${website.siteKey}"></script>`);

    const listed = (await (await h.handle(request(`${base(a)}v1/websites`))).json()) as WebsitesWire;
    expect(listed.websites.map((w) => w.id)).toEqual([website.id]);
    expect(listed).toMatchObject({ canManage: true, limit: null, ownPages: { label: "Your pages on Lawnco" } });

    for (const [method, path, body] of [
      ["GET", `v1/websites/${website.id}/report`, undefined],
      ["POST", `v1/websites/${website.id}`, { name: "Hijacked" }],
      ["POST", `v1/websites/${website.id}/remove`, {}],
    ] as const) {
      const res = await h.handle(request(`${base(b)}${path}`, { method, ...(body ? { body } : {}) }));
      const text = await res.text();
      expect([res.status, method, path]).toEqual([404, method, path]);
      expect(text).not.toContain(website.siteKey);
      expect(text).not.toContain("greenacres");
    }
    const viaQuery = await h.handle(request(`${base(b)}v1/report?site=${website.id}`));
    expect(viaQuery.status).toBe(404);
    const bList = (await (await h.handle(request(`${base(b)}v1/websites`))).json()) as WebsitesWire;
    expect(bList.websites).toEqual([]);
    expect((await analytics.findWebsite(a, website.id))?.name).toBe("Our website");
  });

  it("answers the report, filtered to a website or to the company's own pages", async () => {
    const a = tenant("report");
    const h = handlers();
    const site = await analytics.addWebsite({ tenantId: a, name: "Green Acres", domains: "greenacres.com" });
    for (const path of [`v1/report?days=7`, `v1/report?days=90&site=pages`, `v1/websites/${site.id}/report?days=30`, `v1/report?includeInternal=1`]) {
      const res = await h.handle(request(base(a) + path));
      expect(res.status, path).toBe(200);
      const report = (await res.json()) as WebsiteReportWire;
      expect(report.version).toBe("v1");
      expect(report.ownPagesLabel).toBe("Your pages on Lawnco");
      expect(report.websites).toEqual([{ id: site.id, name: "Green Acres" }]);
    }
    const pages = (await (await h.handle(request(`${base(a)}v1/report?site=pages&days=90`))).json()) as WebsiteReportWire;
    expect([pages.site, pages.range.days]).toEqual(["pages", 90]);
    const everyone = (await (await h.handle(request(`${base(a)}v1/report?includeInternal=1`))).json()) as WebsiteReportWire;
    expect([everyone.includeInternal, everyone.excluded]).toEqual([true, null]);
  });

  it("refuses: past the plan's websites, a bad address, another site's POST, no permission, a signed-out Response", async () => {
    const a = tenant("refuse");
    const limited = handlers({ limit: 1 });
    expect((await limited.handle(request(`${base(a)}v1/websites`, { method: "POST", body: { name: "One", domains: "one-lawn.com" } }))).status).toBe(201);
    const second = await limited.handle(request(`${base(a)}v1/websites`, { method: "POST", body: { name: "Two", domains: "two-lawn.com" } }));
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe("limit_reached");
    const bad = await limited.handle(request(`${base(a)}v1/websites`, { method: "POST", body: { name: "Bad", domains: "nope" } }));
    expect(bad.status).toBe(400);
    expect((await limited.handle(request(`${base(a)}v1/websites`, { method: "POST", body: { name: "X", domains: "x.com" }, headers: { "sec-fetch-site": "cross-site" } }))).status).toBe(403);

    const viewer = handlers({ verdict: (permission) => (permission === "analytics.view" ? { userId: "u_view" } : false) });
    const listed = (await (await viewer.handle(request(`${base(a)}v1/websites`))).json()) as WebsitesWire;
    expect(listed.canManage).toBe(false);
    const add = await viewer.handle(request(`${base(a)}v1/websites`, { method: "POST", body: { name: "No", domains: "no-lawn.com" } }));
    expect(add.status).toBe(403);
    expect(((await add.json()) as { error: { message: string } }).error.message).toBe("You don't have permission to change the websites here.");

    const signedOut = handlers({ verdict: () => new Response("signed out", { status: 401 }) });
    expect((await signedOut.handle(request(`${base(a)}v1/report`))).status).toBe(401);
  });

  it("“these are my visits” marks and unmarks this device for this company; without an audience it says so", async () => {
    const a = tenant("mine");
    const h = handlers();
    const mine = await h.handle(request(`${base(a)}v1/visits/mine`, { method: "POST", body: {} }));
    expect(mine.status).toBe(200);
    expect(((await mine.json()) as { marked: number }).marked).toBeGreaterThan(0);
    const undo = await h.handle(request(`${base(a)}v1/visits/mine/undo`, { method: "POST", body: {} }));
    expect(((await undo.json()) as { marked: number }).marked).toBeGreaterThan(0);
    const without = handlers({ on: bare });
    const refused = await without.handle(request(`${base(a)}v1/visits/mine`, { method: "POST", body: {} }));
    expect(refused.status).toBe(409);
  });
});
