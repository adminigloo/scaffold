import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createAudience, createDrizzleAudienceStore, type AudienceUser } from "@adminigloo/audience";
import { createAnalytics, type Analytics } from "../instance.js";
import { audienceSessionsSource, isAnalyticsError } from "../context.js";
import type { AnalyticsSessionContext } from "../ingest.js";
import { getOverview as legacyGetOverview } from "../legacy.js";
import type { ReportQuery } from "../reports.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";
import { analyticsTables, type AnalyticsTables } from "../schema.js";

/**
 * Rachel's requirement, end to end on real Postgres: a staff member browsing
 * the site is recorded like anyone else, the app's `onSession` hook hands the
 * visit to `audience.observe`, and from then on EVERY report leaves that
 * visit out — unless one call asks for `includeInternal` — while the public
 * snapshot leaves it out always. With no audience, the numbers are 0.1's.
 *
 * Every visit here goes through the real beacon handler, so the session id
 * and visitor key the audience marks are the ones the ingest really wrote.
 */

const SECRET = "test-secret-0123456789-abcdefghijklmnopqrstuvwxyz";
const NOW = new Date("2026-10-08T12:00:00Z");
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const CUSTOMER_IP = "203.0.113.7";
const STAFF_IP = "198.51.100.9";
const RANGE = { from: new Date("2026-10-08T00:00:00Z"), to: new Date("2026-10-09T00:00:00Z") };

interface User extends AudienceUser {
  role: "staff" | "customer";
}
const USERS: User[] = [
  { id: "u_staff", email: "sam@adminigloo.com", role: "staff" },
  { id: "u_cust", email: "pat@gmail.com", role: "customer" },
];

let tdb: TestDb & { tables: unknown[] };
beforeAll(async () => {
  tdb = await createTestDb();
});
afterAll(async () => {
  await tdb?.close();
});

function beacon(body: Record<string, unknown>, ip: string, headers: Record<string, string> = {}): Request {
  return new Request("https://adminigloo.com/api/analytics", {
    method: "POST",
    headers: { origin: "https://adminigloo.com", "user-agent": CHROME, "x-forwarded-for": ip, ...headers },
    body: JSON.stringify(body),
  });
}

/** One instance with an audience, one without, over the same rows; and a visit helper through the real handler. */
function setup(options: { visitorIds?: "stable" | "rotating"; db?: TestDb["db"]; tables?: AnalyticsTables } = {}) {
  const db = options.db ?? tdb.db;
  const tenantId = tenant("site");
  const errors: unknown[] = [];
  const visits: AnalyticsSessionContext[] = [];
  const audience = createAudience<User>({
    store: createDrizzleAudienceStore({ db }),
    secret: SECRET,
    tenantId,
    isInternal: (user) => (user.role === "staff" ? "staff" : false),
    getUser: async (id) => USERS.find((user) => user.id === id) ?? null,
    sessions: audienceSessionsSource({ tenantId, ...(options.tables ? { tables: options.tables } : {}) }),
    ...(options.visitorIds ? { visitorIds: options.visitorIds } : {}),
    now: () => NOW,
    onError: (error) => errors.push(error),
  });
  const tables = options.tables ? { tables: options.tables } : {};
  const analytics = createAnalytics({ db, ...tables, audience, onError: (error) => errors.push(error) });
  const unfiltered = createAnalytics({ db, ...tables, onError: (error) => errors.push(error) });
  let clock = new Date(NOW.getTime() - 60 * 60 * 1000);
  const handler = analytics.createHandler({
    tenantId,
    allowedHosts: ["adminigloo.com"],
    clientIp: (req) => req.headers.get("x-forwarded-for"),
    resolveCountry: () => "US",
    now: () => clock,
    onSession: async (visit) => {
      visits.push(visit);
      return audience.observe({
        visitorId: visit.visitorId,
        sessionId: visit.sessionId,
        userId: visit.req.headers.get("x-test-user"),
        host: visit.host,
        userAgent: visit.userAgent,
        headers: visit.headers,
        ip: visit.ip,
      });
    },
  });

  /** A whole visit: landing from ChatGPT on a campaign link, a second page, a click, a vital, a server-side conversion. */
  async function visit(ip: string, doc: string, headers: Record<string, string> = {}, startAt = new Date(NOW.getTime() - 60 * 60 * 1000)) {
    const at = (minutes: number) => {
      clock = new Date(startAt.getTime() + minutes * 60 * 1000);
    };
    at(0);
    await handler.handle(beacon({ t: "pageview", d: doc, p: "/", r: "https://chatgpt.com/", q: "?utm_campaign=launch" }, ip, headers));
    at(1);
    await handler.handle(beacon({ t: "pageview", d: doc, p: "/pricing", ms: 4000 }, ip, headers));
    at(2);
    await handler.handle(beacon({ t: "event", d: doc, p: "/pricing", n: "book_call", l: "Book a call" }, ip, headers));
    await handler.handle(beacon({ t: "event", d: doc, p: "/pricing", n: "web_vital", l: "LCP", v: 1800, i: `v5-${doc}` }, ip, headers));
    const ua = headers["user-agent"] ?? CHROME;
    await analytics.recordConversion({ tenantId, ip, userAgent: ua, name: "call_booked", at: clock });
  }

  return { tenantId, audience, analytics, unfiltered, handler, visit, visits, errors };
}

const sum = (values: Array<number | null | undefined>) => values.reduce<number>((total, value) => total + (value ?? 0), 0);

/**
 * Every report that reads visitor rows, reduced to numbers — several per
 * report where it has several reads or several measures (`name:part`). Each
 * visit contributes the same amount to each, so with one customer and one
 * staff member a measure must show exactly half its includeInternal number.
 * (Every statement every report sends is also checked at the SQL level, in
 * sql-guard.integration.test.ts.)
 */
const SESSION_REPORTS: Record<string, (a: Analytics, q: ReportQuery) => Promise<number>> = {
  getOverview: async (a, q) => (await a.getOverview(q)).visits.current,
  "getOverview:dailyVisitors": async (a, q) => (await a.getOverview(q)).dailyVisitors.current,
  "getOverview:pageViews": async (a, q) => (await a.getOverview(q)).pageViews.current,
  "getOverview:engagedVisits": async (a, q) => (await a.getOverview(q)).engagedVisits.current,
  "getOverview:conversions": async (a, q) => (await a.getOverview(q)).conversions.current,
  getDailyTrend: async (a, q) => sum((await a.getDailyTrend(q)).map((point) => point.visits)),
  "getDailyTrend:pageViews": async (a, q) => sum((await a.getDailyTrend(q)).map((point) => point.pageViews)),
  getSources: async (a, q) => sum((await a.getSources(q)).map((row) => row.visits)),
  getReferrers: async (a, q) => sum((await a.getReferrers(q)).map((row) => row.visits)),
  getCampaigns: async (a, q) => sum((await a.getCampaigns(q)).map((row) => row.visits)),
  "getCampaigns:conversions": async (a, q) => sum((await a.getCampaigns(q)).map((row) => row.conversions)),
  getBreakdown: async (a, q) => sum((await a.getBreakdown(q, "country")).map((row) => row.visits)),
  "getBreakdown:browser": async (a, q) => sum((await a.getBreakdown(q, "browser")).map((row) => row.visits)),
  getEngagementBySource: async (a, q) => sum((await a.getEngagementBySource(q)).map((row) => row.visits)),
  getActivity: async (a, q) => sum((await a.getActivity(q)).byHour),
  getTopPages: async (a, q) => sum((await a.getTopPages(q)).map((row) => row.views)),
  "getTopPages:visits": async (a, q) => sum((await a.getTopPages(q)).map((row) => row.visits)),
  "getTopPages:onlyPaths": async (a, q) => sum((await a.getTopPages(q, 20, ["/pricing"])).map((row) => row.views)),
  getLandingPages: async (a, q) => sum((await a.getLandingPages(q)).map((row) => row.visits)),
  "getLandingPages:conversions": async (a, q) => sum((await a.getLandingPages(q)).map((row) => row.conversions)),
  getTopClicks: async (a, q) => sum((await a.getTopClicks(q)).map((row) => row.clicks)),
  "getTopClicks:visits": async (a, q) => sum((await a.getTopClicks(q)).map((row) => row.visits)),
  getEventVisits: async (a, q) => sum(Object.values(await a.getEventVisits(q, ["book_call", "call_booked"]))),
  getWebVitals: async (a, q) => (await a.getWebVitals(q)).summary.find((entry) => entry.metric === "LCP")?.samples ?? 0,
  "getWebVitals:byEntryPage": async (a, q) =>
    sum((await a.getWebVitals(q)).byEntryPage.flatMap((page) => page.metrics.filter((m) => m.metric === "LCP").map((m) => m.samples))),
  getAiAssistantTraffic: async (a, q) => (await a.getAiAssistantTraffic(q)).visits,
  "getAiAssistantTraffic:conversions": async (a, q) => sum((await a.getAiAssistantTraffic(q)).engines.map((row) => row.conversions)),
  "getAiAssistantTraffic:pages": async (a, q) => sum((await a.getAiAssistantTraffic(q)).pages.map((row) => row.visits)),
};

/** Reads that are not over visitor rows, each with why — so a NEW report has to be put in one list or the other. */
const NOT_VISITOR_READS: Record<string, string> = {
  getTrackingSince: "when tracking began: a date, not a count of anyone",
  getPipelineHealth: "liveness: a staff page view proves the pipeline works (unfiltered on purpose)",
  getExcludedBreakdown: "it IS the exclusion — the count of what the others leave out",
  getCrawlers: "crawler rows; the SEO-audit exclusion is tested below",
  getRecentAiReads: "crawler rows; tested below",
  getAiCoverage: "crawler rows; tested below",
  getPublicSnapshot: "always excludes — tested below",
};

describe("every report leaves the internal audience out by default", () => {
  let ctx: ReturnType<typeof setup>;
  let q: ReportQuery;
  beforeAll(async () => {
    ctx = setup();
    q = { tenantId: ctx.tenantId, ...RANGE };
    await ctx.visit(CUSTOMER_IP, "doc_customer_0001", { "x-test-user": "u_cust" });
    await ctx.visit(STAFF_IP, "doc_staff_000001", { "x-test-user": "u_staff" });
  });

  it("the hook got the real session id and visitor key, the IP in memory — and recorded the verdict, not the IP", async () => {
    expect(ctx.errors).toEqual([]);
    const sessions = await tdb.db.select().from(analyticsTables.sessions).where(eq(analyticsTables.sessions.tenantId, ctx.tenantId));
    expect(sessions).toHaveLength(2);
    const staffVisit = ctx.visits.find((visit) => visit.ip === STAFF_IP)!;
    const staffRow = sessions.find((row) => row.id === staffVisit.sessionId)!;
    expect(staffRow.visitorKey).toBe(staffVisit.visitorId);
    expect(staffVisit.host).toBe("adminigloo.com");
    expect(ctx.visits.filter((visit) => visit.sessionId === staffVisit.sessionId).map((visit) => visit.isNewSession)).toEqual([true, false]);
    expect(staffRow.internalReason).toBe("role");
    expect(sessions.find((row) => row.id !== staffVisit.sessionId)!.internalReason).toBeNull();
    for (const row of sessions) {
      expect(row.actorKey).toBeNull();
      expect(row.classifierVersion).toBe(2);
      expect(JSON.stringify(row)).not.toContain(STAFF_IP);
      expect(JSON.stringify(row)).not.toContain(CUSTOMER_IP);
    }
    // The audience marked the staff device (and the user), never the customer's.
    const marks = await tdb.client.query<{ subject_kind: string; subject_id: string; reason: string }>(
      "SELECT subject_kind, subject_id, reason FROM aig_audience_marks WHERE tenant_id = $1 ORDER BY subject_kind",
      [ctx.tenantId],
    );
    expect(marks.rows.map((m) => [m.subject_kind, m.subject_id, m.reason])).toEqual([
      ["user", "u_staff", "role"],
      ["visitor", staffVisit.visitorId, "role"],
    ]);
  });

  it.each(Object.keys(SESSION_REPORTS))("%s: one visit by default, both with includeInternal, both without an audience", async (name) => {
    const measure = SESSION_REPORTS[name]!;
    const counted = await measure(ctx.analytics, q);
    const everyone = await measure(ctx.analytics, { ...q, includeInternal: true });
    const noAudience = await measure(ctx.unfiltered, q);
    expect(counted).toBeGreaterThan(0);
    expect(everyone).toBe(counted * 2);
    expect(noAudience).toBe(everyone);
  });

  it("covers every report on the instance (a new one must be added to a list)", () => {
    const reports = Object.keys(ctx.analytics).filter((key) => key.startsWith("get"));
    const measured = new Set(Object.keys(SESSION_REPORTS).map((key) => key.split(":")[0]));
    const unlisted = reports.filter((key) => !measured.has(key) && !(key in NOT_VISITOR_READS));
    expect(unlisted).toEqual([]);
    for (const reason of Object.values(NOT_VISITOR_READS)) expect(reason.length).toBeGreaterThan(10);
  });

  it("includeInternal is per call: the next call excludes again", async () => {
    expect((await ctx.analytics.getOverview({ ...q, includeInternal: true })).visits.current).toBe(2);
    expect((await ctx.analytics.getOverview(q)).visits.current).toBe(1);
  });

  it("the excluded line is exactly the difference, by reason; null without an audience", async () => {
    const excluded = await ctx.analytics.getExcludedBreakdown({ tenantId: ctx.tenantId, ...RANGE });
    expect(excluded).toEqual({ total: 1, byReason: { role: 1 }, unit: "sessions" });
    const everyone = (await ctx.analytics.getOverview({ ...q, includeInternal: true })).visits.current;
    const counted = (await ctx.analytics.getOverview(q)).visits.current;
    expect(everyone - counted).toBe(excluded!.total);
    expect(await ctx.unfiltered.getExcludedBreakdown({ tenantId: ctx.tenantId, ...RANGE })).toBeNull();
  });

  it("the AI traffic report attributes the counted visit to ChatGPT", async () => {
    const traffic = await ctx.analytics.getAiAssistantTraffic(q);
    expect(traffic.engines).toHaveLength(1);
    expect(traffic.engines[0]).toMatchObject({ engine: "chatgpt", label: "ChatGPT", visits: 1, conversions: 1, landingPages: [{ path: "/", visits: 1 }] });
    expect(traffic.pages).toEqual([{ path: "/", visits: 1, byEngine: { chatgpt: 1 }, assistantFetches: 0, assistantFetchesVerified: 0, fetchesByBot: [] }]);
  });

  it("the 0.1 free functions never see the instance's audience: same db, staff counted (documented)", async () => {
    expect((await ctx.analytics.getOverview(q)).visits.current).toBe(1);
    expect((await legacyGetOverview(tdb.db, q)).visits.current).toBe(2);
  });

  it("the public snapshot ALWAYS leaves them out — even when a caller smuggles includeInternal in", async () => {
    const input = { tenantId: ctx.tenantId, days: 1, publicPaths: ["/", "/pricing"], funnel: ["book_call", "call_booked"], now: NOW };
    const snapshot = await ctx.analytics.getPublicSnapshot(input);
    const smuggled = await ctx.analytics.getPublicSnapshot({ ...input, includeInternal: true } as typeof input);
    for (const view of [snapshot, smuggled]) {
      expect(view.visits).toBe(1);
      expect(view.pageViews).toBe(2);
      expect(sum(view.trend.map((point) => point.visits))).toBe(1);
      expect(sum(view.sources.map((row) => row.visits))).toBe(1);
      expect(sum(view.topPages.map((row) => row.views))).toBe(2);
      expect(view.funnel).toEqual({ book_call: 1, call_booked: 1 });
      expect(view.webVitals.find((entry) => entry.metric === "LCP")?.samples).toBe(1);
    }
    // 0.1's numbers without an audience.
    expect((await ctx.unfiltered.getPublicSnapshot(input)).visits).toBe(2);
  });

  it("restoring the person counts their history again, exactly", async () => {
    const staffVisit = ctx.visits.find((visit) => visit.ip === STAFF_IP)!;
    await ctx.audience.unmark({ subjectKind: "user", subjectId: "u_staff", by: "test", sources: "all" });
    await ctx.audience.unmark({ subjectKind: "visitor", subjectId: staffVisit.visitorId, by: "test", sources: "all" });
    for (const [name, measure] of Object.entries(SESSION_REPORTS)) {
      expect([name, await measure(ctx.analytics, q)]).toEqual([name, await measure(ctx.analytics, { ...q, includeInternal: true })]);
    }
    expect((await ctx.analytics.getPublicSnapshot({ tenantId: ctx.tenantId, days: 1, publicPaths: ["/"], now: NOW })).visits).toBe(2);
    // The session still records why it was once left out: a record, never a filter.
    const [row] = await tdb.db.select().from(analyticsTables.sessions).where(eq(analyticsTables.sessions.id, staffVisit.sessionId));
    expect(row?.internalReason).toBe("role");
  });
});

describe("a visit-only reason marks the session, not the device", () => {
  it("an uptime monitor's visit is left out; the same device's next visit is not", async () => {
    const ctx = setup();
    const q = { tenantId: ctx.tenantId, ...RANGE };
    // UptimeRobot is not a crawler to analytics (it runs the page), but it is automation to the audience.
    await ctx.visit(CUSTOMER_IP, "doc_monitor_00001", { "user-agent": "Mozilla/5.0 (compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)" });
    await ctx.visit(CUSTOMER_IP, "doc_person_000001");
    expect(ctx.errors).toEqual([]);
    const monitor = ctx.visits.find((visit) => visit.userAgent.includes("UptimeRobot"))!;
    const marks = await tdb.client.query<{ subject_kind: string; subject_id: string; reason: string }>(
      "SELECT subject_kind, subject_id, reason FROM aig_audience_marks WHERE tenant_id = $1",
      [ctx.tenantId],
    );
    expect(marks.rows.map((m) => [m.subject_kind, m.subject_id, m.reason])).toEqual([["session", monitor.sessionId, "automation"]]);
    for (const measure of Object.values(SESSION_REPORTS)) {
      const counted = await measure(ctx.analytics, q);
      expect(counted).toBeGreaterThan(0);
      expect(await measure(ctx.analytics, { ...q, includeInternal: true })).toBe(counted * 2);
    }
    expect(await ctx.analytics.getExcludedBreakdown(q)).toEqual({ total: 1, byReason: { automation: 1 }, unit: "sessions" });
  });
});

describe("a rule's \"only from\" date is read against the session's start", () => {
  it("a device rule from after the visit keeps it counted; from before, leaves it out — matching the excluded line", async () => {
    const ctx = setup();
    const q = { tenantId: ctx.tenantId, ...RANGE };
    await ctx.visit(CUSTOMER_IP, "doc_dated_000001"); // the visit starts at NOW - 1h
    await ctx.visit(STAFF_IP, "doc_dated_000002");
    const device = ctx.visits.find((visit) => visit.ip === STAFF_IP)!.visitorId;

    const later = await ctx.audience.addRule({ kind: "visitor", value: device, appliesFrom: new Date(NOW.getTime() - 30 * 60 * 1000) }, { by: "test" });
    for (const measure of Object.values(SESSION_REPORTS)) {
      expect(await measure(ctx.analytics, q)).toBe(await measure(ctx.analytics, { ...q, includeInternal: true }));
    }
    expect(await ctx.analytics.getExcludedBreakdown(q)).toEqual({ total: 0, byReason: {}, unit: "sessions" });

    await ctx.audience.remove(later.rule.id, { by: "test" });
    await ctx.audience.addRule({ kind: "visitor", value: device, appliesFrom: new Date(NOW.getTime() - 2 * 60 * 60 * 1000) }, { by: "test" });
    for (const measure of Object.values(SESSION_REPORTS)) {
      expect(await measure(ctx.analytics, { ...q, includeInternal: true })).toBe((await measure(ctx.analytics, q)) * 2);
    }
    expect(await ctx.analytics.getExcludedBreakdown(q)).toEqual({ total: 1, byReason: { device: 1 }, unit: "sessions" });
  });
});

describe("the site's own SEO audit", () => {
  const AUDIT = "adminigloo-seo-reports/0.1";
  const GPTBOT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot";
  const CHATGPT_USER = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";

  it("is never a human visit: its beacon and its conversion record nothing", async () => {
    const ctx = setup();
    const response = await ctx.handler.handle(beacon({ t: "pageview", d: "doc_audit_000001", p: "/" }, CUSTOMER_IP, { "user-agent": AUDIT }));
    expect(response.status).toBe(204);
    expect(await ctx.analytics.recordConversion({ tenantId: ctx.tenantId, ip: CUSTOMER_IP, userAgent: AUDIT, name: "x" })).toBeNull();
    const rows = await tdb.db.select().from(analyticsTables.sessions).where(eq(analyticsTables.sessions.tenantId, ctx.tenantId));
    expect(rows).toEqual([]);
    expect(ctx.visits).toEqual([]);
  });

  it("is recorded as a crawler but left out of the crawler reports unless includeInternal", async () => {
    const ctx = setup();
    const at = new Date(NOW.getTime() - 30 * 60 * 1000);
    for (const path of ["/", "/pricing", "/features"]) await ctx.analytics.recordCrawlerHit({ tenantId: ctx.tenantId, userAgent: AUDIT, path, at });
    await ctx.analytics.recordCrawlerHit({ tenantId: ctx.tenantId, userAgent: GPTBOT, path: "/pricing", at });
    await ctx.analytics.recordCrawlerHit({ tenantId: ctx.tenantId, userAgent: CHATGPT_USER, path: "/", at });
    const q = { tenantId: ctx.tenantId, ...RANGE };

    const counted = await ctx.analytics.getCrawlers(q);
    expect(counted.bots.map((bot) => bot.botName).sort()).toEqual(["ChatGPT-User", "GPTBot"]);
    expect(counted.byKind["seo-tool"]).toBe(0);
    expect(counted.topPaths.map((row) => row.path).sort()).toEqual(["/", "/pricing"]);

    const everyone = await ctx.analytics.getCrawlers({ ...q, includeInternal: true });
    expect(everyone.bots.map((bot) => bot.botName).sort()).toEqual(["AdminIgloo audit", "ChatGPT-User", "GPTBot"]);
    expect(everyone.byKind["seo-tool"]).toBe(3);
    // AI numbers were never touched by it.
    expect(everyone.aiHits).toBe(counted.aiHits);

    // The public window never shows it.
    const snapshot = await ctx.analytics.getPublicSnapshot({ tenantId: ctx.tenantId, days: 1, publicPaths: ["/", "/pricing", "/features"], now: NOW });
    expect(snapshot.ai.hits).toBe(2);

    // The instance's list is configurable, and applies to the AI reads too.
    const strict = createAnalytics({ db: tdb.db, excludeBots: ["GPTBot"] });
    const reads = await strict.getRecentAiReads({ tenantId: ctx.tenantId, since: RANGE.from });
    expect(reads.map((read) => read.botName)).toEqual(["ChatGPT-User"]);
    expect((await strict.getRecentAiReads({ tenantId: ctx.tenantId, since: RANGE.from, includeInternal: true })).map((read) => read.botName).sort()).toEqual([
      "ChatGPT-User",
      "GPTBot",
    ]);
    const coverage = await strict.getAiCoverage({ tenantId: ctx.tenantId, paths: ["/", "/pricing"], since: RANGE.from });
    expect(coverage.byBot.map((bot) => bot.botName)).toEqual(["ChatGPT-User"]);
    const open = createAnalytics({ db: tdb.db, excludeBots: [] });
    expect((await open.getCrawlers(q)).bots).toHaveLength(3);
  });

  it("pairs an engine's live fetches with the visits it sent — claimed and verified apart", async () => {
    const ctx = setup();
    const at = new Date(NOW.getTime() - 30 * 60 * 1000);
    // One fetch from inside OpenAI's published ranges; two that only CLAIM to be ChatGPT-User.
    const verifier = { verify: async (_bot: string, ip: string | null | undefined) => ip === "23.98.142.177" };
    await ctx.analytics.recordCrawlerHit({ tenantId: ctx.tenantId, userAgent: CHATGPT_USER, path: "/", ip: "23.98.142.177", verifier, at });
    for (let i = 0; i < 2; i++) await ctx.analytics.recordCrawlerHit({ tenantId: ctx.tenantId, userAgent: CHATGPT_USER, path: "/", ip: "198.51.100.66", verifier, at });
    await ctx.visit(CUSTOMER_IP, "doc_customer_0002");
    const traffic = await ctx.analytics.getAiAssistantTraffic({ tenantId: ctx.tenantId, ...RANGE });
    expect(traffic.engines[0]).toMatchObject({ engine: "chatgpt", visits: 1, assistantFetches: 3, assistantFetchesVerified: 1 });
    expect(traffic.pages[0]).toEqual({
      path: "/",
      visits: 1,
      byEngine: { chatgpt: 1 },
      assistantFetches: 3,
      assistantFetchesVerified: 1,
      fetchesByBot: [{ botName: "ChatGPT-User", hits: 3, verifiedHits: 1 }],
    });
  });
});

describe("the onSession hook", () => {
  it("can never fail a beacon: a throwing hook still records the visit and answers 204", async () => {
    const tenantId = tenant("hook");
    const errors: Array<[unknown, string]> = [];
    const analytics = createAnalytics({ db: tdb.db, onError: (error, where) => errors.push([error, where]) });
    const handler = analytics.createHandler({
      tenantId,
      allowedHosts: ["adminigloo.com"],
      clientIp: (req) => req.headers.get("x-forwarded-for"),
      now: () => NOW,
      onSession: () => {
        throw new Error("auth is down");
      },
    });
    const response = await handler.handle(beacon({ t: "pageview", d: "doc_hook_0000001", p: "/" }, CUSTOMER_IP));
    expect(response.status).toBe(204);
    expect(errors.map(([, where]) => where)).toEqual(["onSession"]);
    const rows = await tdb.db.select().from(analyticsTables.sessions).where(eq(analyticsTables.sessions.tenantId, tenantId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.internalReason).toBeNull();
  });

  it("records a returned actor key (first answer wins) and cleans what it stores", async () => {
    const tenantId = tenant("hook");
    const analytics = createAnalytics({ db: tdb.db });
    // Keyed digests, the shape the audience's userKey(userId) has (HMAC-SHA256, base64url: 43 characters).
    const KEY_ONE = "Zk9vQmFyQmF6UXV4LWZpcnN0LWtleS1fMDEyMzQ1Njc";
    const KEY_TWO = "U2Vjb25kLWtleS1fLW5ldmVyLXN0b3JlZC0wMTIzNDU";
    const answers = [{ reason: "  staff\u0000 ", actorKey: KEY_ONE }, { reason: "automation", actorKey: KEY_TWO }, null];
    let call = 0;
    const handler = analytics.createHandler({
      tenantId,
      allowedHosts: ["adminigloo.com"],
      clientIp: (req) => req.headers.get("x-forwarded-for"),
      now: () => NOW,
      onSession: () => answers[call++],
    });
    for (const p of ["/", "/a", "/b"]) await handler.handle(beacon({ t: "pageview", d: "doc_hook_0000002", p }, CUSTOMER_IP));
    const [row] = await tdb.db
      .select({ internalReason: analyticsTables.sessions.internalReason, actorKey: analyticsTables.sessions.actorKey, views: analyticsTables.sessions.pageViewCount })
      .from(analyticsTables.sessions)
      .where(and(eq(analyticsTables.sessions.tenantId, tenantId)));
    expect(row).toEqual({ internalReason: "staff", actorKey: KEY_ONE, views: 3 });
  });

  it("is not called for a dropped request or for events", async () => {
    const tenantId = tenant("hook");
    const analytics = createAnalytics({ db: tdb.db });
    let calls = 0;
    const handler = analytics.createHandler({
      tenantId,
      allowedHosts: ["adminigloo.com"],
      clientIp: (req) => req.headers.get("x-forwarded-for"),
      now: () => NOW,
      onSession: () => {
        calls += 1;
      },
    });
    await handler.handle(beacon({ t: "pageview", d: "doc_hook_0000003", p: "/" }, CUSTOMER_IP, { "sec-gpc": "1" }));
    await handler.handle(beacon({ t: "pageview", d: "doc_hook_0000003", p: "/" }, CUSTOMER_IP, { origin: "https://evil.example" }));
    await handler.handle(beacon({ t: "event", d: "doc_hook_0000003", p: "/", n: "click" }, CUSTOMER_IP));
    expect(calls).toBe(0);
    await handler.handle(beacon({ t: "pageview", d: "doc_hook_0000003", p: "/" }, CUSTOMER_IP));
    await handler.handle(beacon({ t: "event", d: "doc_hook_0000003", p: "/", n: "click" }, CUSTOMER_IP));
    await handler.handle(beacon({ t: "leave", d: "doc_hook_0000003", p: "/", ms: 2000 }, CUSTOMER_IP));
    expect(calls).toBe(1);
  });
});

describe("one audience per tenant", () => {
  it("a resolver returning null for a tenant leaves that tenant unfiltered", async () => {
    const ctx = setup();
    await ctx.visit(CUSTOMER_IP, "doc_customer_0003", { "x-test-user": "u_cust" });
    await ctx.visit(STAFF_IP, "doc_staff_000003", { "x-test-user": "u_staff" });
    const q = { tenantId: ctx.tenantId, ...RANGE };
    const byTenant = createAnalytics({ db: tdb.db, audience: (tenantId) => (tenantId === ctx.tenantId ? ctx.audience : null) });
    const nobody = createAnalytics({ db: tdb.db, audience: () => null });
    expect((await byTenant.getOverview(q)).visits.current).toBe(1);
    expect((await nobody.getOverview(q)).visits.current).toBe(2);
    expect(byTenant.audienceFor("someone-else")).toBeNull();
  });

  it("an audience of ANOTHER tenant is refused, not applied (its marks could never match: staff would count again)", async () => {
    const ctx = setup();
    await ctx.visit(STAFF_IP, "doc_staff_000004", { "x-test-user": "u_staff" });
    // The site's audience is for "site"; the local environment's reports are for "site:local".
    const local = tenant("site:local");
    const q = { tenantId: local, ...RANGE };
    for (const read of [
      () => ctx.analytics.getOverview(q),
      () => ctx.analytics.getTopPages(q),
      () => ctx.analytics.getExcludedBreakdown(q),
      () => ctx.analytics.getPublicSnapshot({ tenantId: local, days: 1, publicPaths: ["/"], now: NOW }),
      () => ctx.analytics.markVisitorInternal({ tenantId: local, ip: STAFF_IP, userAgent: CHROME, at: NOW }),
    ]) {
      await expect(read()).rejects.toMatchObject({ code: "invalid_config", status: 500 });
    }
    const viaFunction = createAnalytics({ db: tdb.db, audience: () => ctx.audience });
    await expect(viaFunction.getOverview(q)).rejects.toMatchObject({ code: "invalid_config" });
    // includeInternal reads no audience, so it never trips the check.
    expect((await ctx.analytics.getOverview({ ...q, includeInternal: true })).visits.current).toBe(0);
    // Its own tenant is fine.
    expect((await ctx.analytics.getOverview({ tenantId: ctx.tenantId, ...RANGE })).visits.current).toBe(0);
  });
});

describe("a signed-out device on a cookieless site (visitorIds: rotating)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const YESTERDAY_AFTERNOON = new Date("2026-10-07T15:00:00Z");
  const WIDE = { from: new Date(NOW.getTime() - 2 * DAY), to: new Date(NOW.getTime() + DAY) };

  it("markVisitorInternal marks the device's keys for today and yesterday: ~48 hours of its signed-out visits, and the rest of today, stop counting", async () => {
    const ctx = setup({ visitorIds: "rotating" });
    const q = { tenantId: ctx.tenantId, ...WIDE };
    // The founder browses signed out on their laptop yesterday and this morning; a customer visits today.
    await ctx.visit(STAFF_IP, "doc_rot_founder_y", {}, YESTERDAY_AFTERNOON);
    await ctx.visit(STAFF_IP, "doc_rot_founder_t", {}, new Date(NOW.getTime() - 3 * 60 * 60 * 1000));
    await ctx.visit(CUSTOMER_IP, "doc_rot_customer1");
    expect(ctx.errors).toEqual([]);
    expect((await ctx.analytics.getOverview(q)).visits.current).toBe(3);

    // The audience cannot mark this browser for good: its key changes daily.
    const todayKey = ctx.visits.find((visit) => visit.ip === STAFF_IP && visit.isNewSession && visit.sessionId)!.visitorId;
    await expect(ctx.audience.markVisitor({ visitorId: todayKey, by: "founder" })).rejects.toMatchObject({ code: "not_configured" });

    // "These are my visits", pressed in the admin on that laptop.
    const marked = await ctx.analytics.markVisitorInternal({ tenantId: ctx.tenantId, ip: STAFF_IP, userAgent: CHROME, by: "founder@adminigloo.com", at: NOW });
    expect(marked.visitorIds).toHaveLength(2);
    expect(marked.subjectsChanged).toBe(2);
    const keys = new Set(ctx.visits.filter((visit) => visit.ip === STAFF_IP).map((visit) => visit.visitorId));
    expect(new Set(marked.visitorIds)).toEqual(keys);

    // Signed out again this afternoon, same laptop: today's key, so left out too.
    await ctx.visit(STAFF_IP, "doc_rot_founder_l", {}, new Date(NOW.getTime() + 2 * 60 * 60 * 1000));
    for (const [name, measure] of Object.entries(SESSION_REPORTS)) {
      const counted = await measure(ctx.analytics, q);
      expect([name, counted > 0]).toEqual([name, true]);
      // Four visits, one counted. Distinct visitors: the laptop's two visits today share today's key, so three keys.
      const factor = name === "getOverview:dailyVisitors" ? 3 : 4;
      expect([name, await measure(ctx.analytics, { ...q, includeInternal: true })]).toEqual([name, counted * factor]);
    }
    expect(await ctx.analytics.getExcludedBreakdown(q)).toEqual({ total: 3, byReason: { device: 3 }, unit: "sessions" });

    // Idempotent; and undone with the audience's unmark.
    expect((await ctx.analytics.markVisitorInternal({ tenantId: ctx.tenantId, ip: STAFF_IP, userAgent: CHROME, at: NOW })).subjectsChanged).toBe(0);
    for (const visitorId of marked.visitorIds) await ctx.audience.unmark({ subjectKind: "visitor", subjectId: visitorId, by: "test" });
    expect((await ctx.analytics.getOverview(q)).visits.current).toBe(4);
  });

  it("needs an audience; never marks a crawler", async () => {
    const ctx = setup({ visitorIds: "rotating" });
    await expect(ctx.unfiltered.markVisitorInternal({ tenantId: ctx.tenantId, ip: STAFF_IP, userAgent: CHROME, at: NOW })).rejects.toMatchObject({ code: "invalid_config" });
    expect(await ctx.analytics.markVisitorInternal({ tenantId: ctx.tenantId, ip: STAFF_IP, userAgent: "GPTBot/1.2", at: NOW })).toEqual({ visitorIds: [], subjectsChanged: 0 });
  });
});

describe("under a table prefix (aig_analytics_)", () => {
  it("excludes the same way, and the audience counts the prefixed table when given `tables`", async () => {
    const prefixed = await createTestDb(["aig_analytics_"]);
    try {
      const tables = prefixed.tables[0]!;
      const ctx = setup({ db: prefixed.db, tables });
      const q = { tenantId: ctx.tenantId, ...RANGE };
      await ctx.visit(CUSTOMER_IP, "doc_prefix_cust01", { "x-test-user": "u_cust" });
      await ctx.visit(STAFF_IP, "doc_prefix_staff1", { "x-test-user": "u_staff" });
      expect(ctx.errors).toEqual([]);
      for (const [name, measure] of Object.entries(SESSION_REPORTS)) {
        const counted = await measure(ctx.analytics, q);
        expect([name, counted > 0]).toEqual([name, true]);
        expect([name, await measure(ctx.analytics, { ...q, includeInternal: true })]).toEqual([name, counted * 2]);
      }
      expect(await ctx.analytics.getExcludedBreakdown(q)).toEqual({ total: 1, byReason: { role: 1 }, unit: "sessions" });
      expect((await ctx.analytics.getPublicSnapshot({ tenantId: ctx.tenantId, days: 1, publicPaths: ["/"], now: NOW })).visits).toBe(1);

      // The README's trap: without `tables` the source names the DEFAULT table.
      expect(audienceSessionsSource({ tenantId: ctx.tenantId }).table).toBe("analytics_sessions");
      expect(audienceSessionsSource({ tenantId: ctx.tenantId, tables }).table).toBe("aig_analytics_sessions");
      expect(ctx.analytics.audienceSessions(ctx.tenantId).table).toBe("aig_analytics_sessions");
      // With it, the audience's preview counts the prefixed sessions (this database has no analytics_sessions at all).
      const customerKey = ctx.visits.find((visit) => visit.ip === CUSTOMER_IP)!.visitorId;
      const preview = await ctx.audience.preview({ kind: "visitor", value: customerKey });
      expect(preview.windows.find((window) => window.key === "all")?.excluded.sessions).toBe(1);
    } finally {
      await prefixed.close();
    }
  });
});

describe("the license gate", () => {
  it("guards the reports, never the ingest or the maintenance", async () => {
    const tenantId = tenant("lic");
    const analytics = createAnalytics({ db: tdb.db, license: { mode: "enforce" } });
    const handler = analytics.createHandler({ tenantId, allowedHosts: ["adminigloo.com"], clientIp: (req) => req.headers.get("x-forwarded-for"), now: () => NOW });
    await handler.handle(beacon({ t: "pageview", d: "doc_license_00001", p: "/" }, CUSTOMER_IP));
    expect(await analytics.recordCrawlerHit({ tenantId, userAgent: "GPTBot/1.2", path: "/", at: NOW })).not.toBeNull();
    await analytics.runMaintenance({ now: NOW });
    const rows = await tdb.db.select({ n: sql<number>`count(*)::int` }).from(analyticsTables.sessions).where(eq(analyticsTables.sessions.tenantId, tenantId));
    expect(rows[0]?.n).toBe(1);

    const error = await analytics.getOverview({ tenantId, ...RANGE }).catch((caught: unknown) => caught);
    expect(isAnalyticsError(error)).toBe(true);
    expect(error).toMatchObject({ code: "unlicensed", status: 402 });
    await expect(analytics.getPublicSnapshot({ tenantId, days: 1, publicPaths: ["/"], now: NOW })).rejects.toMatchObject({ code: "unlicensed" });
    await expect(analytics.reclassifySources({ tenantId })).rejects.toMatchObject({ code: "unlicensed" });
    // Pipeline health is liveness, like the ingest it watches: a lapsed install can still show nothing is lost.
    expect((await analytics.getPipelineHealth(tenantId)).lastPageView).toBe(NOW.toISOString());
    // "off" (the default) never denies.
    expect((await createAnalytics({ db: tdb.db, license: { mode: "off" } }).getOverview({ tenantId, ...RANGE })).visits.current).toBe(1);
  });
});
