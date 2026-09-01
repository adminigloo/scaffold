import { describe, expect, it } from "vitest";
import {
  definePlans,
  planAllows,
  planRowKey,
  priceFor,
  reconcilePlans,
  InvalidGrantLimitError,
  InvalidPlanCatalogError,
  InvalidPlanKeyError,
} from "../plans.js";

/**
 * The catalog the rest of this file reads, and every row in it is load-bearing.
 *
 *   free            a 0 price, which is a real row and not an absent one
 *   starter         the tier a customer upgrades away from
 *   pro             highlighted, unlimited seats, and a better support option
 *   enterprise      no prices at all — "talk to us" is a real tier
 *   starter-legacy  retired, and still in the record, because subscriptions
 *                   name it and deleting the declaration orphans them
 */
const PLANS = definePlans({
  features: {
    seats: { kind: "quota", label: "members" },
    exports: { kind: "quota", label: "exports a month" },
    sso: { kind: "flag", label: "Single sign-on" },
    support: {
      kind: "option",
      label: "Support",
      values: ["priority", "email", "community"],
    },
  },
  tiers: [
    {
      key: "free",
      name: "Free",
      prices: { month: { gbp: 0n, usd: 0n }, year: { gbp: 0n, usd: 0n } },
      features: { seats: 3, exports: 100, sso: false, support: ["community"] },
    },
    {
      key: "starter",
      name: "Starter",
      prices: { month: { gbp: 700n, usd: 900n }, year: { gbp: 7000n, usd: 9000n } },
      features: {
        seats: 10,
        exports: 500,
        sso: false,
        support: ["email", "community"],
      },
    },
    {
      key: "pro",
      name: "Pro",
      highlight: true,
      prices: { month: { gbp: 2400n, usd: 2900n }, year: { gbp: 24000n, usd: 29000n } },
      features: {
        seats: null,
        exports: 5000,
        sso: true,
        support: ["priority", "email", "community"],
      },
    },
    {
      key: "enterprise",
      name: "Enterprise",
      prices: {},
      features: {
        seats: null,
        exports: null,
        sso: true,
        support: ["priority", "email", "community"],
      },
    },
    {
      key: "starter-legacy",
      name: "Starter (2024)",
      isActive: false,
      prices: { month: { gbp: 500n, usd: 600n }, year: { gbp: 5000n, usd: 6000n } },
      features: { seats: 5, exports: 250, sso: false, support: ["community"] },
    },
  ],
});

describe("definePlans — the shape of the record", () => {
  it("keeps the declaration order of the tiers, retired ones included", () => {
    // The array IS the pricing page's order, which is why sortOrder is derived
    // from it rather than supplied beside it.
    expect(PLANS.tiers.map((tier) => tier.key)).toEqual([
      "free",
      "starter",
      "pro",
      "enterprise",
      "starter-legacy",
    ]);
    expect(PLANS.tiers.map((tier) => tier.sortOrder)).toEqual([0, 10, 20, 30, 40]);
  });

  it("keeps the declaration order of the features", () => {
    // The rows of the comparison table. Sorted alphabetically they would read
    // exports, seats, sso, support — which is nobody's pricing page.
    expect(PLANS.features.map((f) => f.feature)).toEqual([
      "seats",
      "exports",
      "sso",
      "support",
    ]);
  });

  it("merges the declaration into every tier, so a tier is self-describing", () => {
    // `grantsForPlan` takes a tier and nothing else. Looking the kind up in the
    // catalog instead would let a caller pair one catalog's tier with another
    // catalog's vocabulary.
    expect(PLANS.tier("pro")?.features["seats"]).toEqual({
      kind: "quota",
      feature: "seats",
      label: "members",
      limit: null,
    });
    expect(PLANS.tier("pro")?.features["sso"]).toEqual({
      kind: "flag",
      feature: "sso",
      label: "Single sign-on",
      included: true,
    });
  });

  it("reports the currencies and the intervals it actually offers", () => {
    // A pricing page builds its toggles from these rather than hardcoding a
    // list that goes stale the day a fourth currency is added.
    expect(PLANS.currencies).toEqual(["gbp", "usd"]);
    expect(PLANS.intervals).toEqual(["month", "year"]);
  });

  it("answers with undefined for a tier nobody declared", () => {
    expect(PLANS.tier("platinum")).toBeUndefined();
  });
});

describe("definePlans — the states it refuses to build", () => {
  const feature = { seats: { kind: "quota", label: "members" } } as const;

  it("refuses a duplicate tier key", () => {
    // The key becomes entitlements.source_ref. Two tiers sharing one would
    // upsert their entitlements onto the same rows.
    expect(() =>
      definePlans({
        features: feature,
        tiers: [
          { key: "pro", name: "Pro", prices: {}, features: { seats: 1 } },
          { key: "pro", name: "Pro again", prices: {}, features: { seats: 2 } },
        ],
      }),
    ).toThrow(InvalidPlanKeyError);
  });

  it("refuses a tier key that is empty or not a slug", () => {
    // A colon in particular, because it separates the three parts of a
    // plans.key and would make that key ambiguous.
    for (const key of ["", "Pro", "pro:month", "pro plan", "-pro"]) {
      expect(() =>
        definePlans({
          features: feature,
          tiers: [{ key, name: "x", prices: {}, features: { seats: 1 } }],
        }),
      ).toThrow(InvalidPlanKeyError);
    }
  });

  it("refuses a quota that is not a whole count", () => {
    // A fraction reaches an integer column and is truncated by the driver, so
    // 2.5 seats becomes 2 and nobody is told.
    for (const seats of [2.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        definePlans({
          features: feature,
          tiers: [{ key: "pro", name: "Pro", prices: {}, features: { seats } }],
        }),
      ).toThrow(InvalidGrantLimitError);
    }
  });

  it("refuses an option value the vocabulary does not declare", () => {
    // The whole point of an enum-restricted option: a value nobody implemented
    // cannot be sold on the pricing page.
    expect(() =>
      definePlans({
        features: {
          support: { kind: "option", label: "Support", values: ["email"] },
        },
        tiers: [
          {
            key: "pro",
            name: "Pro",
            prices: {},
            // Deliberately past the type, which already refuses this — the
            // runtime check is what covers a catalog assembled from data.
            features: { support: ["telepathy"] as unknown as readonly ["email"] },
          },
        ],
      }),
    ).toThrow(InvalidPlanCatalogError);
  });

  it("refuses an empty option list on a tier", () => {
    expect(() =>
      definePlans({
        features: {
          support: { kind: "option", label: "Support", values: ["email"] },
        },
        tiers: [
          {
            key: "pro",
            name: "Pro",
            prices: {},
            features: { support: [] as unknown as readonly ["email"] },
          },
        ],
      }),
    ).toThrow(InvalidPlanCatalogError);
  });

  it("refuses two highlighted tiers", () => {
    expect(() =>
      definePlans({
        features: feature,
        tiers: [
          { key: "a", name: "A", highlight: true, prices: {}, features: { seats: 1 } },
          { key: "b", name: "B", highlight: true, prices: {}, features: { seats: 2 } },
        ],
      }),
    ).toThrow(/most/i);
  });

  it("refuses a currency code Intl cannot format", () => {
    // formatMinor asks Intl for the minor-unit exponent and Intl throws
    // RangeError on anything that is not three letters. Caught here it names
    // the tier; missed, it is an uncaught exception on the pricing page.
    expect(() =>
      definePlans({
        features: feature,
        tiers: [
          {
            key: "pro",
            name: "Pro",
            prices: { month: { dollars: 900n } },
            features: { seats: 1 },
          },
        ],
      }),
    ).toThrow(InvalidPlanCatalogError);
  });

  it("refuses a negative price", () => {
    expect(() =>
      definePlans({
        features: feature,
        tiers: [
          {
            key: "pro",
            name: "Pro",
            prices: { month: { usd: -900n } },
            features: { seats: 1 },
          },
        ],
      }),
    ).toThrow(/Free is 0/);
  });

  it("refuses a priced interval missing a currency another tier uses", () => {
    // THE BLANK PRICE. A page rendered in GBP would show this tier with no
    // price beside one that has a price, and nothing says which tier it will be.
    expect(() =>
      definePlans({
        features: feature,
        tiers: [
          {
            key: "starter",
            name: "Starter",
            prices: { month: { usd: 900n, gbp: 700n } },
            features: { seats: 1 },
          },
          {
            key: "pro",
            name: "Pro",
            prices: { month: { usd: 2900n } },
            features: { seats: 2 },
          },
        ],
      }),
    ).toThrow(/gbp/);
  });

  it("allows a tier with no prices at all — Enterprise, talk to us", () => {
    // The interval axis is deliberately not policed: a tier sold monthly and
    // not yearly is an ordinary pricing decision.
    expect(PLANS.tier("enterprise")?.prices).toEqual({});
    expect(PLANS.rows.some((row) => row.tierKey === "enterprise")).toBe(false);
  });
});

describe("the projection into the plans table", () => {
  it("emits one row per tier, interval and currency", () => {
    // A Stripe Price fixes an amount, a currency and an interval and none of
    // them can be changed afterwards, so "Pro" cannot be one row.
    const pro = PLANS.rows.filter((row) => row.tierKey === "pro");
    expect(pro.map((row) => row.key)).toEqual([
      "pro:month:gbp",
      "pro:month:usd",
      "pro:year:gbp",
      "pro:year:usd",
    ]);
    expect(pro.map((row) => row.priceMinor)).toEqual([2400n, 2900n, 24000n, 29000n]);
  });

  it("gives the free tier real rows at zero rather than no rows", () => {
    // plans.price_minor is 0 for a free plan and never NULL, or every price
    // computation downstream renders it as "no price" instead of "Free".
    const free = PLANS.rows.filter((row) => row.tierKey === "free");
    expect(free).toHaveLength(4);
    expect(free.every((row) => row.priceMinor === 0n)).toBe(true);
  });

  it("carries the tier's retirement onto every row it projects", () => {
    const legacy = PLANS.rows.filter((row) => row.tierKey === "starter-legacy");
    expect(legacy.length).toBeGreaterThan(0);
    expect(legacy.every((row) => row.isActive === false)).toBe(true);
  });

  it("names rows with the same function everything else spells them with", () => {
    expect(PLANS.rows.some((row) => row.key === planRowKey("pro", "year", "usd"))).toBe(
      true,
    );
  });

  it("maps a row key back to its tier", () => {
    // The step between a subscriptions row and what the subscriber is entitled
    // to. Built from the projection rather than by parsing the key apart.
    expect(PLANS.tierForRow("pro:year:usd")?.key).toBe("pro");
    expect(PLANS.tierForRow("pro")).toBeUndefined();
    expect(PLANS.tierForRow("platinum:month:usd")).toBeUndefined();
  });

  it("is byte-identical across two constructions of the same input", () => {
    // The seed upserts these rows on every run. Unstable ordering would make
    // every diff of a write plan noise.
    const again = definePlans({
      features: { seats: { kind: "quota", label: "members" } },
      tiers: [
        {
          key: "pro",
          name: "Pro",
          prices: { month: { usd: 2900n, gbp: 2400n } },
          features: { seats: 1 },
        },
      ],
    });
    expect(again.rows.map((row) => row.key)).toEqual(["pro:month:gbp", "pro:month:usd"]);
  });
});

describe("priceFor", () => {
  it("answers in minor units, ready for formatMinor", () => {
    const pro = PLANS.tier("pro");
    expect(pro && priceFor(pro, "month", "usd")).toBe(2900n);
    expect(pro && priceFor(pro, "year", "gbp")).toBe(24000n);
  });

  it("answers undefined rather than zero for a cadence not sold", () => {
    // Zero reads as free on a pricing page, which is a specific and wrong claim
    // about a tier that is simply not sold that way.
    const enterprise = PLANS.tier("enterprise");
    expect(enterprise && priceFor(enterprise, "month", "usd")).toBeUndefined();
    const pro = PLANS.tier("pro");
    expect(pro && priceFor(pro, "once", "usd")).toBeUndefined();
    expect(pro && priceFor(pro, "month", "eur")).toBeUndefined();
  });
});

describe("planAllows — the enum-restricted option", () => {
  it("permits what the tier offers and refuses what it does not", () => {
    const starter = PLANS.tier("starter");
    const pro = PLANS.tier("pro");
    expect(starter && planAllows(starter, "support", "email")).toBe(true);
    expect(starter && planAllows(starter, "support", "priority")).toBe(false);
    expect(pro && planAllows(pro, "support", "priority")).toBe(true);
  });

  it("refuses rather than throws for a feature that is not an option", () => {
    // A throw here would put an error boundary on a page over a typo in a
    // string, and "this tier does not permit that" is the same answer either
    // way.
    const pro = PLANS.tier("pro");
    expect(pro && planAllows(pro, "seats", "10")).toBe(false);
    expect(pro && planAllows(pro, "telepathy", "yes")).toBe(false);
  });

  it("puts the best value first, which is what a pricing page prints", () => {
    const support = PLANS.tier("starter")?.features["support"];
    expect(support?.kind === "option" && support.allowed[0]).toBe("email");
  });
});

describe("reconcilePlans — the record and the table disagreeing", () => {
  const stored = PLANS.rows.map((row) => ({ key: row.key, isActive: row.isActive }));

  it("reports nothing orphaned when the table matches the record", () => {
    const result = reconcilePlans(PLANS, stored);
    expect(result.orphaned).toEqual([]);
    expect(result.needsAttention).toBe(false);
    // Every row is restated, so a price somebody edited in the table snaps back.
    expect(result.upsert).toBe(PLANS.rows);
  });

  it("reports a row no tier projects, and says whether it is still on sale", () => {
    const result = reconcilePlans(PLANS, [
      ...stored,
      { key: "platinum:month:usd", isActive: true },
      { key: "bronze:month:usd", isActive: false },
    ]);

    expect(result.orphaned.map((row) => row.key)).toEqual([
      "platinum:month:usd",
      "bronze:month:usd",
    ]);
    // Active is the dangerous one: checkout can resolve it and grantsForPlan
    // has no tier to entitle the buyer from.
    expect(result.needsAttention).toBe(true);
    expect(result.orphaned[0]?.why).toMatch(/still active/);
    expect(result.orphaned[1]?.why).toMatch(/already retired/);
  });

  it("does not call a retired-but-declared tier an orphan", () => {
    // starter-legacy is inactive and still in the record, which is exactly what
    // isActive is for: subscriptions name it and plan_id is on delete restrict.
    const result = reconcilePlans(PLANS, stored);
    expect(result.orphaned.some((row) => row.key.startsWith("starter-legacy"))).toBe(
      false,
    );
  });

  it("never proposes a deletion", () => {
    // subscriptions.plan_id is on delete restrict, so deleting an orphan either
    // fails or takes a paying customer's subscription with it.
    const result = reconcilePlans(PLANS, [{ key: "platinum:month:usd", isActive: true }]);
    expect(Object.keys(result)).toEqual(["upsert", "orphaned", "needsAttention"]);
  });
});
