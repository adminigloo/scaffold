/**
 * @adminigloo/analytics — first-party, cookieless traffic analytics for an
 * app's own site, and the reports to show for it.
 *
 *   const analytics = createAnalytics({ db, audience });   // ./instance
 *
 * See the README. Modules: sources (attribution, AI engines), crawlers (who
 * else is reading), visitor (paths, devices, the daily visitor key), ingest
 * (the beacon endpoint + crawler logging + retention), reports (every query),
 * reclassify (re-run attribution over history), legacy (the 0.1 free
 * functions, deprecated).
 *
 * Client pieces live in `@adminigloo/analytics/client` (the beacon) and
 * `@adminigloo/analytics/dashboard` (the report UI); tables in `./schema`.
 */
export * from "./sources.js";
export * from "./crawlers.js";
export * from "./visitor.js";
export * from "./vitals.js";
export * from "./periods.js";
export * from "./verify.js";

export { createAnalytics } from "./instance.js";
export type { Analytics, AnalyticsLicenseOptions, CreateAnalyticsOptions } from "./instance.js";

export { AnalyticsError, audienceSessionsSource, DEFAULT_LIMITS, isAnalyticsError } from "./context.js";
export type {
  AnalyticsAudience,
  AnalyticsAudienceOption,
  AnalyticsAudienceRows,
  AnalyticsDb,
  AnalyticsErrorCode,
  AnalyticsExcludedBreakdown,
  AnalyticsLimits,
} from "./context.js";

export { dayIn, DEFAULT_ON_SESSION_TIMEOUT_MS, scrubLabel, scrubUtm, sendsPrivacySignal, sendsPrivacySignalHeaders } from "./ingest.js";
export type {
  AnalyticsHandler,
  AnalyticsHandlerConfig,
  AnalyticsSessionContext,
  AnalyticsSessionVerdict,
  ConversionInput,
  CrawlerHitInput,
  HeadersLike,
  MaintenanceInput,
  MaintenanceResult,
  MarkVisitorInternalInput,
  MarkVisitorInternalResult,
  RecordedConversion,
  VisitorKeys,
  VisitorKeysInput,
} from "./ingest.js";

export { daysInZone, PUBLIC_VITALS_MIN_SAMPLES } from "./reports.js";
export type {
  ActivityReport,
  AiAssistantTraffic,
  AiCoverageQuery,
  AiEngineKey,
  AiEngineTraffic,
  AiRead,
  AiReadsQuery,
  Annotation,
  BreakdownDimension,
  CampaignRow,
  CrawlerReport,
  CrawlerRow,
  EngagementRow,
  ExcludedQuery,
  LandingRow,
  Metric,
  Overview,
  PublicSnapshot,
  PublicSnapshotInput,
  ReportQuery,
  SourceRow,
  TrendPoint,
  WebVitalsReport,
} from "./reports.js";
export type { PipelineHealth } from "./health.js";
export type { ReclassifyOptions, ReclassifyResult, ReclassifyWindow } from "./reclassify.js";

// The 0.1 API: free functions that take `db` first, over a default instance. Deprecated; removed in 1.0.
export {
  addAnnotation,
  createAnalyticsHandler,
  CRAWLER_BUCKET_MS,
  defaultAnalyticsFor,
  deleteAnnotation,
  getActivity,
  getAiCoverage,
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
  getRecentAiReads,
  getReferrers,
  getSources,
  getTopClicks,
  getTopPages,
  getTrackingSince,
  getWebVitals,
  listAnnotations,
  MAX_DURATION_DELTA_MS,
  MAX_HITS_PER_NETWORK_HOUR,
  MAX_PAGE_VIEWS_PER_SESSION,
  MAX_SESSIONS_PER_NETWORK_HOUR,
  recordConversion,
  recordCrawlerHit,
  resolveVisitorKeys,
  runAnalyticsMaintenance,
} from "./legacy.js";
export type { AnalyticsHandlerOptions } from "./legacy.js";
