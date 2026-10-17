import type { PipelineHealth } from "./health.js";
import type { CrawlerReport, Metric, SourceRow, TrendPoint } from "./reports.js";
import type { AiEngineKey } from "./reports.js";

/**
 * WHAT THE ANALYTICS HANDLERS SEND (0.3), as plain JSON — read by the
 * `./dashboard` components through their transport, and by a host app that
 * draws the numbers itself. Dates are ISO strings, so a payload survives a
 * JSON cache. Changing a name here breaks every dashboard already deployed:
 * add, never rename.
 */
export const ANALYTICS_WIRE_VERSION = "v1";

export type AnalyticsErrorCodeWire = "forbidden" | "not_found" | "invalid" | "limit_reached" | "unlicensed" | "cross_site" | "internal";

export interface AnalyticsErrorWire {
  readonly error: { readonly code: AnalyticsErrorCodeWire; readonly message: string };
}

/** One of the company's websites, with the snippet that counts it. */
export interface WebsiteWire {
  readonly id: string;
  readonly name: string;
  readonly domains: readonly string[];
  /** The public site key the snippet carries. */
  readonly siteKey: string;
  /** The one line to paste before `</head>` on every page of the website; null when this deployment has no public address yet. */
  readonly snippet: string | null;
  readonly createdAt: string;
  /** When it last had a visit (anyone's, the team's too); null: nothing yet — the snippet isn't on the site, or nobody has opened it since. */
  readonly lastVisitAt: string | null;
}

export interface WebsitesWire {
  readonly websites: readonly WebsiteWire[];
  /** May this person add, change and remove websites? */
  readonly canManage: boolean;
  /** The most websites the company may have (its plan's); null: no limit. */
  readonly limit: number | null;
  /** The sentence to show instead of the add form once the plan's websites are all used; null while there is room. */
  readonly limitMessage: string | null;
  /** The company's own pages on this deployment, always counted: a name for them, their address and their last visit. */
  readonly ownPages: { readonly label: string; readonly url: string | null; readonly lastVisitAt?: string | null };
}

/** The report's filter on websites: every one, the company's own pages here, or one website's id. */
export type WebsiteFilterWire = "all" | "pages" | (string & {});

export interface ReportRangeWire {
  /** 7, 30 or 90. */
  readonly days: number;
  readonly from: string;
  readonly to: string;
  readonly timeZone: string;
}

export interface AiEngineWire {
  readonly engine: AiEngineKey;
  readonly label: string;
  readonly visits: number;
  readonly engagedRate: number | null;
  readonly conversions: number;
  /** Live fetches by the engine's own assistant bot in the range (User-Agent claims). */
  readonly assistantFetches: number;
  readonly assistantFetchesVerified: number;
}

/** "Excluded: 12 visits (you and your team 10, automation 2)" — the parts add up to the total. */
export interface ExcludedWire {
  readonly total: number;
  readonly byReason: Readonly<Record<string, number>>;
  readonly unit: string;
  /** The line, in words, ready to show. */
  readonly sentence: string;
}

/** Everything the traffic report draws, for one company, one range and one website filter. */
export interface WebsiteReportWire {
  readonly version: typeof ANALYTICS_WIRE_VERSION;
  readonly range: ReportRangeWire;
  readonly site: WebsiteFilterWire;
  /** The websites the filter offers (the company's own pages are "pages"). */
  readonly websites: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly ownPagesLabel: string;
  /** Counting everyone, the company's own people too, for this one look (`?includeInternal=1`). */
  readonly includeInternal: boolean;
  readonly trackingSince: string | null;
  readonly overview: {
    readonly visits: Metric;
    readonly dailyVisitors: Metric;
    readonly pageViews: Metric;
    readonly engagedVisits: Metric;
    readonly conversions: Metric;
    readonly engagedRate: number | null;
    readonly avgEngagedMs: number | null;
    readonly pagesPerVisit: number | null;
  };
  readonly trend: readonly TrendPoint[];
  /** All eight sources, busiest first: search ("organic"), AI assistants, social, email, campaigns, other sites, direct. */
  readonly sources: readonly SourceRow[];
  /** The search engines that sent visits (google.com, bing.com…), busiest first. */
  readonly searchEngines: ReadonlyArray<{ readonly host: string; readonly visits: number }>;
  /** Other sites that sent visits, with their source. */
  readonly referrers: ReadonlyArray<{ readonly host: string; readonly source: string; readonly visits: number }>;
  readonly ai: { readonly visits: number; readonly engines: readonly AiEngineWire[] };
  readonly topPages: ReadonlyArray<{ readonly path: string; readonly views: number; readonly visits: number }>;
  /** Crawlers that read the company's pages on this deployment (a website of its own can't see them). */
  readonly crawlers: CrawlerReport;
  /** Null: nobody is left out here (no audience set up). */
  readonly excluded: ExcludedWire | null;
  readonly health: PipelineHealth;
}

/** "These are my visits": the keys marked (today's and yesterday's) and how many were new. */
export interface MineWire {
  readonly marked: number;
  readonly message: string;
}
