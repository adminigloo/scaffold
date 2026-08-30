import { describe, expect, it } from "vitest";
import { defaultVariant, formatMinor, priceRange } from "../pricing.js";
import type { VariantPricing } from "../pricing.js";

function variant(overrides: Partial<VariantPricing> = {}): VariantPricing {
  return { priceMinor: 1999n, ...overrides };
}

/** Intl uses U+00A0 and U+202F as separators; neither is visible in a diff. */
function normaliseSpaces(value: string): string {
  return value.replace(/[  ]/g, " ");
}

describe("formatMinor", () => {
  it("formats an ordinary amount", () => {
    expect(formatMinor(1999n, "usd", "en-US")).toBe("$19.99");
  });

  it("renders zero as a price, not as nothing", () => {
    // A free variant is legal. If this ever returned "" or "$0" the free tier
    // on a pricing page would look like a rendering bug.
    expect(formatMinor(0n, "usd", "en-US")).toBe("$0.00");
  });

  it("left-pads the fraction, so 5 cents is not 50", () => {
    expect(formatMinor(5n, "usd", "en-US")).toBe("$0.05");
  });

  // -----------------------------------------------------------------------
  // Precision. Each of these is a value where `Number(minor) / 100` gives a
  // different answer, silently.
  // -----------------------------------------------------------------------

  it("is exact above Number.MAX_SAFE_INTEGER", () => {
    const minor = 9007199254740993n; // MAX_SAFE_INTEGER + 2

    // The naive implementation, for the record. The final digit is wrong
    // because the bigint cannot survive the trip through a double.
    expect((Number(minor) / 100).toFixed(2)).toBe("90071992547409.92");

    expect(formatMinor(minor, "usd", "en-US")).toBe("$90,071,992,547,409.93");
  });

  it("is exact far beyond a 64-bit integer", () => {
    // A tenant-wide revenue sum in a zero-decimal currency reaches numbers
    // this shape, and it is the same bigint flowing through the same function
    // that renders a single product card.
    expect(formatMinor(123456789012345678901n, "usd", "en-US")).toBe(
      "$1,234,567,890,123,456,789.01",
    );
  });

  // -----------------------------------------------------------------------
  // Zero-decimal currencies. THE classic bug.
  // -----------------------------------------------------------------------

  it("does not divide a zero-decimal currency by 100", () => {
    // JPY has no minor unit: 1000 minor units is ¥1,000, not ¥10. A hardcoded
    // /100 renders every Japanese price at a hundredth of its value, and it
    // looks entirely plausible on the page.
    expect(formatMinor(1000n, "jpy", "en-US")).toBe("¥1,000");
    expect(formatMinor(1000n, "jpy", "en-US")).not.toContain(".");
  });

  it("handles a three-decimal currency too", () => {
    // The mirror image of JPY: BHD has three minor digits, so 1234567 minor
    // units is 1,234.567 dinars. A hardcoded /100 renders it as 12,345.67 —
    // ten times too much, in the direction that overcharges.
    // Compared with the whitespace normalised: Intl separates the code from the
    // number with U+00A0, which is correct and invisible in a diff.
    expect(normaliseSpaces(formatMinor(1234567n, "bhd", "en-US"))).toBe(
      "BHD 1,234.567",
    );
  });

  // -----------------------------------------------------------------------
  // Sign and locale.
  // -----------------------------------------------------------------------

  it("keeps the minus sign on an amount smaller than one major unit", () => {
    // -50 cents has a major part of 0, and `-0n` is `0n`, so Intl sees a
    // positive zero and emits no sign. Without the explicit fix-up a 50-cent
    // refund renders as a 50-cent charge.
    expect(formatMinor(-50n, "usd", "en-US")).toBe("-$0.50");
  });

  it("keeps the minus sign on a larger negative amount", () => {
    expect(formatMinor(-1999n, "usd", "en-US")).toBe("-$19.99");
  });

  it("uses the locale's separators and symbol placement", () => {
    // The reason the fraction is substituted through formatToParts rather than
    // spliced into a string: the decimal separator here is "," and the symbol
    // is a suffix.
    const formatted = formatMinor(1234567n, "eur", "de-DE");
    expect(formatted).toContain("12.345,67");
    expect(formatted).toContain("€");
  });

  it("does not care about the case of the currency code", () => {
    // Our columns store Stripe's lowercase form, but an import or a hand-typed
    // row can carry "USD". Two spellings must not format two ways.
    expect(formatMinor(1999n, "USD", "en-US")).toBe(
      formatMinor(1999n, "usd", "en-US"),
    );
  });

  it("throws on a currency code Intl cannot resolve, rather than guessing", () => {
    // A bad code is a bug in the catalog row. Swallowing it would render an
    // amount with no currency attached, which is worse than a stack trace —
    // and `validateProduct` reports it as `currency-invalid` before publish.
    expect(() => formatMinor(1999n, "dollars", "en-US")).toThrow(RangeError);
  });
});

describe("defaultVariant", () => {
  it("prefers the flagged default even when it is not the cheapest", () => {
    const flagged = variant({ priceMinor: 4999n, isDefault: true });
    expect(
      defaultVariant([variant({ priceMinor: 999n }), flagged]),
    ).toBe(flagged);
  });

  it("falls back to the lowest price when nothing is flagged", () => {
    const cheap = variant({ priceMinor: 999n });
    expect(
      defaultVariant([variant({ priceMinor: 4999n }), cheap, variant()]),
    ).toBe(cheap);
  });

  it("breaks a price tie on input order, deterministically", () => {
    // A red deck and a blue deck at the same price is normal. If the tiebreak
    // were unstable the server and the client would preselect different
    // variants and the page would hydrate showing one variant's name against
    // another's price.
    const first = variant({ priceMinor: 1999n });
    const second = variant({ priceMinor: 1999n });
    expect(defaultVariant([first, second])).toBe(first);
    expect(defaultVariant([second, first])).toBe(second);
  });

  it("takes the first of two flagged defaults instead of throwing", () => {
    // Two defaults is a validation problem, but this function still has to
    // answer: the product page renders before anyone fixes the data.
    const first = variant({ priceMinor: 4999n, isDefault: true });
    const second = variant({ priceMinor: 999n, isDefault: true });
    expect(defaultVariant([first, second])).toBe(first);
  });

  it("returns undefined for no variants rather than inventing one", () => {
    expect(defaultVariant([])).toBeUndefined();
  });

  it("returns the caller's own object, not a copy", () => {
    // The page needs the variant's id to put it in the cart. A copy would
    // compare unequal and the "selected" highlight would never match.
    const only = { priceMinor: 1999n, id: "var_1" };
    expect(defaultVariant([only])).toBe(only);
  });
});

describe("priceRange", () => {
  it("returns null for a product with no variants", () => {
    // Not { min: 0, max: 0 }: that renders as "Free", which is a specific and
    // wrong claim about a product that simply has no price yet.
    expect(priceRange([])).toBeNull();
  });

  it("marks a single price as single, whatever the order", () => {
    expect(priceRange([variant({ priceMinor: 1200n })])).toEqual({
      min: 1200n,
      max: 1200n,
      single: true,
    });
    expect(
      priceRange([variant({ priceMinor: 1200n }), variant({ priceMinor: 1200n })]),
    ).toEqual({ min: 1200n, max: 1200n, single: true });
  });

  it("finds the range regardless of input order", () => {
    const variants = [
      variant({ priceMinor: 4999n }),
      variant({ priceMinor: 1200n }),
      variant({ priceMinor: 2500n }),
    ];
    expect(priceRange(variants)).toEqual({
      min: 1200n,
      max: 4999n,
      single: false,
    });
    expect(priceRange([...variants].reverse())).toEqual({
      min: 1200n,
      max: 4999n,
      single: false,
    });
  });

  it("treats a free variant as a real bound", () => {
    // "from $0.00" is correct for a product with a free tier. Skipping zero
    // would advertise the paid tier as the entry price.
    expect(
      priceRange([variant({ priceMinor: 0n }), variant({ priceMinor: 1999n })]),
    ).toEqual({ min: 0n, max: 1999n, single: false });
  });
});
