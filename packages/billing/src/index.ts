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

/**
 * The plan record: what a tier includes, what it costs, and what the `plans`
 * table has to hold for it.
 *
 * `IDENTITY_SEPARATOR` is deliberately NOT here. It is the byte grants.ts joins
 * a row identity with and the byte definePlans refuses inside a feature name —
 * a detail two modules in this package share, and nothing an application has any
 * use for.
 */
export {
  definePlans,
  planAllows,
  planRowKey,
  priceFor,
  reconcilePlans,
  InvalidGrantLimitError,
  InvalidPlanCatalogError,
  InvalidPlanKeyError,
} from "./plans.js";
export type {
  ExistingPlanRow,
  OrphanedPlanRow,
  PlanCatalog,
  PlanFeature,
  PlanFeatureDecl,
  PlanFeatureDecls,
  PlanFeatureHeading,
  PlanFeatureValueFor,
  PlanFlag,
  PlanFlagDecl,
  PlanOption,
  PlanOptionDecl,
  PlanPrices,
  PlanQuota,
  PlanQuotaDecl,
  PlanReconciliation,
  PlanRow,
  PlanTier,
  PlanTierInput,
} from "./plans.js";

/**
 * The two decisions a subscription mirror makes before it writes: which of two
 * observations is newer, and what each subscription state does to the
 * entitlement rows the plan granted.
 *
 * Pure, and here rather than in the webhook route, because a rule that only
 * runs behind a signed Stripe request with a live database is a rule nothing
 * exercises — and both of these fail silently when they are wrong.
 */
export {
  decideSubscriptionWrite,
  subscriptionEntitlementWindow,
  PAST_DUE_GRACE_MS,
} from "./mirror.js";
export type {
  EntitlementWindow,
  EntitlementWindowInput,
  SubscriptionWriteDecision,
  SubscriptionWriteInput,
} from "./mirror.js";

export { grantsForPlan, planGrantDiff } from "./grants.js";
export type { PlanGrant, PlanGrantChange, PlanGrantDiff } from "./grants.js";

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
 * `PlanInterval` now comes from ./plans.js, which is where it is declared;
 * ./schema.js re-exports it so "@adminigloo/billing/schema" is unchanged.
 */
export type { PlanInterval } from "./plans.js";
