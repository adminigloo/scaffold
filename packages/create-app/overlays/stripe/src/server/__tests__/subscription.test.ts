import { describe, expect, it } from "vitest";
import {
  applySubscription,
  resolvePlanForSubscription,
  simulatedSubscriptionRef,
  sourceOfSubscriptionRef,
  InvalidSubscriptionReferenceError,
  PLAN_METADATA_KEY,
} from "@/server/subscription";

/**
 * The parts of the subscription mirror that need no database.
 *
 * The rest — the watermark, the entitlement reconciliation, the one-live-row
 * invariant — is enforced by Postgres constraints and by
 * `decideSubscriptionWrite` / `subscriptionEntitlementWindow`, which are pure
 * and tested in @__SCOPE_NAME__/billing. A test here that mocked the database
 * would be asserting against the mock's opinion of a unique index, which is the
 * one thing about it that matters and the one thing a mock cannot check.
 *
 * What IS worth testing here is the boundary: which subscriptions this
 * application claims, which it deliberately does not, and the refusal that has
 * to happen before anything is written.
 */

describe("subscription references", () => {
  it("mints a simulated reference that reads back as simulated", () => {
    const reference = simulatedSubscriptionRef();
    expect(reference.startsWith("simsub_")).toBe(true);
    expect(sourceOfSubscriptionRef(reference)).toBe("simulated");
  });

  it("reads a Stripe subscription id back as a Stripe subscription", () => {
    expect(sourceOfSubscriptionRef("sub_1PxyzAbC")).toBe("stripe");
  });

  it("refuses to classify anything else", () => {
    // Deliberately including the shapes that ALMOST match. `sub` without the
    // underscore and a bare UUID are both things a hand-written reference
    // reaches for, and either would sit in the column claiming to be something
    // it is not.
    for (const candidate of ["", "sub", "subx_1", "simsub_", "pi_1Abc", "abc"]) {
      expect(sourceOfSubscriptionRef(candidate), candidate).toBeNull();
    }
  });
});

describe("applySubscription", () => {
  const base = {
    tenantId: "t_1",
    tierKey: "pro",
    planKey: "pro:month:usd",
    stripeCustomerId: null,
    status: "active" as const,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    trialEndsAt: null,
    observedAt: new Date("2026-03-01T00:00:00Z"),
  };

  it("rejects a malformed Stripe reference before touching the database", async () => {
    // BEFORE the transaction opens, which is what makes this assertable with no
    // DATABASE_URL: a bad reference is caught by the pattern, not by a
    // constraint. The reference is how the row is found again, so a malformed
    // one either mirrors every subscription onto one row or creates a second
    // one on every event.
    await expect(
      applySubscription({ ...base, stripeSubscriptionId: "nope_1", source: "stripe" }),
    ).rejects.toBeInstanceOf(InvalidSubscriptionReferenceError);
  });

  it("refuses a Stripe-sourced write that names no subscription at all", async () => {
    // The simulated path is the ONLY one allowed to write a NULL
    // `stripe_subscription_id`. A Stripe write with no id would take the
    // simulated lookup path — "the tenant's row with no Stripe object" — and
    // silently overwrite a comped subscription with a real one's state.
    await expect(
      applySubscription({ ...base, stripeSubscriptionId: null, source: "stripe" }),
    ).rejects.toBeInstanceOf(InvalidSubscriptionReferenceError);
  });
});

describe("resolvePlanForSubscription", () => {
  it("resolves a tier from the metadata the checkout stamped", async () => {
    const resolved = await resolvePlanForSubscription({
      planMetadata: "pro",
      variantMetadata: undefined,
      priceId: "price_1",
      interval: "month",
      currency: "USD",
    });
    // The currency is lower-cased on the way into the key, because `planRowKey`
    // is what the seed spelled the row with and Stripe reports currencies in
    // lower case everywhere except where it does not.
    expect(resolved).toEqual({ kind: "plan", tierKey: "pro", planKey: "pro:month:usd" });
  });

  it("resolves a RETIRED tier, because subscribers are still on it", async () => {
    // `isActive: false` closes a tier to new subscriptions. It must not stop
    // the mirror reasoning about the people already there — that is the whole
    // reason a tier is retired rather than deleted.
    const resolved = await resolvePlanForSubscription({
      planMetadata: "starter-legacy",
      variantMetadata: undefined,
      priceId: null,
      interval: "month",
      currency: "gbp",
    });
    expect(resolved).toMatchObject({ kind: "plan", tierKey: "starter-legacy" });
  });

  it("reports a tier the record has never heard of rather than guessing", async () => {
    const resolved = await resolvePlanForSubscription({
      planMetadata: "platinum",
      variantMetadata: undefined,
      priceId: null,
      interval: "month",
      currency: "usd",
    });
    expect(resolved.kind).toBe("unknown");
  });

  it("refuses a cadence this catalogue does not sell", async () => {
    // `subscriptionSnapshot` reports a weekly subscription's interval as NULL,
    // and no `plans` row projects one — so there is nothing for
    // `subscriptions.plan_id` to point at.
    const resolved = await resolvePlanForSubscription({
      planMetadata: "pro",
      variantMetadata: undefined,
      priceId: null,
      interval: null,
      currency: "usd",
    });
    expect(resolved.kind).toBe("unknown");
  });

  it("hands a recurring PRODUCT back to the order path rather than claiming it", async () => {
    // A subscription variant in the shop is a Stripe subscription too, and it
    // is deliberately not mirrored: `subscriptions.plan_id` names a row in the
    // plan catalogue and a product variant is not one. Reported, never thrown —
    // throwing would answer 500 to an ordinary event and cost the endpoint.
    const resolved = await resolvePlanForSubscription({
      planMetadata: undefined,
      variantMetadata: "var_field_notes_monthly",
      priceId: null,
      interval: "month",
      currency: "usd",
    });
    expect(resolved.kind).toBe("product");
  });

  it("says it cannot attribute a subscription that names nothing", async () => {
    const resolved = await resolvePlanForSubscription({
      planMetadata: undefined,
      variantMetadata: undefined,
      priceId: null,
      interval: "month",
      currency: "usd",
    });
    expect(resolved.kind).toBe("unknown");
    if (resolved.kind !== "unknown") throw new Error("unreachable");
    // The message names the metadata key, because the person reading it is
    // about to go and look for it in the Stripe dashboard.
    expect(resolved.why).toContain(PLAN_METADATA_KEY);
  });

  it("treats blank metadata as absent rather than as a tier called nothing", async () => {
    const resolved = await resolvePlanForSubscription({
      planMetadata: "   ",
      variantMetadata: "var_1",
      priceId: null,
      interval: "month",
      currency: "usd",
    });
    expect(resolved.kind).toBe("product");
  });
});
