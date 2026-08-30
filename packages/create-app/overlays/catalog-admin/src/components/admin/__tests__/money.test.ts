import { describe, expect, it } from "vitest";
import {
  minorToMajorInput,
  minorUnitDigits,
  parseInventoryInput,
  parseMoneyInput,
} from "@/components/admin/money";

/**
 * The money input is the one place in the product builder where a typo becomes
 * a wrong charge, so it is tested as a pure function with no React anywhere
 * near it.
 *
 * The cases that matter are not "12.99 works". They are the ones that look
 * right and are not: JPY has no minor unit, BHD has three, and `0.07 * 100` in
 * binary floating point is 7.000000000000001.
 */

function minorOf(raw: string, currency: string): bigint {
  const parsed = parseMoneyInput(raw, currency);
  if (!parsed.ok) throw new Error(`expected "${raw}" to parse: ${parsed.message}`);
  return parsed.minor;
}

function codeOf(raw: string, currency: string): string {
  const parsed = parseMoneyInput(raw, currency);
  if (parsed.ok) throw new Error(`expected "${raw}" to be refused, got ${parsed.minor}`);
  return parsed.code;
}

describe("minorUnitDigits", () => {
  it("reads the exponent from CLDR rather than assuming two", () => {
    expect(minorUnitDigits("usd")).toBe(2);
    // The classic bug. The minor unit of JPY IS the yen, so a hardcoded 2 here
    // renders ¥1,000 as ¥10 and charges a hundredth of the intended amount.
    expect(minorUnitDigits("jpy")).toBe(0);
    expect(minorUnitDigits("bhd")).toBe(3);
  });

  it("is case- and whitespace-insensitive, because the column is lowercase", () => {
    expect(minorUnitDigits(" USD ")).toBe(2);
  });

  it("returns null rather than throwing on a half-typed code", () => {
    expect(minorUnitDigits("u")).toBeNull();
    expect(minorUnitDigits("")).toBeNull();
  });
});

describe("parseMoneyInput", () => {
  it("converts the ordinary shapes", () => {
    expect(minorOf("12.99", "usd")).toBe(1299n);
    expect(minorOf("12", "usd")).toBe(1200n);
    expect(minorOf("0", "usd")).toBe(0n);
    expect(minorOf("  12.50  ", "usd")).toBe(1250n);
  });

  it("pads a short fraction rather than reading it as cents", () => {
    // "12.9" is twelve ninety, not twelve and nine cents. Right-padding is the
    // difference between 1290 and 1209.
    expect(minorOf("12.9", "usd")).toBe(1290n);
    // A trailing dot is a normal intermediate state while typing.
    expect(minorOf("12.", "usd")).toBe(1200n);
  });

  it("never routes the value through a float", () => {
    // `0.07 * 100` is 7.000000000000001 in binary floating point. Counting the
    // digits as text cannot produce that.
    expect(minorOf("0.07", "usd")).toBe(7n);
    expect(minorOf("1.005", "bhd")).toBe(1005n);
  });

  it("uses the currency's own decimal count", () => {
    expect(minorOf("1000", "jpy")).toBe(1000n);
    expect(minorOf("1.234", "bhd")).toBe(1234n);
    expect(minorOf("1.2", "bhd")).toBe(1200n);
  });

  it("refuses a fraction the currency cannot carry", () => {
    // A third of a cent is not an amount anyone can be charged, and rounding it
    // silently changes the price the admin agreed to.
    expect(codeOf("12.999", "usd")).toBe("too-many-decimals");
    // JPY has no minor unit at all, so any fraction is meaningless.
    expect(codeOf("12.5", "jpy")).toBe("too-many-decimals");
  });

  it("refuses blank rather than treating it as free", () => {
    expect(codeOf("", "usd")).toBe("empty");
    expect(codeOf("   ", "usd")).toBe("empty");
  });

  it("refuses a comma instead of guessing what it means", () => {
    // "1,5" is one and a half across most of Europe and fifteen if the comma is
    // read as grouping. Picking wrong is a tenfold pricing error that looks
    // entirely plausible in the table.
    expect(codeOf("1,5", "usd")).toBe("comma-decimal");
    expect(codeOf("1,234.50", "usd")).toBe("comma-decimal");
  });

  it("refuses anything that is not an amount", () => {
    expect(codeOf("abc", "usd")).toBe("not-a-number");
    expect(codeOf("12.34.56", "usd")).toBe("not-a-number");
    expect(codeOf("$12", "usd")).toBe("not-a-number");
    expect(codeOf("1e3", "usd")).toBe("not-a-number");
  });

  it("refuses a negative price", () => {
    expect(codeOf("-5", "usd")).toBe("negative");
  });

  it("refuses an amount Stripe cannot carry in a JSON number", () => {
    expect(codeOf("99999999999999999", "usd")).toBe("too-large");
    // The boundary itself is fine: MAX_SAFE_INTEGER minor units exactly.
    expect(minorOf("90071992547409.91", "usd")).toBe(9007199254740991n);
  });

  it("refuses an unknown currency instead of assuming two places", () => {
    expect(codeOf("12.99", "xx")).toBe("unknown-currency");
  });
});

describe("minorToMajorInput", () => {
  it("is the exact inverse of parseMoneyInput", () => {
    for (const [minor, currency] of [
      [1299n, "usd"],
      [5n, "usd"],
      [0n, "usd"],
      [1000n, "jpy"],
      [1234n, "bhd"],
    ] as const) {
      const text = minorToMajorInput(minor, currency);
      expect(minorOf(text, currency)).toBe(minor);
    }
  });

  it("left-pads the fraction", () => {
    // 5 remaining cents is ".05", not ".5" — the difference between 5c and 50c.
    expect(minorToMajorInput(5n, "usd")).toBe("0.05");
    expect(minorToMajorInput(1299n, "usd")).toBe("12.99");
  });

  it("writes a zero-decimal currency with no dot at all", () => {
    expect(minorToMajorInput(1000n, "jpy")).toBe("1000");
  });
});

describe("parseInventoryInput", () => {
  it("keeps untracked and sold out apart", () => {
    // NULL is untracked, 0 is genuinely out of stock, and the UI renders "Add
    // to cart" for one and "Sold out" for the other. Collapsing them makes
    // every digital product in the catalog read as sold out.
    expect(parseInventoryInput("")).toEqual({ ok: true, value: null });
    expect(parseInventoryInput("0")).toEqual({ ok: true, value: 0 });
    expect(parseInventoryInput(" 12 ")).toEqual({ ok: true, value: 12 });
  });

  it("refuses a fraction, which the integer column would reject anyway", () => {
    expect(parseInventoryInput("1.5").ok).toBe(false);
    expect(parseInventoryInput("-1").ok).toBe(false);
    expect(parseInventoryInput("many").ok).toBe(false);
  });
});
