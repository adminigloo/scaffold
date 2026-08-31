import { afterEach, describe, expect, it } from "vitest";
import { asTenantUser } from "__SCOPE__/testing/auth";
import { createScaffoldContext } from "__SCOPE__/trpc";
import {
  assertPurchasable,
  fulfilPurchase,
  simulatedReference,
  sourceOfReference,
  MAX_QUANTITY,
  PurchaseRefusedError,
  STRIPE_MAX_AMOUNT_MINOR,
  type PurchasableVariant,
} from "@/server/fulfilment";
import { appRouter } from "@/server/routers/_app";
import { createCallerFactory } from "@/server/trpc";

/**
 * The parts of fulfilment that need no database.
 *
 * The rest — idempotency, the grants, and the structural equality of a
 * simulated and a Stripe order — is in ./fulfilment.integration.test.ts,
 * because those properties are enforced by Postgres constraints and a test that
 * mocked the database would be asserting against the mock's opinion of them.
 */

// ---------------------------------------------------------------------------
// The eligibility gate
// ---------------------------------------------------------------------------

function variant(overrides: Partial<PurchasableVariant> = {}): PurchasableVariant {
  return {
    variantId: "var_1",
    variantName: "Standard",
    priceMinor: 2500n,
    currency: "usd",
    interval: null,
    inventory: null,
    stripePriceId: null,
    productId: "prod_1",
    productName: "Alpine Trail Card",
    productSlug: "alpine-trail-card",
    tenantId: "*",
    productStatus: "active",
    productDeleted: false,
    ...overrides,
  };
}

function refusalFor(input: PurchasableVariant, quantity: number): string {
  try {
    assertPurchasable(input, quantity);
  } catch (error) {
    if (error instanceof PurchaseRefusedError) return error.code;
    throw error;
  }
  return "allowed";
}

describe("assertPurchasable", () => {
  it("allows an active product with untracked inventory", () => {
    expect(refusalFor(variant(), 1)).toBe("allowed");
  });

  it("refuses a draft, an archived and a soft-deleted product identically", () => {
    // ONE code for all three. The difference between them is information about
    // an unreleased catalog, and a storefront that distinguishes them can be
    // probed for products that have not launched.
    expect(refusalFor(variant({ productStatus: "draft" }), 1)).toBe("not_for_sale");
    expect(refusalFor(variant({ productStatus: "archived" }), 1)).toBe(
      "not_for_sale",
    );
    expect(refusalFor(variant({ productDeleted: true }), 1)).toBe("not_for_sale");
  });

  it("distinguishes sold out from not enough left, and treats NULL as untracked", () => {
    expect(refusalFor(variant({ inventory: 0 }), 1)).toBe("sold_out");
    expect(refusalFor(variant({ inventory: 2 }), 3)).toBe("insufficient_stock");
    expect(refusalFor(variant({ inventory: 3 }), 3)).toBe("allowed");
    // The regression that matters: NULL collapsed to zero marks every digital
    // product in the catalog as sold out.
    expect(refusalFor(variant({ inventory: null }), 999)).toBe("allowed");
  });

  it("caps quantity", () => {
    expect(refusalFor(variant(), MAX_QUANTITY)).toBe("allowed");
    expect(refusalFor(variant(), MAX_QUANTITY + 1)).toBe("quantity_too_large");
    expect(refusalFor(variant(), 0)).toBe("quantity_too_large");
    expect(refusalFor(variant(), 1.5)).toBe("quantity_too_large");
  });

  it("caps the amount at what Stripe will accept — including on the simulated path", () => {
    // The realistic trigger is not a huge price. It is a large quantity against
    // an ordinary one, and quantity is client input.
    const priced = variant({ priceMinor: STRIPE_MAX_AMOUNT_MINOR });
    expect(refusalFor(priced, 1)).toBe("allowed");
    expect(refusalFor(priced, 2)).toBe("amount_too_large");
  });
});

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

describe("fulfilment references", () => {
  it("mints a simulated reference that reads back as simulated", () => {
    const reference = simulatedReference();
    expect(reference.startsWith("sim_")).toBe(true);
    expect(sourceOfReference(reference)).toBe("simulated");
  });

  it("reads a PaymentIntent id back as a Stripe purchase", () => {
    expect(sourceOfReference("pi_3QabcDEFghiJKL01")).toBe("stripe");
  });

  it("refuses to classify anything else", () => {
    // The order row's source is DERIVED from this string, so a value it cannot
    // classify must come back null rather than defaulting to "stripe" — which
    // would relabel a simulated order as a real payment.
    expect(sourceOfReference("")).toBeNull();
    expect(sourceOfReference("sim_not-a-uuid")).toBeNull();
    expect(sourceOfReference("cs_test_a1b2c3")).toBeNull();
  });

  it("rejects a mismatched reference before touching the database", async () => {
    // Each call must fail with the VALIDATION error specifically. The reference
    // is checked before any query is issued, so a malformed one can never reach
    // `orders.idempotency_key` — where an empty string would collapse every
    // order onto one row and a mismatched prefix would relabel a simulated
    // purchase as a real payment.
    await expect(
      fulfilPurchase({
        variantId: "var_1",
        quantity: 1,
        userId: "user_1",
        tenantId: "*",
        reference: "sim_00000000-0000-0000-0000-000000000000",
        source: "stripe",
      }),
    ).rejects.toMatchObject({ name: "InvalidFulfilmentReferenceError" });

    await expect(
      fulfilPurchase({
        variantId: "var_1",
        quantity: 1,
        userId: "user_1",
        tenantId: "*",
        reference: "pi_3QabcDEFghiJKL01",
        source: "simulated",
      }),
    ).rejects.toMatchObject({ name: "InvalidFulfilmentReferenceError" });

    await expect(
      fulfilPurchase({
        variantId: "var_1",
        quantity: 1,
        userId: "user_1",
        tenantId: "*",
        reference: "",
        source: "simulated",
      }),
    ).rejects.toMatchObject({ name: "InvalidFulfilmentReferenceError" });
  });
});

// ---------------------------------------------------------------------------
// The gate that closes when Stripe goes live
// ---------------------------------------------------------------------------

/**
 * `isStripeConfigured()` is exactly `globalThis.__adminiglooStripe !== undefined`
 * — that global IS the mechanism, set by `createStripeClient` when a secret key
 * is present. Setting it here is therefore not a mock of the check; it is the
 * real check, told the truth about a deployment that has Stripe.
 *
 * A `vi.mock` of __SCOPE__/stripe would be weaker: it would still pass if
 * somebody rewrote the guard to read a different flag, which is the exact edit
 * that would reopen this path on a live shop.
 */
function pretendStripeIsConfigured(): void {
  (globalThis as { __adminiglooStripe?: unknown }).__adminiglooStripe = {
    client: {},
    fingerprint: "test",
  };
}

afterEach(() => {
  delete (globalThis as { __adminiglooStripe?: unknown }).__adminiglooStripe;
});

const createCaller = createCallerFactory(appRouter);

describe("checkout.simulate", () => {
  it("refuses once Stripe IS configured", async () => {
    pretendStripeIsConfigured();

    const caller = createCaller(
      createScaffoldContext({ principal: asTenantUser() }),
    );

    // THE PROPERTY THE WHOLE FEATURE RESTS ON. The moment a deployment can take
    // money, this procedure must be unreachable — otherwise it is a way to take
    // products without paying, sitting in production, reachable by any
    // signed-in user with a variant id.
    //
    // It must also refuse BEFORE the eligibility read, or a deployment with
    // Stripe configured and no database would answer "cannot connect" here and
    // hide the fact that the gate exists at all.
    await expect(
      caller.checkout.simulate({ variantId: "var_1", quantity: 1 }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("still requires a signed-in caller when Stripe is not configured", async () => {
    // No `pretendStripeIsConfigured` — this is the state the simulated checkout
    // is meant for, and it is still a protectedProcedure. A purchase has to be
    // attributable to somebody even when nobody is paying for it.
    const caller = createCaller(createScaffoldContext({ principal: null }));

    await expect(
      caller.checkout.simulate({ variantId: "var_1", quantity: 1 }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects a quantity above the cap in its input schema", async () => {
    const caller = createCaller(
      createScaffoldContext({ principal: asTenantUser() }),
    );

    // The same bound `createIntent` declares, from the same constant. A
    // simulated purchase that could ask for more than a real one is a simulated
    // purchase that is not testing the real one.
    await expect(
      caller.checkout.simulate({
        variantId: "var_1",
        quantity: MAX_QUANTITY + 1,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
