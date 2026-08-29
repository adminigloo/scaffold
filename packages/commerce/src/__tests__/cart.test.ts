import { describe, expect, it } from "vitest";
import {
  applyDiscount,
  cartSubtotalMinor,
  cartTotals,
  validateCart,
} from "../cart.js";
import type { CartLine } from "../cart.js";

function line(overrides: Partial<CartLine> = {}): CartLine {
  return {
    productRef: "sku_trailcard",
    name: "Alpine Trail Card",
    unitPriceMinor: 1999n,
    quantity: 1,
    ...overrides,
  };
}

describe("cartSubtotalMinor", () => {
  it("multiplies and sums exactly", () => {
    expect(
      cartSubtotalMinor([
        line({ unitPriceMinor: 1999n, quantity: 3 }),
        line({ productRef: "sku_map", unitPriceMinor: 450n, quantity: 2 }),
      ]),
    ).toBe(6897n);
  });

  it("an empty cart is 0, not NaN and not undefined", () => {
    expect(cartSubtotalMinor([])).toBe(0n);
  });

  // ---------------------------------------------------------------------
  // The float cases. Each of these is a value where the trailcards approach
  // — prices as decimal dollars, converted to cents at the end — produces a
  // different number from integer minor units.
  // ---------------------------------------------------------------------

  it("three 10-cent items are exactly 30 cents, which the float path is not", () => {
    // The float equivalent, 0.1 + 0.1 + 0.1, is 0.30000000000000004. Every
    // downstream step then rounds it independently, and the cart total, the
    // Stripe charge and the invoice PDF each pick a different cent.
    expect(0.1 + 0.1 + 0.1).not.toBe(0.3);
    expect(
      cartSubtotalMinor([
        line({ unitPriceMinor: 10n }),
        line({ productRef: "b", unitPriceMinor: 10n }),
        line({ productRef: "c", unitPriceMinor: 10n }),
      ]),
    ).toBe(30n);
  });

  it("0.1 + 0.2 in cents is exactly 30", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(
      cartSubtotalMinor([
        line({ unitPriceMinor: 10n }),
        line({ productRef: "b", unitPriceMinor: 20n }),
      ]),
    ).toBe(30n);
  });

  it("stays exact past 2^53, where a number silently stops being one", () => {
    // Not one order, but the same type carries a year of a tenant's revenue in
    // a zero-decimal currency. Above 2^53 a number stops being exact and there
    // is no error, just a wrong total — note that the numeric literal for this
    // value cannot even be written down in source without being rounded, which
    // is why the round trip is asserted rather than a literal comparison.
    const subtotal = cartSubtotalMinor([
      line({ unitPriceMinor: 9_007_199_254_740_993n }),
    ]);
    expect(subtotal).toBe(9_007_199_254_740_993n);
    expect(BigInt(Number(subtotal))).not.toBe(subtotal);
    expect(BigInt(Number(subtotal))).toBe(9_007_199_254_740_992n);
  });

  it("throws on a fractional quantity instead of truncating it", () => {
    // parseFloat on a quantity field is the only way 1.5 gets here. Flooring
    // charges for one, ships one, and records nowhere that two were wanted.
    expect(() => cartSubtotalMinor([line({ quantity: 1.5 })])).toThrow(RangeError);
  });
});

describe("applyDiscount — percent, half up on integer minor units", () => {
  it("33% of 100 cents is 33 off", () => {
    expect(applyDiscount(100n, { kind: "percent", value: 33 })).toBe(67n);
  });

  it("33% of 101 cents rounds 33.33 down to 33 off", () => {
    expect(applyDiscount(101n, { kind: "percent", value: 33 })).toBe(68n);
  });

  it("50% of 101 cents rounds 50.5 UP to 51 off", () => {
    // Half UP. Banker's rounding would take 50 and leave the order a cent above
    // the Stripe coupon's own answer, permanently.
    expect(applyDiscount(101n, { kind: "percent", value: 50 })).toBe(50n);
  });

  it("50% of 1 cent rounds 0.5 up to a whole cent off", () => {
    expect(applyDiscount(1n, { kind: "percent", value: 50 })).toBe(0n);
  });

  it("50% of 3 cents rounds 1.5 up to 2 off", () => {
    expect(applyDiscount(3n, { kind: "percent", value: 50 })).toBe(1n);
  });

  it("never produces a float artefact at the .5 boundary", () => {
    // Every exact half in the range, checked against half-up computed with
    // integers only. A `Math.round(subtotal * pct / 100)` implementation
    // disagrees here as soon as the division lands one ulp below .5.
    for (let cents = 1; cents <= 999; cents += 2) {
      const subtotal = BigInt(cents);
      const off = subtotal - applyDiscount(subtotal, { kind: "percent", value: 50 });
      expect(off).toBe((subtotal + 1n) / 2n);
    }
  });

  it("0% takes nothing off", () => {
    expect(applyDiscount(12_345n, { kind: "percent", value: 0 })).toBe(12_345n);
  });

  it("100% takes everything", () => {
    expect(applyDiscount(12_345n, { kind: "percent", value: 100 })).toBe(0n);
  });

  it("clamps a percent above 100 rather than going negative", () => {
    // A stored 1000 is basis points typed into a whole-percent column.
    expect(applyDiscount(5_000n, { kind: "percent", value: 1000 })).toBe(0n);
  });

  it("clamps a negative percent to zero rather than charging more", () => {
    expect(applyDiscount(5_000n, { kind: "percent", value: -20 })).toBe(5_000n);
  });

  it("truncates a fractional percent rather than rounding it up", () => {
    // 9.9 cannot have come from the `value integer` column, so it came from a
    // caller doing float maths. Rounding to 10 hands out a discount nobody set.
    expect(applyDiscount(1_000n, { kind: "percent", value: 9.9 })).toBe(910n);
  });

  it("survives NaN without throwing the checkout page a 500", () => {
    expect(applyDiscount(1_000n, { kind: "percent", value: Number.NaN })).toBe(
      1_000n,
    );
  });
});

describe("applyDiscount — fixed", () => {
  it("subtracts minor units", () => {
    expect(applyDiscount(5_000n, { kind: "fixed", value: 500 })).toBe(4_500n);
  });

  it("never takes the total below zero", () => {
    // 50.00 off a 30.00 cart. A negative total is a Stripe 400 at best and a
    // credit nobody authorised at worst.
    expect(applyDiscount(3_000n, { kind: "fixed", value: 5_000 })).toBe(0n);
  });

  it("exactly consuming the cart lands on zero", () => {
    expect(applyDiscount(3_000n, { kind: "fixed", value: 3_000 })).toBe(0n);
  });

  it("clamps a negative fixed value rather than adding to the bill", () => {
    expect(applyDiscount(3_000n, { kind: "fixed", value: -1_000 })).toBe(3_000n);
  });

  it("an empty cart cannot be discounted into a credit", () => {
    expect(applyDiscount(0n, { kind: "fixed", value: 5_000 })).toBe(0n);
  });
});

describe("cartTotals", () => {
  const lines = [
    line({ unitPriceMinor: 1999n, quantity: 5 }),
    line({ productRef: "sku_map", unitPriceMinor: 505n, quantity: 1 }),
  ];

  it("returns every figure as bigint, never a number", () => {
    const totals = cartTotals({ lines });
    for (const value of Object.values(totals)) {
      expect(typeof value).toBe("bigint");
    }
  });

  it("discounts the SUBTOTAL, never the grand total", () => {
    // 10% of the subtotal, not 10% of subtotal+shipping+tax. Discounting the
    // grand total quietly discounts sales tax the merchant still owes in full,
    // and the shortfall does not surface until a filing.
    const totals = cartTotals({
      lines,
      discount: { kind: "percent", value: 10 },
      shippingMinor: 500n,
      taxMinor: 800n,
    });

    expect(totals.subtotal).toBe(10_500n);
    expect(totals.discount).toBe(1_050n);
    expect(totals.shipping).toBe(500n);
    expect(totals.tax).toBe(800n);
    expect(totals.total).toBe(10_750n);

    // What discounting the grand total would have produced. Never this.
    expect(totals.discount).not.toBe(1_180n);
  });

  it("always reconciles: total = subtotal - discount + shipping + tax", () => {
    for (const value of [0, 1, 7, 33, 50, 99, 100]) {
      const totals = cartTotals({
        lines,
        discount: { kind: "percent", value },
        shippingMinor: 1_234n,
        taxMinor: 987n,
      });
      expect(totals.total).toBe(
        totals.subtotal - totals.discount + totals.shipping + totals.tax,
      );
    }
  });

  it("reports discount as a positive amount already taken off", () => {
    const totals = cartTotals({ lines, discount: { kind: "fixed", value: 250 } });
    expect(totals.discount).toBe(250n);
    expect(totals.total).toBe(10_250n);
  });

  it("clamps the discount at the subtotal, leaving shipping and tax payable", () => {
    // A 100% goods discount is still a bill: the carrier and the state are
    // owed regardless.
    const totals = cartTotals({
      lines,
      discount: { kind: "fixed", value: 999_999 },
      shippingMinor: 500n,
      taxMinor: 0n,
    });
    expect(totals.discount).toBe(10_500n);
    expect(totals.total).toBe(500n);
  });

  it("treats omitted shipping and tax as zero, not as absent", () => {
    const totals = cartTotals({ lines: [line({ unitPriceMinor: 100n })] });
    expect(totals).toEqual({
      subtotal: 100n,
      discount: 0n,
      shipping: 0n,
      tax: 0n,
      total: 100n,
    });
  });
});

describe("validateCart", () => {
  it("an empty cart is one problem and stops there", () => {
    expect(validateCart([])).toEqual([
      { code: "empty-cart", message: "Your cart is empty." },
    ]);
  });

  it("a good cart has no problems", () => {
    expect(validateCart([line(), line({ productRef: "sku_map" })])).toEqual([]);
  });

  it("reports EVERY problem, not just the first", () => {
    // One problem per round trip trains people to fix-and-retry, and the fifth
    // retry is where the cart is abandoned.
    const problems = validateCart([
      line({ quantity: 0 }),
      line({ productRef: "sku_map", unitPriceMinor: -1n }),
      line({ productRef: "sku_pin", quantity: 2.5 }),
    ]);
    expect(problems.map((p) => p.code).sort()).toEqual([
      "negative-price",
      "quantity-below-one",
      "quantity-not-integer",
    ]);
  });

  it("a fractional quantity is reported once, not also as below-one", () => {
    // 0.5 is both fractional and below one. Two errors on one form field reads
    // as a broken form.
    const problems = validateCart([line({ quantity: 0.5 })]);
    expect(problems.map((p) => p.code)).toEqual(["quantity-not-integer"]);
  });

  it("catches zero and negative quantities", () => {
    expect(validateCart([line({ quantity: 0 })])[0]?.code).toBe(
      "quantity-below-one",
    );
    expect(validateCart([line({ quantity: -3 })])[0]?.code).toBe(
      "quantity-below-one",
    );
  });

  it("allows a zero price — free gifts and included accessories are real lines", () => {
    expect(validateCart([line({ unitPriceMinor: 0n })])).toEqual([]);
  });

  it("rejects a negative price rather than treating it as a discount", () => {
    const problems = validateCart([line({ unitPriceMinor: -500n })]);
    expect(problems.map((p) => p.code)).toEqual(["negative-price"]);
  });

  it("flags duplicate lines that should have been merged", () => {
    const problems = validateCart([
      line({ productRef: "sku_a", variantRef: "red" }),
      line({ productRef: "sku_a", variantRef: "red" }),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.code).toBe("duplicate-line");
    expect(problems[0]?.lineIndex).toBe(1);
  });

  it("does not confuse a variant with a product whose ref contains a separator", () => {
    // The reason the key is joined with NUL. Under a "|" or "-" join these two
    // lines collide, the UI merges them, and one of the two things the customer
    // is buying disappears.
    expect(
      validateCart([
        line({ productRef: "sku|red" }),
        line({ productRef: "sku", variantRef: "red" }),
      ]),
    ).toEqual([]);

    expect(
      validateCart([
        line({ productRef: "sku-red" }),
        line({ productRef: "sku", variantRef: "red" }),
      ]),
    ).toEqual([]);
  });

  it("treats no variant and a variant as different lines of the same product", () => {
    expect(
      validateCart([
        line({ productRef: "sku_a" }),
        line({ productRef: "sku_a", variantRef: "large" }),
      ]),
    ).toEqual([]);
  });

  it("reports each extra copy, naming the line it duplicates", () => {
    const problems = validateCart([line(), line(), line()]);
    expect(problems.map((p) => p.lineIndex)).toEqual([1, 2]);
    expect(problems[0]?.message).toContain("lines 1 and 2");
    expect(problems[1]?.message).toContain("lines 1 and 3");
  });
});
