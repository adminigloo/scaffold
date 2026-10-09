import { getTableName, type SQL, type SQLWrapper } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { CrawlerVerifier } from "./verify.js";
import type { AnalyticsTables } from "./schema.js";
import { SESSION_INACTIVITY_MS } from "./visitor.js";

/**
 * What one analytics instance carries: its database, its tables, its limits,
 * its audience, and its OWN caches. Nothing in the package is module-global
 * any more (0.1 kept the salt cache and the "tracking started" set at module
 * level, so two table sets in one process shared them).
 */

/** Structural, as every @adminigloo package types it: never the app's concrete db. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnalyticsDb = PgDatabase<any, any, any>;

// ---------------------------------------------------------------------------
// Limits — the ingest is anonymous by nature, and its numbers may be public.
// ---------------------------------------------------------------------------

export interface AnalyticsLimits {
  /** Requests (page views + events + leaves) per network per hour. Default 600. */
  maxHitsPerNetworkHour: number;
  /** New sessions per network per hour — a household or an office, not a script. Default 30. */
  maxSessionsPerNetworkHour: number;
  /** Page views per session; past this a "session" is a loop. Default 500. */
  maxPageViewsPerSession: number;
  /** Foreground time one beacon may add — a tab cannot report more than the inactivity window. Default 30 minutes. */
  maxDurationDeltaMs: number;
  /** Largest beacon body read, in bytes; a bigger one is dropped unread. Default 4096. */
  maxBodyBytes: number;
  /** A stored UTM value is cut to this many characters. Default 100. */
  maxUtmLength: number;
  /** A stored click label is cut to this many characters. Default 120. */
  maxLabelLength: number;
  /** Crawler rows are bucketed by this, with a hit counter. Default 10 minutes. */
  crawlerBucketMs: number;
  /** Days of raw rows the daily maintenance keeps (sessions cascade their page views and events). Default 395. */
  retentionDays: number;
}

/** 0.1's constants, unchanged — what an instance uses for any limit it is not given. */
export const DEFAULT_LIMITS: Readonly<AnalyticsLimits> = Object.freeze({
  maxHitsPerNetworkHour: 600,
  maxSessionsPerNetworkHour: 30,
  maxPageViewsPerSession: 500,
  maxDurationDeltaMs: SESSION_INACTIVITY_MS,
  maxBodyBytes: 4096,
  maxUtmLength: 100,
  maxLabelLength: 120,
  crawlerBucketMs: 10 * 60 * 1000,
  retentionDays: 395,
});

export function resolveLimits(limits: Partial<AnalyticsLimits> | undefined): AnalyticsLimits {
  const out: AnalyticsLimits = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(limits ?? {})) {
    if (!(key in DEFAULT_LIMITS)) throw new AnalyticsError("invalid_config", `Unknown limit ${JSON.stringify(key)}.`);
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw new AnalyticsError("invalid_config", `limits.${key} must be a positive whole number (got ${JSON.stringify(value)}).`);
    }
    out[key as keyof AnalyticsLimits] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type AnalyticsErrorCode = "unlicensed" | "invalid_config";

const STATUS: Record<AnalyticsErrorCode, number> = { unlicensed: 402, invalid_config: 500 };

export class AnalyticsError extends Error {
  readonly code: AnalyticsErrorCode;
  readonly status: number;
  constructor(code: AnalyticsErrorCode, message: string) {
    super(message);
    this.name = "AnalyticsError";
    this.code = code;
    this.status = STATUS[code];
  }
}

export function isAnalyticsError(error: unknown): error is AnalyticsError {
  return error instanceof AnalyticsError || (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AnalyticsError");
}

// ---------------------------------------------------------------------------
// The audience — @adminigloo/audience's instance, typed structurally.
// ---------------------------------------------------------------------------

/** Where the audience counts sessions (its `RowsSource`). */
export interface AnalyticsAudienceRows {
  table: string;
  visitor: string;
  time: string;
  id?: string;
  where?: Readonly<Record<string, string | number | boolean>>;
}

/** What `audience.excludedBreakdown` returns: `{ total, byReason, unit }`, the parts summing to the total. */
export interface AnalyticsExcludedBreakdown {
  total: number;
  byReason: Partial<Record<string, number>>;
  unit: string;
}

/**
 * What analytics asks of an audience — exactly what `createAudience(...)` from
 * `@adminigloo/audience` (^0.1) returns, so pass that instance. Typed by
 * shape, not imported: analytics has no runtime dependency on the audience
 * package, and an app without one installs nothing extra.
 *
 * Members are PROPERTIES, not methods, on purpose: TypeScript checks a
 * property's function parameters strictly, so an audience release whose
 * `countedVisitorSql` no longer accepts what analytics passes fails to
 * compile here instead of failing at runtime.
 */
export interface AnalyticsAudience {
  /**
   * The tenant the audience's marks are written under. A report for another
   * tenant would never match a mark, so analytics refuses it
   * (`AnalyticsError("invalid_config")`) instead of silently filtering nothing.
   */
  readonly tenantId?: string;
  /** The counted predicate (`NOT EXISTS` over visitor and session marks), as Drizzle `sql`. */
  readonly countedVisitorSql: (
    visitorColumn: SQLWrapper,
    extra: { time: SQLWrapper | null; session: SQLWrapper | null; includeInternal?: boolean },
  ) => SQL;
  /** "Excluded: N (staff X, automation Y)" over the given rows in a window. */
  readonly excludedBreakdown: (
    window: { from?: Date | null; to?: Date | null },
    opts?: { rows?: AnalyticsAudienceRows },
  ) => Promise<AnalyticsExcludedBreakdown>;
  /**
   * Mark one subject by hand. `markVisitorInternal` uses it to mark a
   * device's daily keys: the audience's own `markVisitor` refuses rotating
   * ids, while `mark` writes a hand mark with a run row that `unmark` undoes.
   */
  readonly mark?: (input: {
    subjectKind: "visitor";
    subjectId: string;
    reason?: "device";
    by?: string | null;
  }) => Promise<{ subjectsChanged: number }>;
}

/** One audience for every tenant, or one per tenant (null: that tenant has none, and nothing is filtered). */
export type AnalyticsAudienceOption = AnalyticsAudience | ((tenantId: string) => AnalyticsAudience | null | undefined);

/**
 * The analytics sessions as the audience should count them — pass it as
 * `createAudience({ sessions })` so preview, apply and the breakdown count the
 * same rows the reports do: visitor key, start time, session id, and only this
 * tenant's rows (the table is shared by every tenant and environment).
 *
 * Under a table prefix, pass `tables` (the same `defineAnalyticsTables(...)`
 * you give `createAnalytics`). Without it this names the DEFAULT table,
 * `analytics_sessions`, and the audience's preview and apply would count the
 * wrong table. (`getExcludedBreakdown` always passes the instance's own.)
 */
export function audienceSessionsSource(input: { tenantId: string; tables?: Pick<AnalyticsTables, "sessions"> }): AnalyticsAudienceRows {
  const table = input.tables ? getTableName(input.tables.sessions) : "analytics_sessions";
  return { table, visitor: "visitor_key", time: "started_at", id: "id", where: { tenant_id: input.tenantId } };
}

// ---------------------------------------------------------------------------
// The instance context every internal function takes.
// ---------------------------------------------------------------------------

export interface AnalyticsContext {
  db: AnalyticsDb;
  t: AnalyticsTables;
  limits: AnalyticsLimits;
  /**
   * The audience whose marks a report for `tenantId` honours, or null (no
   * filter: 0.1 behaviour). Throws `invalid_config` when the audience says it
   * belongs to another tenant.
   */
  audienceFor: (tenantId: string) => AnalyticsAudience | null;
  /** Bot names the crawler reports leave out unless `includeInternal`. */
  excludedBots: readonly string[];
  /** day → salt, this instance only. */
  saltCache: Map<string, string>;
  /** Tenants this instance has already stamped a tracking start for. */
  knownSites: Set<string>;
  /** The instance's crawler verifier, used when a call passes none. */
  verifier: CrawlerVerifier | null;
  /** Throws `AnalyticsError("unlicensed")` when the license says no; reports call it. */
  gate: () => void;
  /** Told about failures the ingest swallows (it always answers 204). */
  onError: (error: unknown, where: string) => void;
}
