import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createAnalytics } from "../instance.js";
import { DEFAULT_LIMITS, isAnalyticsError } from "../context.js";
import {
  createAnalyticsHandler,
  defaultAnalyticsFor,
  getCrawlers,
  getOverview,
  getPublicSnapshot,
  getTopPages,
  MAX_SESSIONS_PER_NETWORK_HOUR,
  recordConversion,
  recordCrawlerHit,
  resolveVisitorKeys,
  runAnalyticsMaintenance,
} from "../legacy.js";
import { analyticsTables, type AnalyticsTables } from "../schema.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * Two table sets in one database and one process — the AdminIgloo site's
 * `analytics_*` beside Riddler Go's `aig_analytics_*` — never share a row or
 * a cache; the 0.1 free functions still work, over a default instance per
 * `db`; and the limits are the instance's, with 0.1's defaults.
 */

const NOW = new Date("2026-10-08T12:00:00Z");
const RANGE = { from: new Date("2026-10-08T00:00:00Z"), to: new Date("2026-10-09T00:00:00Z") };
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const GPTBOT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot";

let tdb: TestDb & { tables: AnalyticsTables[] };
let site: AnalyticsTables;
let riddler: AnalyticsTables;
beforeAll(async () => {
  tdb = await createTestDb(["analytics_", "aig_analytics_"]);
  [site, riddler] = tdb.tables as [AnalyticsTables, AnalyticsTables];
});
afterAll(async () => {
  await tdb?.close();
});

function beacon(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  const text = JSON.stringify(body);
  return new Request("https://adminigloo.com/api/analytics", {
    method: "POST",
    headers: { origin: "https://adminigloo.com", "user-agent": CHROME, "x-forwarded-for": "203.0.113.7", ...headers },
    body: text,
  });
}

const count = async (table: AnalyticsTables["sessions"] | AnalyticsTables["sites"], tenantId: string) =>
  (await tdb.db.select({ n: sql<number>`count(*)::int` }).from(table).where(eq(table.tenantId, tenantId)))[0]?.n ?? 0;

describe("two instances with different prefixes", () => {
  it("write to their own tables and never share caches (salts, tracking start)", async () => {
    const tenantId = tenant("shared-name");
    const a = createAnalytics({ db: tdb.db, tables: site });
    const b = createAnalytics({ db: tdb.db, tables: riddler });
    const config = { tenantId, allowedHosts: ["adminigloo.com"], clientIp: (req: Request) => req.headers.get("x-forwarded-for"), now: () => NOW };

    // Same tenant id, same request, to both.
    await a.createHandler(config).handle(beacon({ t: "pageview", d: "doc_prefix_00001", p: "/" }));
    await b.createHandler(config).handle(beacon({ t: "pageview", d: "doc_prefix_00001", p: "/" }));
    expect(await count(site.sessions, tenantId)).toBe(1);
    expect(await count(riddler.sessions, tenantId)).toBe(1);

    // Salts: each set has its own day salt, so the same visitor has two unrelated keys.
    const input = { tenantId, ip: "203.0.113.7", userAgent: CHROME, at: NOW };
    const keyA = await a.resolveVisitorKeys(input);
    const keyB = await b.resolveVisitorKeys(input);
    expect(keyA.current).not.toBe(keyB.current);
    const [saltA] = await tdb.db.select().from(site.salts);
    const [saltB] = await tdb.db.select().from(riddler.salts);
    expect(saltA?.salt).not.toBe(saltB?.salt);
    const [rowA] = await tdb.db.select().from(site.sessions).where(eq(site.sessions.tenantId, tenantId));
    const [rowB] = await tdb.db.select().from(riddler.sessions).where(eq(riddler.sessions.tenantId, tenantId));
    expect(rowA?.visitorKey).toBe(keyA.current);
    expect(rowB?.visitorKey).toBe(keyB.current);

    // "Tracking started": A knowing the tenant must not stop B stamping its own.
    const crawlerTenant = tenant("crawler");
    await a.recordCrawlerHit({ tenantId: crawlerTenant, userAgent: GPTBOT, path: "/", at: NOW });
    await b.recordCrawlerHit({ tenantId: crawlerTenant, userAgent: GPTBOT, path: "/llms.txt", at: NOW });
    expect(await count(site.sites, crawlerTenant)).toBe(1);
    expect(await count(riddler.sites, crawlerTenant)).toBe(1);

    // And the reports read only their own set.
    const crawlersA = await a.getCrawlers({ tenantId: crawlerTenant, ...RANGE });
    const crawlersB = await b.getCrawlers({ tenantId: crawlerTenant, ...RANGE });
    expect(crawlersA.topPaths.map((row) => row.path)).toEqual(["/"]);
    expect(crawlersB.topPaths.map((row) => row.path)).toEqual(["/llms.txt"]);
    expect((await a.getOverview({ tenantId, ...RANGE })).visits.current).toBe(1);
  });

  it("two instances over the SAME tables keep their caches apart too (a stale cache in one never reaches the other)", async () => {
    const tenantId = tenant("same-tables");
    const a = createAnalytics({ db: tdb.db, tables: site });
    const b = createAnalytics({ db: tdb.db, tables: site });
    await a.recordCrawlerHit({ tenantId, userAgent: GPTBOT, path: "/", at: NOW });
    // A data fix deletes the tenant's tracking-start row; A still believes it wrote it, B has never seen it.
    await tdb.db.delete(site.sites).where(eq(site.sites.tenantId, tenantId));
    await b.recordCrawlerHit({ tenantId, userAgent: GPTBOT, path: "/", at: NOW });
    expect(await count(site.sites, tenantId)).toBe(1);
    // invalidate() drops an instance's caches.
    await tdb.db.delete(site.sites).where(eq(site.sites.tenantId, tenantId));
    a.invalidate();
    await a.recordCrawlerHit({ tenantId, userAgent: GPTBOT, path: "/", at: NOW });
    expect(await count(site.sites, tenantId)).toBe(1);
  });
});

describe("the 0.1 free functions", () => {
  it("still work, over a default instance per db, with the 0.1 tables and no filter", async () => {
    const tenantId = tenant("legacy");
    const handler = createAnalyticsHandler({ db: tdb.db, tenantId, allowedHosts: ["adminigloo.com"], clientIp: (req) => req.headers.get("x-forwarded-for"), now: () => NOW });
    await handler.handle(beacon({ t: "pageview", d: "doc_legacy_00001", p: "/pricing" }));
    expect(await recordConversion(tdb.db, { tenantId, ip: "203.0.113.7", userAgent: CHROME, name: "call_booked", at: NOW })).toBe(true);
    expect(await recordConversion(tdb.db, { tenantId, ip: "198.51.100.1", userAgent: CHROME, name: "call_booked", at: NOW })).toBe(false);
    expect(await recordCrawlerHit(tdb.db, { tenantId, userAgent: GPTBOT, path: "/", at: NOW })).toMatchObject({ name: "GPTBot", kind: "ai-training" });
    const q = { tenantId, ...RANGE };
    const overview = await getOverview(tdb.db, q);
    expect(overview.visits.current).toBe(1);
    expect(overview.conversions.current).toBe(1);
    expect(await getTopPages(tdb.db, q)).toEqual([{ path: "/pricing", views: 1, visits: 1 }]);
    expect((await getCrawlers(tdb.db, q)).aiHits).toBe(1);
    expect((await getPublicSnapshot(tdb.db, { tenantId, days: 1, publicPaths: ["/pricing"], now: NOW })).visits).toBe(1);
    expect((await resolveVisitorKeys(tdb.db, { tenantId, ip: "203.0.113.7", userAgent: CHROME, at: NOW })).current).toMatch(/^[0-9a-f]{32}$/);
    expect(await runAnalyticsMaintenance(tdb.db, { now: NOW })).toMatchObject({ sessionsDeleted: 0 });
    // One default instance per db object.
    expect(defaultAnalyticsFor(tdb.db)).toBe(defaultAnalyticsFor(tdb.db));
    expect(defaultAnalyticsFor(tdb.db).tables).toBe(analyticsTables);
    expect(MAX_SESSIONS_PER_NETWORK_HOUR).toBe(30);
  });
});

describe("limits", () => {
  it("default to 0.1's constants", () => {
    const analytics = createAnalytics({ db: tdb.db });
    expect(analytics.limits).toEqual(DEFAULT_LIMITS);
    expect(DEFAULT_LIMITS).toEqual({
      maxHitsPerNetworkHour: 600,
      maxSessionsPerNetworkHour: 30,
      maxPageViewsPerSession: 500,
      maxDurationDeltaMs: 30 * 60 * 1000,
      maxBodyBytes: 4096,
      maxUtmLength: 100,
      maxLabelLength: 120,
      crawlerBucketMs: 10 * 60 * 1000,
      retentionDays: 395,
    });
  });

  it("are the instance's: a venue Wi-Fi budget, a page-view cap, a body cap, UTM and label lengths", async () => {
    const tenantId = tenant("limits");
    const analytics = createAnalytics({
      db: tdb.db,
      tables: site,
      limits: { maxSessionsPerNetworkHour: 1, maxPageViewsPerSession: 2, maxBodyBytes: 200, maxUtmLength: 5, maxLabelLength: 4 },
    });
    const handler = analytics.createHandler({ tenantId, allowedHosts: ["adminigloo.com"], clientIp: (req) => req.headers.get("x-forwarded-for"), now: () => NOW });
    await handler.handle(beacon({ t: "pageview", d: "doc_limits_00001", p: "/", q: "?utm_campaign=springlaunch" }));
    // A second browser on the same network: over the one-session budget.
    await handler.handle(beacon({ t: "pageview", d: "doc_limits_00002", p: "/" }, { "user-agent": `${CHROME} Edg/141.0` }));
    expect(await count(site.sessions, tenantId)).toBe(1);
    // Page views past the cap are dropped.
    for (const p of ["/a", "/b", "/c"]) await handler.handle(beacon({ t: "pageview", d: "doc_limits_00001", p }));
    const [row] = await tdb.db.select().from(site.sessions).where(eq(site.sessions.tenantId, tenantId));
    expect(row?.pageViewCount).toBe(2);
    expect(row?.utmCampaign).toBe("sprin");
    // A body over the cap is dropped unread.
    await handler.handle(beacon({ t: "event", d: "doc_limits_00001", p: "/", n: "click", l: "x".repeat(300) }));
    await handler.handle(beacon({ t: "event", d: "doc_limits_00001", p: "/", n: "click", l: "Book a call" }));
    const events = await tdb.db.select().from(site.events).where(eq(site.events.tenantId, tenantId));
    expect(events.map((event) => event.label)).toEqual(["Book"]);
  });

  it("refuses a nonsense limit", () => {
    for (const limits of [{ maxBodyBytes: 0 }, { maxBodyBytes: 1.5 }, { retentionDays: -1 }, { notALimit: 3 } as never]) {
      let caught: unknown;
      try {
        createAnalytics({ db: tdb.db, limits });
      } catch (error) {
        caught = error;
      }
      expect(isAnalyticsError(caught)).toBe(true);
    }
  });

  it("retention comes from the instance's limits", async () => {
    const tenantId = tenant("retention");
    const analytics = createAnalytics({ db: tdb.db, tables: site, limits: { retentionDays: 1 } });
    const old = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);
    const handler = analytics.createHandler({ tenantId, allowedHosts: ["adminigloo.com"], clientIp: (req) => req.headers.get("x-forwarded-for"), now: () => old });
    await handler.handle(beacon({ t: "pageview", d: "doc_retention_001", p: "/" }));
    expect(await count(site.sessions, tenantId)).toBe(1);
    await analytics.runMaintenance({ now: NOW });
    expect(await count(site.sessions, tenantId)).toBe(0);
  });
});

describe("the crawler half alone (Riddler Go's install)", () => {
  it("runs on just aig_analytics_crawler_hits and aig_analytics_sites", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { tableDdl } = await import("./pglite.js");
    const { defineAnalyticsTables } = await import("../schema.js");
    const tables = defineAnalyticsTables({ prefix: "aig_analytics_" });
    const client = new PGlite();
    try {
      for (const statement of tableDdl([tables.crawlerHits, tables.sites])) await client.exec(statement);
      const analytics = createAnalytics({ db: drizzle(client) as never, tables });
      const tenantId = "riddler-go";
      expect(await analytics.recordCrawlerHit({ tenantId, userAgent: GPTBOT, path: "/events/abc", at: NOW })).toMatchObject({ name: "GPTBot" });
      await analytics.recordCrawlerHit({ tenantId, userAgent: "adminigloo-seo-reports/0.1", path: "/", at: NOW });
      const crawlers = await analytics.getCrawlers({ tenantId, ...RANGE });
      expect(crawlers.bots.map((bot) => bot.botName)).toEqual(["GPTBot"]);
      expect(await analytics.getRecentAiReads({ tenantId, since: RANGE.from })).toHaveLength(1);
      expect((await analytics.getAiCoverage({ tenantId, paths: ["/events/abc", "/"], since: RANGE.from })).byBot).toEqual([
        { botName: "GPTBot", kind: "ai-training", pages: 1 },
      ]);
      expect((await analytics.getTrackingSince(tenantId))?.toISOString()).toBe(NOW.toISOString());
      // The README's list: these read the session tables, which this install never made.
      const q = { tenantId, ...RANGE };
      for (const [name, read] of [
        ["getDailyTrend", () => analytics.getDailyTrend(q)],
        ["getPublicSnapshot", () => analytics.getPublicSnapshot({ tenantId, days: 1, publicPaths: ["/"], now: NOW })],
        ["getPipelineHealth", () => analytics.getPipelineHealth(tenantId)],
        ["getAiAssistantTraffic", () => analytics.getAiAssistantTraffic(q)],
        ["getOverview", () => analytics.getOverview(q)],
      ] as const) {
        expect([name, await read().then(() => "ran", () => "threw")]).toEqual([name, "threw"]);
      }
      const old = new Date(NOW.getTime() - 400 * 24 * 60 * 60 * 1000);
      await analytics.recordCrawlerHit({ tenantId, userAgent: GPTBOT, path: "/old", at: old });
      expect(await analytics.runMaintenance({ now: NOW, crawlersOnly: true })).toEqual({ saltsDeleted: 0, rateRowsDeleted: 0, sessionsDeleted: 0, crawlerRowsDeleted: 1 });
      // Without the flag it would reach for tables this install never made.
      await expect(analytics.runMaintenance({ now: NOW })).rejects.toThrow();
      // Crawler rows are kept as long as limits.retentionDays says: an install that keeps them for good sets it high.
      const keeper = createAnalytics({ db: drizzle(client) as never, tables, limits: { retentionDays: 36500 } });
      await keeper.recordCrawlerHit({ tenantId, userAgent: GPTBOT, path: "/old", at: old });
      expect((await keeper.runMaintenance({ now: NOW, crawlersOnly: true })).crawlerRowsDeleted).toBe(0);
    } finally {
      await client.close();
    }
  });
});
