import { and, count, desc, eq, gte, inArray, lt, max, notInArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { audienceSessionsSource, type AnalyticsContext, type AnalyticsExcludedBreakdown } from "./context.js";
import { aiEngineOf, AI_ENGINE_LABELS, SOURCE_BUCKETS, type AiEngineId, type SourceBucket } from "./sources.js";
import { ASSISTANT_BOT_ENGINES, CRAWLER_KINDS, isAiCrawlerKind, type CrawlerKind } from "./crawlers.js";
import { deltaPct, lastDays, priorPeriod, SMALL_SAMPLE, type DateRange } from "./periods.js";
import { summarizeWebVitals, type WebVitalSummary } from "./vitals.js";

/**
 * Every report the dashboard and the public window draw, over one instance's
 * tables. Ranges are half-open [from, to). Humans only in the session tables —
 * crawlers are dropped at ingest and live in their own table — so there is no
 * `is_bot` filter to forget (trailcards had two reports that counted bots and
 * the rest did not).
 *
 * THE INTERNAL AUDIENCE. With an audience (`createAnalytics({ audience })`),
 * every read of sessions, page views and events leaves out what the audience
 * has marked — staff, testers, automation, a named person — with its
 * `NOT EXISTS` anti-join: `sessionWindow` for the session reports, and
 * `countedThroughSession` (an EXISTS on the visit, with the same predicate)
 * for page views and events. Nothing is rewritten, so a rule added today
 * cleans history at once and removing it restores the numbers exactly.
 * `includeInternal: true` on one call counts everyone, for that call only.
 * The public snapshot ALWAYS leaves them out. With no audience there is no
 * filter at all — 0.1's numbers.
 *
 * A guard test (src/__tests__/guard.test.ts) fails the build when a function
 * here reads those tables without one of the two helpers.
 *
 * Aggregates are cast to int/float8 in SQL: the pg driver returns int8 and
 * numeric as strings, and a string sum concatenates.
 */

export interface ReportQuery extends DateRange {
  tenantId: string;
  /** IANA zone the day buckets are drawn in. Default UTC. */
  timeZone?: string;
  /**
   * Count the internal audience (and the site's own SEO audit in the crawler
   * reports) too — for THIS call only; nothing remembers it. Default false.
   * Read it from the URL (`?includeInternal=1`), never from a stored setting.
   * Ignored by `getPublicSnapshot`, which always leaves them out.
   */
  includeInternal?: boolean;
}

/** Who a read is for: the tenant, and whether this one call counts the internal audience. */
type Audience = Pick<ReportQuery, "tenantId" | "includeInternal">;

function zoneOf(timeZone: string | undefined): string {
  const zone = timeZone ?? "UTC";
  if (!/^[A-Za-z0-9_+\-/]{1,64}$/.test(zone)) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}

/**
 * The zone as an inline SQL literal. Not a bound parameter on purpose: a
 * grouped expression must match its SELECT twin exactly, and two binds of the
 * same value are two different parameters to Postgres (error 42803). Safe
 * because zoneOf admits only IANA-name characters, never a quote.
 */
function zoneLiteral(zone: string): SQL {
  return sql.raw(`'${zone}'`);
}

const n = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));
const AI_KINDS = ["ai-assistant", "ai-search", "ai-training"] as const;

// ---------------------------------------------------------------------------
// The counted predicate — the ONLY ways a report reads visitor rows.
// ---------------------------------------------------------------------------

/**
 * True for sessions that COUNT: the audience's anti-join over visitor and
 * session marks, on the (unaliased) sessions table — its visitor key, its
 * start time (a rule's "only from" date) and its id (visit-only marks).
 * Undefined, i.e. no filter: no audience for this tenant, or `includeInternal`.
 */
function countedSessions(ctx: AnalyticsContext, q: Audience): SQL | undefined {
  if (q.includeInternal === true) return undefined;
  const audience = ctx.audienceFor(q.tenantId);
  if (!audience) return undefined;
  const s = ctx.t.sessions;
  return audience.countedVisitorSql(s.visitorKey, { time: s.startedAt, session: s.id, includeInternal: false });
}

/**
 * A page view or event counts when the visit it belongs to counts. The
 * session's tenant is repeated inside the EXISTS (exact: a page view or
 * event is always written under its session's tenant) so the planner reads
 * only this tenant's sessions — the table is shared by every tenant and
 * environment. No time bound is added: a backdated server-side conversion
 * can precede its session's start, so one would not be exact.
 */
function countedThroughSession(ctx: AnalyticsContext, sessionId: SQLWrapper, q: Audience): SQL | undefined {
  const counted = countedSessions(ctx, q);
  if (!counted) return undefined;
  const s = ctx.t.sessions;
  return sql`exists (select 1 from ${s} where ${s.id} = ${sessionId} and ${s.tenantId} = ${q.tenantId} and ${counted})`;
}

/** Sessions of this tenant started in the range, that count. */
function sessionWindow(ctx: AnalyticsContext, q: Audience, range: DateRange): SQL | undefined {
  const s = ctx.t.sessions;
  return and(eq(s.tenantId, q.tenantId), gte(s.startedAt, range.from), lt(s.startedAt, range.to), countedSessions(ctx, q));
}

/** The bots a crawler report leaves out (the site's own SEO audit, by default) unless `includeInternal`. */
function excludedBotsClause(ctx: AnalyticsContext, q: Audience): SQL | undefined {
  if (q.includeInternal === true || ctx.excludedBots.length === 0) return undefined;
  return notInArray(ctx.t.crawlerHits.botName, [...ctx.excludedBots]);
}

function crawlerWindow(ctx: AnalyticsContext, q: Audience, range: DateRange): SQL | undefined {
  const c = ctx.t.crawlerHits;
  return and(eq(c.tenantId, q.tenantId), gte(c.bucketStart, range.from), lt(c.bucketStart, range.to), excludedBotsClause(ctx, q));
}

/** Every calendar day of the range as seen in `zone`, YYYY-MM-DD. */
export function daysInZone(range: DateRange, zone: string): string[] {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
  const first = format.format(range.from);
  const last = format.format(new Date(range.to.getTime() - 1));
  const days: string[] = [];
  const cursor = new Date(`${first}T00:00:00Z`);
  const end = new Date(`${last}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/** When this tenant's tracking began (first beacon or crawler hit), or null before any. Never moves with retention. */
export async function getTrackingSince(ctx: AnalyticsContext, tenantId: string): Promise<Date | null> {
  const { db, t } = ctx;
  const [row] = await db.select({ at: t.sites.trackingSince }).from(t.sites).where(eq(t.sites.tenantId, tenantId)).limit(1);
  return row?.at ? new Date(row.at) : null;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface Metric {
  current: number;
  prior: number;
  /** null when there is no honest comparison: a zero prior, or a prior window from before tracking began. */
  deltaPct: number | null;
  /** True when the prior window began before tracking did — show "first period", not a growth figure. */
  priorPartial: boolean;
  smallSample: boolean;
}

export interface Overview {
  trackingSince: string | null;
  /** Sessions — the honest headline. */
  visits: Metric;
  /** Daily unique visitors, summed: the cookieless model counts a person once per day. */
  dailyVisitors: Metric;
  pageViews: Metric;
  engagedVisits: Metric;
  conversions: Metric;
  /** 0–100, null with no visits. */
  engagedRate: number | null;
  /** Foreground (engaged) time per visit. */
  avgEngagedMs: number | null;
  pagesPerVisit: number | null;
}

async function totals(ctx: AnalyticsContext, q: Audience, range: DateRange) {
  const s = ctx.t.sessions;
  const [row] = await ctx.db
    .select({
      visits: sql<number>`count(*)::int`,
      visitors: sql<number>`count(distinct ${s.visitorKey})::int`,
      pageViews: sql<number>`coalesce(sum(${s.pageViewCount}), 0)::int`,
      engaged: sql<number>`(count(*) filter (where ${s.isEngaged}))::int`,
      converted: sql<number>`(count(*) filter (where ${s.converted}))::int`,
      durationMs: sql<number>`coalesce(sum(${s.durationMs}), 0)::float8`,
    })
    .from(s)
    .where(sessionWindow(ctx, q, range));
  return {
    visits: n(row?.visits),
    visitors: n(row?.visitors),
    pageViews: n(row?.pageViews),
    engaged: n(row?.engaged),
    converted: n(row?.converted),
    durationMs: n(row?.durationMs),
  };
}

function metric(current: number, prior: number, priorPartial: boolean): Metric {
  return { current, prior, deltaPct: priorPartial ? null : deltaPct(current, prior), priorPartial, smallSample: current < SMALL_SAMPLE };
}

export async function getOverview(ctx: AnalyticsContext, query: ReportQuery): Promise<Overview> {
  const prior = priorPeriod(query);
  const [current, before, since] = await Promise.all([totals(ctx, query, query), totals(ctx, query, prior), getTrackingSince(ctx, query.tenantId)]);
  const partial = !since || prior.from.getTime() < since.getTime();
  return {
    trackingSince: since?.toISOString() ?? null,
    visits: metric(current.visits, before.visits, partial),
    dailyVisitors: metric(current.visitors, before.visitors, partial),
    pageViews: metric(current.pageViews, before.pageViews, partial),
    engagedVisits: metric(current.engaged, before.engaged, partial),
    conversions: metric(current.converted, before.converted, partial),
    engagedRate: current.visits ? (current.engaged / current.visits) * 100 : null,
    avgEngagedMs: current.visits ? current.durationMs / current.visits : null,
    pagesPerVisit: current.visits ? current.pageViews / current.visits : null,
  };
}

// ---------------------------------------------------------------------------
// Trend
// ---------------------------------------------------------------------------

export interface TrendPoint {
  date: string;
  /** null for days before tracking began — never measured, so never drawn as zero. */
  visits: number | null;
  dailyVisitors: number | null;
  pageViews: number | null;
  engaged: number | null;
  aiCrawlerHits: number | null;
}

export async function getDailyTrend(ctx: AnalyticsContext, query: ReportQuery): Promise<TrendPoint[]> {
  const { db } = ctx;
  const s = ctx.t.sessions;
  const c = ctx.t.crawlerHits;
  const zone = zoneOf(query.timeZone);
  const day = sql<string>`to_char(${s.startedAt} at time zone ${zoneLiteral(zone)}, 'YYYY-MM-DD')`;
  const hitDay = sql<string>`to_char(${c.bucketStart} at time zone ${zoneLiteral(zone)}, 'YYYY-MM-DD')`;
  const [sessionRows, hitRows, since] = await Promise.all([
    db
      .select({
        date: day,
        visits: sql<number>`count(*)::int`,
        visitors: sql<number>`count(distinct ${s.visitorKey})::int`,
        pageViews: sql<number>`coalesce(sum(${s.pageViewCount}), 0)::int`,
        engaged: sql<number>`(count(*) filter (where ${s.isEngaged}))::int`,
      })
      .from(s)
      .where(sessionWindow(ctx, query, query))
      .groupBy(day),
    db
      .select({ date: hitDay, hits: sql<number>`coalesce(sum(${c.hits}), 0)::int` })
      .from(c)
      .where(and(crawlerWindow(ctx, query, query), inArray(c.botKind, [...AI_KINDS])))
      .groupBy(hitDay),
    getTrackingSince(ctx, query.tenantId),
  ]);
  const sinceDay = since ? new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(since) : null;
  const sessionsByDay = new Map(sessionRows.map((row) => [row.date, row]));
  const hitsByDay = new Map(hitRows.map((row) => [row.date, n(row.hits)]));
  return daysInZone(query, zone).map((date) => {
    if (!sinceDay || date < sinceDay) return { date, visits: null, dailyVisitors: null, pageViews: null, engaged: null, aiCrawlerHits: null };
    const row = sessionsByDay.get(date);
    return {
      date,
      visits: n(row?.visits),
      dailyVisitors: n(row?.visitors),
      pageViews: n(row?.pageViews),
      engaged: n(row?.engaged),
      aiCrawlerHits: hitsByDay.get(date) ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Acquisition
// ---------------------------------------------------------------------------

export interface SourceRow {
  source: SourceBucket;
  visits: number;
  prior: number;
  deltaPct: number | null;
  engagedRate: number | null;
}

export async function getSources(ctx: AnalyticsContext, query: ReportQuery): Promise<SourceRow[]> {
  const s = ctx.t.sessions;
  const read = (range: DateRange) =>
    ctx.db
      .select({
        source: s.sourceBucket,
        visits: sql<number>`count(*)::int`,
        engaged: sql<number>`(count(*) filter (where ${s.isEngaged}))::int`,
      })
      .from(s)
      .where(sessionWindow(ctx, query, range))
      .groupBy(s.sourceBucket);
  const prior = priorPeriod(query);
  const [current, before, since] = await Promise.all([read(query), read(prior), getTrackingSince(ctx, query.tenantId)]);
  const partial = !since || prior.from.getTime() < since.getTime();
  const currentBy = new Map(current.map((row) => [row.source, row]));
  const priorBy = new Map(before.map((row) => [row.source, n(row.visits)]));
  return SOURCE_BUCKETS.map((source) => {
    const row = currentBy.get(source);
    const visits = n(row?.visits);
    const previous = priorBy.get(source) ?? 0;
    return {
      source,
      visits,
      prior: previous,
      deltaPct: partial ? null : deltaPct(visits, previous),
      engagedRate: visits ? (n(row?.engaged) / visits) * 100 : null,
    };
  }).sort((a, b) => b.visits - a.visits);
}

export async function getReferrers(ctx: AnalyticsContext, query: ReportQuery, limit = 20): Promise<Array<{ host: string; source: SourceBucket; visits: number }>> {
  const s = ctx.t.sessions;
  const rows = await ctx.db
    .select({ host: s.referrerHost, source: s.sourceBucket, visits: sql<number>`count(*)::int` })
    .from(s)
    .where(and(sessionWindow(ctx, query, query), sql`${s.referrerHost} is not null`))
    .groupBy(s.referrerHost, s.sourceBucket)
    .orderBy(desc(count()))
    .limit(limit);
  return rows.map((row) => ({ host: row.host ?? "", source: row.source as SourceBucket, visits: n(row.visits) }));
}

export interface CampaignRow {
  campaign: string;
  source: string | null;
  medium: string | null;
  visits: number;
  engagedRate: number | null;
  conversions: number;
}

export async function getCampaigns(ctx: AnalyticsContext, query: ReportQuery, limit = 20): Promise<CampaignRow[]> {
  const s = ctx.t.sessions;
  const rows = await ctx.db
    .select({
      campaign: s.utmCampaign,
      source: s.utmSource,
      medium: s.utmMedium,
      visits: sql<number>`count(*)::int`,
      engaged: sql<number>`(count(*) filter (where ${s.isEngaged}))::int`,
      conversions: sql<number>`(count(*) filter (where ${s.converted}))::int`,
    })
    .from(s)
    .where(and(sessionWindow(ctx, query, query), sql`${s.utmCampaign} is not null`))
    .groupBy(s.utmCampaign, s.utmSource, s.utmMedium)
    .orderBy(desc(count()))
    .limit(limit);
  return rows.map((row) => ({
    campaign: row.campaign ?? "",
    source: row.source,
    medium: row.medium,
    visits: n(row.visits),
    engagedRate: n(row.visits) ? (n(row.engaged) / n(row.visits)) * 100 : null,
    conversions: n(row.conversions),
  }));
}

export type BreakdownDimension = "country" | "device" | "browser" | "os";

export async function getBreakdown(
  ctx: AnalyticsContext,
  query: ReportQuery,
  dimension: BreakdownDimension,
  limit = 15,
): Promise<Array<{ value: string; visits: number }>> {
  const s = ctx.t.sessions;
  const column = { country: s.country, device: s.device, browser: s.browser, os: s.os }[dimension];
  const rows = await ctx.db
    .select({ value: column, visits: sql<number>`count(*)::int` })
    .from(s)
    .where(sessionWindow(ctx, query, query))
    .groupBy(column)
    .orderBy(desc(count()))
    .limit(limit);
  return rows.map((row) => ({ value: row.value ?? "Unknown", visits: n(row.visits) }));
}

export interface EngagementRow {
  source: SourceBucket;
  visits: number;
  engagedRate: number | null;
  avgEngagedMs: number | null;
  pagesPerVisit: number | null;
  conversionRate: number | null;
  smallSample: boolean;
}

export async function getEngagementBySource(ctx: AnalyticsContext, query: ReportQuery): Promise<EngagementRow[]> {
  const s = ctx.t.sessions;
  const rows = await ctx.db
    .select({
      source: s.sourceBucket,
      visits: sql<number>`count(*)::int`,
      engaged: sql<number>`(count(*) filter (where ${s.isEngaged}))::int`,
      converted: sql<number>`(count(*) filter (where ${s.converted}))::int`,
      durationMs: sql<number>`coalesce(sum(${s.durationMs}), 0)::float8`,
      pageViews: sql<number>`coalesce(sum(${s.pageViewCount}), 0)::int`,
    })
    .from(s)
    .where(sessionWindow(ctx, query, query))
    .groupBy(s.sourceBucket)
    .orderBy(desc(count()));
  return rows.map((row) => {
    const visits = n(row.visits);
    return {
      source: row.source as SourceBucket,
      visits,
      engagedRate: visits ? (n(row.engaged) / visits) * 100 : null,
      avgEngagedMs: visits ? n(row.durationMs) / visits : null,
      pagesPerVisit: visits ? n(row.pageViews) / visits : null,
      conversionRate: visits ? (n(row.converted) / visits) * 100 : null,
      smallSample: visits < SMALL_SAMPLE,
    };
  });
}

export interface ActivityReport {
  /** grid[weekday][hour] visits, weekday 0 = Sunday, in the query's zone. */
  grid: number[][];
  byHour: number[];
  byWeekday: number[];
}

/** When people arrive — the hour-by-weekday heatmap, in the site's zone. */
export async function getActivity(ctx: AnalyticsContext, query: ReportQuery): Promise<ActivityReport> {
  const s = ctx.t.sessions;
  const zone = zoneOf(query.timeZone);
  const local = sql`(${s.startedAt} at time zone ${zoneLiteral(zone)})`;
  const weekday = sql<number>`extract(dow from ${local})::int`;
  const hour = sql<number>`extract(hour from ${local})::int`;
  const result = await ctx.db
    .select({ weekday, hour, visits: sql<number>`count(*)::int` })
    .from(s)
    .where(sessionWindow(ctx, query, query))
    .groupBy(weekday, hour);
  const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const row of result) {
    const day = grid[n(row.weekday)];
    const h = n(row.hour);
    if (day && h >= 0 && h < 24) day[h] = n(row.visits);
  }
  return {
    grid,
    byHour: Array.from({ length: 24 }, (_, h) => grid.reduce((sum, day) => sum + (day[h] ?? 0), 0)),
    byWeekday: grid.map((day) => day.reduce((sum, value) => sum + value, 0)),
  };
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export async function getTopPages(
  ctx: AnalyticsContext,
  query: ReportQuery,
  limit = 20,
  onlyPaths?: readonly string[],
): Promise<Array<{ path: string; views: number; visits: number }>> {
  if (onlyPaths && onlyPaths.length === 0) return [];
  const p = ctx.t.pageViews;
  const rows = await ctx.db
    .select({ path: p.path, views: sql<number>`count(*)::int`, visits: sql<number>`count(distinct ${p.sessionId})::int` })
    .from(p)
    .where(
      and(
        eq(p.tenantId, query.tenantId),
        gte(p.occurredAt, query.from),
        lt(p.occurredAt, query.to),
        onlyPaths ? inArray(p.path, [...onlyPaths]) : undefined,
        countedThroughSession(ctx, p.sessionId, query),
      ),
    )
    .groupBy(p.path)
    .orderBy(desc(count()))
    .limit(limit);
  return rows.map((row) => ({ path: row.path, views: n(row.views), visits: n(row.visits) }));
}

export interface LandingRow {
  path: string;
  visits: number;
  engagedRate: number | null;
  avgEngagedMs: number | null;
  conversions: number;
}

export async function getLandingPages(ctx: AnalyticsContext, query: ReportQuery, limit = 20): Promise<LandingRow[]> {
  const s = ctx.t.sessions;
  const rows = await ctx.db
    .select({
      path: s.landingPath,
      visits: sql<number>`count(*)::int`,
      engaged: sql<number>`(count(*) filter (where ${s.isEngaged}))::int`,
      converted: sql<number>`(count(*) filter (where ${s.converted}))::int`,
      durationMs: sql<number>`coalesce(sum(${s.durationMs}), 0)::float8`,
    })
    .from(s)
    .where(sessionWindow(ctx, query, query))
    .groupBy(s.landingPath)
    .orderBy(desc(count()))
    .limit(limit);
  return rows.map((row) => {
    const visits = n(row.visits);
    return {
      path: row.path,
      visits,
      engagedRate: visits ? (n(row.engaged) / visits) * 100 : null,
      avgEngagedMs: visits ? n(row.durationMs) / visits : null,
      conversions: n(row.converted),
    };
  });
}

/** Clicks, outbound links and conversions — everything but the vitals. */
export async function getTopClicks(
  ctx: AnalyticsContext,
  query: ReportQuery,
  limit = 20,
): Promise<Array<{ name: string; label: string | null; clicks: number; visits: number }>> {
  const e = ctx.t.events;
  const rows = await ctx.db
    .select({ name: e.name, label: e.label, clicks: sql<number>`count(*)::int`, visits: sql<number>`count(distinct ${e.sessionId})::int` })
    .from(e)
    .where(
      and(
        eq(e.tenantId, query.tenantId),
        gte(e.occurredAt, query.from),
        lt(e.occurredAt, query.to),
        sql`${e.name} <> 'web_vital'`,
        countedThroughSession(ctx, e.sessionId, query),
      ),
    )
    .groupBy(e.name, e.label)
    .orderBy(desc(count()))
    .limit(limit);
  return rows.map((row) => ({ name: row.name, label: row.label, clicks: n(row.clicks), visits: n(row.visits) }));
}

/**
 * Visits that did each named thing — a click event by its name, or a
 * conversion by its label — for a funnel: "37 visits · 9 pressed the demo ·
 * 3 filed a ticket". Distinct visits, so a visitor pressing twice counts once.
 */
export async function getEventVisits(ctx: AnalyticsContext, query: ReportQuery, names: readonly string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = Object.fromEntries(names.map((name) => [name, 0]));
  if (names.length === 0) return out;
  const e = ctx.t.events;
  const key = sql<string>`case when ${e.name} = 'conversion' then ${e.label} else ${e.name} end`;
  const result = await ctx.db
    .select({ key, visits: sql<number>`count(distinct ${e.sessionId})::int` })
    .from(e)
    .where(
      and(
        eq(e.tenantId, query.tenantId),
        gte(e.occurredAt, query.from),
        lt(e.occurredAt, query.to),
        sql`(${inArray(e.name, [...names])} or (${e.name} = 'conversion' and ${inArray(e.label, [...names])}))`,
        countedThroughSession(ctx, e.sessionId, query),
      ),
    )
    .groupBy(key);
  for (const row of result) if (row.key && row.key in out) out[row.key] = n(row.visits);
  return out;
}

// ---------------------------------------------------------------------------
// Speed
// ---------------------------------------------------------------------------

export interface WebVitalsReport {
  summary: WebVitalSummary[];
  /** By the page each load STARTED on (vitals cover a whole document, across soft navigations). */
  byEntryPage: Array<{ path: string; metrics: WebVitalSummary[] }>;
}

/**
 * p75 per metric over page LOADS: CLS and INP report several times per load,
 * so each load's metric id contributes its final (max) value once.
 */
export async function getWebVitals(ctx: AnalyticsContext, query: ReportQuery, pathLimit = 10): Promise<WebVitalsReport> {
  const e = ctx.t.events;
  const counted = countedThroughSession(ctx, e.sessionId, query);
  const loads = sql`(
    select ${e.label} as metric, ${e.path} as path, max(${e.value}) as value
    from ${e}
    where ${e.tenantId} = ${query.tenantId}
      and ${e.name} = 'web_vital'
      and ${e.occurredAt} >= ${query.from.toISOString()}::timestamptz
      and ${e.occurredAt} < ${query.to.toISOString()}::timestamptz
      and ${e.value} is not null
      ${counted ? sql`and ${counted}` : sql``}
    group by ${e.label}, ${e.path}, coalesce(${e.metricId}, ${e.id}::text)
  )`;
  const overall = await rows<{ metric: string; p75: number | null; samples: number }>(
    ctx,
    sql`select metric, percentile_cont(0.75) within group (order by value)::float8 as p75, count(*)::int as samples from ${loads} as loads group by metric`,
  );
  let byEntryPage: WebVitalsReport["byEntryPage"] = [];
  if (pathLimit > 0) {
    const perPath = await rows<{ path: string; metric: string; p75: number | null; samples: number }>(
      ctx,
      sql`select path, metric, percentile_cont(0.75) within group (order by value)::float8 as p75, count(*)::int as samples from ${loads} as loads group by path, metric`,
    );
    const busiest = [...new Set(perPath.sort((a, b) => n(b.samples) - n(a.samples)).map((row) => row.path))].slice(0, pathLimit);
    byEntryPage = busiest.map((path) => ({ path, metrics: summarizeWebVitals(perPath.filter((row) => row.path === path)) }));
  }
  return { summary: summarizeWebVitals(overall), byEntryPage };
}

/** Raw SQL rows, whichever driver: neon-serverless and PGlite return `{ rows }`, others an array. */
async function rows<T>(ctx: AnalyticsContext, query: SQL): Promise<T[]> {
  const result = (await ctx.db.execute(query)) as unknown as { rows?: T[] } | T[];
  return Array.isArray(result) ? result : (result.rows ?? []);
}

// ---------------------------------------------------------------------------
// AI assistants — the visits they sent, by engine, beside their live fetches.
// ---------------------------------------------------------------------------

export type AiEngineKey = AiEngineId | "other";

export interface AiEngineTraffic {
  engine: AiEngineKey;
  label: string;
  visits: number;
  /** 0–100, null with no visits. */
  engagedRate: number | null;
  conversions: number;
  /** Where its visitors landed, busiest first. */
  landingPages: Array<{ path: string; visits: number }>;
  /**
   * Live fetches by the engine's own assistant bot (ChatGPT-User, Claude-User…)
   * in the range, every path. A User-Agent CLAIM: anyone can send one.
   */
  assistantFetches: number;
  /**
   * Of those, the fetches whose IP was inside the operator's published ranges
   * (needs a crawler verifier; only OpenAI's and Perplexity's assistant bots
   * publish ranges, so for the others this stays 0).
   */
  assistantFetchesVerified: number;
  smallSample: boolean;
}

export interface AiAssistantTraffic {
  /** Visits from AI assistants (the `aiAssistant` source), counted as every other report counts them. */
  visits: number;
  engines: AiEngineTraffic[];
  /**
   * Each page AI assistants sent people to, beside how often an assistant
   * fetched that page live — "ChatGPT-User fetched /pricing 14 times, and 6
   * visits came from ChatGPT".
   */
  pages: Array<{
    path: string;
    visits: number;
    byEngine: Partial<Record<AiEngineKey, number>>;
    /** Assistant-bot fetches of this page (User-Agent claims). */
    assistantFetches: number;
    /** Of those, verified against the operator's published ranges. */
    assistantFetchesVerified: number;
    fetchesByBot: Array<{ botName: string; hits: number; verifiedHits: number }>;
  }>;
}

const OTHER_AI_LABEL = "Other AI assistant";

/**
 * AI-assistant traffic by engine. Sessions in the `aiAssistant` bucket only,
 * attributed with `aiEngineOf` (utm first, then the referrer host); sessions
 * stored before the classifier knew an engine's host stay where they were
 * bucketed until `reclassifySources` runs. Google AI Overviews and AI Mode
 * arrive as google.com and are Search here: the referrer cannot tell them apart.
 */
export async function getAiAssistantTraffic(
  ctx: AnalyticsContext,
  query: ReportQuery,
  options: { landingPagesPerEngine?: number; pageLimit?: number } = {},
): Promise<AiAssistantTraffic> {
  const s = ctx.t.sessions;
  const c = ctx.t.crawlerHits;
  const perEngine = options.landingPagesPerEngine ?? 5;
  const pageLimit = options.pageLimit ?? 20;
  const sessionRows = await ctx.db
    .select({
      referrerHost: s.referrerHost,
      utmSource: s.utmSource,
      path: s.landingPath,
      visits: sql<number>`count(*)::int`,
      engaged: sql<number>`(count(*) filter (where ${s.isEngaged}))::int`,
      converted: sql<number>`(count(*) filter (where ${s.converted}))::int`,
    })
    .from(s)
    .where(and(sessionWindow(ctx, query, query), eq(s.sourceBucket, "aiAssistant")))
    .groupBy(s.referrerHost, s.utmSource, s.landingPath);

  const engines = new Map<AiEngineKey, { visits: number; engaged: number; converted: number; pages: Map<string, number> }>();
  const pages = new Map<string, { visits: number; byEngine: Partial<Record<AiEngineKey, number>> }>();
  for (const row of sessionRows) {
    const engine: AiEngineKey = aiEngineOf({ referrerHost: row.referrerHost, utmSource: row.utmSource }) ?? "other";
    const visits = n(row.visits);
    const entry = engines.get(engine) ?? { visits: 0, engaged: 0, converted: 0, pages: new Map<string, number>() };
    entry.visits += visits;
    entry.engaged += n(row.engaged);
    entry.converted += n(row.converted);
    entry.pages.set(row.path, (entry.pages.get(row.path) ?? 0) + visits);
    engines.set(engine, entry);
    const page = pages.get(row.path) ?? { visits: 0, byEngine: {} };
    page.visits += visits;
    page.byEngine[engine] = (page.byEngine[engine] ?? 0) + visits;
    pages.set(row.path, page);
  }

  const topPages = [...pages.entries()].sort((a, b) => b[1].visits - a[1].visits || a[0].localeCompare(b[0])).slice(0, pageLimit);
  const fetchWhere = and(crawlerWindow(ctx, query, query), eq(c.botKind, "ai-assistant"));
  const hitsSum = sql<number>`coalesce(sum(${c.hits}), 0)::int`;
  const verifiedSum = sql<number>`coalesce(sum(${c.hits}) filter (where ${c.verified}), 0)::int`;
  const [byBot, byPathBot] = await Promise.all([
    ctx.db.select({ botName: c.botName, hits: hitsSum, verified: verifiedSum }).from(c).where(fetchWhere).groupBy(c.botName),
    topPages.length
      ? ctx.db
          .select({ path: c.path, botName: c.botName, hits: hitsSum, verified: verifiedSum })
          .from(c)
          .where(and(fetchWhere, inArray(c.path, topPages.map(([path]) => path))))
          .groupBy(c.path, c.botName)
      : Promise.resolve([] as Array<{ path: string; botName: string; hits: number; verified: number }>),
  ]);
  const fetchesByEngine = new Map<string, { hits: number; verified: number }>();
  for (const row of byBot) {
    const engine = ASSISTANT_BOT_ENGINES[row.botName];
    if (!engine) continue;
    const entry = fetchesByEngine.get(engine) ?? { hits: 0, verified: 0 };
    entry.hits += n(row.hits);
    entry.verified += n(row.verified);
    fetchesByEngine.set(engine, entry);
  }
  const fetchesByPath = new Map<string, Array<{ botName: string; hits: number; verifiedHits: number }>>();
  for (const row of byPathBot) {
    const list = fetchesByPath.get(row.path) ?? [];
    list.push({ botName: row.botName, hits: n(row.hits), verifiedHits: n(row.verified) });
    fetchesByPath.set(row.path, list);
  }

  const engineRows: AiEngineTraffic[] = [...engines.entries()]
    .map(([engine, entry]) => ({
      engine,
      label: engine === "other" ? OTHER_AI_LABEL : AI_ENGINE_LABELS[engine],
      visits: entry.visits,
      engagedRate: entry.visits ? (entry.engaged / entry.visits) * 100 : null,
      conversions: entry.converted,
      landingPages: [...entry.pages.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, perEngine)
        .map(([path, visits]) => ({ path, visits })),
      assistantFetches: engine === "other" ? 0 : (fetchesByEngine.get(engine)?.hits ?? 0),
      assistantFetchesVerified: engine === "other" ? 0 : (fetchesByEngine.get(engine)?.verified ?? 0),
      smallSample: entry.visits < SMALL_SAMPLE,
    }))
    .sort((a, b) => b.visits - a.visits || a.label.localeCompare(b.label));

  return {
    visits: engineRows.reduce((sum, row) => sum + row.visits, 0),
    engines: engineRows,
    pages: topPages.map(([path, page]) => {
      const fetches = (fetchesByPath.get(path) ?? []).sort((a, b) => b.hits - a.hits || a.botName.localeCompare(b.botName));
      return {
        path,
        visits: page.visits,
        byEngine: page.byEngine,
        assistantFetches: fetches.reduce((sum, row) => sum + row.hits, 0),
        assistantFetchesVerified: fetches.reduce((sum, row) => sum + row.verifiedHits, 0),
        fetchesByBot: fetches,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Crawlers
// ---------------------------------------------------------------------------

export interface CrawlerRow {
  botName: string;
  kind: CrawlerKind;
  operator: string | null;
  hits: number;
  verifiedHits: number;
  pages: number;
  lastSeen: string | null;
}

export interface CrawlerReport {
  bots: CrawlerRow[];
  byKind: Record<CrawlerKind, number>;
  aiHits: number;
  aiVerifiedHits: number;
  topPaths: Array<{ path: string; hits: number; aiHits: number; lastAiAt: string | null }>;
}

export async function getCrawlers(ctx: AnalyticsContext, query: ReportQuery, limit = 25): Promise<CrawlerReport> {
  const c = ctx.t.crawlerHits;
  const window = crawlerWindow(ctx, query, query);
  const [bots, kinds, paths] = await Promise.all([
    ctx.db
      .select({
        botName: c.botName,
        kind: c.botKind,
        operator: c.operator,
        hits: sql<number>`coalesce(sum(${c.hits}), 0)::int`,
        verifiedHits: sql<number>`coalesce(sum(${c.hits}) filter (where ${c.verified}), 0)::int`,
        pages: sql<number>`count(distinct ${c.path})::int`,
        lastSeen: max(c.lastAt),
      })
      .from(c)
      .where(window)
      .groupBy(c.botName, c.botKind, c.operator)
      .orderBy(desc(sql`sum(${c.hits})`))
      .limit(limit),
    ctx.db
      .select({
        kind: c.botKind,
        hits: sql<number>`coalesce(sum(${c.hits}), 0)::int`,
        verified: sql<number>`coalesce(sum(${c.hits}) filter (where ${c.verified}), 0)::int`,
      })
      .from(c)
      .where(window)
      .groupBy(c.botKind),
    ctx.db
      .select({
        path: c.path,
        hits: sql<number>`coalesce(sum(${c.hits}), 0)::int`,
        aiHits: sql<number>`coalesce(sum(${c.hits}) filter (where ${inArray(c.botKind, [...AI_KINDS])}), 0)::int`,
        lastAiAt: sql<Date | null>`max(${c.lastAt}) filter (where ${inArray(c.botKind, [...AI_KINDS])})`,
      })
      .from(c)
      .where(window)
      .groupBy(c.path)
      .orderBy(desc(sql`sum(${c.hits})`))
      .limit(20),
  ]);
  const byKind = Object.fromEntries(CRAWLER_KINDS.map((kind) => [kind, 0])) as Record<CrawlerKind, number>;
  let aiVerifiedHits = 0;
  for (const row of kinds) {
    if (row.kind in byKind) byKind[row.kind as CrawlerKind] = n(row.hits);
    if (isAiCrawlerKind(row.kind as CrawlerKind)) aiVerifiedHits += n(row.verified);
  }
  return {
    bots: bots.map((row) => ({
      botName: row.botName,
      kind: row.kind as CrawlerKind,
      operator: row.operator,
      hits: n(row.hits),
      verifiedHits: n(row.verifiedHits),
      pages: n(row.pages),
      lastSeen: row.lastSeen ? new Date(row.lastSeen).toISOString() : null,
    })),
    byKind,
    aiHits: CRAWLER_KINDS.filter(isAiCrawlerKind).reduce((sum, kind) => sum + byKind[kind], 0),
    aiVerifiedHits,
    topPaths: paths.map((row) => ({ path: row.path, hits: n(row.hits), aiHits: n(row.aiHits), lastAiAt: row.lastAiAt ? new Date(row.lastAiAt).toISOString() : null })),
  };
}

export interface AiRead {
  botName: string;
  kind: CrawlerKind;
  operator: string | null;
  path: string;
  at: string;
  verified: boolean;
}

export interface AiReadsQuery {
  tenantId: string;
  paths?: readonly string[];
  since: Date;
  limit?: number;
  /** Include the bots the instance leaves out (`excludeBots`), for this call. */
  includeInternal?: boolean;
}

/**
 * The latest AI reads of the given pages — "someone asked ChatGPT about you
 * and it read /features/feedback, 2 hours ago". Assistant fetches first (a
 * person asked), then search indexes, then training crawlers.
 */
export async function getRecentAiReads(ctx: AnalyticsContext, input: AiReadsQuery): Promise<AiRead[]> {
  if (input.paths && input.paths.length === 0) return [];
  const c = ctx.t.crawlerHits;
  const result = await ctx.db
    .select({
      botName: c.botName,
      kind: c.botKind,
      operator: c.operator,
      path: c.path,
      at: max(c.lastAt),
      verified: sql<boolean>`bool_or(${c.verified})`,
    })
    .from(c)
    .where(
      and(
        eq(c.tenantId, input.tenantId),
        gte(c.bucketStart, input.since),
        inArray(c.botKind, [...AI_KINDS]),
        input.paths ? inArray(c.path, [...input.paths]) : undefined,
        excludedBotsClause(ctx, input),
      ),
    )
    .groupBy(c.botName, c.botKind, c.operator, c.path)
    .orderBy(desc(max(c.lastAt)))
    .limit(input.limit ?? 8);
  const rank: Record<string, number> = { "ai-assistant": 0, "ai-search": 1, "ai-training": 2 };
  return result
    .map((row) => ({
      botName: row.botName,
      kind: row.kind as CrawlerKind,
      operator: row.operator,
      path: row.path,
      at: row.at ? new Date(row.at).toISOString() : new Date(0).toISOString(),
      verified: Boolean(row.verified),
    }))
    .sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || b.at.localeCompare(a.at));
}

export interface AiCoverageQuery {
  tenantId: string;
  paths: readonly string[];
  since: Date;
  /** Include the bots the instance leaves out (`excludeBots`), for this call. */
  includeInternal?: boolean;
}

/** Which of `paths` each AI crawler has read since `since` — coverage, which a flood of forged requests cannot inflate past the page count. */
export async function getAiCoverage(
  ctx: AnalyticsContext,
  input: AiCoverageQuery,
): Promise<{ pathsRead: Map<string, string>; byBot: Array<{ botName: string; kind: CrawlerKind; pages: number }> }> {
  if (input.paths.length === 0) return { pathsRead: new Map(), byBot: [] };
  const c = ctx.t.crawlerHits;
  const where = and(
    eq(c.tenantId, input.tenantId),
    gte(c.bucketStart, input.since),
    inArray(c.botKind, [...AI_KINDS]),
    inArray(c.path, [...input.paths]),
    excludedBotsClause(ctx, input),
  );
  const [byPath, byBot] = await Promise.all([
    ctx.db.select({ path: c.path, at: max(c.lastAt) }).from(c).where(where).groupBy(c.path),
    ctx.db
      .select({ botName: c.botName, kind: c.botKind, pages: sql<number>`count(distinct ${c.path})::int` })
      .from(c)
      .where(where)
      .groupBy(c.botName, c.botKind)
      .orderBy(desc(sql`count(distinct ${c.path})`)),
  ]);
  return {
    pathsRead: new Map(byPath.filter((row) => row.at).map((row) => [row.path, new Date(row.at as Date).toISOString()])),
    byBot: byBot.map((row) => ({ botName: row.botName, kind: row.kind as CrawlerKind, pages: n(row.pages) })),
  };
}

// ---------------------------------------------------------------------------
// The excluded line — delegated to the audience.
// ---------------------------------------------------------------------------

export interface ExcludedQuery extends DateRange {
  tenantId: string;
}

/**
 * "Excluded: 312 sessions (staff 200, automation 112)" for a window — the
 * audience's breakdown over THIS instance's sessions table and tenant, so it
 * is exactly the difference between a report with and without
 * `includeInternal`. Null when no audience is configured: nothing is left out.
 */
export async function getExcludedBreakdown(ctx: AnalyticsContext, window: ExcludedQuery): Promise<AnalyticsExcludedBreakdown | null> {
  const audience = ctx.audienceFor(window.tenantId);
  if (!audience) return null;
  return audience.excludedBreakdown({ from: window.from, to: window.to }, { rows: audienceSessionsSource({ tenantId: window.tenantId, tables: ctx.t }) });
}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

export interface Annotation {
  id: string;
  day: string;
  label: string;
  kind: string;
}

export async function listAnnotations(ctx: AnalyticsContext, query: { tenantId: string; fromDay: string; toDay: string }): Promise<Annotation[]> {
  const a = ctx.t.annotations;
  return ctx.db
    .select({ id: a.id, day: a.day, label: a.label, kind: a.kind })
    .from(a)
    .where(and(eq(a.tenantId, query.tenantId), gte(a.day, query.fromDay), sql`${a.day} <= ${query.toDay}`))
    .orderBy(a.day);
}

export async function addAnnotation(
  ctx: AnalyticsContext,
  input: { tenantId: string; day: string; label: string; kind?: string; createdBy?: string | null },
): Promise<Annotation> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.day)) throw new Error("day must be YYYY-MM-DD");
  const a = ctx.t.annotations;
  const [row] = await ctx.db
    .insert(a)
    .values({ tenantId: input.tenantId, day: input.day, label: input.label.slice(0, 120), kind: input.kind ?? "note", createdBy: input.createdBy ?? null })
    .returning({ id: a.id, day: a.day, label: a.label, kind: a.kind });
  if (!row) throw new Error("annotation insert returned no row");
  return row;
}

export async function deleteAnnotation(ctx: AnalyticsContext, input: { tenantId: string; id: string }): Promise<void> {
  const a = ctx.t.annotations;
  await ctx.db.delete(a).where(and(eq(a.tenantId, input.tenantId), eq(a.id, input.id)));
}

// ---------------------------------------------------------------------------
// The public window
// ---------------------------------------------------------------------------

/** Below this many page loads, a public p75 is noise and is withheld. */
export const PUBLIC_VITALS_MIN_SAMPLES = 50;

export interface PublicSnapshot {
  /** ISO; null before anything was ever recorded. */
  trackingSince: string | null;
  days: number;
  visits: number;
  pageViews: number;
  engagedRate: number | null;
  /** Zero-filled from tracking start, nulls before it. */
  trend: Array<{ date: string; visits: number | null; aiCrawlerHits: number | null }>;
  sources: Array<{ source: SourceBucket; visits: number }>;
  topPages: Array<{ path: string; views: number }>;
  ai: {
    /** Latest AI reads of public pages. */
    recentReads: AiRead[];
    /** Public pages read by any AI crawler in the window, and when last. */
    pagesRead: Array<{ path: string; at: string }>;
    publicPageCount: number;
    /** Public pages each AI crawler read (coverage — bounded by the page count). */
    byBot: Array<{ botName: string; kind: CrawlerKind; pages: number }>;
    hits: number;
    verifiedHits: number;
  };
  /** Withheld (null p75) per metric until it has PUBLIC_VITALS_MIN_SAMPLES loads. */
  webVitals: WebVitalSummary[];
  /** Visits per named event/conversion, for the names the caller asked for. */
  funnel: Record<string, number>;
  computedAt: string;
}

export interface PublicSnapshotInput {
  tenantId: string;
  days: number;
  publicPaths: readonly string[];
  funnel?: readonly string[];
  now?: Date;
  timeZone?: string;
}

/**
 * What a public page may show, aggregates only: visit counts, sources as
 * buckets (never a referrer host), pages and AI reads only for paths in
 * `publicPaths` (applied in SQL, so private paths can neither show nor crowd
 * the list), crawler COVERAGE rather than raw hits as the headline, and vitals
 * only past the sample floor. Dates are ISO strings so the result survives a
 * JSON cache round-trip.
 *
 * It ALWAYS leaves the internal audience out — and the site's own SEO audit —
 * whatever the caller passes: the founder checking their own homepage must
 * never be the homepage's numbers.
 */
export async function getPublicSnapshot(ctx: AnalyticsContext, input: PublicSnapshotInput): Promise<PublicSnapshot> {
  const at = input.now ?? new Date();
  // Built field by field: an `includeInternal` smuggled into `input` never reaches a read.
  const query: ReportQuery = { tenantId: input.tenantId, ...lastDays(input.days, at, zoneOf(input.timeZone)), timeZone: input.timeZone, includeInternal: false };
  const [overall, trend, sources, pages, crawlers, reads, coverage, vitals, since, funnel] = await Promise.all([
    totals(ctx, query, query),
    getDailyTrend(ctx, query),
    getSources(ctx, query),
    getTopPages(ctx, query, 6, input.publicPaths),
    getCrawlers(ctx, query, 0),
    getRecentAiReads(ctx, { tenantId: input.tenantId, paths: input.publicPaths, since: query.from, limit: 6, includeInternal: false }),
    getAiCoverage(ctx, { tenantId: input.tenantId, paths: input.publicPaths, since: query.from, includeInternal: false }),
    getWebVitals(ctx, query, 0),
    getTrackingSince(ctx, input.tenantId),
    getEventVisits(ctx, query, input.funnel ?? []),
  ]);
  return {
    trackingSince: since?.toISOString() ?? null,
    days: input.days,
    visits: overall.visits,
    pageViews: overall.pageViews,
    engagedRate: overall.visits ? (overall.engaged / overall.visits) * 100 : null,
    trend: trend.map((point) => ({ date: point.date, visits: point.visits, aiCrawlerHits: point.aiCrawlerHits })),
    sources: sources.filter((row) => row.visits > 0).map((row) => ({ source: row.source, visits: row.visits })),
    topPages: pages.map((row) => ({ path: row.path, views: row.views })),
    ai: {
      recentReads: reads,
      pagesRead: [...coverage.pathsRead.entries()].map(([path, readAt]) => ({ path, at: readAt })).sort((a, b) => b.at.localeCompare(a.at)),
      publicPageCount: input.publicPaths.length,
      byBot: coverage.byBot,
      hits: crawlers.aiHits,
      verifiedHits: crawlers.aiVerifiedHits,
    },
    webVitals: vitals.summary.map((entry) => (entry.samples >= PUBLIC_VITALS_MIN_SAMPLES ? entry : { ...entry, p75: null, rating: null })),
    funnel,
    computedAt: at.toISOString(),
  };
}
