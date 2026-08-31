import { describe, expect, it } from "vitest";
import {
  accountOrderHref,
  describeSubscription,
  deliveryStageOf,
  formatDay,
  metersFor,
  type GrantedEntitlement,
} from "@/account";
import {
  featureLabel,
  limitLabel,
  orderStatusView,
} from "@/components/account/orderPresentation";

/**
 * The parts of the account area that need no database.
 *
 * Everything the customer reads is a rendering decision made from columns
 * `fulfilPurchase` already writes, and the decisions are exactly where this can
 * go wrong quietly: a subscription banner that says "renews" to somebody who
 * cancelled, an unlimited allowance rendered as zero, a refunded total printed
 * as though the money is gone. None of those are database behaviour, and all of
 * them are one wrong branch.
 *
 * The reads themselves are not covered here on purpose. `readGrantsForReferences`
 * and `readOrderForUser` are one SQL predicate each, and a test with a mocked
 * database would assert the mock's opinion of a WHERE clause — which is the one
 * thing about them that matters and the one thing a mock cannot check.
 *
 * NOTHING IMPORTED HERE TOUCHES `@/db`, which is what lets this file run in the
 * generator's own workspace suite as well as inside a generated project. That
 * is the whole reason the decisions live in `src/account.ts` and the queries in
 * `src/server/account.ts`: an overlay test that can only run after a project is
 * generated is a test that runs in no pipeline, which the catalog-admin overlay
 * has already demonstrated the cost of.
 */

const NOW = new Date("2026-06-01T12:00:00.000Z");
const day = (offset: number): Date =>
  new Date(NOW.getTime() + offset * 24 * 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// The subscription banner
// ---------------------------------------------------------------------------

function subscription(
  overrides: Partial<Parameters<typeof describeSubscription>[0]> = {},
) {
  return {
    status: "active" as const,
    currentPeriodEnd: day(20),
    cancelAtPeriodEnd: false,
    canceledAt: null,
    trialEndsAt: null,
    ...overrides,
  };
}

describe("describeSubscription", () => {
  it("says renews when it renews", () => {
    const banner = describeSubscription(subscription(), NOW);
    expect(banner.title).toContain("Renews on");
    expect(banner.tone).toBe("info");
  });

  it("says ENDS, not renews, when a cancellation is scheduled", () => {
    // THE ORDERING BUG THIS FUNCTION EXISTS TO PREVENT. `cancel_at_period_end`
    // and an ordinary renewal share `current_period_end`, so the same date
    // means the opposite thing — and a customer who scheduled a cancellation
    // and is then told their subscription renews cancels their card instead,
    // which turns a clean exit into a failed payment and a dunning email.
    const banner = describeSubscription(
      subscription({ cancelAtPeriodEnd: true }),
      NOW,
    );
    expect(banner.title).toContain("ends on");
    expect(banner.title).not.toContain("Renews");
    expect(banner.tone).toBe("warn");
  });

  it("prefers the scheduled cancellation over the trial", () => {
    // A trial that is already set to cancel is the combination a per-column
    // rendering gets wrong: it would show both "your trial ends" and "will not
    // renew", and the reader has to work out that those are one fact.
    const banner = describeSubscription(
      subscription({
        status: "trialing",
        trialEndsAt: day(5),
        cancelAtPeriodEnd: true,
      }),
      NOW,
    );
    expect(banner.title).toContain("ends on");
  });

  it("prefers a failed payment over everything below it", () => {
    // past_due is the only live state with something for the customer to DO,
    // so it outranks the renewal line even though the period is still open.
    const banner = describeSubscription(
      subscription({ status: "past_due", cancelAtPeriodEnd: true }),
      NOW,
    );
    expect(banner.tone).toBe("danger");
    expect(banner.title).toContain("payment");
  });

  it("treats a trial as over at the instant it ends", () => {
    // Closed boundary, matching `resolveEntitlements`. The open form leaves a
    // state that is unreachable in production and permanently flaky in tests.
    const onTheDot = describeSubscription(
      subscription({ status: "trialing", trialEndsAt: NOW }),
      NOW,
    );
    expect(onTheDot.title).toContain("Renews on");

    const stillRunning = describeSubscription(
      subscription({ status: "trialing", trialEndsAt: day(1) }),
      NOW,
    );
    expect(stillRunning.title).toContain("trial ends");
  });

  it("never prints undefined when a date column is null", () => {
    // Every one of these five columns is nullable, and a subscription that has
    // not completed its first payment has no period at all. A template literal
    // over a null renders the word "null" onto a customer's billing page.
    for (const status of ["active", "canceled", "trialing"] as const) {
      const banner = describeSubscription(
        subscription({ status, currentPeriodEnd: null, trialEndsAt: null }),
        NOW,
      );
      expect(banner.title).not.toContain("null");
      expect(banner.title).not.toContain("undefined");
      expect(banner.body).not.toContain("undefined");
    }
  });
});

describe("formatDay", () => {
  it("reads the date in UTC, not in the region that happened to be warm", () => {
    // A renewal date that reads 2 March from one serverless region and 3 March
    // from another is a support ticket about a charge on the wrong day.
    expect(formatDay(new Date("2026-03-02T23:30:00.000Z"))).toBe("2 March 2026");
  });
});

// ---------------------------------------------------------------------------
// Allowances
// ---------------------------------------------------------------------------

function grant(overrides: Partial<GrantedEntitlement> = {}): GrantedEntitlement {
  return {
    feature: "seats",
    limitValue: 5,
    usedValue: 0,
    source: "grant",
    expiresAt: null,
    reference: "sim_abc",
    ...overrides,
  };
}

describe("metersFor", () => {
  it("sums two grants of the same feature rather than showing two rows", () => {
    // Buying the same thing twice is the ordinary case, and a page that listed
    // it twice would leave the customer adding up their own allowance.
    const meters = metersFor([grant(), grant({ limitValue: 3 })], NOW);
    expect(meters).toHaveLength(1);
    expect(meters[0]?.resolved.limit).toBe(8);
  });

  it("lets one unlimited grant win the feature", () => {
    const meters = metersFor([grant(), grant({ limitValue: null })], NOW);
    expect(meters[0]?.resolved.unlimited).toBe(true);
    expect(meters[0]?.resolved.limit).toBeNull();
  });

  it("drops an expired grant whole", () => {
    const meters = metersFor([grant({ expiresAt: day(-1) })], NOW);
    expect(meters).toHaveLength(0);
  });

  it("marks a spent allowance exhausted, and does not hide the overage", () => {
    // `used` is deliberately unclamped by the resolver: 7 against a limit of 5
    // has to stay sayable, because it is real and somebody is accountable for
    // it. Only `remaining` clamps, because a negative remaining is truthy.
    const meters = metersFor([grant({ limitValue: 5, usedValue: 7 })], NOW);
    expect(meters[0]?.exhausted).toBe(true);
    expect(meters[0]?.resolved.used).toBe(7);
    expect(meters[0]?.resolved.remaining).toBe(0);
  });

  it("does not mark an unlimited feature exhausted", () => {
    const meters = metersFor([grant({ limitValue: null, usedValue: 900 })], NOW);
    expect(meters[0]?.exhausted).toBe(false);
  });
});

describe("limitLabel", () => {
  it("renders NULL as unlimited and never as zero", () => {
    // `?? 0` and a bare template literal both tell a customer who paid for
    // unlimited access that they have none.
    expect(limitLabel(null)).toBe("unlimited");
    expect(limitLabel(0)).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// Order status
// ---------------------------------------------------------------------------

describe("orderStatusView", () => {
  it("strikes a refunded total through and leaves a cancelled one alone", () => {
    // A refunded order still has a total — it is what was charged — and
    // printing it plainly reads as money the customer is still out of pocket.
    // A cancelled order was never paid, so the strike would imply a refund
    // that never happened.
    expect(orderStatusView("refunded").struckThrough).toBe(true);
    expect(orderStatusView("cancelled").struckThrough).toBe(false);
  });

  it("covers every status the commerce union declares", () => {
    // All five are written by something, and until this overlay none of them
    // were rendered anywhere. A status with no case falls to the default and
    // shows a raw column value to a customer.
    for (const status of ["pending", "paid", "fulfilled", "cancelled", "refunded"]) {
      expect(orderStatusView(status).label).not.toBe(status);
    }
  });

  it("renders an unknown status instead of crashing on it", () => {
    // The column is text and a migration or a later status can widen it. A
    // page that threw would take a whole order history down over one row.
    expect(orderStatusView("part_refunded").label).toBe("part_refunded");
    expect(orderStatusView("part_refunded").tone).toBe("neutral");
  });
});

describe("featureLabel", () => {
  it("makes a machine key readable without renaming it", () => {
    expect(featureLabel("api_calls")).toBe("Api calls");
    expect(featureLabel("extra-storage")).toBe("Extra storage");
  });

  it("gives back anything it cannot improve", () => {
    expect(featureLabel("")).toBe("");
    expect(featureLabel("__")).toBe("__");
  });
});

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

describe("deliveryStageOf", () => {
  it("calls a row with no shipped_at prepared, not shipped", () => {
    // The `ship` grant inserts the row with carrier, tracking and shipped_at
    // all NULL, and @__SCOPE_NAME__/commerce is explicit that the row exists so
    // a warehouse queue has something to pick up rather than to claim anything
    // moved. Rendering those NULLs directly tells a customer their parcel is in
    // transit with a missing carrier.
    expect(deliveryStageOf({ shippedAt: null, deliveredAt: null })).toBe("preparing");
  });

  it("prefers delivered over despatched", () => {
    expect(
      deliveryStageOf({ shippedAt: day(-3), deliveredAt: day(-1) }),
    ).toBe("delivered");
  });

  it("reports delivered even if shipped_at was never filled in", () => {
    // Two nullable timestamps written by two different processes: a delivery
    // confirmation can land without the despatch one, and "preparing" would
    // then be shown for a parcel already in somebody's hands.
    expect(deliveryStageOf({ shippedAt: null, deliveredAt: day(-1) })).toBe("delivered");
  });
});

describe("accountOrderHref", () => {
  it("names the route the [orderNumber] page actually serves", () => {
    expect(accountOrderHref("ORD-20260601-000001-42")).toBe(
      "/account/orders/ORD-20260601-000001-42",
    );
  });

  it("keeps an order number inside one path segment", () => {
    // `ORDER_NUMBER_PREFIX` is a constant a project is invited to change, and
    // the first prefix with a slash in it would address a route that does not
    // exist — which reads as a lost order rather than a mislinked one.
    expect(accountOrderHref("A/B-1")).toBe("/account/orders/A%2FB-1");
  });
});
