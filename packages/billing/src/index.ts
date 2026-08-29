export {
  resolveEntitlements,
  checkEntitlement,
  InvalidEntitlementAmountError,
} from "./entitlements.js";
export type {
  EntitlementCheck,
  EntitlementReason,
  EntitlementRow,
  EntitlementSource,
  ResolvedEntitlement,
} from "./entitlements.js";

export { prorateMinor, CurrencyMismatchError } from "./proration.js";
export type { Proration, ProrationInput } from "./proration.js";

export {
  mapStripeSubscriptionStatus,
  isEntitledStatus,
  isLiveStatus,
  LIVE_SUBSCRIPTION_STATUSES,
} from "./status.js";
export type { SubscriptionStatus } from "./status.js";

export {
  grantsForPlan,
  planGrantDiff,
  GRANT_PREFIX,
  EmptyPlanKeyError,
  InvalidGrantLimitError,
} from "./grants.js";
export type {
  FeatureGrants,
  PlanGrant,
  PlanGrantChange,
  PlanGrantDiff,
  PlanRef,
} from "./grants.js";

export { billingPermissions } from "./permissions.js";
export type { BillingPermission } from "./permissions.js";

/**
 * Tables are reachable ONLY from "@adminigloo/billing/schema", matching auth,
 * stripe, permissions and tenancy.
 *
 * Re-exporting them here costs twice. The root entry becomes a static import of
 * drizzle-orm/pg-core, so a client component importing `checkEntitlement` drags
 * the whole query builder into the browser bundle — and with no
 * `sideEffects: false` anywhere in the repo, a bundler must assume the chunk
 * matters and cannot drop it. Worse, tsup does not code-split CJS: the same
 * `pgTable` call is emitted into BOTH dist/index.cjs and dist/schema.cjs, so a
 * CJS consumer holds two distinct objects for one physical table and reference
 * equality — which Drizzle relations and getTableConfig rely on — silently
 * fails.
 *
 * Types are safe to re-export: they erase at build time and pull in nothing.
 */
export type { PlanInterval } from "./schema.js";
