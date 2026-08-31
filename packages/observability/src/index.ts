export { createLogger, redactValue, REDACT_PATHS, REDACTED } from "./logger.js";
export type { CreateLoggerOptions, LogLevel, LogSink } from "./logger.js";

export {
  clientIpFromHeaders,
  resolveRequestId,
  REQUEST_ID_HEADER,
} from "./request.js";
export type { HeaderSource } from "./request.js";

export { createErrorReporter } from "./reporter.js";
export type {
  CreateErrorReporterOptions,
  ErrorReport,
  ErrorReporter,
  ErrorReporterDb,
} from "./reporter.js";

export {
  createRateLimiter,
  rateLimitHeaders,
  RATE_LIMIT_POLICIES,
} from "./limiter.js";
export type {
  RateLimitCheck,
  RateLimiter,
  RateLimiterOptions,
  RateLimitFetch,
  RateLimitPolicy,
} from "./limiter.js";

export {
  defineAuditedActions,
  auditEntry,
  DuplicateAuditActionError,
  UnknownAuditActionError,
} from "./audit.js";
export type {
  AuditActionKeyOf,
  AuditActor,
  AuditedAction,
  AuditedActionMap,
  AuditEntry,
  AuditEntryInput,
  AuditRegistry,
  AuditRequestContext,
} from "./audit.js";

export {
  errorFingerprint,
  fingerprintSource,
  DEFAULT_FINGERPRINT_FRAMES,
  FINGERPRINT_LENGTH,
} from "./fingerprint.js";
export type { FingerprintOptions } from "./fingerprint.js";

export {
  checkRateLimit,
  createMemoryRateLimitStore,
  RateLimitConfigError,
} from "./ratelimit.js";
export type {
  MemoryRateLimitStore,
  MemoryRateLimitStoreOptions,
  RateLimitInput,
  RateLimitResult,
  RateLimitStore,
} from "./ratelimit.js";

export {
  observabilityServer,
  observabilityGroupStatus,
  groupComplete,
  OBSERVABILITY_ENV_GROUPS,
} from "./env.js";
export type { EnvGroupState, EnvGroupStatus } from "./env.js";

/**
 * Row types only. The tables themselves are reachable exclusively from
 * `@adminigloo/observability/schema`.
 *
 * `export type` erases completely, so this adds nothing to the runtime graph.
 * Re-exporting the `pgTable` VALUES here would pull `drizzle-orm/pg-core` into
 * every consumer of the barrel — including client bundles that only wanted
 * `redactValue` — and tsup does not code-split CJS, so a CJS consumer would
 * end up holding two distinct objects for one physical table and Drizzle's
 * reference equality (`eq(auditLog.id, …)` against a query built elsewhere)
 * would stop matching.
 */
export type {
  AuditLogRow,
  ErrorLogRow,
  NewAuditLogRow,
  NewErrorLogRow,
} from "./schema.js";
