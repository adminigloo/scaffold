import { createAnalytics, lastDays, SOURCE_LABELS } from "@adminigloo/analytics";
import { plural, type Glance, type GlanceRow, type GlanceTile } from "../glance.js";
import type { DashboardDb } from "../handlers.js";

/**
 * The glance over @adminigloo/analytics: this site's own visits. Built on
 * the package's own reports (`createAnalytics({ db }).get…`) rather than
 * re-querying its tables — `getDailyTrend` already buckets by day in the
 * right zone, and `getSources` already groups by where a visit came from,
 * so "today", "this week" and the spark are all read off those two calls
 * instead of three more custom ones.
 */
export interface AnalyticsGlanceInput {
  readonly db: DashboardDb;
  readonly tenantId: string;
  readonly now: Date;
  /** The day the trend and "today" are cut on. Default UTC. */
  readonly timeZone?: string;
  /** The report page. */
  readonly href?: string;
}

const SPARK_DAYS = 14;
const WEEK_DAYS = 7;

export async function visitsGlance(input: AnalyticsGlanceInput): Promise<Glance> {
  const { tenantId, now } = input;
  const href = input.href ?? "/admin/analytics";
  const timeZone = input.timeZone ?? "UTC";
  const analytics = createAnalytics({ db: input.db });

  const since = await analytics.getTrackingSince(tenantId);
  if (!since) {
    return {
      setup: {
        text: "No website is sending visits yet. Add the tracking snippet to a page to start counting.",
        href,
        label: "Set up analytics",
      },
    };
  }

  const spark = lastDays(SPARK_DAYS, now, timeZone);
  const week = lastDays(WEEK_DAYS, now, timeZone);
  const [trend, sources] = await Promise.all([
    analytics.getDailyTrend({ tenantId, ...spark, timeZone }),
    analytics.getSources({ tenantId, ...week, timeZone }),
  ]);

  // The trend already covers the last 14 days, oldest first: "today" is its
  // last point, "this week" the sum of its last 7 — one query answers all
  // three instead of three separate ones re-asking the same table.
  const points = trend.map((point) => point.visits ?? 0);
  const todayVisits = points.at(-1) ?? 0;
  const weekVisits = points.slice(-WEEK_DAYS).reduce((sum, value) => sum + value, 0);

  const aiVisits = sources.find((row) => row.source === "aiAssistant")?.visits ?? 0;
  const searchVisits = sources.find((row) => row.source === "organic")?.visits ?? 0;

  const tiles: GlanceTile[] = [
    { label: "Today", value: todayVisits, href },
    { label: "Last 7 days", value: weekVisits, href },
    { label: "From AI assistants", value: aiVisits, href, hint: "Last 7 days" },
    { label: "From search engines", value: searchVisits, href, hint: "Last 7 days" },
  ];

  const topSources: GlanceRow[] = sources
    .filter((row) => row.visits > 0)
    .map((row): GlanceRow => ({ title: SOURCE_LABELS[row.source], meta: plural(row.visits, "visit"), href }));

  return {
    status:
      weekVisits === 0
        ? { text: "No visits in the last 7 days.", tone: "warn" }
        : { text: `${plural(weekVisits, "visit")} in the last 7 days, ${plural(todayVisits, "visit")} today.`, tone: "neutral" },
    tiles,
    spark: { label: "Visits by day", points, lastLabel: "Today" },
    list: { title: "Where visits come from", empty: "No visits in the last 7 days.", rows: topSources },
    link: { href, label: "Open analytics" },
  };
}
