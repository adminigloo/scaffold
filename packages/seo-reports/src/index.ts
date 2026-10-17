/**
 * @adminigloo/seo-reports — the SEARCH CHECK (0.2): how search engines and AI
 * assistants read a company's own website and pages, as a worklist in plain
 * words, with the receipts kept per company in the app's own database.
 *
 *   const { handle, runScheduled } = createSeoReportsHandlers({ db, resolveTenant, authorize, addresses });
 *
 * Modules: audit (one page, pure), robots (robots.txt as crawlers read it),
 * net (the safe fetcher: own hosts only, no private addresses, capped),
 * crawl (a whole check), store (per-company receipts), report (the worklist),
 * handlers + routes + permissions (the HTTP surface). The screen is on
 * `@adminigloo/seo-reports/ui`; the table on `./schema`.
 */
export { auditPage, attrOf, canonicalOf, check, plural, decodeEntities, linksOf, metaContent, samePage, scoreOf, titleOf } from "./audit.js";
export type { AuditPageContext, CheckKind, CheckStatus, PageAudit, SeoCheck } from "./audit.js";
export { parseRobots, patternMatches, productToken, robotsBlocks, robotsVerdict } from "./robots.js";
export type { ParsedRobots, RobotsGroup, RobotsRule, RobotsVerdict } from "./robots.js";
export { bareHostName, createSafeFetcher, DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS, DEFAULT_USER_AGENT, isBlockedAddress, nodeTransport } from "./net.js";
export type { FetchedPage, RefusalReason, ResolveHost, SafeFetcher, SafeFetchOptions, Transport, TransportRequest, TransportResponse } from "./net.js";
export { AI_CRAWLERS, CRAWLER_WORDS, DEFAULT_CRAWL_LIMITS, runSeoReport, runSiteCheck, SEARCH_CRAWLERS, SeoReportsError } from "./crawl.js";
export type { CheckCounts, CheckTarget, CrawlLimits, RunSeoReportOptions, RunSiteCheckOptions, SeoReportResult, SiteCheckResult } from "./crawl.js";
export {
  beginSiteCheck,
  failSiteCheck,
  finishSiteCheck,
  getSeoReport,
  getSiteCheck,
  lastSiteCheckAt,
  listSeoReports,
  listSiteChecks,
  nextMonthUtc,
  saveSeoReport,
  siteChecksThisMonth,
  STALE_RUNNING_MS,
} from "./store.js";
export type { BeginSiteCheckInput, SeoDb, SiteCheckRecord, SiteCheckStatus, SiteCheckSummary } from "./store.js";
export { CHECK_WORDS, wordsFor } from "./words.js";
export type { CheckWords } from "./words.js";
export { buildWorklist, toCheckWire, toSummaryWire } from "./report.js";
export { addressSentence, createSeoReportsHandlers, DEFAULT_MONTHLY_CHECKS, SCHEDULE_EVERY_MS } from "./handlers.js";
export type { CreateSeoReportsHandlersOptions, ScheduledCheckOutcome, SeoReportsAuthorizeResult, SeoReportsHandlers } from "./handlers.js";
export { SEO_REPORTS_ADMIN_ROUTE_PERMISSIONS, SEO_REPORTS_ADMIN_ROUTES } from "./routes.js";
export type { SeoReportsAdminRouteKind, SeoReportsRoute } from "./routes.js";
export { seoReportsPermissions } from "./permissions.js";
export type { SeoReportsPermission, SeoReportsPermissionDefinition } from "./permissions.js";
export type { SearchCheckOverviewWire, SeoReportsErrorCodeWire, SeoReportsErrorWire, SiteCheckSummaryWire, SiteCheckWire, WorkItemWire } from "./wire.js";
