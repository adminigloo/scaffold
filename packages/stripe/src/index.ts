export {
  createStripeClient,
  isStripeConfigured,
  getStripeOrThrow,
  StripeNotConfiguredError,
  STRIPE_API_VERSION,
} from "./client.js";
export type { CreateStripeClientOptions, StripeClient } from "./client.js";

export {
  verifyStripeSignature,
  assertEventLivemode,
  StripeSignatureError,
  StripeLivemodeMismatchError,
} from "./webhook.js";

export {
  decideClaim,
  tenantIdFromEvent,
  claimStatements,
  DEFAULT_CLAIM_LEASE_MS,
} from "./ledger.js";
export type { ClaimInput, ClaimOutcome } from "./ledger.js";

export { createEventRegistry, DuplicateEventHandlerError } from "./registry.js";
export type {
  DispatchResult,
  EventRegistry,
  EventRegistryOptions,
  StripeEventHandler,
  StripeEventOf,
  StripeEventType,
} from "./registry.js";

export {
  checkoutReturnUrls,
  createBillingPortalSession,
  createCheckoutSession,
  withTenantMetadata,
  CHECKOUT_SESSION_ID_TEMPLATE,
} from "./checkout.js";
export type {
  CheckoutReturnUrls,
  CreateBillingPortalSessionInput,
  CreateCheckoutSessionInput,
  ReturnUrlPaths,
} from "./checkout.js";

/**
 * Reading a subscription out of Stripe, in the one module that knows where its
 * fields live after two API versions moved them.
 */
export {
  subscriptionSnapshot,
  subscriptionIdFromInvoice,
  SUBSCRIPTION_EVENT_TYPES,
} from "./subscription.js";
export type { StripeSubscriptionSnapshot } from "./subscription.js";

/** Publishing a plan row to Stripe so there is a Price to bill against. */
export { ensurePlanPrice, PlanPriceMismatchError } from "./plan-price.js";
export type { EnsurePlanPriceInput, EnsuredPlanPrice } from "./plan-price.js";

export { stripeServer, stripeClient, STRIPE_MODE_BOUND_KEYS } from "./env.js";

export { stripePermissions } from "./permissions.js";
