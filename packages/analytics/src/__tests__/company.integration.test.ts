import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createAudiences, createDrizzleAudienceStore, type AudienceUser } from "@adminigloo/audience";
import { createAnalytics, type Analytics } from "../instance.js";
import { audienceSessionsSource, isAnalyticsError } from "../context.js";
import { buildWebsiteReport, excludedWords } from "../report.js";
import { newSiteKey, normalizeDomain, SITE_KEY_SHAPE, siteKeyOf, type ResolvedSite } from "../websites.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";
import type { AnalyticsTables } from "../schema.js";

/**
 * EVERY COMPANY'S WEBSITES, ONE DEPLOYMENT (0.3), on real Postgres:
 *
 *   - the site register is each company's own (another company's website id
 *     is "not found" for every change);
 *   - a website's beacon counts only from that website's own addresses, under
 *     its company — never from somebody else's page carrying its key, never
 *     after it was removed;
 *   - every report reads one company's visits, and a website filter reads one
 *     website's;
 *   - each company's audience leaves ITS team out, and only of its own numbers;
 *   - a server-side conversion by a company's own person leaves their visit
 *     out (the 0.2 gap).
 */

const SECRET = "test-secret-0123456789-abcdefghijklmnopqrstuvwxyz";
const NOW = new Date("2026-10-08T12:00:00Z");
const RANGE = { from: new Date("2026-10-08T00:00:00Z"), to: new Date("2026-10-09T00:00:00Z") };
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const APP = "app.lawnco.com";

interface Member extends AudienceUser {
  companies: string[];
}

let tdb: TestDb & { tables: AnalyticsTables[] };
let t: AnalyticsTables;
beforeAll(async () => {
  tdb = await createTestDb();
  t = tdb.tables[0]!;
});
afterAll(async () => {
  await tdb?.close();
});

function setup(members: Member[] = []) {
  const errors: unknown[] = [];
  const audiences = createAudiences<Member>({
    store: createDrizzleAudienceStore({ db: tdb.db }),
    secret: SECRET,
    visitorIds: "rotating",
    link: "pseudonymous",
    now: () => NOW,
    onError: (error) => errors.push(error),
    forTenant: (tenantId) => ({
      isInternal: (user) => (user.companies.includes(tenantId) ? "team" : false),
      getUser: async (id) => members.find((member) => member.id === id) ?? null,
      listUsers: async () => members.filter((member) => member.companies.includes(tenantId)),
      sessions: audienceSessionsSource({ tenantId, tables: t }),
    }),
  });
  const analytics: Analytics = createAnalytics({ db: tdb.db, tables: t, audience: (tenantId) => audiences.for(tenantId), onError: (error) => errors.push(error) });
  let clock = new Date(NOW.getTime() - 60 * 60 * 1000);
  const tick = (minutes = 1) => {
    clock = new Date(clock.getTime() + minutes * 60_000);
  };
  const onSession = async (visit: { tenantId: string; visitorId: string; sessionId: string; host: string | null; userAgent: string; headers: Headers; ip: string | null; req: Request }) =>
    audiences.for(visit.tenantId).observe({
      visitorId: visit.visitorId,
      sessionId: visit.sessionId,
      userId: visit.req.headers.get("x-test-user"),
      host: visit.host,
      userAgent: visit.userAgent,
      headers: visit.headers,
      ip: visit.ip,
    });
  /** The keyed endpoint every company's own website calls (/api/w/v1/collect?site=…). */
  const keyed = analytics.createHandler({ resolveSite: analytics.siteResolver(), clientIp: (req) => req.headers.get("x-forwarded-for"), now: () => clock, onSession });
  /** A company's pages here (/api/t/{web address}/website/v1/collect): the route names the company. */
  const pagesFor = (tenantId: string) =>
    analytics.createHandler({
      resolveSite: (): ResolvedSite => ({ tenantId, siteId: null, allowedHosts: [APP] }),
      clientIp: (req) => req.headers.get("x-forwarded-for"),
      now: () => clock,
      onSession,
    });
  return { analytics, audiences, keyed, pagesFor, tick, errors, now: () => clock };
}

function beacon(url: string, body: Record<string, unknown>, origin: string, ip = "203.0.113.7", headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { origin: `https://${origin}`, "user-agent": CHROME, "x-forwarded-for": ip, ...headers },
    body: JSON.stringify(body),
  });
}

const keyedUrl = (key: string) => `https://${APP}/api/w/v1/collect?site=${key}`;
const sessions = async (tenantId: string) =>
  tdb.db.select({ id: t.sessions.id, siteId: t.sessions.siteId, landingPath: t.sessions.landingPath }).from(t.sessions).where(eq(t.sessions.tenantId, tenantId));

describe("web addresses and keys", () => {
  it("normalises what an owner types, and refuses what isn't an address", () => {
    expect(normalizeDomain("https://www.GreenAcres.com/contact?x=1")).toBe("greenacres.com");
    expect(normalizeDomain("  shop.greenacres.com ")).toBe("shop.greenacres.com");
    expect(normalizeDomain("localhost:3000")).toBe("localhost:3000");
    for (const bad of ["", "greenacres", "*.greenacres.com", "ann@greenacres.com", "green acres.com", "/contact"]) expect(normalizeDomain(bad), bad).toBeNull();
    const key = newSiteKey();
    expect(key).toMatch(SITE_KEY_SHAPE);
    expect(newSiteKey()).not.toBe(key);
    expect(siteKeyOf(new Request(`https://x.test/c?site=${key}`, { method: "POST" }))).toBe(key);
    expect(siteKeyOf(new Request("https://x.test/c", { method: "POST", headers: { "x-aig-site": key } }))).toBe(key);
  });
});

describe("the site register is each company's own", () => {
  it("adds, lists, renames and removes a company's websites; another company's id is not found", async () => {
    const { analytics } = setup();
    const a = tenant("acres");
    const b = tenant("summit");
    const site = await analytics.addWebsite({ tenantId: a, name: "Our website", domains: "greenacres.com, www.greenacres.com, shop.greenacres.com", by: "u_ann" });
    expect(site.domains).toEqual(["greenacres.com", "shop.greenacres.com"]);
    expect(site.siteKey).toMatch(SITE_KEY_SHAPE);
    expect((await analytics.listWebsites(a)).map((w) => w.id)).toEqual([site.id]);
    expect(await analytics.listWebsites(b)).toEqual([]);

    // B with A's website id: every change is "not found", and A's website is untouched.
    expect(await analytics.findWebsite(b, site.id)).toBeNull();
    expect(await analytics.updateWebsite({ tenantId: b, id: site.id, name: "Hijacked" })).toBeNull();
    expect(await analytics.removeWebsite({ tenantId: b, id: site.id })).toBeNull();
    expect((await analytics.findWebsite(a, site.id))?.name).toBe("Our website");

    const renamed = await analytics.updateWebsite({ tenantId: a, id: site.id, name: "Green Acres", domains: ["greenacres.com"] });
    expect(renamed).toMatchObject({ name: "Green Acres", domains: ["greenacres.com"], siteKey: site.siteKey });
    expect(await analytics.removeWebsite({ tenantId: a, id: site.id })).not.toBeNull();
    expect(await analytics.listWebsites(a)).toEqual([]);
    expect((await analytics.listWebsites(a, { includeRemoved: true })).length).toBe(1);
  });

  it("refuses a bad name or address, and a website past the plan's limit, in plain words", async () => {
    const { analytics } = setup();
    const a = tenant("limit");
    await expect(analytics.addWebsite({ tenantId: a, name: "", domains: "x.com" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(analytics.addWebsite({ tenantId: a, name: "Site", domains: "not an address" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(analytics.addWebsite({ tenantId: a, name: "Site", domains: [] })).rejects.toMatchObject({ code: "invalid_input" });
    await analytics.addWebsite({ tenantId: a, name: "One", domains: "one.com", limit: 1 });
    const refused = await analytics.addWebsite({ tenantId: a, name: "Two", domains: "two.com", limit: 1 }).catch((error: unknown) => error);
    expect(isAnalyticsError(refused) && refused.code).toBe("limit_reached");
    expect((refused as Error).message).toBe("Your plan includes 1 website. Stop counting one or choose a bigger plan to add another.");
  });

  it("saves exactly one of three adds sent at once when the plan allows one (count and insert under one lock)", async () => {
    const { analytics } = setup();
    const a = tenant("race");
    const results = await Promise.allSettled(
      ["one.com", "two.com", "three.com"].map((domain, i) => analytics.addWebsite({ tenantId: a, name: `Site ${i}`, domains: domain, limit: 1 })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason.code)).toEqual(["limit_reached", "limit_reached"]);
    expect(await analytics.listWebsites(a)).toHaveLength(1);
  });

  it("refuses an address another of the company's websites has, the app's own address and a laptop's — another company may have it", async () => {
    const { analytics } = setup();
    const a = tenant("dupe-a");
    const b = tenant("dupe-b");
    const first = await analytics.addWebsite({ tenantId: a, name: "Main", domains: "greenacres.com" });
    const dupe = await analytics.addWebsite({ tenantId: a, name: "Again", domains: "www.greenacres.com, shop.greenacres.com" }).catch((e: unknown) => e);
    expect(isAnalyticsError(dupe) && dupe.code).toBe("invalid_input");
    expect((dupe as Error).message).toBe("greenacres.com is already one of your websites (Main).");
    const shop = await analytics.addWebsite({ tenantId: a, name: "Shop", domains: "shop.greenacres.com" });
    await expect(analytics.updateWebsite({ tenantId: a, id: shop.id, domains: "greenacres.com" })).rejects.toMatchObject({ code: "invalid_input" });
    // Renaming a website with its own addresses is not a duplicate of itself.
    expect((await analytics.updateWebsite({ tenantId: a, id: first.id, domains: "greenacres.com" }))?.domains).toEqual(["greenacres.com"]);
    // Another company's register is its own (the beacon's address check keeps their counts apart).
    await expect(analytics.addWebsite({ tenantId: b, name: "Theirs", domains: "greenacres.com" })).resolves.toMatchObject({ tenantId: b });
    // A removed website's address is free again.
    await analytics.removeWebsite({ tenantId: a, id: shop.id });
    await expect(analytics.addWebsite({ tenantId: a, name: "Shop again", domains: "shop.greenacres.com" })).resolves.toBeTruthy();

    const refuse = { hosts: ["https://app.lawnco.com"], local: true };
    for (const domain of ["app.lawnco.com", "www.app.lawnco.com", "localhost:3000", "127.0.0.1", "mybox.local"]) {
      const refused = await analytics.addWebsite({ tenantId: a, name: "Bad", domains: domain, refuse }).catch((e: unknown) => e);
      expect(isAnalyticsError(refused) && refused.code, domain).toBe("invalid_input");
    }
    // On a laptop (local not refused) localhost is fine.
    await expect(analytics.addWebsite({ tenantId: tenant("laptop"), name: "Local", domains: "localhost:3000", refuse: { hosts: [] } })).resolves.toBeTruthy();
  });

  it("says when each website last had a visit, its own pages under null", async () => {
    const { analytics, keyed } = setup();
    const a = tenant("last");
    const site = await analytics.addWebsite({ tenantId: a, name: "Main", domains: "lastvisit.com" });
    const quiet = await analytics.addWebsite({ tenantId: a, name: "Quiet", domains: "quiet.com" });
    expect((await analytics.lastVisits(a)).size).toBe(0);
    expect((await keyed.handle(beacon(keyedUrl(site.siteKey), { t: "pageview", d: "lastvisitdoc0001", p: "/" }, "lastvisit.com"))).status).toBe(204);
    const last = await analytics.lastVisits(a);
    expect(last.get(site.id)).toBeInstanceOf(Date);
    expect(last.has(quiet.id)).toBe(false);
    expect((await analytics.lastVisits(tenant("last-other"))).size).toBe(0);
  });
});

describe("a website's beacon counts only from its own addresses, under its company", () => {
  it("counts the website's own pages, and drops another site's page carrying the key, a made-up key, no key and a removed website", async () => {
    const ctx = setup();
    const a = tenant("beacon-a");
    const b = tenant("beacon-b");
    const siteA = await ctx.analytics.addWebsite({ tenantId: a, name: "Green Acres", domains: "greenacres.com" });
    const siteB = await ctx.analytics.addWebsite({ tenantId: b, name: "Summit", domains: "summitlawn.com" });

    expect((await ctx.keyed.handle(beacon(keyedUrl(siteA.siteKey), { t: "pageview", d: "doc_a_0000001", p: "/" }, "www.greenacres.com"))).status).toBe(204);
    // Summit's page carrying Green Acres' key (copied snippet): dropped.
    await ctx.keyed.handle(beacon(keyedUrl(siteA.siteKey), { t: "pageview", d: "doc_a_0000002", p: "/stolen" }, "summitlawn.com", "198.51.100.1"));
    // A made-up key, and no key at all: dropped.
    await ctx.keyed.handle(beacon(keyedUrl(newSiteKey()), { t: "pageview", d: "doc_a_0000003", p: "/x" }, "greenacres.com", "198.51.100.2"));
    await ctx.keyed.handle(beacon(`https://${APP}/api/w/v1/collect`, { t: "pageview", d: "doc_a_0000004", p: "/y" }, "greenacres.com", "198.51.100.3"));
    // Summit's own page, its own key: Summit's.
    await ctx.keyed.handle(beacon(keyedUrl(siteB.siteKey), { t: "pageview", d: "doc_b_0000001", p: "/" }, "summitlawn.com", "198.51.100.4"));

    expect((await sessions(a)).map((row) => [row.landingPath, row.siteId])).toEqual([["/", siteA.id]]);
    expect((await sessions(b)).map((row) => [row.landingPath, row.siteId])).toEqual([["/", siteB.id]]);

    // Removed: its key stops counting at once (this instance drops its cache).
    await ctx.analytics.removeWebsite({ tenantId: a, id: siteA.id });
    ctx.tick(40);
    await ctx.keyed.handle(beacon(keyedUrl(siteA.siteKey), { t: "pageview", d: "doc_a_0000005", p: "/after" }, "greenacres.com", "198.51.100.5"));
    expect((await sessions(a)).length).toBe(1);
  });

  it("keeps a company's own website and its pages here as two visits, one per website", async () => {
    const ctx = setup();
    const a = tenant("two-sites");
    const site = await ctx.analytics.addWebsite({ tenantId: a, name: "Green Acres", domains: "greenacres.com" });
    await ctx.keyed.handle(beacon(keyedUrl(site.siteKey), { t: "pageview", d: "doc_two_000001", p: "/" }, "greenacres.com"));
    ctx.tick();
    await ctx.pagesFor(a).handle(beacon(`https://${APP}/api/t/green-acres/website/v1/collect`, { t: "pageview", d: "doc_two_000002", p: "/t/green-acres" }, APP));
    // The page here, from somewhere else: dropped.
    await ctx.pagesFor(a).handle(beacon(`https://${APP}/api/t/green-acres/website/v1/collect`, { t: "pageview", d: "doc_two_000003", p: "/t/green-acres" }, "evil.example", "198.51.100.9"));
    const rows = await sessions(a);
    expect(rows.map((row) => row.siteId).sort()).toEqual([null, site.id].sort());

    const q = { tenantId: a, ...RANGE };
    expect((await ctx.analytics.getOverview(q)).visits.current).toBe(2);
    expect((await ctx.analytics.getOverview({ ...q, siteId: site.id })).visits.current).toBe(1);
    expect((await ctx.analytics.getOverview({ ...q, siteId: null })).visits.current).toBe(1);
    expect((await ctx.analytics.getTopPages({ ...q, siteId: null })).map((row) => row.path)).toEqual(["/t/green-acres"]);
    expect((await ctx.analytics.getTopPages({ ...q, siteId: site.id })).map((row) => row.path)).toEqual(["/"]);
  });

  it("a company's pages here count only under its own web address (pathPrefix)", async () => {
    const ctx = setup();
    const a = tenant("prefix");
    const handler = ctx.analytics.createHandler({
      resolveSite: (): ResolvedSite => ({ tenantId: a, siteId: null, allowedHosts: [APP], pathPrefix: "/t/green-acres" }),
      clientIp: (req) => req.headers.get("x-forwarded-for"),
      now: ctx.now,
    });
    const url = `https://${APP}/api/t/green-acres/website/v1/collect`;
    await handler.handle(beacon(url, { t: "pageview", d: "doc_prefix_0001", p: "/t/green-acres/book-visit" }, APP, "198.51.100.21"));
    await handler.handle(beacon(url, { t: "pageview", d: "doc_prefix_0002", p: "/t/green-acres-2" }, APP, "198.51.100.22"));
    await handler.handle(beacon(url, { t: "pageview", d: "doc_prefix_0003", p: "/pricing" }, APP, "198.51.100.23"));
    expect((await sessions(a)).map((row) => row.landingPath)).toEqual(["/t/green-acres/book-visit"]);
  });

  it("a conversion lands on the visit to the website it happened on, never the same person's visit to another", async () => {
    const ctx = setup();
    const a = tenant("conv-site");
    const site = await ctx.analytics.addWebsite({ tenantId: a, name: "Green Acres", domains: "greenacres.com" });
    await ctx.pagesFor(a).handle(beacon(`https://${APP}/api/t/green-acres/website/v1/collect`, { t: "pageview", d: "doc_conv_00001", p: "/t/green-acres" }, APP));
    ctx.tick();
    // The same person, a minute later, on the company's own website: the newer visit.
    await ctx.keyed.handle(beacon(keyedUrl(site.siteKey), { t: "pageview", d: "doc_conv_00002", p: "/" }, "greenacres.com"));
    ctx.tick();
    const landed = await ctx.analytics.recordConversion({ tenantId: a, ip: "203.0.113.7", userAgent: CHROME, name: "booking", siteId: null, at: ctx.now() });
    const rows = await tdb.db.select({ id: t.sessions.id, siteId: t.sessions.siteId, converted: t.sessions.converted }).from(t.sessions).where(eq(t.sessions.tenantId, a));
    const pages = rows.find((row) => row.siteId === null)!;
    expect(landed?.sessionId).toBe(pages.id);
    expect(rows.find((row) => row.siteId === site.id)?.converted).toBe(false);
  });
});

describe("reports are one company's", () => {
  it("company B's reports say nothing of company A's visits", async () => {
    const ctx = setup();
    const a = tenant("rep-a");
    const b = tenant("rep-b");
    const siteA = await ctx.analytics.addWebsite({ tenantId: a, name: "Green Acres", domains: "greenacres.com" });
    await ctx.keyed.handle(beacon(keyedUrl(siteA.siteKey), { t: "pageview", d: "doc_rep_000001", p: "/spring-cleanup", r: "https://www.google.com/" }, "greenacres.com"));
    ctx.tick();
    await ctx.keyed.handle(beacon(keyedUrl(siteA.siteKey), { t: "event", d: "doc_rep_000001", p: "/spring-cleanup", n: "outbound", l: "maps.google.com" }, "greenacres.com"));

    const qa = { tenantId: a, ...RANGE };
    const qb = { tenantId: b, ...RANGE };
    expect((await ctx.analytics.getOverview(qa)).visits.current).toBe(1);
    expect((await ctx.analytics.getOverview(qb)).visits.current).toBe(0);
    expect((await ctx.analytics.getTopPages(qb)).length).toBe(0);
    expect((await ctx.analytics.getTopClicks(qb)).length).toBe(0);
    expect((await ctx.analytics.getReferrers(qb)).length).toBe(0);
    expect((await ctx.analytics.getSources(qb)).every((row) => row.visits === 0)).toBe(true);

    const reportB = await buildWebsiteReport(ctx.analytics, { tenantId: b, days: 7, now: NOW });
    expect(JSON.stringify(reportB)).not.toContain("spring-cleanup");
    expect(JSON.stringify(reportB)).not.toContain(siteA.id);
    const reportA = await buildWebsiteReport(ctx.analytics, { tenantId: a, days: 7, now: NOW });
    expect(reportA.overview.visits.current).toBe(1);
    expect(reportA.topPages.map((row) => row.path)).toEqual(["/spring-cleanup"]);
    expect(reportA.searchEngines).toEqual([{ host: "google.com", visits: 1 }]);
    expect(reportA.websites).toEqual([{ id: siteA.id, name: "Green Acres" }]);

    // Another company's website as the filter: "not found".
    await expect(buildWebsiteReport(ctx.analytics, { tenantId: b, site: siteA.id, now: NOW })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("each company leaves ITS people out, of its own numbers only", () => {
  it("a member browsing their own company's pages is left out there, and counted on the company next door", async () => {
    const a = tenant("aud-a");
    const b = tenant("aud-b");
    const ctx = setup([{ id: "u_ann", email: "ann@greenacreslawn.com", companies: [a] }]);
    await ctx.pagesFor(a).handle(beacon(`https://${APP}/api/t/a/website/v1/collect`, { t: "pageview", d: "doc_aud_000001", p: "/t/a" }, APP, "203.0.113.20", { "x-test-user": "u_ann" }));
    await ctx.pagesFor(b).handle(beacon(`https://${APP}/api/t/b/website/v1/collect`, { t: "pageview", d: "doc_aud_000002", p: "/t/b" }, APP, "203.0.113.20", { "x-test-user": "u_ann" }));
    ctx.tick();
    await ctx.pagesFor(a).handle(beacon(`https://${APP}/api/t/a/website/v1/collect`, { t: "pageview", d: "doc_aud_000003", p: "/t/a" }, APP, "203.0.113.21"));

    const qa = { tenantId: a, ...RANGE };
    const qb = { tenantId: b, ...RANGE };
    expect((await ctx.analytics.getOverview(qa)).visits.current).toBe(1);
    expect((await ctx.analytics.getOverview({ ...qa, includeInternal: true })).visits.current).toBe(2);
    expect(await ctx.analytics.getExcludedBreakdown({ tenantId: a, ...RANGE })).toEqual({ total: 1, byReason: { role: 1 }, unit: "sessions" });
    // Ann is nobody to Summit.
    expect((await ctx.analytics.getOverview(qb)).visits.current).toBe(1);
    expect((await ctx.analytics.getExcludedBreakdown({ tenantId: b, ...RANGE }))?.total).toBe(0);

    const report = await buildWebsiteReport(ctx.analytics, { tenantId: a, days: 7, now: NOW });
    expect(report.excluded?.sentence).toBe("Left out: 1 visit (your team 1).");
  });

  it("“these are my visits” leaves one device out of one company's numbers, and can be undone", async () => {
    const a = tenant("mine-a");
    const b = tenant("mine-b");
    const ctx = setup();
    const ip = "203.0.113.30";
    await ctx.pagesFor(a).handle(beacon(`https://${APP}/api/t/a/website/v1/collect`, { t: "pageview", d: "doc_mine_00001", p: "/t/a" }, APP, ip));
    await ctx.pagesFor(b).handle(beacon(`https://${APP}/api/t/b/website/v1/collect`, { t: "pageview", d: "doc_mine_00002", p: "/t/b" }, APP, ip));
    const marked = await ctx.analytics.markVisitorInternal({ tenantId: a, ip, userAgent: CHROME, by: "u_owner", at: ctx.now() });
    expect(marked.subjectsChanged).toBeGreaterThan(0);
    expect((await ctx.analytics.getOverview({ tenantId: a, ...RANGE })).visits.current).toBe(0);
    expect((await ctx.analytics.getOverview({ tenantId: b, ...RANGE })).visits.current).toBe(1);
    for (const visitorId of marked.visitorIds) await ctx.audiences.for(a).unmark({ subjectKind: "visitor", subjectId: visitorId, by: "u_owner" });
    expect((await ctx.analytics.getOverview({ tenantId: a, ...RANGE })).visits.current).toBe(1);
  });
});

describe("server-side conversions leave a company's own people out (the 0.2 gap)", () => {
  it("a conversion recorded for a team member marks their visit; a customer's stays counted", async () => {
    const a = tenant("conv");
    const ctx = setup([{ id: "u_ann", email: "ann@greenacreslawn.com", companies: [a] }]);
    const staffIp = "203.0.113.40";
    const customerIp = "203.0.113.41";
    // Both arrive signed out: the beacon cannot know who they are.
    await ctx.pagesFor(a).handle(beacon(`https://${APP}/api/t/a/website/v1/collect`, { t: "pageview", d: "doc_conv_00001", p: "/t/a/book-visit" }, APP, staffIp));
    await ctx.pagesFor(a).handle(beacon(`https://${APP}/api/t/a/website/v1/collect`, { t: "pageview", d: "doc_conv_00002", p: "/t/a/book-visit" }, APP, customerIp));
    ctx.tick();
    // The booking is recorded on the server, where it is known who did it.
    expect(await ctx.analytics.recordConversion({ tenantId: a, ip: staffIp, userAgent: CHROME, name: "visit_booked", userId: "u_ann", at: ctx.now(), headers: new Headers() })).not.toBeNull();
    expect(await ctx.analytics.recordConversion({ tenantId: a, ip: customerIp, userAgent: CHROME, name: "visit_booked", userId: null, at: ctx.now(), headers: new Headers() })).not.toBeNull();
    const overview = await ctx.analytics.getOverview({ tenantId: a, ...RANGE });
    expect(overview.visits.current).toBe(1);
    expect(overview.conversions.current).toBe(1);
    expect((await ctx.analytics.getOverview({ tenantId: a, ...RANGE, includeInternal: true })).conversions.current).toBe(2);
    const marked = await tdb.db.execute(sql`select count(*)::int as n from aig_audience_marks where tenant_id = ${a} and cleared_at is null`);
    expect(Number((marked as unknown as { rows: Array<{ n: number }> }).rows[0]?.n)).toBeGreaterThan(0);
    expect(ctx.errors).toEqual([]);
  });
});

describe("the excluded line, in words", () => {
  it("names each reason the way an owner says it, and adds up", () => {
    expect(excludedWords({ total: 12, byReason: { role: 10, automation: 2 }, unit: "sessions" })).toBe("Left out: 12 visits (your team 10, automation 2).");
    expect(excludedWords({ total: 0, byReason: {}, unit: "sessions" })).toBe("Left out: no visits in this range.");
    expect(excludedWords({ total: 1, byReason: { device: 1 }, unit: "sessions" })).toBe("Left out: 1 visit (devices marked as yours 1).");
  });
});

// The beacon writes under its resolved tenant, never one named in the payload.
describe("a payload can't name its own company", () => {
  it("ignores a tenant smuggled into the body", async () => {
    const ctx = setup();
    const a = tenant("smuggle-a");
    const b = tenant("smuggle-b");
    const site = await ctx.analytics.addWebsite({ tenantId: a, name: "A", domains: "a-lawn.com" });
    await ctx.keyed.handle(beacon(keyedUrl(site.siteKey), { t: "pageview", d: "doc_smug_00001", p: "/", tenantId: b, tenant: b }, "a-lawn.com"));
    expect((await sessions(a)).length).toBe(1);
    expect((await sessions(b)).length).toBe(0);
    const [row] = await tdb.db.select({ n: sql<number>`count(*)::int` }).from(t.pageViews).where(and(eq(t.pageViews.tenantId, b)));
    expect(row?.n).toBe(0);
  });
});
