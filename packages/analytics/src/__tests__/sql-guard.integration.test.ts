import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/pglite";
import { createAudience, createDrizzleAudienceStore } from "@adminigloo/audience";
import { createAnalytics, type Analytics } from "../instance.js";
import { audienceSessionsSource, type AnalyticsDb } from "../context.js";
import type { ReportQuery } from "../reports.js";
import type { AnalyticsTables } from "../schema.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * The guard at the level that cannot be fooled by how the source is written:
 * every SQL statement every report SENDS, captured from the driver, under
 * two table prefixes. Each read of the sessions table must carry the
 * audience's anti-join (visitor marks, session marks, and the rule's "only
 * from" time on both), and each read of page views or events must go through
 * a counted EXISTS on its session — scoped to the tenant. Counted per
 * statement, so a report that filters one query and forgets a second, or a
 * statement with one filtered and one unfiltered subquery, fails here by
 * name, whatever helper the source called (guard.test.ts checks the source).
 */

const NOW = new Date("2026-10-08T12:00:00Z");
const RANGE = { from: new Date("2026-10-08T00:00:00Z"), to: new Date("2026-10-09T00:00:00Z") };
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const CHATGPT_USER = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";
const SECRET = "test-secret-0123456789-abcdefghijklmnopqrstuvwxyz";

/** Every report on the instance, called so that each of its statements runs (data seeded so no branch is skipped). */
const REPORT_CALLS: Record<string, (a: Analytics, q: ReportQuery) => Promise<unknown>> = {
  getTrackingSince: (a, q) => a.getTrackingSince(q.tenantId),
  getOverview: (a, q) => a.getOverview(q),
  getDailyTrend: (a, q) => a.getDailyTrend(q),
  getSources: (a, q) => a.getSources(q),
  getReferrers: (a, q) => a.getReferrers(q),
  getCampaigns: (a, q) => a.getCampaigns(q),
  getBreakdown: (a, q) => Promise.all((["country", "device", "browser", "os"] as const).map((dimension) => a.getBreakdown(q, dimension))),
  getEngagementBySource: (a, q) => a.getEngagementBySource(q),
  getActivity: (a, q) => a.getActivity(q),
  getTopPages: (a, q) => Promise.all([a.getTopPages(q), a.getTopPages(q, 5, ["/", "/pricing"])]),
  getLandingPages: (a, q) => a.getLandingPages(q),
  getTopClicks: (a, q) => a.getTopClicks(q),
  getEventVisits: (a, q) => a.getEventVisits(q, ["book_call", "call_booked"]),
  getWebVitals: (a, q) => a.getWebVitals(q, 10),
  getAiAssistantTraffic: (a, q) => a.getAiAssistantTraffic(q),
  getCrawlers: (a, q) => a.getCrawlers(q),
  getRecentAiReads: (a, q) => a.getRecentAiReads({ tenantId: q.tenantId, since: q.from, paths: ["/", "/pricing"] }),
  getAiCoverage: (a, q) => a.getAiCoverage({ tenantId: q.tenantId, paths: ["/", "/pricing"], since: q.from }),
  getPublicSnapshot: (a, q) => a.getPublicSnapshot({ tenantId: q.tenantId, days: 1, publicPaths: ["/", "/pricing"], funnel: ["book_call"], now: NOW }),
  getExcludedBreakdown: (a, q) => a.getExcludedBreakdown(q),
  getPipelineHealth: (a, q) => a.getPipelineHealth(q.tenantId),
};

/** Reports whose statements may read visitor rows unfiltered, and why. */
const UNFILTERED_ON_PURPOSE: Record<string, string> = {
  getPipelineHealth: "liveness: 'is anything arriving?' — a staff page view proves the pipeline (health.ts)",
};

const count = (text: string, needle: string) => text.split(needle).length - 1;

/** What is wrong with one statement, for one table prefix: an empty list when every visitor read is counted. */
function problemsIn(statement: string, prefix: string): string[] {
  const text = statement.replace(/\s+/g, " ").toLowerCase();
  const S = `"${prefix}sessions"`;
  const problems: string[] = [];
  const sessionReads = count(text, `from ${S}`) + count(text, `join ${S}`);
  const visitorMarks = count(text, `aig_m.subject_kind = 'visitor' and aig_m.subject_id = ${S}."visitor_key"`);
  const sessionMarks = count(text, `aig_m.subject_kind = 'session' and aig_m.subject_id = ${S}."id"`);
  const timeChecks = count(text, `aig_m.applies_from <= ${S}."started_at"`);
  if (visitorMarks < sessionReads) problems.push(`reads ${S} ${sessionReads}× but applies visitor marks ${visitorMarks}×`);
  if (sessionMarks < sessionReads) problems.push(`reads ${S} ${sessionReads}× but applies session marks ${sessionMarks}×`);
  if (timeChecks < 2 * sessionReads) problems.push(`reads ${S} ${sessionReads}× but checks a rule's "only from" ${timeChecks}× (2 per read)`);
  for (const table of [`"${prefix}page_views"`, `"${prefix}events"`]) {
    const reads = count(text, `from ${table}`) + count(text, `join ${table}`);
    const through = count(text, `exists (select 1 from ${S} where ${S}."id" = ${table}."session_id" and ${S}."tenant_id" = `);
    if (through < reads) problems.push(`reads ${table} ${reads}× but goes through a tenant-scoped counted session ${through}×`);
  }
  return problems;
}

const touchesVisitorRows = (statement: string, prefix: string) =>
  [`"${prefix}sessions"`, `"${prefix}page_views"`, `"${prefix}events"`].some((table) => statement.toLowerCase().includes(table));

let tdb: TestDb & { tables: AnalyticsTables[] };
beforeAll(async () => {
  tdb = await createTestDb(["analytics_", "aig_analytics_"]);
});
afterAll(async () => {
  await tdb?.close();
});

/** An instance whose every statement is captured, with an audience, over one prefix's tables — and a seeded tenant. */
async function capturing(tables: AnalyticsTables) {
  const tenantId = tenant("guard");
  const statements: string[] = [];
  const logged = drizzle(tdb.client, { logger: { logQuery: (query) => statements.push(query) } }) as unknown as AnalyticsDb;
  const audience = createAudience({
    store: createDrizzleAudienceStore({ db: tdb.db }),
    secret: SECRET,
    tenantId,
    sessions: audienceSessionsSource({ tenantId, tables }),
    now: () => NOW,
  });
  const analytics = createAnalytics({ db: logged, tables, audience });
  // Seed through an uncaptured instance: a ChatGPT visit with two pages, a click, a vital and a conversion; an assistant fetch.
  const writer = createAnalytics({ db: tdb.db, tables });
  let clock = new Date(NOW.getTime() - 60 * 60 * 1000);
  const handler = writer.createHandler({ tenantId, allowedHosts: ["adminigloo.com"], clientIp: () => "203.0.113.7", now: () => clock });
  const send = (body: Record<string, unknown>) =>
    handler.handle(
      new Request("https://adminigloo.com/api/analytics", {
        method: "POST",
        headers: { origin: "https://adminigloo.com", "user-agent": CHROME },
        body: JSON.stringify(body),
      }),
    );
  await send({ t: "pageview", d: "doc_guard_000001", p: "/", r: "https://chatgpt.com/", q: "?utm_campaign=launch" });
  clock = new Date(clock.getTime() + 60_000);
  await send({ t: "pageview", d: "doc_guard_000001", p: "/pricing", ms: 4000 });
  await send({ t: "event", d: "doc_guard_000001", p: "/pricing", n: "book_call", l: "Book a call" });
  await send({ t: "event", d: "doc_guard_000001", p: "/pricing", n: "web_vital", l: "LCP", v: 1800, i: "v5-guard" });
  await writer.recordConversion({ tenantId, ip: "203.0.113.7", userAgent: CHROME, name: "call_booked", at: clock });
  await writer.recordCrawlerHit({ tenantId, userAgent: CHATGPT_USER, path: "/", at: clock });
  return { tenantId, analytics, statements };
}

describe.each([["analytics_"], ["aig_analytics_"]])("every statement every report sends, prefix %s", (prefix) => {
  let run: Awaited<ReturnType<typeof capturing>>;
  let q: ReportQuery;
  const byReport = new Map<string, string[]>();
  beforeAll(async () => {
    const tables = tdb.tables[prefix === "analytics_" ? 0 : 1]!;
    run = await capturing(tables);
    q = { tenantId: run.tenantId, ...RANGE };
    for (const [name, call] of Object.entries(REPORT_CALLS)) {
      run.statements.length = 0;
      await call(run.analytics, q);
      byReport.set(name, [...run.statements]);
    }
  });

  it("the list is every report on the instance", () => {
    const reports = Object.keys(run.analytics).filter((key) => key.startsWith("get")).sort();
    expect(Object.keys(REPORT_CALLS).sort()).toEqual(reports);
  });

  it.each(Object.keys(REPORT_CALLS).filter((name) => !(name in UNFILTERED_ON_PURPOSE)))("%s: every read of visitor rows is counted", (name) => {
    const statements = byReport.get(name)!;
    const problems = statements.flatMap((statement) => problemsIn(statement, prefix).map((problem) => `${problem} in: ${statement.slice(0, 160)}`));
    expect(problems).toEqual([]);
  });

  it("the guard is not vacuous: the session, page-view and event reports really read visitor rows", () => {
    for (const name of ["getOverview", "getTopPages", "getTopClicks", "getEventVisits", "getWebVitals", "getAiAssistantTraffic", "getPublicSnapshot"]) {
      expect([name, byReport.get(name)!.some((statement) => touchesVisitorRows(statement, prefix))]).toEqual([name, true]);
    }
    // getWebVitals with a path limit sends two statements (overall and per entry page): both checked.
    expect(byReport.get("getWebVitals")!.filter((statement) => touchesVisitorRows(statement, prefix))).toHaveLength(2);
  });

  it("with includeInternal, no statement carries the anti-join (so the check above sees the real filter)", async () => {
    run.statements.length = 0;
    await run.analytics.getOverview({ ...q, includeInternal: true });
    await run.analytics.getTopPages({ ...q, includeInternal: true });
    expect(run.statements.length).toBeGreaterThan(0);
    expect(run.statements.filter((statement) => statement.includes("aig_audience_marks"))).toEqual([]);
  });
});

describe("the statement check (negative controls)", () => {
  it("flags a sessions read with no anti-join", () => {
    expect(problemsIn(`select count(*) from "analytics_sessions" where "analytics_sessions"."tenant_id" = $1`, "analytics_")).not.toEqual([]);
  });

  it("flags a statement that filters one sessions read and not a second", () => {
    const filtered = `select count(*) from "analytics_sessions" where (NOT EXISTS (SELECT 1 FROM aig_audience_marks aig_m WHERE aig_m.subject_kind = 'visitor' AND aig_m.subject_id = "analytics_sessions"."visitor_key" AND (aig_m.applies_from IS NULL OR aig_m.applies_from <= "analytics_sessions"."started_at")) AND NOT EXISTS (SELECT 1 FROM aig_audience_marks aig_m WHERE aig_m.subject_kind = 'session' AND aig_m.subject_id = "analytics_sessions"."id" AND (aig_m.applies_from IS NULL OR aig_m.applies_from <= "analytics_sessions"."started_at")))`;
    expect(problemsIn(filtered, "analytics_")).toEqual([]);
    expect(problemsIn(`${filtered} union all select count(*) from "analytics_sessions"`, "analytics_")).not.toEqual([]);
  });

  it("flags a page-view read that is not scoped through a counted session of the tenant", () => {
    expect(problemsIn(`select path from "analytics_page_views" where "analytics_page_views"."tenant_id" = $1`, "analytics_")).not.toEqual([]);
    // An EXISTS without the tenant bound is not enough either.
    expect(
      problemsIn(
        `select path from "analytics_page_views" where exists (select 1 from "analytics_sessions" where "analytics_sessions"."id" = "analytics_page_views"."session_id")`,
        "analytics_",
      ),
    ).not.toEqual([]);
  });

  it("reads another prefix's tables as another prefix", () => {
    expect(problemsIn(`select count(*) from "aig_analytics_sessions"`, "aig_analytics_")).not.toEqual([]);
    expect(problemsIn(`select count(*) from "aig_analytics_sessions"`, "analytics_")).toEqual([]);
  });
});
