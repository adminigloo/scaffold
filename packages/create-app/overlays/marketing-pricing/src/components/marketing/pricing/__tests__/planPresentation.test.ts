import { definePlans } from "__SCOPE__/billing";
import type { PlanFeature, PlanTier } from "__SCOPE__/billing";
import { describe, expect, it } from "vitest";
import {
  amountLabel,
  annualSavingPercent,
  featureBullet,
  featureCell,
  priceDisplay,
  resolveCurrency,
  resolveInterval,
  toggleableIntervals,
} from "@/components/marketing/pricing/planPresentation";

/**
 * The numbers on the pricing page, checked against the record they came from.
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
    expect(toggleableIntervals(catalog)).toEqual(["month", "year"]);
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
    expect(resolveInterval("once", catalog)).toBe("month");
    expect(resolveInterval("weekly", catalog)).toBe("month");
    expect(resolveInterval(undefined, catalog)).toBe("month");
    expect(resolveInterval("", catalog)).toBe("month");
  });

  it("refuses a currency the catalog does not price in", () => {
    // Unchecked, this reaches `Intl` through formatMinor, which throws
    // RangeError on anything that is not three letters — a 500 on the one page
    // that must never be down, triggered by a crawler following a mistyped link.
    expect(resolveCurrency("usd", catalog)).toBe("usd");
    expect(resolveCurrency("XXXXX", catalog)).toBe("gbp");
    expect(resolveCurrency(undefined, catalog)).toBe("gbp");
  });
});

describe("what a tier costs", () => {
  it("reads the amount out of the record for the cadence asked for", () => {
    expect(priceDisplay(tier("pro"), "month", "gbp")).toEqual({
      kind: "amount",
      amountMinor: 2400n,
      interval: "month",
    });
    expect(priceDisplay(tier("pro"), "year", "usd")).toEqual({
      kind: "amount",
      amountMinor: 29000n,
      interval: "year",
    });
  });

  it("says a tier is sold on another cadence rather than showing nothing", () => {
    // A blank card between two priced ones reads as a page that failed to load,
    // and the reader's conclusion is about the product rather than about the
    // cadence they happen to have selected.
    expect(priceDisplay(tier("monthly-only"), "year", "gbp")).toEqual({
      kind: "other-interval",
      available: ["month"],
    });
  });

  it("shows a lifetime price under either position of the toggle", () => {
    for (const interval of ["month", "year"] as const) {
      expect(priceDisplay(tier("lifetime"), interval, "gbp")).toEqual({
        kind: "amount",
        amountMinor: 40000n,
        interval: "once",
      });
    }
  });

  it("distinguishes an unpriced tier from an unavailable cadence", () => {
    // "Enterprise, talk to us" is a tier with no prices at all, and it must not
    // be reported as one that is merely sold annually — the page renders a
    // contact action for the first and a switch-the-toggle hint for the second.
    expect(priceDisplay(tier("enterprise"), "month", "gbp")).toEqual({
      kind: "enquire",
    });
  });

  it("prints zero as Free", () => {
    // The record writes a free plan as 0 rather than as an absent price, on
    // purpose. £0.00 at the top of a pricing page reads as a price that failed
    // to load.
    expect(amountLabel(0n, "gbp")).toBe("Free");
    expect(amountLabel(2400n, "gbp")).toBe("£24.00");
  });

  it("formats in one pinned locale, so two build agents agree", () => {
    // Not the machine's ICU default. The same commit built on two runners would
    // otherwise produce two differently punctuated pricing pages.
    expect(amountLabel(2900n, "usd")).toBe("US$29.00");
  });
});

describe("the annual saving", () => {
  it("is the percentage off twelve months, rounded down", () => {
    // 24000 against 12 x 2400 = 28800, which is 16.66…% and must print as 16.
    // Rounded down so a saving is never overstated.
    expect(annualSavingPercent(tier("pro"), "gbp")).toBe(16);
  });

  it("claims nothing for a free tier", () => {
    expect(annualSavingPercent(tier("free"), "gbp")).toBeNull();
  });

  it("claims nothing when there is no annual price to compare", () => {
    expect(annualSavingPercent(tier("monthly-only"), "gbp")).toBeNull();
    expect(annualSavingPercent(tier("enterprise"), "gbp")).toBeNull();
  });

  it("refuses to advertise a negative saving", () => {
    // An annual price above twelve months is a pricing mistake. Printing
    // "save -8%" would put the mistake on the page in the client's own voice.
    const wrong = definePlans({
      features: {},
      tiers: [
        {
          key: "backwards",
          name: "Backwards",
          prices: { month: { gbp: 1000n }, year: { gbp: 13000n } },
          features: {},
        },
      ],
    });
    const backwards = wrong.tier("backwards");
    expect(backwards).toBeDefined();
    if (backwards === undefined) return;
    expect(annualSavingPercent(backwards, "gbp")).toBeNull();
  });
});

describe("what a plan card lists", () => {
  const pro = tier("pro");
  const free = tier("free");

  it("prints an unlimited quota as unlimited, never as a number", () => {
    expect(featureBullet(feature(pro, "seats"))).toBe("Unlimited members");
  });

  it("groups a thousand", () => {
    expect(featureBullet(feature(pro, "exports"))).toBe("5,000 exports a month");
  });

  it("lists an included flag by its label", () => {
    expect(featureBullet(feature(pro, "sso"))).toBe("Single sign-on");
  });

  it("lists the best option a tier offers", () => {
    // `allowed` is best first and non-empty by construction, which is why there
    // is no fallback in the renderer for a case the record forbids.
    expect(featureBullet(feature(pro, "support"))).toBe("Priority support");
    expect(featureBullet(feature(free, "support"))).toBe("Community support");
  });

  it("contributes NO LINE for something the tier withholds", () => {
    // A bullet reading "No single sign-on" belongs in the comparison table,
    // where columns are being weighed against each other — not on the card
    // somebody is deciding to buy. A zero quota is the same: the record writes
    // it as an explicit 0 so the entitlement row survives for the audit trail,
    // and that is a fact about the database, not a selling point.
    expect(featureBullet(feature(free, "sso"))).toBeNull();
    expect(featureBullet(feature(free, "exports"))).toBeNull();
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
