import { definePlans } from "__SCOPE__/billing";
import type { PlanFeature, PlanTier } from "__SCOPE__/billing";
import { describe, expect, it } from "vitest";
import {
  featureCell,
  resolveCurrency,
  resolveInterval,
  toggleableIntervals,
} from "@/components/marketing/pricing/planPresentation";

/**
 * The pricing page's own decisions, checked against the record they came from:
 * the cadence and currency it opens on, and the comparison table's cells. What
 * a plan CARD says (its price, what it includes, "Everything in Free, plus:")
 * is @__SCOPE_NAME__/billing's `planColumns`, tested in that package.
 *
 * WHY THIS SUITE EXISTS AT ALL. The rule the whole marketing half is built on is
 * that the page and the enforcement read the SAME record — so the page cannot
 * advertise something `grantsForPlan` will not grant. That rule is only worth
 * anything if the page renders the record faithfully, and every way of getting
 * it wrong here compiles: an unlimited allowance printed as 0, a withheld
 * feature printed as included, a tier that is not sold monthly rendering as
 * free, a saving computed the wrong way round. None of those is a type error and
 * all of them are a number a customer reads before they pay.
 *
 * The catalog below is built with `definePlans`, not stubbed. A hand-written
 * object satisfying `PlanTier` could hold a shape the constructor refuses, and
 * then this suite would be testing a state the product cannot reach.
 */
const catalog = definePlans({
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
      features: { seats: 3, exports: 0, sso: false, support: ["community"] },
    },
    {
      key: "pro",
      name: "Pro",
      prices: {
        month: { gbp: 2400n, usd: 2900n },
        year: { gbp: 24000n, usd: 29000n },
      },
      features: {
        seats: null,
        exports: 5000,
        sso: true,
        support: ["priority", "email"],
      },
    },
    {
      key: "monthly-only",
      name: "Monthly only",
      prices: { month: { gbp: 900n, usd: 1200n } },
      features: { seats: 5, exports: 100, sso: false, support: ["email"] },
    },
    {
      key: "lifetime",
      name: "Lifetime",
      prices: { once: { gbp: 40000n, usd: 50000n } },
      features: { seats: 10, exports: 1000, sso: true, support: ["email"] },
    },
    {
      key: "enterprise",
      name: "Enterprise",
      prices: {},
      features: { seats: null, exports: null, sso: true, support: ["priority"] },
    },
  ],
});

function tier(key: string): PlanTier {
  const found = catalog.tier(key);
  if (found === undefined) throw new Error(`no tier ${key} in the test catalog`);
  return found;
}

/**
 * A tier's feature, or a failure that names it.
 *
 * `noUncheckedIndexedAccess` makes `tier.features.sso` possibly-undefined, and a
 * `!` here would turn "the catalog above no longer declares that feature" into
 * a TypeError inside a matcher. The whole point of the two-level record is that
 * a missing feature is loud.
 */
function feature(of: PlanTier, name: string): PlanFeature {
  const found = of.features[name];
  if (found === undefined) throw new Error(`no feature ${name} on ${of.key}`);
  return found;
}

describe("which cadences the toggle offers", () => {
  it("offers the two that are cadences and not the one that is not", () => {
    // `once` is priced by the lifetime tier, so it is in `catalog.intervals`.
    // It must still not reach the toggle: a lifetime purchase is not the same
    // product billed differently, and a reader asked to compare it against a
    // monthly price is being asked a question with no answer.
    expect(catalog.intervals).toContain("once");
    // Yearly first (create-app 0.39): one charge a year, and the better deal.
    expect(toggleableIntervals(catalog)).toEqual(["year", "month"]);
  });

  it("takes an interval from the query string only if the record prices it", () => {
    expect(resolveInterval("year", catalog)).toBe("year");
    expect(resolveInterval("month", catalog)).toBe("month");
  });

  it("refuses `once` from the query string, and anything else", () => {
    // THE QUERY STRING IS UNTRUSTED and this page is public. `once` is the
    // interesting rejection: it is a real PlanInterval and a real key in the
    // record, so a naive "is this a valid interval" check would accept it and
    // put the toggle in a third state nothing renders.
    // The default is yearly, wherever a plan is sold yearly.
    expect(resolveInterval("once", catalog)).toBe("year");
    expect(resolveInterval("weekly", catalog)).toBe("year");
    expect(resolveInterval(undefined, catalog)).toBe("year");
    expect(resolveInterval("", catalog)).toBe("year");
    // NEGATIVE CONTROL: a catalog sold monthly only opens on monthly.
    expect(resolveInterval(undefined, { intervals: ["month"] })).toBe("month");
  });

  it("refuses a currency the catalog does not price in", () => {
    // Unchecked, this reaches `Intl` through formatMinor, which throws
    // RangeError on anything that is not three letters — a 500 on the one page
    // that must never be down, triggered by a crawler following a mistyped link.
    expect(resolveCurrency("usd", catalog)).toBe("usd");
    // The fallback is US dollars where the catalog prices in them (create-app 0.36).
    expect(resolveCurrency("XXXXX", catalog)).toBe("usd");
    expect(resolveCurrency(undefined, catalog)).toBe("usd");
  });
});

describe("what a comparison cell says", () => {
  const pro = tier("pro");
  const free = tier("free");

  it("drops the label, because the row heading already carries it", () => {
    expect(featureCell(feature(pro, "exports"))).toEqual({
      text: "5,000",
      included: true,
    });
    expect(featureCell(feature(pro, "seats"))).toEqual({
      text: "Unlimited",
      included: true,
    });
  });

  it("always has a cell, even for something withheld", () => {
    // A blank cell in a comparison table is indistinguishable from a row that
    // failed to render, and the reader's guess is whichever is worse for you.
    expect(featureCell(feature(free, "sso"))).toEqual({
      text: "Not included",
      included: false,
    });
    expect(featureCell(feature(free, "exports"))).toEqual({
      text: "None",
      included: false,
    });
  });

  it("names the option rather than ticking it", () => {
    expect(featureCell(feature(free, "support"))).toEqual({
      text: "Community",
      included: true,
    });
  });
});
