import { describe, expect, it } from "vitest";
import {
  StripeAmountOutOfRangeError,
  planStripeSync,
} from "../stripe-sync.js";
import type {
  CachedStripePrice,
  CachedStripeProduct,
  SyncProduct,
  SyncStep,
  SyncVariant,
} from "../stripe-sync.js";

function product(overrides: Partial<SyncProduct> = {}): SyncProduct {
  return {
    id: "prod_local_1",
    name: "Alpine Trail Deck",
    description: "A deck of cards.",
    status: "active",
    ...overrides,
  };
}

function variant(overrides: Partial<SyncVariant> = {}): SyncVariant {
  return {
    id: "var_local_1",
    priceMinor: 1999n,
    currency: "usd",
    interval: null,
    ...overrides,
  };
}

function cachedProduct(
  overrides: Partial<CachedStripeProduct> = {},
): CachedStripeProduct {
  return {
    id: "prod_stripe_1",
    name: "Alpine Trail Deck",
    description: "A deck of cards.",
    active: true,
    ...overrides,
  };
}

function cachedPrice(
  overrides: Partial<CachedStripePrice> = {},
): CachedStripePrice {
  return {
    id: "price_stripe_1",
    unitAmountMinor: 1999n,
    currency: "usd",
    interval: null,
    ...overrides,
  };
}

function actions(steps: readonly SyncStep[]): string[] {
  return steps.map((step) => step.action);
}

/** In sync: what every "nothing changed" assertion is measured against. */
function inSync() {
  return {
    product: product(),
    variant: variant(),
    cached: { product: cachedProduct(), price: cachedPrice() },
  };
}

// ---------------------------------------------------------------------------
// The matrix.
// ---------------------------------------------------------------------------

describe("nothing cached", () => {
  it("creates the product and then the price, in that order", () => {
    const plan = planStripeSync({ product: product(), variant: variant() });
    expect(actions(plan.steps)).toEqual(["create-product", "create-price"]);
    expect(plan.isNoop).toBe(false);
  });

  it("leaves the price's productId null, because the id does not exist yet", () => {
    // Explicit rather than implied. An executor that silently posts a price
    // with no `product` gets a 400 that names nothing useful.
    const plan = planStripeSync({ product: product(), variant: variant() });
    const step = plan.steps[1];
    expect(step?.action).toBe("create-price");
    if (step?.action !== "create-price") throw new Error("wrong step");
    expect(step.productId).toBeNull();
    expect(step.params.product).toBeUndefined();
  });

  it("archives nothing, because there is nothing to archive", () => {
    const plan = planStripeSync({ product: product(), variant: variant() });
    expect(actions(plan.steps)).not.toContain("archive-price-and-create");
  });

  it("stamps the local ids into metadata both ways", () => {
    const plan = planStripeSync({ product: product(), variant: variant() });
    const [create, price] = plan.steps;
    if (create?.action !== "create-product") throw new Error("wrong step");
    if (price?.action !== "create-price") throw new Error("wrong step");
    expect(create.params.metadata).toEqual({ catalogProductId: "prod_local_1" });
    expect(price.params.metadata).toEqual({
      catalogProductId: "prod_local_1",
      catalogVariantId: "var_local_1",
    });
  });
});

describe("nothing changed", () => {
  it("is a single noop step, not an empty plan", () => {
    // A UI listing "what will happen" needs something to render, and an empty
    // array is indistinguishable from a planner that returned nothing after a
    // bug.
    const plan = planStripeSync(inSync());
    expect(actions(plan.steps)).toEqual(["noop"]);
    expect(plan.isNoop).toBe(true);
  });

  it("stays a noop when the currencies differ only in case", () => {
    // THE expensive false positive. A case-sensitive compare treats a
    // hand-typed 'USD' as a change, archives the price and creates a new one —
    // on every single sync run, each one orphaning the last, subscriptions
    // scattered across all of them.
    const plan = planStripeSync({
      ...inSync(),
      variant: variant({ currency: "USD" }),
    });
    expect(plan.isNoop).toBe(true);
  });

  it("stays a noop when a draft product is active in Stripe", () => {
    // Draft is our concept, not Stripe's: checkout builds line items from this
    // catalog and filters on status, so a draft never reaches a session.
    // Mapping draft to inactive would make every publish a Stripe round trip
    // that can fail, and Stripe refuses to create a price on an archived
    // product.
    const plan = planStripeSync({
      ...inSync(),
      product: product({ status: "draft" }),
    });
    expect(plan.isNoop).toBe(true);
  });
});

describe("the name changed", () => {
  it("updates the product and leaves the price completely alone", () => {
    const plan = planStripeSync({
      ...inSync(),
      product: product({ name: "Alpine Trail Deck v2" }),
    });
    expect(actions(plan.steps)).toEqual(["update-product"]);
  });

  it("sends only the field that changed", () => {
    const plan = planStripeSync({
      ...inSync(),
      product: product({ name: "Alpine Trail Deck v2" }),
    });
    const step = plan.steps[0];
    if (step?.action !== "update-product") throw new Error("wrong step");
    expect(step.params).toEqual({ name: "Alpine Trail Deck v2" });
    expect(step.productId).toBe("prod_stripe_1");
  });

  it("says out loud that no charge changes", () => {
    const plan = planStripeSync({
      ...inSync(),
      product: product({ name: "Alpine Trail Deck v2" }),
    });
    expect(plan.steps[0]?.reason).toContain("name");
    expect(plan.steps[0]?.reason).toContain("no customer");
  });

  it("clears a removed description with the empty string, not null", () => {
    // Stripe types the field as `Emptyable<string>` and will not take null; the
    // empty string is how you unset it.
    const plan = planStripeSync({
      ...inSync(),
      product: product({ description: null }),
    });
    const step = plan.steps[0];
    if (step?.action !== "update-product") throw new Error("wrong step");
    expect(step.params).toEqual({ description: "" });
  });

  it("archives the Stripe product when the local product is archived", () => {
    // An archived product's prices may already be in a payment link somebody
    // pasted into Slack, and our own status column cannot stop that one.
    const plan = planStripeSync({
      ...inSync(),
      product: product({ status: "archived" }),
    });
    const step = plan.steps[0];
    if (step?.action !== "update-product") throw new Error("wrong step");
    expect(step.params).toEqual({ active: false });
  });
});

// ---------------------------------------------------------------------------
// The immutable fields. A Stripe price cannot be edited: `prices.update`
// accepts active/nickname/metadata and SILENTLY IGNORES the rest, so a sync
// that patches an amount returns 200 and charges the old amount forever.
// ---------------------------------------------------------------------------

describe("the amount changed", () => {
  it("archives the old price and creates a new one", () => {
    const plan = planStripeSync({
      ...inSync(),
      variant: variant({ priceMinor: 2499n }),
    });
    expect(actions(plan.steps)).toEqual(["archive-price-and-create"]);
  });

  it("never emits an update that would silently no-op", () => {
    const plan = planStripeSync({
      ...inSync(),
      variant: variant({ priceMinor: 2499n }),
    });
    for (const step of plan.steps) {
      expect(step.action).not.toBe("update-price");
    }
  });

  it("names the field that forced it, and the price being archived", () => {
    const plan = planStripeSync({
      ...inSync(),
      variant: variant({ priceMinor: 2499n }),
    });
    const step = plan.steps[0];
    if (step?.action !== "archive-price-and-create") throw new Error("wrong step");
    expect(step.changed).toEqual(["amount"]);
    expect(step.archivePriceId).toBe("price_stripe_1");
    expect(step.params.unit_amount).toBe(2499);
    expect(step.params.product).toBe("prod_stripe_1");
    expect(step.reason).toContain("immutable");
  });
});

describe("the currency changed", () => {
  it("archives and creates, because currency is immutable too", () => {
    const plan = planStripeSync({
      ...inSync(),
      variant: variant({ currency: "eur" }),
    });
    const step = plan.steps[0];
    if (step?.action !== "archive-price-and-create") throw new Error("wrong step");
    expect(step.changed).toEqual(["currency"]);
    expect(step.params.currency).toBe("eur");
  });
});

describe("the interval changed", () => {
  it("archives and creates when a one-time price becomes recurring", () => {
    const plan = planStripeSync({
      ...inSync(),
      variant: variant({ interval: "month" }),
    });
    const step = plan.steps[0];
    if (step?.action !== "archive-price-and-create") throw new Error("wrong step");
    expect(step.changed).toEqual(["interval"]);
    expect(step.params.recurring).toEqual({ interval: "month" });
  });

  it("archives and creates when a recurring price becomes one-time", () => {
    const plan = planStripeSync({
      product: product(),
      variant: variant({ interval: null }),
      cached: {
        product: cachedProduct(),
        price: cachedPrice({ interval: "year" }),
      },
    });
    const step = plan.steps[0];
    if (step?.action !== "archive-price-and-create") throw new Error("wrong step");
    expect(step.changed).toEqual(["interval"]);
    // No `recurring` key at all, rather than `recurring: undefined` — Stripe's
    // form encoder sends the key either way and rejects an empty object.
    expect("recurring" in step.params).toBe(false);
  });

  it("archives and creates when only the period changes", () => {
    const plan = planStripeSync({
      product: product(),
      variant: variant({ interval: "year" }),
      cached: {
        product: cachedProduct(),
        price: cachedPrice({ interval: "month" }),
      },
    });
    const step = plan.steps[0];
    if (step?.action !== "archive-price-and-create") throw new Error("wrong step");
    expect(step.changed).toEqual(["interval"]);
  });
});

describe("several things changed at once", () => {
  it("lists every immutable field, and updates the product separately", () => {
    const plan = planStripeSync({
      product: product({ name: "Renamed" }),
      variant: variant({ priceMinor: 2499n, currency: "eur", interval: "month" }),
      cached: { product: cachedProduct(), price: cachedPrice() },
    });
    expect(actions(plan.steps)).toEqual([
      "update-product",
      "archive-price-and-create",
    ]);
    const step = plan.steps[1];
    if (step?.action !== "archive-price-and-create") throw new Error("wrong step");
    expect(step.changed).toEqual(["amount", "currency", "interval"]);
    expect(step.reason).toContain("amount, currency and interval");
  });
});

describe("a cached price with no cached product", () => {
  it("re-creates the price, because a price's product is immutable as well", () => {
    const plan = planStripeSync({
      product: product(),
      variant: variant(),
      cached: { product: null, price: cachedPrice() },
    });
    expect(actions(plan.steps)).toEqual([
      "create-product",
      "archive-price-and-create",
    ]);
    const step = plan.steps[1];
    if (step?.action !== "archive-price-and-create") throw new Error("wrong step");
    expect(step.changed).toEqual(["product"]);
    expect(step.productId).toBeNull();
  });
});

describe("a cached product with no cached price", () => {
  it("creates only the price, against the known product id", () => {
    const plan = planStripeSync({
      product: product(),
      variant: variant(),
      cached: { product: cachedProduct(), price: null },
    });
    expect(actions(plan.steps)).toEqual(["create-price"]);
    const step = plan.steps[0];
    if (step?.action !== "create-price") throw new Error("wrong step");
    expect(step.productId).toBe("prod_stripe_1");
    expect(step.params.product).toBe("prod_stripe_1");
  });
});

describe("amounts", () => {
  it("passes minor units straight through, with no conversion", () => {
    // For JPY the minor unit IS the yen. A "× 100 to get cents" step here
    // charges every Japanese customer a hundredfold.
    const plan = planStripeSync({
      product: product(),
      variant: variant({ priceMinor: 1000n, currency: "jpy" }),
    });
    const step = plan.steps[1];
    if (step?.action !== "create-price") throw new Error("wrong step");
    expect(step.params.unit_amount).toBe(1000);
    expect(step.params.currency).toBe("jpy");
  });

  it("sends a free variant as 0 rather than omitting the amount", () => {
    const plan = planStripeSync({
      product: product(),
      variant: variant({ priceMinor: 0n }),
    });
    const step = plan.steps[1];
    if (step?.action !== "create-price") throw new Error("wrong step");
    expect(step.params.unit_amount).toBe(0);
  });

  it("refuses an amount that cannot survive the trip through a JSON number", () => {
    // unit_amount is a JSON number. Above 2^53 the bigint silently loses its
    // last digits on the way out, so the customer is charged an amount nobody
    // typed.
    expect(() =>
      planStripeSync({
        product: product(),
        variant: variant({ priceMinor: BigInt(Number.MAX_SAFE_INTEGER) + 1n }),
      }),
    ).toThrow(StripeAmountOutOfRangeError);
  });

  it("refuses a negative amount", () => {
    expect(() =>
      planStripeSync({
        product: product(),
        variant: variant({ priceMinor: -1n }),
      }),
    ).toThrow(StripeAmountOutOfRangeError);
  });
});

describe("every step explains itself", () => {
  it("carries a non-empty reason, so an admin UI never has to invent one", () => {
    const plans = [
      planStripeSync({ product: product(), variant: variant() }),
      planStripeSync(inSync()),
      planStripeSync({ ...inSync(), product: product({ name: "Renamed" }) }),
      planStripeSync({ ...inSync(), variant: variant({ priceMinor: 1n }) }),
      planStripeSync({
        product: product(),
        variant: variant(),
        cached: { product: cachedProduct(), price: null },
      }),
    ];
    for (const plan of plans) {
      expect(plan.steps.length).toBeGreaterThan(0);
      for (const step of plan.steps) {
        expect(step.reason.length).toBeGreaterThan(20);
      }
    }
  });
});
