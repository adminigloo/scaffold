import { DEFAULT_LIMITS, type AnalyticsDb } from "./context.js";
import type { AnalyticsHandler, AnalyticsHandlerConfig, ConversionInput } from "./ingest.js";
import { createAnalytics, type Analytics } from "./instance.js";

/**
 * The 0.1 API — free functions that take `db` first — kept working for one
 * release as thin wrappers over a DEFAULT INSTANCE per `db` object: the 0.1
 * table names, the default limits, no audience (so no internal filter: 0.1's
 * numbers), no license gate, no crawler verifier unless a call passes one.
 * Each `db` object gets its own instance and so its own caches; 0.1 kept one
 * module-wide set.
 *
 * THEY NEVER SEE YOUR INSTANCE. In an app that also has
 * `createAnalytics({ db, audience, license })`, `getOverview(db, q)` still
 * counts staff and testers and is never license-gated, while
 * `analytics.getOverview(q)` leaves them out and is gated. Move every call to
 * the instance at once when you wire the audience — a page that mixes the two
 * shows two different numbers.
 *
 * Deprecated: move to `createAnalytics({ db, … })`, whose methods are the
 * same names without the `db` argument. These are removed in 1.0.
 */

const instances = new WeakMap<object, Analytics>();

/** The instance a 0.1 call runs on: one per `db` object, built on first use. */
export function defaultAnalyticsFor(db: AnalyticsDb): Analytics {
  let instance = instances.get(db);
  if (!instance) {
    instance = createAnalytics({ db });
    instances.set(db, instance);
  }
  return instance;
}

/** A 0.1 free function: the default instance's method — no audience (staff count) and no license gate, whatever instance the app also built. */
function legacy<A extends unknown[], R>(pick: (analytics: Analytics) => (...args: A) => R) {
  return (db: AnalyticsDb, ...args: A): R => pick(defaultAnalyticsFor(db))(...args);
}

/** The 0.1 handler options: the instance's handler config plus `db`. */
export interface AnalyticsHandlerOptions extends AnalyticsHandlerConfig {
  db: AnalyticsDb;
}

/** @deprecated 0.1 API — use `createAnalytics({ db }).createHandler(config)`. */
export function createAnalyticsHandler(options: AnalyticsHandlerOptions): AnalyticsHandler {
  const { db, ...config } = options;
  return defaultAnalyticsFor(db).createHandler(config);
}

/** @deprecated 0.1 API — use `createAnalytics({ db }).recordConversion(input)`, which returns the visit (or null) instead of a boolean. */
export async function recordConversion(db: AnalyticsDb, input: ConversionInput): Promise<boolean> {
  return (await defaultAnalyticsFor(db).recordConversion(input)) !== null;
}

/** @deprecated 0.1 API — use `createAnalytics({ db }).resolveVisitorKeys(input)`. */
export const resolveVisitorKeys = legacy((a) => a.resolveVisitorKeys);
/** @deprecated 0.1 API — use `createAnalytics({ db }).recordCrawlerHit(input)`. */
export const recordCrawlerHit = legacy((a) => a.recordCrawlerHit);
/** @deprecated 0.1 API — use `createAnalytics({ db }).runMaintenance(input)`. */
export const runAnalyticsMaintenance = legacy((a) => a.runMaintenance);

/** @deprecated 0.1 API — use `createAnalytics({ db }).getTrackingSince(tenantId)`. Never filtered by an audience or gated by a license, whatever instance the app also built. */
export const getTrackingSince = legacy((a) => a.getTrackingSince);
/** @deprecated 0.1 API — use `createAnalytics({ db }).getOverview(query)`. Never filtered by an audience or gated by a license, whatever instance the app also built. */
export const getOverview = legacy((a) => a.getOverview);
/** @deprecated 0.1 API — use `createAnalytics({ db }).getDailyTrend(query)`. Never filtered by an audience or gated by a license, whatever instance the app also built. */
export const getDailyTrend = legacy((a) => a.getDailyTrend);
/** @deprecated 0.1 API — use `createAnalytics({ db }).getSources(query)`. Never filtered by an audience or gated by a license, whatever instance the app also built. */
export const getSources = legacy((a) => a.getSources);
/** @deprecated 0.1 API — use `createAnalytics({ db }).getReferrers(query, limit)`. Never filtered by an audience or gated by a license, whatever instance the app also built. */
export const getReferrers = legacy((a) => a.getReferrers);
/** @deprecated 0.1 API — use `createAnalytics({ db }).getCampaigns(query, limit)`. Never filtered by an audience or gated by a license, whatever instance the app also built. */
export const getCampaigns = legacy((a) => a.getCampaigns);
/** @deprecated 0.1 API — use `createAnalytics({ db }).getBreakdown(query, dimension, limit)`. Never filtered by an audience or gated by a license, whatever instance the app also built. */
export const getBreakdown = legacy((a) => a.getBreakdown);
/** @deprecated 0.1 API — use `createAnalytics({ db }).getEngagementBySource(query)`. Never filtered by an audience or gated by a license, whatever instance the app also built. */
export const getEngagementBySource = legacy((a) => a.getEngagementBySource);
/** @deprecated 0.1 API — use `createAnalytics({ db }).getActivity(query)`. Never filtered by an audience or gated by a license, whatever instance the app also built. */
export const getActivity = legacy((a) => a.getActivity);
/** @deprecated 0.1 API — use `createAnalytics({ db }).getTopPages(query, limit, onlyPaths)`. Never filtered by an audience or gated by a license, whatever instance the app also built. */
export const getTopPages = legacy((a) => a.getTopPages);
/** @deprecated 0.1 API — use `createAnalytics({ db }).getLandingPages(query, limit)`. Never filtered by an audience or gated by a license, whatever instance the app also built. */
export const getLandingPages = legacy((a) => a.getLandingPages);
/** @deprecated 0.1 API — use `createAnalytics({ db }).getTopClicks(query, limit)`. Never filtered by an audience or gated by a license, whatever instance the app also built. */
export const getTopClicks = legacy((a) => a.getTopClicks);
/** @deprecated 0.1 API — use `createAnalytics({ db }).getEventVisits(query, names)`. Never filtered by an audience or gated by a license, whatever instance the app also built. */
export const getEventVisits = legacy((a) => a.getEventVisits);
/** @deprecated 0.1 API — use `createAnalytics({ db }).getWebVitals(query, pathLimit)`. Never filtered by an audience or gated by a license, whatever instance the app also built. */
export const getWebVitals = legacy((a) => a.getWebVitals);
/** @deprecated 0.1 API — use `createAnalytics({ db }).getCrawlers(query, limit)`. Never filtered by an audience or gated by a license, whatever instance the app also built. */
export const getCrawlers = legacy((a) => a.getCrawlers);
/** @deprecated 0.1 API — use `createAnalytics({ db }).getRecentAiReads(input)`. Never filtered by an audience or gated by a license, whatever instance the app also built. */
export const getRecentAiReads = legacy((a) => a.getRecentAiReads);
/** @deprecated 0.1 API — use `createAnalytics({ db }).getAiCoverage(input)`. Never filtered by an audience or gated by a license, whatever instance the app also built. */
export const getAiCoverage = legacy((a) => a.getAiCoverage);
/** @deprecated 0.1 API — use `createAnalytics({ db }).getPipelineHealth(tenantId)`. Never filtered by an audience or gated by a license, whatever instance the app also built. */
export const getPipelineHealth = legacy((a) => a.getPipelineHealth);
/** @deprecated 0.1 API — use `createAnalytics({ db }).listAnnotations(query)`. */
export const listAnnotations = legacy((a) => a.listAnnotations);
/** @deprecated 0.1 API — use `createAnalytics({ db }).addAnnotation(input)`. */
export const addAnnotation = legacy((a) => a.addAnnotation);
/** @deprecated 0.1 API — use `createAnalytics({ db }).deleteAnnotation(input)`. */
export const deleteAnnotation = legacy((a) => a.deleteAnnotation);
/** @deprecated 0.1 API — use `createAnalytics({ db }).getPublicSnapshot(input)`. Never filtered by an audience or gated by a license, whatever instance the app also built. */
export const getPublicSnapshot = legacy((a) => a.getPublicSnapshot);

/** @deprecated use `DEFAULT_LIMITS.maxHitsPerNetworkHour` (and `createAnalytics({ limits })` to change it). */
export const MAX_HITS_PER_NETWORK_HOUR = DEFAULT_LIMITS.maxHitsPerNetworkHour;
/** @deprecated use `DEFAULT_LIMITS.maxSessionsPerNetworkHour`. */
export const MAX_SESSIONS_PER_NETWORK_HOUR = DEFAULT_LIMITS.maxSessionsPerNetworkHour;
/** @deprecated use `DEFAULT_LIMITS.maxPageViewsPerSession`. */
export const MAX_PAGE_VIEWS_PER_SESSION = DEFAULT_LIMITS.maxPageViewsPerSession;
/** @deprecated use `DEFAULT_LIMITS.maxDurationDeltaMs`. */
export const MAX_DURATION_DELTA_MS = DEFAULT_LIMITS.maxDurationDeltaMs;
/** @deprecated use `DEFAULT_LIMITS.crawlerBucketMs`. */
export const CRAWLER_BUCKET_MS = DEFAULT_LIMITS.crawlerBucketMs;
