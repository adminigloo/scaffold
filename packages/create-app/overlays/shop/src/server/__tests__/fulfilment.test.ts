import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asTenantUser } from "__SCOPE__/testing/auth";
import { createScaffoldContext } from "__SCOPE__/trpc";
import {
  assertPurchasable,
  fulfilPurchase,
  referenceOfKey,
  simulatedReference,
  sourceOfReference,
  FULFILMENT_KEY_PREFIX,
  MAX_QUANTITY,
  PurchaseRefusedError,
  STRIPE_MAX_AMOUNT_MINOR,
  type PurchasableVariant,
} from "@/server/fulfilment";
import { appRouter } from "@/server/routers/_app";
import { createCallerFactory } from "@/server/trpc";

/**
 * Whether this deployment can sign anybody in, as a stub.
 *
 * The real function reads `env`, which t3-env validates and freezes at import
 * time, so there is nothing left to stub by the time a test runs. Replacing the
 * export is therefore the only seam — and it is the honest one: `simulate`
 * reads exactly this function, so a rewrite of the guard that stopped calling
 * it would fail these tests rather than pass them.
 *
 * `importOriginal` keeps `currentPrincipal` and the rest of the module real, so
 * adding an export to it later does not silently blank it out here.
 */
const auth = vi.hoisted(() => ({
  isSignInConfigured: vi.fn<() => boolean>(),
}));

/**
 * `checkoutMode` reads the `stripe` const from this module, bound at import
 * time. The stub used to write `globalThis.__adminiglooStripe`, which nothing
 * has read since the four scattered checks were replaced by one predicate — so
 * "refuses once Stripe IS configured" was asserting against a client that was
 * still null, and it shipped RED in every generated project that sells
 * anything.
 *
 * Spying on the module the predicate imports keeps the test honest in the way
 * the original comment wanted: `checkoutMode` itself still runs, so rewriting
 * it to consult some other flag makes this fail rather than pass.
 */
const stripeState = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("@/server/stripe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/stripe")>()),
  // A GETTER, because a module export is read-only: assigning to it passes
  // under vitest and fails `tsc --noEmit`, which would ship a red typecheck in
  // every generated project — the same class of defect this test exists to
  // stop.
  get stripe() {
    return stripeState.client;
  },
}));

vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  ...auth,
}));

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
  stripeState.client = {};
}

function pretendStripeIsNotConfigured(): void {
  stripeState.client = null;
}

beforeEach(() => {
  // The configuration the simulated checkout exists for: a project generated
  // this morning, with a database and nothing else. Every test that needs the
  // other answer says so.
  auth.isSignInConfigured.mockReturnValue(false);
});

afterEach(() => {
  pretendStripeIsNotConfigured();
  delete (globalThis as { __adminiglooStripe?: unknown }).__adminiglooStripe;
  // `resolveAppEnv()` reads VERCEL_ENV out of `process.env` on every call, so a
  // stub left behind would make every later test in this file believe it is
  // running on a production deployment.
  vi.unstubAllEnvs();
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

  it("refuses on a production deployment, keys or no keys", async () => {
    // THE HOLE THE STRIPE CHECK ALONE LEAVES, and the expensive one: a
    // production deployment whose keys have not been pasted in yet. That is not
    // a demo, it is a shop minutes before launch with a real catalogue on it,
    // and without this gate every visitor could take all of it for free.
    //
    // VERCEL_ENV is what `resolveAppEnv()` derives from, and the platform sets
    // it — there is no variable a person can put in a dashboard to turn this
    // off, which is the same property `assertKeyMode` relies on.
    vi.stubEnv("VERCEL_ENV", "production");

    const caller = createCaller(
      createScaffoldContext({ principal: asTenantUser() }),
    );

    await expect(
      caller.checkout.simulate({ variantId: "var_1", quantity: 1 }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("still refuses an anonymous caller wherever anybody CAN sign in", async () => {
    // The rung changed from `protectedProcedure` to `publicProcedure`, and this
    // is the property that must survive the change: on a deployment with an
    // identity provider, an order still has to belong to somebody. The refusal
    // moved from the middleware into the handler; it did not go away.
    auth.isSignInConfigured.mockReturnValue(true);

    const caller = createCaller(createScaffoldContext({ principal: null }));

    await expect(
      caller.checkout.simulate({ variantId: "var_1", quantity: 1 }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("lets an anonymous caller through when nobody can sign in at all", async () => {
    // WHY THE GUEST PATH EXISTS. With no Clerk keys `currentPrincipal()` returns
    // null for every request by construction, so a `protectedProcedure` refused
    // everybody — which made the simulated checkout unreachable on exactly the
    // configuration it was built for, and "sign in first" is not advice anybody
    // can act on when there is nowhere to sign in.
    //
    // The assertion is negative on purpose. Past the gate the procedure reads
    // the variant, and a unit test has no database — so getting a DIFFERENT
    // failure is the proof that the sign-in gate let this call through, and it
    // stays true without inventing a fake catalog for the gate to be tested
    // against. The order that gets written on the other side is covered by
    // ./fulfilment.integration.test.ts, against a real Postgres.
    const caller = createCaller(createScaffoldContext({ principal: null }));

    const failure: unknown = await caller.checkout
      .simulate({ variantId: "var_1", quantity: 1 })
      .then(() => null)
      .catch((error: unknown) => error);

    expect(failure).not.toBeNull();
    expect((failure as { code?: string }).code).not.toBe("UNAUTHORIZED");
    expect((failure as { code?: string }).code).not.toBe("PRECONDITION_FAILED");
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

// ---------------------------------------------------------------------------
// The key an order is booked under, read back
// ---------------------------------------------------------------------------

describe("referenceOfKey", () => {
  it("is the exact inverse of the key bookOrder writes", () => {
    // THE HINGE THE WHOLE ACCOUNT AREA HANGS ON. `orders.idempotency_key` is
    // `fulfilment:<reference>` and `entitlements.source_ref` is
    // `<reference>:<grantId>`, so this function is the only thing connecting an
    // order a customer owns to the grants it produced. A change to the prefix
    // that broke it would not fail to compile and would not fail a build — the
    // account area would simply stop showing anybody the access they paid for.
    const reference = simulatedReference();
    expect(referenceOfKey(`${FULFILMENT_KEY_PREFIX}${reference}`)).toBe(reference);
    expect(referenceOfKey(`${FULFILMENT_KEY_PREFIX}pi_3ABCdef`)).toBe("pi_3ABCdef");
  });

  it("returns null for a key written under another namespace", () => {
    // @__SCOPE_NAME__/commerce defines its own `checkout_session:` prefix over
    // the same column. A row keyed that way is still somebody's order and must
    // still appear in their history; it simply names no grants.
    expect(referenceOfKey("checkout_session:cs_test_123")).toBeNull();
    expect(referenceOfKey("")).toBeNull();
  });

  it("does not mistake a reference that merely starts with the prefix letters", () => {
    // The prefix includes its colon, so a hypothetical `fulfilmentX:` namespace
    // is a different namespace rather than a reference beginning with "X".
    expect(referenceOfKey("fulfilmentX:abc")).toBeNull();
  });
});
