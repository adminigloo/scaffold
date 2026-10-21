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

// 0.3: the site register, the company handlers, the report adapter and the snippet.
export {
  bareHost,
  isLocalHost,
  MAX_WEBSITE_DOMAINS,
  newSiteKey,
  normalizeDomain,
  SITE_CACHE_MS,
  SITE_KEY_HEADER,
  SITE_KEY_PARAM,
  SITE_KEY_SHAPE,
  siteKeyOf,
  websiteLimitSentence,
} from "./websites.js";
export type { AddWebsiteInput, ResolvedSite, SiteResolverOptions, UpdateWebsiteInput, Website, WebsiteAddressRules } from "./websites.js";
export { analyticsPermissions } from "./permissions.js";
export type { AnalyticsPermission, AnalyticsPermissionDefinition } from "./permissions.js";
export { ANALYTICS_ADMIN_ROUTE_PERMISSIONS, ANALYTICS_ADMIN_ROUTES, ANALYTICS_PUBLIC_ROUTES } from "./routes.js";
export type { AnalyticsAdminRouteKind, AnalyticsPublicRouteKind, AnalyticsRoute } from "./routes.js";
export { createAnalyticsAdminHandlers } from "./admin-handlers.js";
export type { AnalyticsAdminHandlers, AnalyticsAuthorizeResult, CreateAnalyticsAdminHandlersOptions } from "./admin-handlers.js";
export { createAnalyticsPublicHandlers } from "./public-handlers.js";
export type { AnalyticsPublicHandlers, CreateAnalyticsPublicHandlersOptions } from "./public-handlers.js";
export { buildWebsiteReport, EXCLUDED_REASON_WORDS, excludedWords, REPORT_DAYS, reportDaysOf } from "./report.js";
export type { ReportDays, WebsiteReportInput } from "./report.js";
export { BEACON_SCRIPT, websiteSnippet } from "./beacon-script.js";
export { ANALYTICS_WIRE_VERSION } from "./wire.js";
export type {
  AiEngineWire,
  AnalyticsErrorCodeWire,
  AnalyticsErrorWire,
  ExcludedWire,
  MineWire,
  ReportRangeWire,
  WebsiteFilterWire,
  WebsiteReportWire,
  WebsitesWire,
  WebsiteWire,
} from "./wire.js";

/**
 * This site's OWN numbers, in a deployment that also serves companies' (0.3):
 * the tenant the platform's beacon, reports and audience use. "*" can never be
 * a company id (ids are UUIDs), and it is the same word @adminigloo/feedback
 * uses for the site's own board.
 */
export const ANALYTICS_PLATFORM_SITE = "*";

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

// Delete a company (create-app 0.37): every row of one company, children first.
export { forgetTenant } from "./forget.js";

// Past visits brought in from records (0.4): the shapes importVisits takes and answers.
export { importedVisitorKey, MAX_IMPORT_VISITS } from "./import.js";
export type { ImportVisitInput, ImportVisitsInput, ImportVisitsResult } from "./import.js";
