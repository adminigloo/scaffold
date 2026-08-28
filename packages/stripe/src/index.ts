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

export { stripeServer, stripeClient, STRIPE_MODE_BOUND_KEYS } from "./env.js";

export { stripePermissions } from "./permissions.js";
