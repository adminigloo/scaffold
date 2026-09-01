import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import {
  subscriptionIdFromInvoice,
  subscriptionSnapshot,
  SUBSCRIPTION_EVENT_TYPES,
} from "../subscription.js";

/**
 * Built as the API renders them, not as the SDK types would let you get away
 * with. The whole reason this mapper exists is that two of these fields moved
 * between API versions and reading the old spelling yields `undefined` rather
 * than an error — so the fixtures put the period on the ITEM and the
 * subscription link under `parent`, which is where 2026-08-26.dahlia puts them.
 */
function subscription(
  overrides: Partial<Stripe.Subscription> = {},
  itemOverrides: Partial<Stripe.SubscriptionItem> = {},
): Stripe.Subscription {
  const item = {
    id: "si_1",
    object: "subscription_item",
    current_period_start: 1_772_323_200, // 2026-03-01T00:00:00Z
    current_period_end: 1_774_915_200, // 2026-03-31T00:00:00Z
    quantity: 1,
    price: {
      id: "price_pro_month_usd",
      object: "price",
      currency: "usd",
      unit_amount: 2900,
      recurring: { interval: "month" },
    },
    ...itemOverrides,
  } as unknown as Stripe.SubscriptionItem;

  return {
    id: "sub_1",
    object: "subscription",
    customer: "cus_1",
    status: "active",
    cancel_at_period_end: false,
    canceled_at: null,
    trial_end: null,
    currency: "usd",
    metadata: { tenantId: "t_42", planKey: "pro" },
    items: { object: "list", data: [item], has_more: false, url: "" },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

describe("subscriptionSnapshot", () => {
  it("reads the period off the ITEM, which is where it lives now", () => {
    const snapshot = subscriptionSnapshot(subscription());
    expect(snapshot.currentPeriodStart).toEqual(new Date("2026-03-01T00:00:00Z"));
    expect(snapshot.currentPeriodEnd).toEqual(new Date("2026-03-31T00:00:00Z"));
  });

  it("carries the identity, the price and the metadata the mirror needs", () => {
    const snapshot = subscriptionSnapshot(subscription());
    expect(snapshot).toMatchObject({
      subscriptionId: "sub_1",
      customerId: "cus_1",
      status: "active",
      priceId: "price_pro_month_usd",
      interval: "month",
      currency: "usd",
      quantity: 1,
      metadata: { tenantId: "t_42", planKey: "pro" },
    });
  });

  it("takes the customer id whether it came back expanded or not", () => {
    const expanded = subscriptionSnapshot(
      subscription({ customer: { id: "cus_9" } as Stripe.Customer }),
    );
    expect(expanded.customerId).toBe("cus_9");
  });

  it("does NOT narrow the status — the billing package owns that mapping", () => {
    // `paused` is a Stripe status this package must pass through untouched, so
    // that `mapStripeSubscriptionStatus` remains the one place deciding what an
    // unknown or unhandled status means.
    const snapshot = subscriptionSnapshot(
      subscription({ status: "paused" as Stripe.Subscription.Status }),
    );
    expect(snapshot.status).toBe("paused");
  });

  it("reports a cadence it cannot sell as NULL rather than passing it through", () => {
    const weekly = subscriptionSnapshot(
      subscription(
        {},
        {
          price: {
            id: "price_weekly",
            object: "price",
            currency: "usd",
            unit_amount: 500,
            recurring: { interval: "week" },
          },
        } as unknown as Partial<Stripe.SubscriptionItem>,
      ),
    );
    expect(weekly.interval).toBeNull();
  });

  it("survives a subscription with no items rather than throwing on index 0", () => {
    const empty = subscriptionSnapshot(
      subscription({
        items: { object: "list", data: [], has_more: false, url: "" },
      } as unknown as Partial<Stripe.Subscription>),
    );
    expect(empty).toMatchObject({
      priceId: null,
      interval: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      quantity: 1,
    });
    // The currency still comes back, off the subscription itself, because a
    // subscription with no items is a broken object and not an unreadable one.
    expect(empty.currency).toBe("usd");
  });

  it("treats a zero or absent unix timestamp as no date at all", () => {
    const snapshot = subscriptionSnapshot(
      subscription({ canceled_at: 0, trial_end: null }),
    );
    expect(snapshot.canceledAt).toBeNull();
    expect(snapshot.trialEndsAt).toBeNull();
  });

  it("keeps canceled_at and cancel_at_period_end as separate facts", () => {
    const scheduled = subscriptionSnapshot(
      subscription({ cancel_at_period_end: true, canceled_at: 1_772_323_200 }),
    );
    expect(scheduled.cancelAtPeriodEnd).toBe(true);
    expect(scheduled.canceledAt).toEqual(new Date("2026-03-01T00:00:00Z"));
    // Still running: the schedule is not the cancellation.
    expect(scheduled.status).toBe("active");
  });
});

describe("subscriptionIdFromInvoice", () => {
  const invoice = (parent: unknown): Stripe.Invoice =>
    ({ id: "in_1", object: "invoice", parent }) as unknown as Stripe.Invoice;

  it("reads the link from parent.subscription_details, where it moved to", () => {
    expect(
      subscriptionIdFromInvoice(
        invoice({ type: "subscription_details", subscription_details: { subscription: "sub_7" } }),
      ),
    ).toBe("sub_7");
  });

  it("accepts an expanded subscription", () => {
    expect(
      subscriptionIdFromInvoice(
        invoice({
          type: "subscription_details",
          subscription_details: { subscription: { id: "sub_8" } },
        }),
      ),
    ).toBe("sub_8");
  });

  it("returns NULL for a one-off invoice instead of throwing", () => {
    expect(subscriptionIdFromInvoice(invoice(null))).toBeNull();
    expect(
      subscriptionIdFromInvoice(invoice({ type: "quote_details", subscription_details: null })),
    ).toBeNull();
  });
});

describe("SUBSCRIPTION_EVENT_TYPES", () => {
  it("names the lifecycle and the two invoice events, with no duplicates", () => {
    expect([...SUBSCRIPTION_EVENT_TYPES]).toEqual([
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
      "invoice.paid",
      "invoice.payment_failed",
    ]);
    expect(new Set(SUBSCRIPTION_EVENT_TYPES).size).toBe(SUBSCRIPTION_EVENT_TYPES.length);
  });
});
