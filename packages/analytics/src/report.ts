import { AnalyticsError, type AnalyticsExcludedBreakdown } from "./context.js";
import type { Analytics } from "./instance.js";
import { lastDays } from "./periods.js";
import type { CrawlerReport } from "./reports.js";
import { ANALYTICS_WIRE_VERSION, type ExcludedWire, type WebsiteFilterWire, type WebsiteReportWire } from "./wire.js";

/**
 * THE REPORT ADAPTER (0.3): everything the traffic dashboard draws for one
 * tenant, in one call, as plain JSON — over the instance's own reports, so
 * the internal audience is left out of every number exactly as the reports
 * leave it out.
 *
 *   const report = await buildWebsiteReport(analytics, { tenantId, days: 30, timeZone });
 *   <WebsiteTraffic initial={report} transport={…} />
 *
 * The package's admin handlers answer `v1/report` with it; a host app with
 * its own routes, server actions or tRPC calls it directly and hands the
 * result to the component. It reads only the tenant it is given.
 */

export const REPORT_DAYS = [7, 30, 90] as const;
export type ReportDays = (typeof REPORT_DAYS)[number];

/** A requested range, as one of the three the dashboard offers (30 for anything else). */
export function reportDaysOf(value: unknown): ReportDays {
  const n = typeof value === "string" ? Number(value) : value;
  return (REPORT_DAYS as readonly unknown[]).includes(n) ? (n as ReportDays) : 30;
}

/**
 * The excluded line's words per reason, for a business owner reading their
 * own numbers ("you and your team", not "staff"). Reasons the package does not
 * know are shown as they are.
 */
export const EXCLUDED_REASON_WORDS: Readonly<Record<string, string>> = {
  role: "your team",
  named_user: "named people",
  email: "named people",
  domain: "email domain",
  pattern: "test sign-ups",
  org: "your organization",
  event: "tests",
  order: "tests",
  device: "devices marked as yours",
  network: "office network",
  manual: "marked by hand",
  automation: "automation",
  bot: "bots",
  non_production: "test sites",
};

/** "Left out: 12 visits (your team 10, automation 2)." — or that nobody was left out. */
export function excludedWords(excluded: AnalyticsExcludedBreakdown): string {
  const unit = excluded.unit === "sessions" ? "visits" : excluded.unit;
  if (excluded.total === 0) return `Left out: no ${unit} in this range.`;
  const parts = Object.entries(excluded.byReason)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${EXCLUDED_REASON_WORDS[reason] ?? reason.replace(/_/g, " ")} ${count.toLocaleString("en-US")}`);
  const total = excluded.total.toLocaleString("en-US");
  const noun = excluded.total === 1 && unit === "visits" ? "visit" : unit;
  return `Left out: ${total} ${noun}${parts.length ? ` (${parts.join(", ")})` : ""}.`;
}

function toExcludedWire(excluded: AnalyticsExcludedBreakdown | null): ExcludedWire | null {
  if (!excluded) return null;
  const byReason: Record<string, number> = {};
  for (const [reason, count] of Object.entries(excluded.byReason)) if (typeof count === "number") byReason[reason] = count;
  return { total: excluded.total, byReason, unit: excluded.unit, sentence: excludedWords(excluded) };
}

const EMPTY_CRAWLERS: CrawlerReport = {
  bots: [],
  byKind: { "ai-assistant": 0, "ai-search": 0, "ai-training": 0, search: 0, social: 0, "seo-tool": 0, other: 0 },
  aiHits: 0,
  aiVerifiedHits: 0,
  topPaths: [],
};

export interface WebsiteReportInput {
  tenantId: string;
  /** 7, 30 or 90 local days ending today. Default 30. */
  days?: number;
  /** Every website ("all", the default), the tenant's own pages here ("pages"), or one website's id. */
  site?: WebsiteFilterWire | null;
  /** Count everyone, the tenant's own people too — for this one call. Default false. */
  includeInternal?: boolean;
  /** The IANA zone the days are drawn in (the company's). Default UTC. */
  timeZone?: string | null;
  /** What the dashboard calls the tenant's own pages here ("Your pages on Lawnco"). */
  ownPagesLabel?: string;
  now?: Date;
}

/**
 * One tenant's traffic report. A `site` that is not one of the tenant's
 * websites (removed ones included: their history is still theirs) throws
 * `AnalyticsError("not_found")` — another tenant's website id is no
 * different from one that never existed.
 */
export async function buildWebsiteReport(analytics: Analytics, input: WebsiteReportInput): Promise<WebsiteReportWire> {
  const tenantId = input.tenantId;
  const days = reportDaysOf(input.days);
  const timeZone = input.timeZone || "UTC";
  const range = lastDays(days, input.now ?? new Date(), timeZone);
  const includeInternal = input.includeInternal === true;
  const websites = await analytics.listWebsites(tenantId, { includeRemoved: true });
  const site: WebsiteFilterWire = input.site ?? "all";
  if (site !== "all" && site !== "pages" && !websites.some((website) => website.id === site)) {
    throw new AnalyticsError("not_found", "That website isn't here.");
  }
  const siteId: string | null | undefined = site === "all" ? undefined : site === "pages" ? null : site;
  const query = { tenantId, ...range, timeZone, includeInternal, ...(siteId !== undefined ? { siteId } : {}) };
  // Crawlers are logged where THIS deployment serves the page: a company's
  // pages here. A website of its own never sees them, so its filter shows none.
  const crawlersHere = siteId === undefined || siteId === null;
  const [overview, trend, sources, referrers, ai, topPages, crawlers, excluded, health] = await Promise.all([
    analytics.getOverview(query),
    analytics.getDailyTrend(query),
    analytics.getSources(query),
    analytics.getReferrers(query, 40),
    analytics.getAiAssistantTraffic(query, { landingPagesPerEngine: 3, pageLimit: 10 }),
    analytics.getTopPages(query, 15),
    crawlersHere ? analytics.getCrawlers(query, 12) : Promise.resolve(EMPTY_CRAWLERS),
    analytics.getExcludedBreakdown({ tenantId, from: range.from, to: range.to, ...(siteId !== undefined ? { siteId } : {}) }),
    analytics.getPipelineHealth(tenantId),
  ]);
  return {
    version: ANALYTICS_WIRE_VERSION,
    range: { days, from: range.from.toISOString(), to: range.to.toISOString(), timeZone },
    site,
    websites: websites.map((website) => ({ id: website.id, name: website.removedAt ? `${website.name} (removed)` : website.name })),
    ownPagesLabel: input.ownPagesLabel ?? "Your pages here",
    includeInternal,
    trackingSince: overview.trackingSince,
    overview: {
      visits: overview.visits,
      dailyVisitors: overview.dailyVisitors,
      pageViews: overview.pageViews,
      engagedVisits: overview.engagedVisits,
      conversions: overview.conversions,
      engagedRate: overview.engagedRate,
      avgEngagedMs: overview.avgEngagedMs,
      pagesPerVisit: overview.pagesPerVisit,
    },
    trend,
    sources,
    searchEngines: referrers.filter((row) => row.source === "organic").map((row) => ({ host: row.host, visits: row.visits })),
    referrers: referrers.filter((row) => row.source !== "organic").slice(0, 15),
    ai: {
      visits: ai.visits,
      engines: ai.engines.map((engine) => ({
        engine: engine.engine,
        label: engine.label,
        visits: engine.visits,
        engagedRate: engine.engagedRate,
        conversions: engine.conversions,
        assistantFetches: engine.assistantFetches,
        assistantFetchesVerified: engine.assistantFetchesVerified,
      })),
    },
    topPages,
    crawlers,
    excluded: includeInternal ? null : toExcludedWire(excluded),
    health,
  };
}
