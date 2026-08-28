import type Stripe from "stripe";
import type { StripeClient } from "./client.js";

/**
 * Stripe expands this placeholder server-side when it redirects the customer.
 * It must reach `success_url` unescaped, which is why the URLs below are built
 * by string concatenation: `URLSearchParams` percent-encodes the braces and
 * Stripe then hands the success page the literal text `%7BCHECKOUT_SESSION_ID%7D`.
 */
export const CHECKOUT_SESSION_ID_TEMPLATE = "{CHECKOUT_SESSION_ID}";

export interface ReturnUrlPaths {
  /** Path on this app, e.g. "/orders/thanks". Resolved against the app URL. */
  readonly successPath: string;
  readonly cancelPath: string;
}

export interface CheckoutReturnUrls {
  readonly success_url: string;
  readonly cancel_url: string;
}

/**
 * Absolute success and cancel URLs for a Checkout Session.
 *
 * The success URL always carries the session id. Without it the success page
 * has no handle on what was just bought and has to work it out from the most
 * recent order for that customer — which is trailcards' habit of inferring
 * identity from business keys, and it picks the wrong row the first time
 * somebody checks out twice in a minute.
 *
 * Resolved with `new URL` rather than concatenation so an app URL with a
 * trailing slash does not produce a double slash, which some payment methods
 * reject as a malformed return URL only in live mode.
 */
export function checkoutReturnUrls(
  appUrl: string,
  paths: ReturnUrlPaths,
): CheckoutReturnUrls {
  const success = restorePlaceholder(
    new URL(paths.successPath, appUrl).toString(),
  );
  const separator = success.includes("?") ? "&" : "?";
  return {
    success_url: success.includes(CHECKOUT_SESSION_ID_TEMPLATE)
      ? success
      : `${success}${separator}session_id=${CHECKOUT_SESSION_ID_TEMPLATE}`,
    cancel_url: new URL(paths.cancelPath, appUrl).toString(),
  };
}

/**
 * `new URL` leaves braces alone in a query string but percent-encodes them in
 * a PATH segment, so a caller who writes `/thanks/{CHECKOUT_SESSION_ID}` gets
 * `/thanks/%7BCHECKOUT_SESSION_ID%7D` — which Stripe does not recognise and
 * hands to the success page verbatim. Undone here rather than by skipping URL
 * resolution, and narrowed to this exact token so a genuinely encoded brace
 * elsewhere in the URL is left as the caller wrote it.
 */
function restorePlaceholder(url: string): string {
  return url.replace(/%7BCHECKOUT_SESSION_ID%7D/gi, CHECKOUT_SESSION_ID_TEMPLATE);
}

/**
 * Stamp the tenant onto the Session AND onto the object the Session creates.
 *
 * A Session's metadata does NOT propagate to the PaymentIntent or Subscription
 * it creates. That single Stripe behaviour is why the ledger cannot attribute
 * `payment_intent.succeeded` or `customer.subscription.updated` to a tenant
 * unless the metadata is written in both places at creation time — and an event
 * with no tenant is an event no support engineer can find.
 *
 * `payment_intent_data` is only legal in `payment` mode and `subscription_data`
 * only in `subscription` mode; sending the wrong one is a 400 from Stripe.
 * `setup` mode creates a SetupIntent and takes neither.
 *
 * The tenant always wins over anything in `params.metadata`. It comes from the
 * authenticated request, so a caller-supplied `metadata.tenantId` is either a
 * mistake or an attempt to book a payment against another tenant, and silently
 * honouring it is the worse of the two outcomes.
 */
export function withTenantMetadata(
  tenantId: string,
  params: Stripe.Checkout.SessionCreateParams,
): Stripe.Checkout.SessionCreateParams {
  const metadata = { ...params.metadata, tenantId };

  if (params.mode === "subscription") {
    return {
      ...params,
      metadata,
      subscription_data: {
        ...params.subscription_data,
        metadata: { ...params.subscription_data?.metadata, tenantId },
      },
    };
  }

  if (params.mode === "setup") return { ...params, metadata };

  // `payment` is also the default when `mode` is omitted.
  return {
    ...params,
    metadata,
    payment_intent_data: {
      ...params.payment_intent_data,
      metadata: { ...params.payment_intent_data?.metadata, tenantId },
    },
  };
}

export interface CreateCheckoutSessionInput {
  /** Attributed to this tenant in the ledger. Never taken from `params`. */
  readonly tenantId: string;
  readonly params: Stripe.Checkout.SessionCreateParams;
  /**
   * Strongly recommended: derive it from the thing being paid for (cart id,
   * invoice id), not from a random value. A double-clicked pay button without
   * one creates two Sessions and two PaymentIntents, and the customer can
   * complete both.
   */
  readonly idempotencyKey?: string;
}

export async function createCheckoutSession(
  client: StripeClient,
  input: CreateCheckoutSessionInput,
): Promise<Stripe.Response<Stripe.Checkout.Session>> {
  return client.stripe.checkout.sessions.create(
    withTenantMetadata(input.tenantId, input.params),
    input.idempotencyKey === undefined
      ? undefined
      : { idempotencyKey: input.idempotencyKey },
  );
}

export interface CreateBillingPortalSessionInput {
  readonly customerId: string;
  /** Path on this app to return to, e.g. "/settings/billing". */
  readonly returnPath: string;
  /** A portal configuration id, when the default configuration is not wanted. */
  readonly configuration?: string;
}

/**
 * A one-time link into Stripe's hosted billing portal.
 *
 * No idempotency key: portal sessions are short-lived, single-use links and
 * creating a second one costs nothing. Reusing a key here would hand a
 * customer a link that a previous request already consumed.
 */
export async function createBillingPortalSession(
  client: StripeClient,
  input: CreateBillingPortalSessionInput,
): Promise<Stripe.Response<Stripe.BillingPortal.Session>> {
  return client.stripe.billingPortal.sessions.create({
    customer: input.customerId,
    return_url: new URL(input.returnPath, client.appUrl).toString(),
    ...(input.configuration === undefined
      ? {}
      : { configuration: input.configuration }),
  });
}
