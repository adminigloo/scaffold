import { describe, expect, it } from "vitest";
import {
  calculateEstimatePrice,
  calculateTotals,
  midpointOf,
  resolveMeasurement,
} from "../pricing.js";

describe("resolveMeasurement", () => {
  it("derives area and perimeter from width×height inches (the glass default)", () => {
    // 72in × 36in = 6ft × 3ft
    expect(resolveMeasurement({ widthIn: 72, heightIn: 36 })).toEqual({
      sqFt: 18,
      linearFt: 18,
      units: 1,
    });
  });

  it("takes linear feet directly for a trade that isn't a rectangle (a ramp)", () => {
    expect(resolveMeasurement({ linearFt: 24 })).toEqual({ sqFt: 0, linearFt: 24, units: 1 });
  });

  it("prefers direct quantities over width/height when both are given", () => {
    expect(resolveMeasurement({ widthIn: 72, heightIn: 36, sqFt: 10 })).toEqual({
      sqFt: 10,
      linearFt: 0,
      units: 1,
    });
  });
});

describe("calculateEstimatePrice — parity with the original engine (knobs at zero)", () => {
  it("prices a full shower door exactly like the ported SG Glass example", () => {
    // base $150, $25/sqft, labor $75, one $35 option, glass $8/sqft, hardware $50 flat,
    // on an 18 sqft panel (72×36 in) → subtotal $904, range $813.60–$1039.60.
    const result = calculateEstimatePrice({
      basePrice: 15_000,
      pricePerSqFt: 2_500,
      laborCost: 7_500,
      measurement: { widthIn: 72, heightIn: 36 },
      quantity: 1,
      optionModifiers: [3_500],
      components: [
        { unitCost: 800, unitType: "per_sqft", quantityMilli: 1000, isActive: true },
        { unitCost: 5_000, unitType: "flat", quantityMilli: 1000, isActive: true },
      ],
    });
    expect(result.sqFt).toBe(18);
    expect(result.linearFt).toBe(18);
    expect(result.subtotal).toBe(90_400);
    expect(result.estimateLow).toBe(81_360);
    expect(result.estimateHigh).toBe(103_960);
  });

  it("skips inactive components, exactly as before", () => {
    const withInactive = calculateEstimatePrice({
      basePrice: 10_000,
      measurement: { units: 1 },
      quantity: 1,
      components: [{ unitCost: 9_999, unitType: "flat", quantityMilli: 1000, isActive: false }],
    });
    expect(withInactive.subtotal).toBe(10_000);
  });
});

describe("calculateEstimatePrice — the knobs the original never applied", () => {
  it("prices a wheelchair ramp on linear feet with waste and markup", () => {
    // $120/linear ft over 24 ft, railing $30/ft on both sides, a $250 landing and a
    // $150 permit, +10% material waste, +35% markup.
    const result = calculateEstimatePrice({
      basePrice: 0,
      pricePerLinearFt: 12_000,
      measurement: { linearFt: 24 },
      quantity: 1,
      components: [
        { unitCost: 3_000, unitType: "per_linear_ft", quantityMilli: 2000, isActive: true },
        { unitCost: 25_000, unitType: "flat", quantityMilli: 1000, isActive: true },
        { unitCost: 15_000, unitType: "flat", quantityMilli: 1000, isActive: true },
      ],
      wasteBp: 1_000,
      markupBp: 3_500,
    });
    // materials 472000 → +10% waste = 519200 → +35% markup = 700920
    expect(result.subtotal).toBe(700_920);
    expect(result.estimateLow).toBe(630_828);
    expect(result.estimateHigh).toBe(806_058);
  });

  it("never quotes below the minimum charge", () => {
    const result = calculateEstimatePrice({
      basePrice: 5_000,
      measurement: { units: 1 },
      quantity: 1,
      minimumCharge: 20_000,
    });
    expect(result.subtotal).toBe(20_000);
    expect(result.estimateLow).toBe(18_000);
    expect(result.estimateHigh).toBe(23_000);
  });

  it("multiplies the whole per-unit subtotal by quantity", () => {
    const one = calculateEstimatePrice({ basePrice: 10_000, measurement: { units: 1 }, quantity: 1 });
    const three = calculateEstimatePrice({ basePrice: 10_000, measurement: { units: 1 }, quantity: 3 });
    expect(three.subtotal).toBe(one.subtotal * 3);
  });
});

describe("calculateTotals", () => {
  it("rolls line totals into subtotal, tax and balance", () => {
    const totals = calculateTotals({ itemTotals: [90_400, 20_000], taxRateBp: 825 });
    expect(totals.subtotal).toBe(110_400);
    expect(totals.taxAmount).toBe(9_108); // 110400 × 8.25%
    expect(totals.total).toBe(119_508);
    expect(totals.balanceDue).toBe(119_508);
  });

  it("applies a discount before tax and subtracts what's paid", () => {
    const totals = calculateTotals({
      itemTotals: [100_000],
      taxRateBp: 0,
      discount: 10_000,
      amountPaid: 40_000,
    });
    expect(totals.taxableAmount).toBe(90_000);
    expect(totals.total).toBe(90_000);
    expect(totals.balanceDue).toBe(50_000);
  });
});

describe("midpointOf", () => {
  it("is the rounded average of the range", () => {
    expect(midpointOf(81_360, 103_960)).toBe(92_660);
  });
});
