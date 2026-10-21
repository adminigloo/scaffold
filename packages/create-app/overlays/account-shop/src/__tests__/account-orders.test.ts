import { describe, expect, it } from "vitest";
import { accountOrderHref, deliveryStageOf } from "@/account-orders";
import {
  featureLabel,
  limitLabel,
  orderStatusView,
} from "@/components/account/orderPresentation";

/**
 * The shop's half of the account area, with no database: how an order's
 * status, an allowance's limit, a parcel's stage and an order's link read.
 * (Plans and their banner are src/__tests__/account.test.ts.)
 */

const NOW = new Date("2026-06-01T12:00:00.000Z");
const day = (offset: number): Date =>
  new Date(NOW.getTime() + offset * 24 * 60 * 60 * 1000);

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
