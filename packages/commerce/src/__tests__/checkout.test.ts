import { describe, expect, it } from "vitest";
import {
  StripeAmountRangeError,
  buildCheckoutDiscounts,
  buildOrderCheckoutParams,
  buildStripeLineItems,
} from "../checkout.js";
import type { CartLine } from "../cart.js";

function line(overrides: Partial<CartLine> = {}): CartLine {
  return {
    productRef: "sku_trailcard",
    name: "Alpine Trail Card",
    unitPriceMinor: 1999n,
    quantity: 1,
    ...overrides,
  };
}

const RETURN_URLS = {
  success_url: "https://shop.example.com/thanks?session_id={CHECKOUT_SESSION_ID}",
  cancel_url: "https://shop.example.com/cart",
} as const;

describe("buildStripeLineItems", () => {
  it("passes minor units through unchanged", () => {
    // Stripe's unit_amount is minor units and so is ours. No conversion, in
    // either direction, ever.
    const [item] = buildStripeLineItems([line({ unitPriceMinor: 1999n })], "usd");
    expect(item?.price_data?.unit_amount).toBe(1999);
  });

  it("does not multiply by 100, which is what breaks zero-decimal currencies", () => {
    // For JPY the minor unit IS the yen. A "convert to cents" step here charges
    // every Japanese customer a hundred times over.
    const [item] = buildStripeLineItems([line({ unitPriceMinor: 1200n })], "jpy");
    expect(item?.price_data?.unit_amount).toBe(1200);
    expect(item?.price_data?.currency).toBe("jpy");
  });

  it("lowercases and trims the currency", () => {
    const [item] = buildStripeLineItems([line()], " USD ");
    expect(item?.price_data?.currency).toBe("usd");
  });

  it("carries quantity and name", () => {
    const [item] = buildStripeLineItems([line({ quantity: 3 })], "usd");
    expect(item?.quantity).toBe(3);
    expect(item?.price_data?.product_data?.name).toBe("Alpine Trail Card");
  });

  it("copies line metadata for the packing slip", () => {
    const [item] = buildStripeLineItems(
      [line({ metadata: { engraving: "For Ada" } })],
      "usd",
    );
    expect(item?.price_data?.product_data?.metadata).toEqual({
      engraving: "For Ada",
    });
  });

  it("never emits a negative unit_amount", () => {
    // The invariant that forces discounts to be coupons.
    const items = buildStripeLineItems(
      [line({ unitPriceMinor: 0n }), line({ productRef: "b", unitPriceMinor: 5n })],
      "usd",
    );
    for (const item of items) {
      expect(item.price_data?.unit_amount).toBeGreaterThanOrEqual(0);
    }
  });

  it("throws rather than sending a negative amount Stripe will not explain", () => {
    expect(() =>
      buildStripeLineItems([line({ unitPriceMinor: -1n })], "usd"),
    ).toThrow(StripeAmountRangeError);
  });

  it("throws above 2^53 instead of silently rounding the charge", () => {
    // unit_amount is a JSON number. Past MAX_SAFE_INTEGER the value that
    // reaches Stripe differs from the order row and nobody can say why.
    expect(() =>
      buildStripeLineItems(
        [line({ unitPriceMinor: BigInt(Number.MAX_SAFE_INTEGER) + 1n })],
        "usd",
      ),
    ).toThrow(StripeAmountRangeError);
  });

  it("names the line in the error, which Stripe's own message does not", () => {
    expect(() =>
      buildStripeLineItems([line({ name: "Summit Pin", unitPriceMinor: -5n })], "usd"),
    ).toThrow(/Summit Pin/);
  });
});

describe("buildStripeLineItems — image filtering", () => {
  it("keeps absolute https and http URLs", () => {
    for (const url of [
      "https://cdn.example.com/card.png",
      "http://cdn.example.com/card.png",
    ]) {
      const [item] = buildStripeLineItems([line({ imageUrl: url })], "usd");
      expect(item?.price_data?.product_data?.images).toEqual([url]);
    }
  });

  it("drops a relative path", () => {
    // Stripe answers "Not a valid URL" without naming the line item or the
    // field, so one relative path in a thirty-line cart fails the whole
    // checkout with no pointer. Dropping the thumbnail still takes the money.
    const [item] = buildStripeLineItems([line({ imageUrl: "/img/card.png" })], "usd");
    expect(item?.price_data?.product_data?.images).toBeUndefined();
  });

  it("drops data: and blob: URIs, which a truthiness check would keep", () => {
    for (const url of [
      "data:image/png;base64,iVBORw0KGgo=",
      "blob:https://shop.example.com/2f1c",
    ]) {
      const [item] = buildStripeLineItems([line({ imageUrl: url })], "usd");
      expect(item?.price_data?.product_data?.images).toBeUndefined();
    }
  });

  it("omits the images key entirely rather than sending an empty array", () => {
    const [item] = buildStripeLineItems([line()], "usd");
    expect(item?.price_data?.product_data).not.toHaveProperty("images");
  });

  it("drops one bad image without failing the lines around it", () => {
    const items = buildStripeLineItems(
      [
        line({ productRef: "a", imageUrl: "/img/a.png" }),
        line({ productRef: "b", imageUrl: "https://cdn.example.com/b.png" }),
      ],
      "usd",
    );
    expect(items).toHaveLength(2);
    expect(items[0]?.price_data?.product_data?.images).toBeUndefined();
    expect(items[1]?.price_data?.product_data?.images).toEqual([
      "https://cdn.example.com/b.png",
    ]);
  });
});

describe("buildCheckoutDiscounts", () => {
  it("emits a Stripe coupon", () => {
    expect(buildCheckoutDiscounts({ coupon: "SPRING25" })).toEqual([
      { coupon: "SPRING25" },
    ]);
  });

  it("emits a promotion code", () => {
    expect(buildCheckoutDiscounts({ promotionCode: "promo_123" })).toEqual([
      { promotion_code: "promo_123" },
    ]);
  });

  it("is undefined when there is no discount, not an empty array", () => {
    // Stripe refuses `discounts` alongside `allow_promotion_codes`, and an
    // empty array still counts as sending the parameter.
    expect(buildCheckoutDiscounts(undefined)).toBeUndefined();
  });

  it("sends at most one, because Stripe accepts at most one", () => {
    expect(buildCheckoutDiscounts({ coupon: "A" })).toHaveLength(1);
  });
});

describe("buildOrderCheckoutParams", () => {
  const base = {
    tenantId: "t_42",
    lines: [line({ unitPriceMinor: 1999n, quantity: 2 })],
    currency: "usd",
    returnUrls: RETURN_URLS,
  } as const;

  it("stamps the tenant on the Session AND on the PaymentIntent", () => {
    // A Session's metadata does NOT propagate to the PaymentIntent it creates.
    // payment_intent.succeeded carries only the PaymentIntent's metadata, and
    // the ledger's tenantIdFromEvent reads it from there — miss this and the
    // event lands with a NULL tenant and no support engineer can find the order.
    const params = buildOrderCheckoutParams(base);
    expect(params.metadata?.tenantId).toBe("t_42");
    expect(params.payment_intent_data?.metadata?.tenantId).toBe("t_42");
  });

  it("refuses a caller-supplied tenantId in metadata", () => {
    // The tenant comes from the authenticated request. A metadata.tenantId is
    // either a mistake or an attempt to book a payment against another tenant.
    const params = buildOrderCheckoutParams({
      ...base,
      metadata: { tenantId: "t_someone_else", cartId: "c_9" },
    });
    expect(params.metadata?.tenantId).toBe("t_42");
    expect(params.metadata?.cartId).toBe("c_9");
    expect(params.payment_intent_data?.metadata?.tenantId).toBe("t_42");
  });

  it("sets mode explicitly, because withTenantMetadata branches on it", () => {
    // An omitted mode works today by falling through to the payment branch. A
    // later edit that makes the mode dynamic would move the metadata somewhere
    // payment_intent.succeeded cannot see it, silently.
    expect(buildOrderCheckoutParams(base).mode).toBe("payment");
  });

  it("NEVER represents a discount as a line item", () => {
    // trailcards writes the discount into the products' own unit_amount, which
    // hides the promo from the receipt, taxes the written-down price, and
    // redistributes one rounding across N lines — the cent the order row and
    // the Stripe charge then differ by, permanently.
    const params = buildOrderCheckoutParams({
      ...base,
      discount: { coupon: "SPRING25" },
    });

    expect(params.discounts).toEqual([{ coupon: "SPRING25" }]);
    expect(params.line_items).toHaveLength(1);
    for (const item of params.line_items ?? []) {
      expect(item.price_data?.unit_amount).toBe(1999);
      expect(item.price_data?.unit_amount).toBeGreaterThan(0);
    }
  });

  it("omits discounts entirely when there is none", () => {
    expect(buildOrderCheckoutParams(base)).not.toHaveProperty("discounts");
  });

  it("sends shipping as a Stripe shipping rate, not as a product line", () => {
    // Stripe Tax taxes shipping at the jurisdiction's shipping rate, which in
    // several US states is not the product rate. A "Shipping" product line is
    // taxed as a product and the difference is the merchant's to make up.
    const params = buildOrderCheckoutParams({
      ...base,
      shippingRateIds: ["shr_standard", "shr_express"],
    });
    expect(params.shipping_options).toEqual([
      { shipping_rate: "shr_standard" },
      { shipping_rate: "shr_express" },
    ]);
    expect(params.line_items).toHaveLength(1);
  });

  it("omits shipping_options for an empty rate list", () => {
    expect(
      buildOrderCheckoutParams({ ...base, shippingRateIds: [] }),
    ).not.toHaveProperty("shipping_options");
  });

  it("carries the return URLs through untouched", () => {
    // The session id placeholder must reach Stripe unescaped; anything that
    // re-encodes it hands the success page a literal %7BCHECKOUT_SESSION_ID%7D.
    const params = buildOrderCheckoutParams(base);
    expect(params.success_url).toBe(RETURN_URLS.success_url);
    expect(params.cancel_url).toBe(RETURN_URLS.cancel_url);
  });

  it("omits customer_email rather than sending an empty string", () => {
    expect(buildOrderCheckoutParams(base)).not.toHaveProperty("customer_email");
    expect(
      buildOrderCheckoutParams({ ...base, customerEmail: "ada@example.com" })
        .customer_email,
    ).toBe("ada@example.com");
  });
});
