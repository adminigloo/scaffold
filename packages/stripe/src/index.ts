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

export { stripeServer, stripeClient, stripeConnectServer, stripeInvoicePaymentsServer, STRIPE_MODE_BOUND_KEYS } from "./env.js";

export { stripePermissions } from "./permissions.js";

// stripe 0.3: change a company's plan on its existing subscription (never a second one).
export { previewPlanChange, changePlan, PlanChangeError, prepareCompanyCheckout, PRORATION_DATE_MAX_AGE_SECONDS } from "./plan-change.js";
export type { PlanChangeInput, PlanChangePreview, ChangePlanInput, ChangePlanResult, CompanyCheckout, CompanyCheckoutInput } from "./plan-change.js";

// stripe 0.4: companies take card payments from their own customers (Connect).
export {
  MAX_PLATFORM_FEE_BPS,
  accountDisplayName,
  accountTakesCharges,
  applyAccountUpdate,
  companyAccountParams,
  companyForConnectEvent,
  connectLedgerKey,
  connectedAccountFor,
  createDirectCheckoutSession,
  describePlatformFee,
  disconnectConnectedAccount,
  expireDirectCheckoutSession,
  markAccountDeauthorized,
  platformFeeMinor,
  startConnectOnboarding,
} from "./connect.js";
export type { ConnectEventCompany, ConnectedAccountRow, DirectCheckoutInput, StartOnboardingInput, StripeDb } from "./connect.js";
export { runLedgeredEvent, ledgerRunStatus } from "./ledger-run.js";
export type { LedgeredEvent, LedgerRunResult } from "./ledger-run.js";
export { createConnectAdminHandlers } from "./connect-handlers.js";
export type { ConnectAuthorizeResult, CreateConnectAdminHandlersOptions, PaymentsStatusWire } from "./connect-handlers.js";
export { CONNECT_COUNTRIES } from "./connect-handlers.js";
export { STRIPE_CONNECT_ADMIN_ROUTES, STRIPE_CONNECT_ADMIN_ROUTE_PERMISSIONS, stripeConnectPermissions } from "./connect-routes.js";
export type { StripeConnectAdminRouteKind, StripeConnectRoute } from "./connect-routes.js";
// stripe 0.5: when Stripe says no — the owner's words, Stripe's own for staff, the fix link, and what to log.
export {
  CARD_PAYMENTS_SWITCHED_OFF,
  SOMETHING_ON_OUR_SIDE,
  STRIPE_BUSY,
  STRIPE_NOT_ANSWERING,
  STRIPE_REFUSED,
  describeStripeFailure,
  isStripeError,
  stripeFailureWire,
  stripeNotSetUp,
} from "./failure.js";
export type { StripeFailure, StripeFailureKind, StripeSetupProblem } from "./failure.js";

// Delete a company (create-app 0.37): every row of one company, children first.
export { forgetTenant } from "./forget.js";
