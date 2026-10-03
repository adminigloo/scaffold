import { and, count, desc, eq, gte, inArray, lt, max, sql, type SQL } from "drizzle-orm";
import type { AnalyticsDb } from "./ingest.js";
import {
  analyticsAnnotations,
  analyticsCrawlerHits,
  analyticsEvents,
  analyticsPageViews,
  analyticsSessions,
  analyticsSites,
} from "./schema.js";
import { SOURCE_BUCKETS, type SourceBucket } from "./sources.js";
import { CRAWLER_KINDS, isAiCrawlerKind, type CrawlerKind } from "./crawlers.js";
import { deltaPct, lastDays, priorPeriod, SMALL_SAMPLE, type DateRange } from "./periods.js";
import { summarizeWebVitals, type WebVitalSummary } from "./vitals.js";

/**
 * Every report the dashboard and the public window draw, as plain async
 * functions over the injected db. Ranges are half-open [from, to). Humans
 * only in the session tables — crawlers are dropped at ingest and live in
 * their own table — so there is no `is_bot` filter to forget (trailcards had
 * two reports that counted bots and the rest did not).
 *
 * Aggregates are cast to int/float8 in SQL: the pg driver returns int8 and
 * numeric as strings, and a string sum concatenates.
 */

export interface ReportQuery extends DateRange {
  tenantId: string;
  /** IANA zone the day buckets are drawn in. Default UTC. */
  timeZone?: string;
}

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

function sessionWindow(tenantId: string, range: DateRange): SQL | undefined {
  return and(eq(analyticsSessions.tenantId, tenantId), gte(analyticsSessions.startedAt, range.from), lt(analyticsSessions.startedAt, range.to));
}

function crawlerWindow(tenantId: string, range: DateRange): SQL | undefined {
  return and(eq(analyticsCrawlerHits.tenantId, tenantId), gte(analyticsCrawlerHits.bucketStart, range.from), lt(analyticsCrawlerHits.bucketStart, range.to));
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
export async function getTrackingSince(db: AnalyticsDb, tenantId: string): Promise<Date | null> {
  const [row] = await db.select({ at: analyticsSites.trackingSince }).from(analyticsSites).where(eq(analyticsSites.tenantId, tenantId)).limit(1);
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

async function totals(db: AnalyticsDb, tenantId: string, range: DateRange) {
  const [row] = await db
    .select({
      visits: sql<number>`count(*)::int`,
      visitors: sql<number>`count(distinct ${analyticsSessions.visitorKey})::int`,
      pageViews: sql<number>`coalesce(sum(${analyticsSessions.pageViewCount}), 0)::int`,
      engaged: sql<number>`(count(*) filter (where ${analyticsSessions.isEngaged}))::int`,
      converted: sql<number>`(count(*) filter (where ${analyticsSessions.converted}))::int`,
      durationMs: sql<number>`coalesce(sum(${analyticsSessions.durationMs}), 0)::float8`,
    })
    .from(analyticsSessions)
    .where(sessionWindow(tenantId, range));
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

export async function getOverview(db: AnalyticsDb, query: ReportQuery): Promise<Overview> {
  const prior = priorPeriod(query);
  const [current, before, since] = await Promise.all([totals(db, query.tenantId, query), totals(db, query.tenantId, prior), getTrackingSince(db, query.tenantId)]);
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

export async function getDailyTrend(db: AnalyticsDb, query: ReportQuery): Promise<TrendPoint[]> {
  const zone = zoneOf(query.timeZone);
  const day = sql<string>`to_char(${analyticsSessions.startedAt} at time zone ${zoneLiteral(zone)}, 'YYYY-MM-DD')`;
  const hitDay = sql<string>`to_char(${analyticsCrawlerHits.bucketStart} at time zone ${zoneLiteral(zone)}, 'YYYY-MM-DD')`;
  const [sessionRows, hitRows, since] = await Promise.all([
    db
      .select({
        date: day,
        visits: sql<number>`count(*)::int`,
        visitors: sql<number>`count(distinct ${analyticsSessions.visitorKey})::int`,
        pageViews: sql<number>`coalesce(sum(${analyticsSessions.pageViewCount}), 0)::int`,
        engaged: sql<number>`(count(*) filter (where ${analyticsSessions.isEngaged}))::int`,
      })
      .from(analyticsSessions)
      .where(sessionWindow(query.tenantId, query))
      .groupBy(day),
    db
      .select({ date: hitDay, hits: sql<number>`coalesce(sum(${analyticsCrawlerHits.hits}), 0)::int` })
      .from(analyticsCrawlerHits)
      .where(and(crawlerWindow(query.tenantId, query), inArray(analyticsCrawlerHits.botKind, [...AI_KINDS])))
      .groupBy(hitDay),
    getTrackingSince(db, query.tenantId),
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

export async function getSources(db: AnalyticsDb, query: ReportQuery): Promise<SourceRow[]> {
  const read = (range: DateRange) =>
    db
      .select({
        source: analyticsSessions.sourceBucket,
        visits: sql<number>`count(*)::int`,
        engaged: sql<number>`(count(*) filter (where ${analyticsSessions.isEngaged}))::int`,
      })
      .from(analyticsSessions)
      .where(sessionWindow(query.tenantId, range))
      .groupBy(analyticsSessions.sourceBucket);
  const prior = priorPeriod(query);
  const [current, before, since] = await Promise.all([read(query), read(prior), getTrackingSince(db, query.tenantId)]);
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

export async function getReferrers(db: AnalyticsDb, query: ReportQuery, limit = 20): Promise<Array<{ host: string; source: SourceBucket; visits: number }>> {
  const rows = await db
    .select({ host: analyticsSessions.referrerHost, source: analyticsSessions.sourceBucket, visits: sql<number>`count(*)::int` })
    .from(analyticsSessions)
    .where(and(sessionWindow(query.tenantId, query), sql`${analyticsSessions.referrerHost} is not null`))
    .groupBy(analyticsSessions.referrerHost, analyticsSessions.sourceBucket)
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

export async function getCampaigns(db: AnalyticsDb, query: ReportQuery, limit = 20): Promise<CampaignRow[]> {
  const rows = await db
    .select({
      campaign: analyticsSessions.utmCampaign,
      source: analyticsSessions.utmSource,
      medium: analyticsSessions.utmMedium,
      visits: sql<number>`count(*)::int`,
      engaged: sql<number>`(count(*) filter (where ${analyticsSessions.isEngaged}))::int`,
      conversions: sql<number>`(count(*) filter (where ${analyticsSessions.converted}))::int`,
    })
    .from(analyticsSessions)
    .where(and(sessionWindow(query.tenantId, query), sql`${analyticsSessions.utmCampaign} is not null`))
    .groupBy(analyticsSessions.utmCampaign, analyticsSessions.utmSource, analyticsSessions.utmMedium)
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

export async function getBreakdown(db: AnalyticsDb, query: ReportQuery, dimension: BreakdownDimension, limit = 15): Promise<Array<{ value: string; visits: number }>> {
  const column = { country: analyticsSessions.country, device: analyticsSessions.device, browser: analyticsSessions.browser, os: analyticsSessions.os }[dimension];
  const rows = await db
    .select({ value: column, visits: sql<number>`count(*)::int` })
    .from(analyticsSessions)
    .where(sessionWindow(query.tenantId, query))
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

export async function getEngagementBySource(db: AnalyticsDb, query: ReportQuery): Promise<EngagementRow[]> {
  const rows = await db
    .select({
      source: analyticsSessions.sourceBucket,
      visits: sql<number>`count(*)::int`,
      engaged: sql<number>`(count(*) filter (where ${analyticsSessions.isEngaged}))::int`,
      converted: sql<number>`(count(*) filter (where ${analyticsSessions.converted}))::int`,
      durationMs: sql<number>`coalesce(sum(${analyticsSessions.durationMs}), 0)::float8`,
      pageViews: sql<number>`coalesce(sum(${analyticsSessions.pageViewCount}), 0)::int`,
    })
    .from(analyticsSessions)
    .where(sessionWindow(query.tenantId, query))
    .groupBy(analyticsSessions.sourceBucket)
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
export async function getActivity(db: AnalyticsDb, query: ReportQuery): Promise<ActivityReport> {
  const zone = zoneOf(query.timeZone);
  const local = sql`(${analyticsSessions.startedAt} at time zone ${zoneLiteral(zone)})`;
  const weekday = sql<number>`extract(dow from ${local})::int`;
  const hour = sql<number>`extract(hour from ${local})::int`;
  const result = await db
    .select({ weekday, hour, visits: sql<number>`count(*)::int` })
    .from(analyticsSessions)
    .where(sessionWindow(query.tenantId, query))
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

export async function getTopPages(db: AnalyticsDb, query: ReportQuery, limit = 20, onlyPaths?: readonly string[]): Promise<Array<{ path: string; views: number; visits: number }>> {
  if (onlyPaths && onlyPaths.length === 0) return [];
  const rows = await db
    .select({ path: analyticsPageViews.path, views: sql<number>`count(*)::int`, visits: sql<number>`count(distinct ${analyticsPageViews.sessionId})::int` })
    .from(analyticsPageViews)
    .where(
      and(
        eq(analyticsPageViews.tenantId, query.tenantId),
        gte(analyticsPageViews.occurredAt, query.from),
        lt(analyticsPageViews.occurredAt, query.to),
        onlyPaths ? inArray(analyticsPageViews.path, [...onlyPaths]) : undefined,
      ),
    )
    .groupBy(analyticsPageViews.path)
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

export async function getLandingPages(db: AnalyticsDb, query: ReportQuery, limit = 20): Promise<LandingRow[]> {
  const rows = await db
    .select({
      path: analyticsSessions.landingPath,
      visits: sql<number>`count(*)::int`,
      engaged: sql<number>`(count(*) filter (where ${analyticsSessions.isEngaged}))::int`,
      converted: sql<number>`(count(*) filter (where ${analyticsSessions.converted}))::int`,
      durationMs: sql<number>`coalesce(sum(${analyticsSessions.durationMs}), 0)::float8`,
    })
    .from(analyticsSessions)
    .where(sessionWindow(query.tenantId, query))
    .groupBy(analyticsSessions.landingPath)
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
export async function getTopClicks(db: AnalyticsDb, query: ReportQuery, limit = 20): Promise<Array<{ name: string; label: string | null; clicks: number; visits: number }>> {
  const rows = await db
    .select({ name: analyticsEvents.name, label: analyticsEvents.label, clicks: sql<number>`count(*)::int`, visits: sql<number>`count(distinct ${analyticsEvents.sessionId})::int` })
    .from(analyticsEvents)
    .where(and(eq(analyticsEvents.tenantId, query.tenantId), gte(analyticsEvents.occurredAt, query.from), lt(analyticsEvents.occurredAt, query.to), sql`${analyticsEvents.name} <> 'web_vital'`))
    .groupBy(analyticsEvents.name, analyticsEvents.label)
    .orderBy(desc(count()))
    .limit(limit);
  return rows.map((row) => ({ name: row.name, label: row.label, clicks: n(row.clicks), visits: n(row.visits) }));
}

/**
 * Visits that did each named thing — a click event by its name, or a
 * conversion by its label — for a funnel: "37 visits · 9 pressed the demo ·
 * 3 filed a ticket". Distinct visits, so a visitor pressing twice counts once.
 */
export async function getEventVisits(db: AnalyticsDb, query: ReportQuery, names: readonly string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = Object.fromEntries(names.map((name) => [name, 0]));
  if (names.length === 0) return out;
  const key = sql<string>`case when ${analyticsEvents.name} = 'conversion' then ${analyticsEvents.label} else ${analyticsEvents.name} end`;
  const result = await db
    .select({ key, visits: sql<number>`count(distinct ${analyticsEvents.sessionId})::int` })
    .from(analyticsEvents)
    .where(
      and(
        eq(analyticsEvents.tenantId, query.tenantId),
        gte(analyticsEvents.occurredAt, query.from),
        lt(analyticsEvents.occurredAt, query.to),
        sql`(${inArray(analyticsEvents.name, [...names])} or (${analyticsEvents.name} = 'conversion' and ${inArray(analyticsEvents.label, [...names])}))`,
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
export async function getWebVitals(db: AnalyticsDb, query: ReportQuery, pathLimit = 10): Promise<WebVitalsReport> {
  const loads = sql`(
    select ${analyticsEvents.label} as metric, ${analyticsEvents.path} as path, max(${analyticsEvents.value}) as value
    from ${analyticsEvents}
    where ${analyticsEvents.tenantId} = ${query.tenantId}
      and ${analyticsEvents.name} = 'web_vital'
      and ${analyticsEvents.occurredAt} >= ${query.from.toISOString()}::timestamptz
      and ${analyticsEvents.occurredAt} < ${query.to.toISOString()}::timestamptz
      and ${analyticsEvents.value} is not null
    group by ${analyticsEvents.label}, ${analyticsEvents.path}, coalesce(${analyticsEvents.metricId}, ${analyticsEvents.id}::text)
  )`;
  const overall = await rows<{ metric: string; p75: number | null; samples: number }>(
    db,
    sql`select metric, percentile_cont(0.75) within group (order by value)::float8 as p75, count(*)::int as samples from ${loads} as loads group by metric`,
  );
  let byEntryPage: WebVitalsReport["byEntryPage"] = [];
  if (pathLimit > 0) {
    const perPath = await rows<{ path: string; metric: string; p75: number | null; samples: number }>(
      db,
      sql`select path, metric, percentile_cont(0.75) within group (order by value)::float8 as p75, count(*)::int as samples from ${loads} as loads group by path, metric`,
    );
    const busiest = [...new Set(perPath.sort((a, b) => n(b.samples) - n(a.samples)).map((row) => row.path))].slice(0, pathLimit);
    byEntryPage = busiest.map((path) => ({ path, metrics: summarizeWebVitals(perPath.filter((row) => row.path === path)) }));
  }
  return { summary: summarizeWebVitals(overall), byEntryPage };
}

/** Raw SQL rows, whichever driver: neon-serverless returns `{ rows }`, others an array. */
async function rows<T>(db: AnalyticsDb, query: SQL): Promise<T[]> {
  const result = (await db.execute(query)) as unknown as { rows?: T[] } | T[];
  return Array.isArray(result) ? result : (result.rows ?? []);
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

export async function getCrawlers(db: AnalyticsDb, query: ReportQuery, limit = 25): Promise<CrawlerReport> {
  const window = crawlerWindow(query.tenantId, query);
  const [bots, kinds, paths] = await Promise.all([
    db
      .select({
        botName: analyticsCrawlerHits.botName,
        kind: analyticsCrawlerHits.botKind,
        operator: analyticsCrawlerHits.operator,
        hits: sql<number>`coalesce(sum(${analyticsCrawlerHits.hits}), 0)::int`,
        verifiedHits: sql<number>`coalesce(sum(${analyticsCrawlerHits.hits}) filter (where ${analyticsCrawlerHits.verified}), 0)::int`,
        pages: sql<number>`count(distinct ${analyticsCrawlerHits.path})::int`,
        lastSeen: max(analyticsCrawlerHits.lastAt),
      })
      .from(analyticsCrawlerHits)
      .where(window)
      .groupBy(analyticsCrawlerHits.botName, analyticsCrawlerHits.botKind, analyticsCrawlerHits.operator)
      .orderBy(desc(sql`sum(${analyticsCrawlerHits.hits})`))
      .limit(limit),
    db
      .select({
        kind: analyticsCrawlerHits.botKind,
        hits: sql<number>`coalesce(sum(${analyticsCrawlerHits.hits}), 0)::int`,
        verified: sql<number>`coalesce(sum(${analyticsCrawlerHits.hits}) filter (where ${analyticsCrawlerHits.verified}), 0)::int`,
      })
      .from(analyticsCrawlerHits)
      .where(window)
      .groupBy(analyticsCrawlerHits.botKind),
    db
      .select({
        path: analyticsCrawlerHits.path,
        hits: sql<number>`coalesce(sum(${analyticsCrawlerHits.hits}), 0)::int`,
        aiHits: sql<number>`coalesce(sum(${analyticsCrawlerHits.hits}) filter (where ${inArray(analyticsCrawlerHits.botKind, [...AI_KINDS])}), 0)::int`,
        lastAiAt: sql<Date | null>`max(${analyticsCrawlerHits.lastAt}) filter (where ${inArray(analyticsCrawlerHits.botKind, [...AI_KINDS])})`,
      })
      .from(analyticsCrawlerHits)
      .where(window)
      .groupBy(analyticsCrawlerHits.path)
      .orderBy(desc(sql`sum(${analyticsCrawlerHits.hits})`))
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

/**
 * The latest AI reads of the given pages — "someone asked ChatGPT about you
 * and it read /features/feedback, 2 hours ago". Assistant fetches first (a
 * person asked), then search indexes, then training crawlers.
 */
export async function getRecentAiReads(db: AnalyticsDb, input: { tenantId: string; paths?: readonly string[]; since: Date; limit?: number }): Promise<AiRead[]> {
  if (input.paths && input.paths.length === 0) return [];
  const result = await db
    .select({
      botName: analyticsCrawlerHits.botName,
      kind: analyticsCrawlerHits.botKind,
      operator: analyticsCrawlerHits.operator,
      path: analyticsCrawlerHits.path,
      at: max(analyticsCrawlerHits.lastAt),
      verified: sql<boolean>`bool_or(${analyticsCrawlerHits.verified})`,
    })
    .from(analyticsCrawlerHits)
    .where(
      and(
        eq(analyticsCrawlerHits.tenantId, input.tenantId),
        gte(analyticsCrawlerHits.bucketStart, input.since),
        inArray(analyticsCrawlerHits.botKind, [...AI_KINDS]),
        input.paths ? inArray(analyticsCrawlerHits.path, [...input.paths]) : undefined,
      ),
    )
    .groupBy(analyticsCrawlerHits.botName, analyticsCrawlerHits.botKind, analyticsCrawlerHits.operator, analyticsCrawlerHits.path)
    .orderBy(desc(max(analyticsCrawlerHits.lastAt)))
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

/** Which of `paths` each AI crawler has read since `since` — coverage, which a flood of forged requests cannot inflate past the page count. */
export async function getAiCoverage(db: AnalyticsDb, input: { tenantId: string; paths: readonly string[]; since: Date }): Promise<{ pathsRead: Map<string, string>; byBot: Array<{ botName: string; kind: CrawlerKind; pages: number }> }> {
  if (input.paths.length === 0) return { pathsRead: new Map(), byBot: [] };
  const where = and(
    eq(analyticsCrawlerHits.tenantId, input.tenantId),
    gte(analyticsCrawlerHits.bucketStart, input.since),
    inArray(analyticsCrawlerHits.botKind, [...AI_KINDS]),
    inArray(analyticsCrawlerHits.path, [...input.paths]),
  );
  const [byPath, byBot] = await Promise.all([
    db.select({ path: analyticsCrawlerHits.path, at: max(analyticsCrawlerHits.lastAt) }).from(analyticsCrawlerHits).where(where).groupBy(analyticsCrawlerHits.path),
    db
      .select({ botName: analyticsCrawlerHits.botName, kind: analyticsCrawlerHits.botKind, pages: sql<number>`count(distinct ${analyticsCrawlerHits.path})::int` })
      .from(analyticsCrawlerHits)
      .where(where)
      .groupBy(analyticsCrawlerHits.botName, analyticsCrawlerHits.botKind)
      .orderBy(desc(sql`count(distinct ${analyticsCrawlerHits.path})`)),
  ]);
  return {
    pathsRead: new Map(byPath.filter((row) => row.at).map((row) => [row.path, new Date(row.at as Date).toISOString()])),
    byBot: byBot.map((row) => ({ botName: row.botName, kind: row.kind as CrawlerKind, pages: n(row.pages) })),
  };
}

// ---------------------------------------------------------------------------
// Pipeline health — so the reports can never be silently empty.
// ---------------------------------------------------------------------------

export interface PipelineHealth {
  trackingSince: string | null;
  lastPageView: string | null;
  lastEvent: string | null;
  lastWebVital: string | null;
  lastConversion: string | null;
  lastCrawlerHit: string | null;
  lastAiCrawlerHit: string | null;
}

export async function getPipelineHealth(db: AnalyticsDb, tenantId: string): Promise<PipelineHealth> {
  const iso = (value: unknown) => (value ? new Date(value as Date).toISOString() : null);
  const [since, pv, ev, vital, conv, hit, aiHit] = await Promise.all([
    getTrackingSince(db, tenantId),
    db.select({ at: max(analyticsPageViews.occurredAt) }).from(analyticsPageViews).where(eq(analyticsPageViews.tenantId, tenantId)),
    db.select({ at: max(analyticsEvents.occurredAt) }).from(analyticsEvents).where(and(eq(analyticsEvents.tenantId, tenantId), sql`${analyticsEvents.name} not in ('web_vital', 'conversion')`)),
    db.select({ at: max(analyticsEvents.occurredAt) }).from(analyticsEvents).where(and(eq(analyticsEvents.tenantId, tenantId), eq(analyticsEvents.name, "web_vital"))),
    db.select({ at: max(analyticsEvents.occurredAt) }).from(analyticsEvents).where(and(eq(analyticsEvents.tenantId, tenantId), eq(analyticsEvents.name, "conversion"))),
    db.select({ at: max(analyticsCrawlerHits.lastAt) }).from(analyticsCrawlerHits).where(eq(analyticsCrawlerHits.tenantId, tenantId)),
    db.select({ at: max(analyticsCrawlerHits.lastAt) }).from(analyticsCrawlerHits).where(and(eq(analyticsCrawlerHits.tenantId, tenantId), inArray(analyticsCrawlerHits.botKind, [...AI_KINDS]))),
  ]);
  return {
    trackingSince: since?.toISOString() ?? null,
    lastPageView: iso(pv[0]?.at),
    lastEvent: iso(ev[0]?.at),
    lastWebVital: iso(vital[0]?.at),
    lastConversion: iso(conv[0]?.at),
    lastCrawlerHit: iso(hit[0]?.at),
    lastAiCrawlerHit: iso(aiHit[0]?.at),
  };
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

export async function listAnnotations(db: AnalyticsDb, query: { tenantId: string; fromDay: string; toDay: string }): Promise<Annotation[]> {
  return db
    .select({ id: analyticsAnnotations.id, day: analyticsAnnotations.day, label: analyticsAnnotations.label, kind: analyticsAnnotations.kind })
    .from(analyticsAnnotations)
    .where(and(eq(analyticsAnnotations.tenantId, query.tenantId), gte(analyticsAnnotations.day, query.fromDay), sql`${analyticsAnnotations.day} <= ${query.toDay}`))
    .orderBy(analyticsAnnotations.day);
}

export async function addAnnotation(db: AnalyticsDb, input: { tenantId: string; day: string; label: string; kind?: string; createdBy?: string | null }): Promise<Annotation> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.day)) throw new Error("day must be YYYY-MM-DD");
  const [row] = await db
    .insert(analyticsAnnotations)
    .values({ tenantId: input.tenantId, day: input.day, label: input.label.slice(0, 120), kind: input.kind ?? "note", createdBy: input.createdBy ?? null })
    .returning({ id: analyticsAnnotations.id, day: analyticsAnnotations.day, label: analyticsAnnotations.label, kind: analyticsAnnotations.kind });
  if (!row) throw new Error("annotation insert returned no row");
  return row;
}

export async function deleteAnnotation(db: AnalyticsDb, input: { tenantId: string; id: string }): Promise<void> {
  await db.delete(analyticsAnnotations).where(and(eq(analyticsAnnotations.tenantId, input.tenantId), eq(analyticsAnnotations.id, input.id)));
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

/**
 * What a public page may show, aggregates only: visit counts, sources as
 * buckets (never a referrer host), pages and AI reads only for paths in
 * `publicPaths` (applied in SQL, so private paths can neither show nor crowd
 * the list), crawler COVERAGE rather than raw hits as the headline, and vitals
 * only past the sample floor. Dates are ISO strings so the result survives a
 * JSON cache round-trip.
 */
export async function getPublicSnapshot(
  db: AnalyticsDb,
  input: { tenantId: string; days: number; publicPaths: readonly string[]; funnel?: readonly string[]; now?: Date; timeZone?: string },
): Promise<PublicSnapshot> {
  const at = input.now ?? new Date();
  const query: ReportQuery = { tenantId: input.tenantId, ...lastDays(input.days, at, zoneOf(input.timeZone)), timeZone: input.timeZone };
  const [overall, trend, sources, pages, crawlers, reads, coverage, vitals, since, funnel] = await Promise.all([
    totals(db, input.tenantId, query),
    getDailyTrend(db, query),
    getSources(db, query),
    getTopPages(db, query, 6, input.publicPaths),
    getCrawlers(db, query, 0),
    getRecentAiReads(db, { tenantId: input.tenantId, paths: input.publicPaths, since: query.from, limit: 6 }),
    getAiCoverage(db, { tenantId: input.tenantId, paths: input.publicPaths, since: query.from }),
    getWebVitals(db, query, 0),
    getTrackingSince(db, input.tenantId),
    getEventVisits(db, query, input.funnel ?? []),
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
