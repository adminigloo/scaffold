import { verifyLicense, type LicenseMode } from "@adminigloo/license";
import {
  AnalyticsError,
  audienceSessionsSource,
  resolveLimits,
  type AnalyticsAudience,
  type AnalyticsAudienceOption,
  type AnalyticsAudienceRows,
  type AnalyticsContext,
  type AnalyticsDb,
  type AnalyticsExcludedBreakdown,
  type AnalyticsLimits,
} from "./context.js";
import { DEFAULT_EXCLUDED_BOTS } from "./crawlers.js";
import { getPipelineHealth, type PipelineHealth } from "./health.js";
import {
  createHandlerIn,
  markVisitorInternalIn,
  recordConversionIn,
  recordCrawlerHitIn,
  resolveVisitorKeysIn,
  runMaintenanceIn,
  type AnalyticsHandler,
  type AnalyticsHandlerConfig,
  type ConversionInput,
  type CrawlerHitInput,
  type MaintenanceInput,
  type MaintenanceResult,
  type MarkVisitorInternalInput,
  type MarkVisitorInternalResult,
  type RecordedConversion,
  type VisitorKeys,
  type VisitorKeysInput,
} from "./ingest.js";
import { reclassifySources, type ReclassifyOptions, type ReclassifyResult, type ReclassifyWindow } from "./reclassify.js";
import * as reports from "./reports.js";
import { analyticsTables, type AnalyticsTables } from "./schema.js";
import { createCrawlerVerifier, type CrawlerVerifier } from "./verify.js";

export interface AnalyticsLicenseOptions {
  /** ADMINIGLOO_LICENSE_KEY */
  readonly key?: string | undefined;
  /** ADMINIGLOO_LICENSE_PUBLIC_KEY */
  readonly publicKey?: string | undefined;
  /** ADMINIGLOO_LICENSE_MODE — "off" (default) never denies. */
  readonly mode?: LicenseMode | undefined;
}

export interface CreateAnalyticsOptions {
  db: AnalyticsDb;
  /** `defineAnalyticsTables({ prefix })`. Default: the 0.1 names (`analytics_*`). */
  tables?: AnalyticsTables;
  /**
   * The internal audience — the instance `createAudience(...)` from
   * `@adminigloo/audience` returns (or a function from tenant id to one).
   * With it, every report leaves out what the audience has marked, unless a
   * call says `includeInternal`. Without it, nothing is filtered: 0.1's numbers.
   */
  audience?: AnalyticsAudienceOption;
  /** Ingest limits; any left out keep 0.1's values (`DEFAULT_LIMITS`). */
  limits?: Partial<AnalyticsLimits>;
  /**
   * The AdminIgloo license gate, feature "analytics". It guards the REPORTS
   * (every `get…` but `getPipelineHealth`, and `reclassifySources`) and never
   * the ingest, the crawler log, conversions, maintenance or the pipeline
   * health: a lapsed license must not lose a single visit (renewing brings
   * the full history back), retention deletes must keep running, and the
   * health strip can still say data is arriving. A public page calling
   * `getPublicSnapshot` must catch `isAnalyticsError` (402). Mode "off" (the
   * default) never denies; "warn" never denies either, and tells `onError`
   * once per instance when the license is not valid.
   */
  license?: AnalyticsLicenseOptions;
  /**
   * Bot names the crawler reports leave out unless a call asks for
   * `includeInternal`. Default `["AdminIgloo audit"]` — @adminigloo/seo-reports'
   * own fetcher. Pass `[]` to show every bot. The rows are always recorded.
   */
  excludeBots?: readonly string[];
  /**
   * Check crawler claims against the operators' published IP ranges: a
   * verifier of your own, or `true` for one this instance owns (its range
   * lists are cached per instance, 24 hours). Default: none — rows are
   * recorded unverified unless a call passes `verifier`.
   */
  crawlerVerifier?: CrawlerVerifier | boolean;
  /**
   * Told about failures the ingest swallows (it always answers 204). Default:
   * console.warn, at most once a minute for the same place and message, so a
   * deploy with a broken database logs a line a minute, not one per beacon.
   */
  onError?: (error: unknown, where: string) => void;
}

/** How long the default reporter stays quiet about a failure it has just logged. */
const DEFAULT_REPORT_QUIET_MS = 60_000;

/**
 * console.warn, deduplicated for a minute — the default `onError`. The key is
 * where it happened and the message's first line: Drizzle's "Failed query:
 * <sql>\nparams: …" carries per-request values (a network key, a session id)
 * on its second line, and the same failure for two visitors is one failure.
 * The driver's own error (Drizzle's `cause`) is logged with it.
 */
function createDefaultReporter(now: () => number = Date.now): (error: unknown, where: string) => void {
  const lastLogged = new Map<string, number>();
  return (error: unknown, where: string) => {
    const cause = error instanceof Error && error.cause instanceof Error ? ` (cause: ${error.cause.message})` : "";
    const message = `${error instanceof Error ? error.message : String(error)}${cause}`;
    const key = `${where}\u0000${message.split("\n")[0]}`;
    const at = now();
    const last = lastLogged.get(key);
    if (last !== undefined && at - last < DEFAULT_REPORT_QUIET_MS) return;
    lastLogged.set(key, at);
    if (lastLogged.size > 100) lastLogged.delete(lastLogged.keys().next().value as string);
    console.warn(`[@adminigloo/analytics] ${where}:`, message);
  };
}

/**
 * One analytics install: its tables, its limits, its audience and its own
 * caches (the daily salts, "tracking started", the crawler range lists). Two
 * instances never share any of them, so two table sets can run in one process.
 *
 *   const analytics = createAnalytics({ db, audience });
 *   export const handler = analytics.createHandler({ tenantId, allowedHosts, clientIp, onSession });
 *   const overview = await analytics.getOverview({ tenantId, ...lastDays(30) });
 */
export function createAnalytics(options: CreateAnalyticsOptions) {
  if (!options || !options.db) throw new AnalyticsError("invalid_config", "createAnalytics needs `db`.");
  const t = options.tables ?? analyticsTables;
  const limits = resolveLimits(options.limits);
  const audience = options.audience;
  const audienceFor = (tenantId: string): AnalyticsAudience | null => {
    const found = typeof audience === "function" ? (audience(tenantId) ?? null) : (audience ?? null);
    // An audience writes its marks under ONE tenant. Applied to another
    // tenant's sessions its anti-join could never match, so every report
    // would quietly count staff again: refuse instead.
    if (found && typeof found.tenantId === "string" && found.tenantId !== tenantId) {
      throw new AnalyticsError(
        "invalid_config",
        `The audience belongs to tenant ${JSON.stringify(found.tenantId)}, not ${JSON.stringify(tenantId)}: its marks would never match. Give createAudience the same tenantId as the reports, or pass \`audience\` as a function of the tenant.`,
      );
    }
    return found;
  };
  const verifier =
    options.crawlerVerifier === true
      ? createCrawlerVerifier()
      : options.crawlerVerifier && typeof options.crawlerVerifier === "object"
        ? options.crawlerVerifier
        : null;
  const license = options.license;
  const onError = options.onError ?? createDefaultReporter();
  let warnedLicense = false;

  const ctx: AnalyticsContext = {
    db: options.db,
    t,
    limits,
    audienceFor,
    excludedBots: [...(options.excludeBots ?? DEFAULT_EXCLUDED_BOTS)],
    saltCache: new Map(),
    knownSites: new Set(),
    verifier,
    gate: () => {
      if (!license) return;
      const decision = verifyLicense({ feature: "analytics", ...license });
      if (!decision.ok) throw new AnalyticsError("unlicensed", decision.reason);
      // "warn" exists so a deployment hears about a missing or lapsed license
      // without anyone being turned away: say so once per instance.
      if (decision.mode === "warn" && decision.status !== "valid" && !warnedLicense) {
        warnedLicense = true;
        try {
          onError(new AnalyticsError("unlicensed", decision.reason), "license");
        } catch {
          /* a reporter that throws never fails a report */
        }
      }
    },
    onError,
  };

  /** A report: license first, then the read. */
  function gated<A extends unknown[], R>(read: (ctx: AnalyticsContext, ...args: A) => Promise<R>) {
    return async (...args: A): Promise<R> => {
      ctx.gate();
      return read(ctx, ...args);
    };
  }

  return {
    /** This instance's tables (spread the default set's named exports from `./schema` into your Drizzle schema). */
    tables: t,
    /** The limits in force, defaults filled in. */
    limits: limits as Readonly<AnalyticsLimits>,

    // ------------------------------------------------------------- ingest
    /** The beacon endpoint. Mount `handler.handle(req)` on your route. */
    createHandler: (config: AnalyticsHandlerConfig): AnalyticsHandler => createHandlerIn(ctx, config),
    /** A conversion that happened on the server. Returns the visit it landed on, or null when there was none. */
    recordConversion: (input: ConversionInput): Promise<RecordedConversion | null> => recordConversionIn(ctx, input),
    /** Log a crawler request (from your proxy/middleware). */
    recordCrawlerHit: (input: CrawlerHitInput) => recordCrawlerHitIn(ctx, input),
    /** The daily job: salts, throttle windows, retention. */
    runMaintenance: (input?: MaintenanceInput): Promise<MaintenanceResult> => runMaintenanceIn(ctx, input),
    /** The cookieless keys a request would be filed under (today's and yesterday's). */
    resolveVisitorKeys: (input: VisitorKeysInput): Promise<VisitorKeys> => resolveVisitorKeysIn(ctx, input),
    /**
     * "These are my visits": mark this device's keys for today and yesterday
     * through the audience, so its signed-out visits of about the last 48
     * hours (and the rest of today) stop counting. Needs an audience.
     */
    markVisitorInternal: (input: MarkVisitorInternalInput): Promise<MarkVisitorInternalResult> => markVisitorInternalIn(ctx, input),

    // ------------------------------------------------------------ reports
    getTrackingSince: gated(reports.getTrackingSince),
    getOverview: gated(reports.getOverview),
    getDailyTrend: gated(reports.getDailyTrend),
    getSources: gated(reports.getSources),
    getReferrers: gated(reports.getReferrers),
    getCampaigns: gated(reports.getCampaigns),
    getBreakdown: gated(reports.getBreakdown),
    getEngagementBySource: gated(reports.getEngagementBySource),
    getActivity: gated(reports.getActivity),
    getTopPages: gated(reports.getTopPages),
    getLandingPages: gated(reports.getLandingPages),
    getTopClicks: gated(reports.getTopClicks),
    getEventVisits: gated(reports.getEventVisits),
    getWebVitals: gated(reports.getWebVitals),
    getAiAssistantTraffic: gated(reports.getAiAssistantTraffic),
    getCrawlers: gated(reports.getCrawlers),
    getRecentAiReads: gated(reports.getRecentAiReads),
    getAiCoverage: gated(reports.getAiCoverage),
    /** Always leaves the internal audience out, whatever the caller passes. */
    getPublicSnapshot: gated(reports.getPublicSnapshot),
    /**
     * Liveness: deliberately unfiltered (a staff page view proves the pipe
     * works), and never license-gated — like the ingest it watches, so a
     * lapsed install can still show that nothing is being lost.
     */
    getPipelineHealth: (tenantId: string): Promise<PipelineHealth> => getPipelineHealth(ctx, tenantId),
    /** "Excluded: N (…)" for a window, from the audience; null without one. */
    getExcludedBreakdown: gated((c: AnalyticsContext, window: reports.ExcludedQuery): Promise<AnalyticsExcludedBreakdown | null> =>
      reports.getExcludedBreakdown(c, window),
    ),
    /** Re-run the source classifier over stored sessions (after an upgrade changed it). */
    reclassifySources: gated((c: AnalyticsContext, window: ReclassifyWindow, opts?: ReclassifyOptions): Promise<ReclassifyResult> =>
      reclassifySources(c, window, opts),
    ),

    // -------------------------------------------------------- annotations
    listAnnotations: (query: { tenantId: string; fromDay: string; toDay: string }) => reports.listAnnotations(ctx, query),
    addAnnotation: (input: { tenantId: string; day: string; label: string; kind?: string; createdBy?: string | null }) => reports.addAnnotation(ctx, input),
    deleteAnnotation: (input: { tenantId: string; id: string }) => reports.deleteAnnotation(ctx, input),

    // ----------------------------------------------------------- audience
    /** Pass as `createAudience({ sessions })`, so the audience counts exactly the rows these reports do. */
    audienceSessions: (tenantId: string): AnalyticsAudienceRows => audienceSessionsSource({ tenantId, tables: t }),
    /** The audience a tenant's reports honour, or null. */
    audienceFor,

    /** Drop this instance's caches (salts, "tracking started"). For tests and after restoring a database. */
    invalidate(): void {
      ctx.saltCache.clear();
      ctx.knownSites.clear();
    },
  };
}

export type Analytics = ReturnType<typeof createAnalytics>;
