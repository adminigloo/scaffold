import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addAnnotation,
  classifyCrawler as classifyFromRoot,
  createAnalyticsHandler,
  createCrawlerVerifier,
  deleteAnnotation,
  getActivity,
  getBreakdown,
  getCampaigns,
  getCrawlers,
  getDailyTrend,
  getEngagementBySource,
  getEventVisits,
  getLandingPages,
  getOverview,
  getPipelineHealth,
  getPublicSnapshot,
  getReferrers,
  getSources,
  getTopClicks,
  getTopPages,
  getWebVitals,
  lastDays,
  listAnnotations,
  recordConversion,
  recordCrawlerHit,
  runAnalyticsMaintenance,
  type AnalyticsDb,
  type AnalyticsHandler,
  type ContentType,
  type PathPattern,
  type PublicSnapshot,
  type ReportQuery,
} from "../index.js";
import { classifyCrawler } from "../crawlers.js";
import { analyticsCrawlerHits, analyticsEvents, analyticsPageViews, analyticsSessions } from "../schema.js";
import { createTestDb, type TestDb } from "./pglite.js";

/**
 * The founder's site upgrades from the 0.1 vendor tarball WITHOUT a code
 * change: every 0.1 call it makes — the beacon route, the server-side
 * conversion, the crawler log in proxy.ts, the cron's maintenance, the
 * /admin/analytics tRPC procedure (seventeen reports in one Promise.all) and
 * the homepage window — written here in the same shapes, against the 0.1
 * table exports. If this file stops compiling or passing, the site breaks.
 */

const ANALYTICS_TENANT = "site";
const ANALYTICS_TIME_ZONE = "America/Denver";
const ANALYTICS_PATH_PATTERNS: readonly PathPattern[] = [{ pattern: /^\/invoice\/[^/]+/, replace: "/invoice/:token" }];
const CONTENT_TYPES: readonly ContentType[] = [{ type: "feature", pattern: /^\/features\/([^/]+)/ }];
const PUBLIC_FUNNEL = ["demo_open", "call_booked"] as const;
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const NOW = new Date();

let tdb: TestDb;
let db: AnalyticsDb;
beforeAll(async () => {
  tdb = await createTestDb();
  db = tdb.db;
});
afterAll(async () => {
  await tdb?.close();
});

describe("the founder's site, on 0.2, unchanged", () => {
  it("site-analytics.ts, crawler-log.ts, the cron and the admin router all run", async () => {
    // src/server/site-analytics.ts
    const handler: AnalyticsHandler = createAnalyticsHandler({
      db,
      tenantId: ANALYTICS_TENANT,
      allowedHosts: ["adminigloo.com", "localhost:3000"],
      clientIp: (req) => req.headers.get("x-real-ip"),
      resolveCountry: (req) => req.headers.get("x-vercel-ip-country"),
      timeZone: ANALYTICS_TIME_ZONE,
      pathPatterns: ANALYTICS_PATH_PATTERNS,
      contentTypes: CONTENT_TYPES,
      conversionEvents: [],
    });
    const response = await handler.handle(
      new Request("https://adminigloo.com/api/analytics", {
        method: "POST",
        headers: { origin: "https://adminigloo.com", "user-agent": CHROME, "x-real-ip": "203.0.113.7", "x-vercel-ip-country": "US" },
        body: JSON.stringify({ t: "pageview", d: "doc_site_compat_01", p: "/features/feedback", r: "https://chatgpt.com/", q: "?utm_source=chatgpt.com" }),
      }),
    );
    expect(response.status).toBe(204);
    const converted: boolean = await recordConversion(db, {
      tenantId: ANALYTICS_TENANT,
      ip: "203.0.113.7",
      userAgent: CHROME,
      name: "call_booked",
      path: undefined,
      timeZone: ANALYTICS_TIME_ZONE,
    });
    expect(converted).toBe(true);

    // src/server/crawler-log.ts (and proxy.ts's classifier entry)
    const verifier = createCrawlerVerifier({ fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch });
    const gptbot = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot";
    expect(classifyCrawler(gptbot)).toEqual(classifyFromRoot(gptbot));
    await recordCrawlerHit(db, { tenantId: ANALYTICS_TENANT, userAgent: gptbot, path: "/pricing", ip: "20.171.206.17", country: "US", verifier, pathPatterns: ANALYTICS_PATH_PATTERNS });

    // app/api/cron/analytics/route.ts
    const maintenance = await runAnalyticsMaintenance(db, { timeZone: ANALYTICS_TIME_ZONE });
    expect(maintenance).toEqual({ saltsDeleted: 0, rateRowsDeleted: 0, sessionsDeleted: 0, crawlerRowsDeleted: 0 });

    // src/server/routers/analytics.ts — the report procedure
    const query: ReportQuery = { tenantId: ANALYTICS_TENANT, ...lastDays(30, new Date(), ANALYTICS_TIME_ZONE), timeZone: ANALYTICS_TIME_ZONE };
    const [overview, trend, sources, referrers, campaigns, engagement, landing, pages, clicks, funnel, vitals, crawlers, activity, countries, devices, browsers, health] =
      await Promise.all([
        getOverview(db, query),
        getDailyTrend(db, query),
        getSources(db, query),
        getReferrers(db, query, 25),
        getCampaigns(db, query, 25),
        getEngagementBySource(db, query),
        getLandingPages(db, query, 25),
        getTopPages(db, query, 50),
        getTopClicks(db, query, 50),
        getEventVisits(db, query, [...PUBLIC_FUNNEL, "book_call"]),
        getWebVitals(db, query, 10),
        getCrawlers(db, query, 50),
        getActivity(db, query),
        getBreakdown(db, query, "country", 15),
        getBreakdown(db, query, "device", 5),
        getBreakdown(db, query, "browser", 8),
        getPipelineHealth(db, ANALYTICS_TENANT),
      ]);
    expect(overview.visits.current).toBe(1);
    expect(overview.conversions.current).toBe(1);
    expect(trend.length).toBe(30);
    expect(sources.find((row) => row.source === "aiAssistant")?.visits).toBe(1);
    expect(referrers).toEqual([{ host: "chatgpt.com", source: "aiAssistant", visits: 1 }]);
    expect(campaigns).toEqual([]);
    expect(engagement[0]?.source).toBe("aiAssistant");
    expect(landing[0]?.path).toBe("/features/feedback");
    expect(pages).toEqual([{ path: "/features/feedback", views: 1, visits: 1 }]);
    expect(clicks).toEqual([{ name: "conversion", label: "call_booked", clicks: 1, visits: 1 }]);
    expect(funnel).toEqual({ demo_open: 0, call_booked: 1, book_call: 0 });
    expect(vitals.summary).toHaveLength(3);
    expect(crawlers.aiHits).toBe(1);
    expect(activity.byHour.reduce((a, b) => a + b, 0)).toBe(1);
    expect(countries).toEqual([{ value: "US", visits: 1 }]);
    expect(devices).toEqual([{ value: "desktop", visits: 1 }]);
    expect(browsers).toEqual([{ value: "Chrome", visits: 1 }]);
    expect(health.lastPageView).not.toBeNull();

    const first = trend[0]?.date ?? "";
    const last = trend[trend.length - 1]?.date ?? "";
    const added = await addAnnotation(db, { tenantId: ANALYTICS_TENANT, day: last, label: "0.2 upgrade", createdBy: "u_founder" });
    expect(await listAnnotations(db, { tenantId: ANALYTICS_TENANT, fromDay: first, toDay: last })).toEqual([added]);
    await deleteAnnotation(db, { tenantId: ANALYTICS_TENANT, id: added.id });

    // The homepage window (getPublicAnalytics → readPublicAnalytics)
    const snapshot: PublicSnapshot = await getPublicSnapshot(db, {
      tenantId: ANALYTICS_TENANT,
      days: 30,
      publicPaths: ["/", "/features/feedback", "/pricing"],
      funnel: PUBLIC_FUNNEL,
      timeZone: ANALYTICS_TIME_ZONE,
    });
    expect(snapshot.visits).toBe(1);
    expect(snapshot.ai.hits).toBe(1);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);

    // The site's integration test reads the 0.1 table exports directly.
    for (const table of [analyticsSessions, analyticsPageViews, analyticsEvents, analyticsCrawlerHits]) {
      expect((await db.select().from(table)).length).toBeGreaterThan(0);
    }
  });
});
