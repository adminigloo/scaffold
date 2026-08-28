import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import {
  CHECKOUT_SESSION_ID_TEMPLATE,
  checkoutReturnUrls,
  withTenantMetadata,
} from "../checkout.js";

const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
  { price: "price_1", quantity: 1 },
];

describe("withTenantMetadata", () => {
  it("stamps the tenant on the Session and on the PaymentIntent it creates", () => {
    // Session metadata does NOT propagate to the PaymentIntent, so
    // payment_intent.succeeded would arrive with no tenant if only the Session
    // were stamped.
    const params = withTenantMetadata("t_42", { mode: "payment", line_items: lineItems });
    expect(params.metadata).toEqual({ tenantId: "t_42" });
    expect(params.payment_intent_data?.metadata).toEqual({ tenantId: "t_42" });
  });

  it("defaults to payment mode when mode is omitted, as Stripe does", () => {
    const params = withTenantMetadata("t_42", { line_items: lineItems });
    expect(params.payment_intent_data?.metadata).toEqual({ tenantId: "t_42" });
  });

  it("uses subscription_data in subscription mode, never payment_intent_data", () => {
    // Sending payment_intent_data with mode: subscription is a 400 from Stripe.
    const params = withTenantMetadata("t_42", {
      mode: "subscription",
      line_items: lineItems,
    });
    expect(params.subscription_data?.metadata).toEqual({ tenantId: "t_42" });
    expect(params.payment_intent_data).toBeUndefined();
  });

  it("sends neither in setup mode, which creates a SetupIntent", () => {
    const params = withTenantMetadata("t_42", { mode: "setup" });
    expect(params.metadata).toEqual({ tenantId: "t_42" });
    expect(params.payment_intent_data).toBeUndefined();
    expect(params.subscription_data).toBeUndefined();
  });

  it("keeps the caller's other metadata", () => {
    const params = withTenantMetadata("t_42", {
      mode: "payment",
      line_items: lineItems,
      metadata: { cartId: "c_9" },
    });
    expect(params.metadata).toEqual({ cartId: "c_9", tenantId: "t_42" });
  });

  it("keeps the caller's other payment_intent_data fields", () => {
    const params = withTenantMetadata("t_42", {
      mode: "payment",
      line_items: lineItems,
      payment_intent_data: { description: "Order 9", metadata: { cartId: "c_9" } },
    });
    expect(params.payment_intent_data).toEqual({
      description: "Order 9",
      metadata: { cartId: "c_9", tenantId: "t_42" },
    });
  });

  it("OVERWRITES a caller-supplied tenantId rather than honouring it", () => {
    // The tenant comes from the authenticated request. A tenantId arriving in
    // params is either a bug or an attempt to book a payment against somebody
    // else's account.
    const params = withTenantMetadata("t_42", {
      mode: "payment",
      line_items: lineItems,
      metadata: { tenantId: "t_victim" },
      payment_intent_data: { metadata: { tenantId: "t_victim" } },
    });
    expect(params.metadata).toEqual({ tenantId: "t_42" });
    expect(params.payment_intent_data?.metadata).toEqual({ tenantId: "t_42" });
  });

  it("does not mutate the params it was given", () => {
    const original: Stripe.Checkout.SessionCreateParams = {
      mode: "payment",
      line_items: lineItems,
      metadata: { cartId: "c_9" },
    };
    withTenantMetadata("t_42", original);
    expect(original.metadata).toEqual({ cartId: "c_9" });
    expect(original.payment_intent_data).toBeUndefined();
  });
});

describe("checkoutReturnUrls", () => {
  it("builds absolute URLs and appends the session id placeholder", () => {
    expect(
      checkoutReturnUrls("https://app.example.com", {
        successPath: "/orders/thanks",
        cancelPath: "/cart",
      }),
    ).toEqual({
      success_url:
        `https://app.example.com/orders/thanks` +
        `?session_id=${CHECKOUT_SESSION_ID_TEMPLATE}`,
      cancel_url: "https://app.example.com/cart",
    });
  });

  it("leaves the placeholder braces unescaped", () => {
    // URLSearchParams would percent-encode them and Stripe would hand the
    // success page the literal text %7BCHECKOUT_SESSION_ID%7D.
    const { success_url } = checkoutReturnUrls("https://app.example.com", {
      successPath: "/thanks",
      cancelPath: "/cart",
    });
    expect(success_url).toContain("{CHECKOUT_SESSION_ID}");
    expect(success_url).not.toContain("%7B");
  });

  it("joins with & when the path already has a query string", () => {
    const { success_url } = checkoutReturnUrls("https://app.example.com", {
      successPath: "/thanks?ref=email",
      cancelPath: "/cart",
    });
    expect(success_url).toBe(
      `https://app.example.com/thanks?ref=email` +
        `&session_id=${CHECKOUT_SESSION_ID_TEMPLATE}`,
    );
  });

  it("does not add a second placeholder when the caller placed one", () => {
    const { success_url } = checkoutReturnUrls("https://app.example.com", {
      successPath: "/thanks?cs={CHECKOUT_SESSION_ID}",
      cancelPath: "/cart",
    });
    expect(success_url).toBe("https://app.example.com/thanks?cs={CHECKOUT_SESSION_ID}");
  });

  it("keeps the placeholder usable in a PATH segment, which URL would encode", () => {
    // `new URL` leaves braces alone in a query string but percent-encodes them
    // in a path, and Stripe matches the placeholder as exact text — so
    // /thanks/%7BCHECKOUT_SESSION_ID%7D reaches the browser unsubstituted.
    const { success_url } = checkoutReturnUrls("https://app.example.com", {
      successPath: "/thanks/{CHECKOUT_SESSION_ID}",
      cancelPath: "/cart",
    });
    expect(success_url).toBe("https://app.example.com/thanks/{CHECKOUT_SESSION_ID}");
  });

  it("does not double the slash when the app URL has a trailing one", () => {
    const { cancel_url } = checkoutReturnUrls("https://app.example.com/", {
      successPath: "/thanks",
      cancelPath: "/cart",
    });
    expect(cancel_url).toBe("https://app.example.com/cart");
  });
});
