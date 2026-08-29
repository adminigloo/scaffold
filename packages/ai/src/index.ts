export { createStreamRoute, InvalidStreamScopeError } from "./route.js";
export type {
  CreateStreamRouteOptions,
  StreamRouteAuth,
  StreamRouteContext,
  StreamRouteScope,
} from "./route.js";

export { meterStream, reportUsage } from "./stream.js";
export type {
  MeterStreamOptions,
  StreamOutcome,
  StreamUsage,
  UsageReporter,
} from "./stream.js";

export { estimateCostMicros, costMinorUnits, InvalidCostInputError } from "./cost.js";
export type { CostInput, TokenRate } from "./cost.js";

export { aiPermissions } from "./permissions.js";

export { aiServer, configuredAiProviders, isAiConfigured } from "./env.js";
export type { AiProvider, AiProviderKeys } from "./env.js";

/**
 * Types only. `aiUsage` itself is reachable exclusively from `@adminigloo/ai/schema`
 * — re-exporting the pgTable here would pull `drizzle-orm/pg-core` into every
 * client bundle that imports a cost helper, and because tsup does not code-split
 * the CJS build, a CJS consumer would end up holding two distinct objects for
 * one physical table and Drizzle's reference equality would fail. These erase.
 */
export type { AiUsageRow, AiUsageStatus, NewAiUsageRow } from "./schema.js";
