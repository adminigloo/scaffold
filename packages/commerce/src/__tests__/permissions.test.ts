import { describe, expect, it } from "vitest";
import { definePermissions, DuplicatePermissionError } from "@adminigloo/permissions";
import { stripePermissions } from "@adminigloo/stripe";
import { tenancyPermissions } from "@adminigloo/tenancy";
import { commercePermissions } from "../permissions.js";

const catalog = definePermissions("tenant", commercePermissions);

describe("commercePermissions", () => {
  it("declares exactly the five commerce capabilities", () => {
    expect([...catalog.keys].sort()).toEqual([
      "discounts.manage",
      "discounts.view",
      "orders.manage",
      "orders.refund",
      "orders.view",
    ]);
  });

  it("SEALS refunds, so a template's deny cannot be reopened per person", () => {
    // Same failure as stripe's billing.refund.issue: granted to one person
    // "just for today" during an incident and never taken away.
    expect(catalog.isSealed("orders.refund")).toBe(true);
  });

  it("never seeds the sealed refund key into any template", () => {
    expect(catalog.get("orders.refund").defaultFor).toBeUndefined();
  });

  it("does not seal anything whose blast radius is bounded", () => {
    // A discount is capped by max_redemptions and min_subtotal_minor and shows
    // up in the order totals afterwards. A refund moves money out with nothing
    // left to cap it.
    for (const key of [
      "orders.view",
      "orders.manage",
      "discounts.view",
      "discounts.manage",
    ] as const) {
      expect(catalog.isSealed(key)).toBe(false);
    }
  });

  it("withholds the customer list from viewers", () => {
    // An order carries a name, a postal address and a phone number. A read-only
    // seat handed out to show somebody a dashboard should not come with the
    // customer list attached.
    expect(catalog.get("orders.view").defaultFor).toEqual([
      "owner",
      "admin",
      "member",
    ]);
    expect(catalog.get("orders.manage").defaultFor).toEqual(["owner", "admin"]);
  });

  it("groups under one category so the checklist stays readable", () => {
    expect([...(catalog.byCategory().get("Commerce") ?? [])].sort()).toEqual([
      "discounts.manage",
      "discounts.view",
      "orders.manage",
      "orders.refund",
      "orders.view",
    ]);
    expect(catalog.byCategory().size).toBe(1);
  });
});

describe("namespace ownership", () => {
  it("claims no key another package owns", () => {
    // @adminigloo/stripe owns billing.*; @adminigloo/tenancy owns members.* and
    // tenant.*. definePermissions only rejects byte-identical keys, so a
    // billing.orders.refund declared here would coexist happily with stripe's
    // billing.refund.issue and whichever key a route happened to check would
    // decide the answer. That is exactly the bug tenancy's billing.manage
    // caused: five keys for one capability, and a seeded owner told they could
    // do something the route then refused.
    for (const key of catalog.keys) {
      expect(key.startsWith("billing.")).toBe(false);
      expect(key.startsWith("members.")).toBe(false);
      expect(key.startsWith("tenant.")).toBe(false);
    }
  });

  it("composes with tenancy and stripe with no duplicate key", () => {
    // The real assembly, the way an app writes it. `contributedBy` re-reads the
    // source records, so a collision the spread would have silently resolved
    // throws here instead of at 3am.
    expect(() =>
      definePermissions(
        "tenant",
        { ...tenancyPermissions, ...stripePermissions, ...commercePermissions },
        {
          contributedBy: [
            tenancyPermissions,
            stripePermissions,
            commercePermissions,
          ],
        },
      ),
    ).not.toThrow();
  });

  it("would fail loudly if a future edit re-declared somebody else's key", () => {
    // Pins the guard itself. If this ever stops throwing, the test above stops
    // proving anything.
    expect(() =>
      definePermissions(
        "tenant",
        { ...stripePermissions, ...commercePermissions },
        {
          contributedBy: [
            stripePermissions,
            { ...commercePermissions, "billing.refund.issue": { label: "Refund" } },
          ],
        },
      ),
    ).toThrow(DuplicatePermissionError);
  });
});
