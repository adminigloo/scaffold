import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSeoReportsHandlers, type CreateSeoReportsHandlersOptions } from "../handlers.js";
import { SEO_REPORTS_ADMIN_ROUTES } from "../routes.js";
import { beginSiteCheck, getSiteCheck, listSiteChecks, siteChecksThisMonth, type SeoDb } from "../store.js";
import type { SearchCheckOverviewWire, SiteCheckWire } from "../wire.js";
import { fakeNetwork, html, type FakeNetwork } from "./fake-network.js";
import { createTestDb } from "./pglite.js";

/**
 * EACH COMPANY'S SEARCH CHECK IS ITS OWN (0.2), on a real Postgres (PGlite):
 * its checks read only its addresses, its reports are listed only to it, and
 * another company's report id is "not found" — plus the month's limit, the
 * one-at-a-time lock, a closed plan, the rate limit and the weekly job.
 */

let db: SeoDb;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

const ADDRESSES: Record<string, { label: string; baseUrl: string; pending?: string }[]> = {
  alpha: [{ label: "Alpha website", baseUrl: "https://alpha-lawncare.com" }],
  bravo: [{ label: "Bravo website", baseUrl: "https://bravo-lawncare.com" }],
  empty: [],
};

function sites(): FakeNetwork {
  const pages: Record<string, { body: string; headers?: Record<string, string> }> = {};
  for (const name of ["alpha", "bravo"]) {
    pages[`https://${name}-lawncare.com/`] = { body: html({ title: `${name} lawn care in Raleigh`, description: `${name} `.repeat(15), body: '<a href="/prices">Prices</a>' }) };
    pages[`https://${name}-lawncare.com/prices`] = { body: html({ title: `${name} prices for lawn care`, description: `${name} prices `.repeat(6) }) };
  }
  return fakeNetwork(pages);
}

function handlers(overrides: Partial<CreateSeoReportsHandlersOptions> = {}, net: FakeNetwork = sites()) {
  return createSeoReportsHandlers({
    db,
    resolveTenant: (req) => new URL(req.url).pathname.split("/")[3] ?? null,
    authorize: () => ({ userId: "u1" }),
    addresses: (tenantId) => ADDRESSES[tenantId] ?? [],
    network: { resolve: net.resolve, transport: net.transport },
    ...overrides,
  });
}

function call(h: ReturnType<typeof handlers>, tenantId: string, path: string, method: "GET" | "POST" = "GET", headers: Record<string, string> = {}) {
  return h.handle(new Request(`http://app.test/api/app/${tenantId}/search-check/${path}`, { method, headers, ...(method === "POST" ? { body: "{}" } : {}) }));
}

async function checkNow(tenantId: string, h = handlers()): Promise<SiteCheckWire> {
  const res = await call(h, tenantId, "v1/checks", "POST");
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as SiteCheckWire;
}

describe("a company's search check", () => {
  it("reads only that company's own addresses, and keeps the report as its own", async () => {
    const net = sites();
    const report = await checkNow("alpha", handlers({}, net));
    expect(net.requests.length).toBeGreaterThan(0);
    expect(net.requests.every((r) => new URL(r.url).hostname === "alpha-lawncare.com")).toBe(true);
    expect(report.status).toBe("done");
    expect(report.pageCount).toBe(2);
    expect(report.worklist.some((item) => item.id === "site.llms-txt")).toBe(true);
    expect(await getSiteCheck(db, "alpha", report.id)).not.toBeNull();
    expect((await listSiteChecks(db, "alpha")).map((c) => c.id)).toContain(report.id);
  });

  it("another company's report id is “not found”, and its list never shows it", async () => {
    const alpha = await checkNow("alpha");
    const bravo = await checkNow("bravo");
    const asBravo = await call(handlers(), "bravo", `v1/checks/${alpha.id}`);
    expect(asBravo.status).toBe(404);
    expect(await asBravo.text()).not.toContain("alpha");
    expect(await getSiteCheck(db, "bravo", alpha.id)).toBeNull();
    const list = (await (await call(handlers(), "bravo", "v1/checks")).json()) as SearchCheckOverviewWire;
    expect(list.checks.map((c) => c.id)).toContain(bravo.id);
    expect(list.checks.map((c) => c.id)).not.toContain(alpha.id);
    expect(JSON.stringify(list)).not.toContain("alpha-lawncare");
    // And the check can fail: Alpha does see its own.
    expect((await call(handlers(), "alpha", `v1/checks/${alpha.id}`)).status).toBe(200);
  });

  it("drives every route in SEO_REPORTS_ADMIN_ROUTES for the company itself", async () => {
    const own = await checkNow("alpha");
    for (const route of SEO_REPORTS_ADMIN_ROUTES) {
      const res = await call(handlers(), "alpha", route.path.replace("{site-check}", own.id), route.method);
      expect([200, 201], `${route.kind}`).toContain(res.status);
    }
  });

  it("stops at the month's Check now presses (a site that doesn't answer still used one)", async () => {
    const h = handlers({ monthlyLimit: () => 1 });
    const fresh = "limit-co";
    ADDRESSES[fresh] = ADDRESSES.alpha!;
    const broken = handlers({ monthlyLimit: () => 1, network: { resolve: async () => ["93.184.216.34"], transport: async () => { throw new Error("boom"); } }, limits: { totalTimeMs: 2_000 } });
    // A transport failing on every page is the SITE not answering: it still counts.
    expect((await call(broken, fresh, "v1/checks", "POST")).status).toBe(201);
    expect(await siteChecksThisMonth(db, fresh)).toBe(1);
    const refused = await call(h, fresh, "v1/checks", "POST");
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "limit_reached" });
    const overview = (await (await call(h, fresh, "v1/checks")).json()) as SearchCheckOverviewWire;
    expect(overview.notice).toMatch(/used this month's 1 Check now press/);
  });

  it("never counts the weekly check against the month, and never stops it at the limit (review M2)", async () => {
    const tenant = "weekly-free-co";
    ADDRESSES[tenant] = ADDRESSES.bravo!;
    const h = handlers({ monthlyLimit: () => 0, automatic: true });
    expect(await h.runScheduled(tenant)).toMatchObject({ ran: true });
    expect(await siteChecksThisMonth(db, tenant)).toBe(0);
    expect((await call(h, tenant, "v1/checks", "POST")).status).toBe(409);
    const overview = (await (await call(h, tenant, "v1/checks")).json()) as SearchCheckOverviewWire;
    expect(overview.nextAutomaticAt).not.toBeNull();
  });

  it("a check that died with its process doesn't count, and doesn't block the next (review M1)", async () => {
    const tenant = "dead-co";
    ADDRESSES[tenant] = ADDRESSES.alpha!;
    const long = new Date(Date.now() - 10 * 60_000);
    await beginSiteCheck(db, { tenantId: tenant, trigger: "manual", requestedBy: null, baseUrl: "x", addresses: [], monthlyLimit: null, now: long });
    expect(await siteChecksThisMonth(db, tenant)).toBe(0);
    expect((await call(handlers({ monthlyLimit: () => 1 }), tenant, "v1/checks", "POST")).status).toBe(201);
    const list = await listSiteChecks(db, tenant);
    expect(list.map((c) => c.status).sort()).toEqual(["done", "failed"]);
  });

  it("never reads an address that's waiting, and says why (review L4)", async () => {
    const tenant = "waiting-co";
    ADDRESSES[tenant] = [
      { label: "Your pages on Snowplow", baseUrl: "https://alpha-lawncare.com" },
      { label: "your website “Bravo”", baseUrl: "https://bravo-lawncare.com", pending: "We'll check this site once your visits line is working." },
    ];
    const net = sites();
    expect((await call(handlers({}, net), tenant, "v1/checks", "POST")).status).toBe(201);
    expect(net.requests.some((r) => r.url.includes("bravo"))).toBe(false);
    const overview = (await (await call(handlers(), tenant, "v1/checks")).json()) as SearchCheckOverviewWire;
    expect(overview.waiting).toEqual(["Your website “Bravo” (bravo-lawncare.com): We'll check this site once your visits line is working."]);
    expect(overview.addressSentence).toBe("Your pages on Snowplow (alpha-lawncare.com)");
  });

  it("refuses a second check while one is running", async () => {
    const tenant = "busy-co";
    ADDRESSES[tenant] = ADDRESSES.alpha!;
    await beginSiteCheck(db, { tenantId: tenant, trigger: "manual", requestedBy: null, baseUrl: "https://alpha-lawncare.com", addresses: [], monthlyLimit: null });
    const res = await call(handlers(), tenant, "v1/checks", "POST");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("running");
  });

  it("never reads a page for a company whose plan is closed, or who presses too often", async () => {
    const net = sites();
    const closed = await call(handlers({ admit: () => "This company's plan has ended." }, net), "alpha", "v1/checks", "POST");
    expect(closed.status).toBe(403);
    expect(((await closed.json()) as { error: { message: string } }).error.message).toBe("This company's plan has ended.");
    const limited = await call(handlers({ rateLimit: () => "Give it a minute." }, net), "alpha", "v1/checks", "POST");
    expect(limited.status).toBe(429);
    expect(net.requests).toEqual([]);
  });

  it("says there's nothing to check for a company with no address", async () => {
    const res = await call(handlers(), "empty", "v1/checks", "POST");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("no_addresses");
    expect(((await (await call(handlers(), "empty", "v1/checks")).json()) as SearchCheckOverviewWire).notice).toMatch(/nothing to check/);
  });

  it("asks authorize for each route's permission, and passes a refusal through", async () => {
    const asked: string[] = [];
    const h = handlers({ authorize: (_req, permission) => (asked.push(permission), permission === "seo_reports.view") });
    expect((await call(h, "alpha", "v1/checks")).status).toBe(200);
    const forbidden = await call(h, "alpha", "v1/checks", "POST");
    expect(forbidden.status).toBe(403);
    expect(asked).toContain("seo_reports.run");
    const signedOut = handlers({ authorize: () => new Response("sign in", { status: 401 }) });
    expect((await call(signedOut, "alpha", "v1/checks")).status).toBe(401);
    expect((await call(handlers(), "alpha", "v1/checks", "POST", { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await call(handlers(), "alpha", "v1/checks/not%00an-id")).status).toBe(404);
  });

  it("the weekly job checks a company once a week", async () => {
    const tenant = "weekly-co";
    ADDRESSES[tenant] = ADDRESSES.bravo!;
    const h = handlers();
    expect(await h.runScheduled(tenant)).toMatchObject({ ran: true });
    expect(await h.runScheduled(tenant)).toEqual({ ran: false, reason: "recent" });
    expect(await handlers({ admit: () => "closed" }).runScheduled("never-checked-co")).toEqual({ ran: false, reason: "closed" });
    const [row] = await listSiteChecks(db, tenant);
    expect(row?.trigger).toBe("schedule");
  });
});
