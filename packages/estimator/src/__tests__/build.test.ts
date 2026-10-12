import { describe, expect, it } from "vitest";
import { buildPrice, cents, pct, type BuildInput, type BuildSupply } from "../build.js";
import { calculateEstimatePrice } from "../pricing.js";
import type { Quantities, QuantityRange } from "../recipes.js";

/**
 * The price build (section 4): prices from the owner's supplies, labor,
 * waste and markup or margin, at the low, point and high quantity sets.
 * Section 4.5's worked example (the sample ramp) is asserted to the cent.
 */

const supply = (over: Partial<BuildSupply> & Pick<BuildSupply, "name" | "unitCost" | "quantityMilli" | "per">): BuildSupply => ({
  assignmentId: over.name,
  supplyId: over.name,
  unitType: "per_unit",
  sortOrder: 0,
  ...over,
});

/** The sample "Modular aluminum ramp" (6.3). */
const RAMP_SUPPLIES: BuildSupply[] = [
  supply({ name: "Aluminum ramp section", unitType: "per_linear_ft", unitCost: 9_500, quantityMilli: 1000, per: "rampFt", sortOrder: 0 }),
  supply({ name: "Handrail", unitType: "per_linear_ft", unitCost: 1_800, quantityMilli: 2000, per: "rampFt", sortOrder: 10 }),
  supply({ name: "Support post & footing", unitCost: 4_200, quantityMilli: 250, per: "rampFt", sortOrder: 20 }),
  supply({ name: "Top landing platform (5 × 5 ft)", unitCost: 64_000, quantityMilli: 1000, per: "job", sortOrder: 30 }),
  supply({ name: "Resting landing platform (5 × 5 ft)", unitCost: 64_000, quantityMilli: 1000, per: "landings", sortOrder: 40 }),
  supply({ name: "Permit & inspection", unitType: "flat", unitCost: 15_000, quantityMilli: 1000, per: "job", sortOrder: 50 }),
  supply({ name: "Delivery", unitType: "flat", unitCost: 8_500, quantityMilli: 1000, per: "job", sortOrder: 60 }),
];

const set = (rampFt: number, landings: number): Quantities => ({ rampFt, landings, sqFt: 0, linearFt: rampFt, units: 1 });
const exact = (q: Quantities): QuantityRange => ({ low: q, point: q, high: q });

function rampInput(quantities: QuantityRange, over: Partial<BuildInput> = {}): BuildInput {
  return {
    quantities,
    primaryKey: "rampFt",
    quantityKinds: { rampFt: "length", landings: "count" },
    supplies: RAMP_SUPPLIES,
    lump: { basePrice: 0, pricePerSqFt: null, pricePerLinearFt: null, laborCost: 0 },
    labor: { hoursPerUnitMilli: 350, setupHoursMilli: 2000, rateCents: 6_500 },
    wasteBp: 500,
    pricing: { basis: "markup", markupBp: 4_000 },
    optionModifiers: [],
    quantity: 1,
    minimumCharge: 150_000,
    range: { mode: "measured", contingencyBp: 0 },
    ...over,
  };
}

describe("4.5: the sample ramp, to the cent", () => {
  const table: Array<[number, number, number, number]> = [
    // rampFt, landings, cost (×2 to keep half-cents exact), price
    [21, 0, 920_565, 644_396],
    [23, 0, 989_095, 692_367],
    [24, 0, 1_023_360, 716_352],
    [26, 0, 1_091_890, 764_323],
    [29, 0, 1_194_685, 836_280],
    [30, 0, 1_228_950, 860_265],
    [32, 1, 1_425_480, 997_836],
    [34, 1, 1_494_010, 1_045_807],
  ];
  for (const [rampFt, landings, costTwice, price] of table) {
    it(`${rampFt} ft, ${landings} landing(s) → ${price}`, () => {
      const build = buildPrice(rampInput(exact(set(rampFt, landings))));
      expect(build.point).toBe(price);
      expect(build.cost).toBe(cents(costTwice / 2));
      expect(build.single).toBe(true);
    });
  }

  it("the breakdown at 21 ft: per-ft supplies 297 150, waste 14 857.5, job 87 500, labor 60 775", () => {
    const build = buildPrice(rampInput(exact(set(21, 0))));
    const lines = build.breakdown;
    expect(lines.map((l) => [l.kind, l.label, l.quantity, l.unit, l.amount])).toEqual([
      ["supply", "Aluminum ramp section", 21, "ft", 199_500],
      ["supply", "Handrail", 42, "ft", 75_600],
      ["supply", "Support post & footing", 5.25, "each", 22_050],
      ["supply", "Resting landing platform (5 × 5 ft)", 0, "each", 0],
      ["supply", "Top landing platform (5 × 5 ft)", 1, "each", 64_000],
      ["supply", "Permit & inspection", 1, "flat", 15_000],
      ["supply", "Delivery", 1, "flat", 8_500],
      ["waste", "Waste 5%", null, null, 14_858],
      ["labor", "Labor 7.35 h × $65.00", 7.35, "h", 47_775],
      ["setup", "Setup 2 h × $65.00", 2, "h", 13_000],
      ["markup", "Markup 40%", null, null, 184_113],
    ]);
    // Rounded per line: the sum may differ from the price by a cent; the price comes from the exact values.
    const sum = lines.reduce((total, line) => total + line.amount, 0);
    expect(Math.abs(sum - build.point)).toBeLessThanOrEqual(1);
  });

  it("'3 steps, height unknown' is $6,443.96 – $7,163.52; '3 × 7.5 in' is one number, $6,923.67", () => {
    const unknown = buildPrice(rampInput({ low: set(21, 0), point: set(21, 0), high: set(24, 0) }));
    expect([unknown.estimateLow, unknown.estimateHigh, unknown.lineTotal, unknown.single]).toEqual([644_396, 716_352, 644_396, false]);
    const measured = buildPrice(rampInput(exact(set(23, 0))));
    expect([measured.estimateLow, measured.estimateHigh, measured.single]).toEqual([692_367, 692_367, true]);
  });

  it("at 21 ft the margin is 2857 bp; at a 35% target margin the same cost prices at 708 127", () => {
    expect(buildPrice(rampInput(exact(set(21, 0)))).marginBp).toBe(2857);
    const margin = buildPrice(rampInput(exact(set(21, 0)), { pricing: { basis: "margin", marginBp: 3500 } }));
    expect(margin.point).toBe(708_127);
    expect(margin.marginBp).toBe(3500);
    expect(margin.breakdown.find((l) => l.kind === "margin")?.label).toBe("Margin 35%");
  });
});

describe("cents(): snap, then round half up", () => {
  it("a half cent a float left just under rounds up: 692 366.4999999999 → 692 367", () => {
    // Plain Math.round would give 692 366: the float noise of a long sum of
    // supply amounts × 1.4 is what the snap removes.
    expect(Math.round(692_366.4999999999)).toBe(692_366);
    expect(cents(692_366.4999999999)).toBe(692_367);
    expect(cents(494_547.5 * 1.4)).toBe(692_367);
    expect(cents(0.5)).toBe(1);
    expect(cents(1.499_999)).toBe(1); // a real fraction (six decimals) is not noise
    expect(pct(725)).toBe("7.25%");
    expect(pct(500)).toBe("5%");
  });
});

describe("each supply basis", () => {
  const base = (supplies: BuildSupply[], q: Quantities, over: Partial<BuildInput> = {}) =>
    buildPrice({
      quantities: exact(q),
      primaryKey: "sqFt",
      quantityKinds: { sqFt: "area", perimeterFt: "length" },
      supplies,
      lump: { basePrice: 0, pricePerSqFt: null, pricePerLinearFt: null, laborCost: 0 },
      labor: { hoursPerUnitMilli: 0, setupHoursMilli: 0, rateCents: 0 },
      wasteBp: 0,
      pricing: { basis: "markup", markupBp: 0 },
      optionModifiers: [],
      quantity: 1,
      minimumCharge: 0,
      range: { mode: "measured", contingencyBp: 0 },
      ...over,
    });
  const q = { sqFt: 10, perimeterFt: 14, linearFt: 14, units: 3 };

  it("a quantity key, an item, a job, and a 0.2 null (by unit type)", () => {
    expect(base([supply({ name: "a", unitCost: 100, quantityMilli: 2000, per: "sqFt" })], q).point).toBe(2_000);
    expect(base([supply({ name: "b", unitCost: 100, quantityMilli: 2000, per: "item" })], q, { quantity: 3 }).point).toBe(600);
    expect(base([supply({ name: "c", unitCost: 100, quantityMilli: 2000, per: "job" })], q, { quantity: 3 }).point).toBe(200);
    expect(base([supply({ name: "d", unitType: "per_sqft", unitCost: 100, quantityMilli: 1000, per: null })], q).point).toBe(1_000);
    expect(base([supply({ name: "e", unitType: "per_linear_ft", unitCost: 100, quantityMilli: 1000, per: null })], q).point).toBe(1_400);
    expect(base([supply({ name: "f", unitType: "per_unit", unitCost: 100, quantityMilli: 1000, per: null })], q).point).toBe(300);
    expect(base([supply({ name: "g", unitType: "flat", unitCost: 100, quantityMilli: 1000, per: null })], q, { quantity: 2 }).point).toBe(200);
  });

  it("waste only on length/area bases, null-per supplies and the lumps — not on items, jobs or counts", () => {
    const wasteOf = (s: BuildSupply, over: Partial<BuildInput> = {}) => base([s], q, { wasteBp: 1000, ...over }).breakdown.find((l) => l.kind === "waste")?.amount;
    expect(wasteOf(supply({ name: "area", unitCost: 100, quantityMilli: 1000, per: "sqFt" }))).toBe(100);
    expect(wasteOf(supply({ name: "edge", unitCost: 100, quantityMilli: 1000, per: "perimeterFt" }))).toBe(140);
    expect(wasteOf(supply({ name: "item", unitCost: 100, quantityMilli: 1000, per: "item" }))).toBe(0);
    expect(wasteOf(supply({ name: "job", unitCost: 100, quantityMilli: 1000, per: "job" }))).toBe(0);
    expect(wasteOf(supply({ name: "old", unitType: "flat", unitCost: 100, quantityMilli: 1000, per: null }))).toBe(10);
    expect(
      wasteOf(supply({ name: "item", unitCost: 0, quantityMilli: 1000, per: "item" }), {
        lump: { basePrice: 1000, pricePerSqFt: 10, pricePerLinearFt: null, laborCost: 0 },
      }),
    ).toBe(110);
  });

  it("labor: hours per unit of the primary measure × rate (× items), plus setup once, plus lump labor", () => {
    const b = base([], q, { labor: { hoursPerUnitMilli: 100, setupHoursMilli: 1500, rateCents: 6_000 }, quantity: 2 });
    // 0.1 h × 10 sq ft × 2 items × $60 = $120; setup 1.5 h × $60 = $90.
    expect(b.point).toBe(21_000);
    expect(b.breakdown.map((l) => l.label)).toEqual(["Labor 2 h × $60.00", "Setup 1.5 h × $60.00"]);
    const lump = base([], q, { lump: { basePrice: 0, pricePerSqFt: null, pricePerLinearFt: null, laborCost: 5_000 }, quantity: 2 });
    expect(lump.point).toBe(10_000);
  });

  it("markup vs margin", () => {
    const s = [supply({ name: "a", unitCost: 10_000, quantityMilli: 1000, per: "job" })];
    expect(base(s, q, { pricing: { basis: "markup", markupBp: 2_500 } }).point).toBe(12_500);
    expect(base(s, q, { pricing: { basis: "margin", marginBp: 2_000 } }).point).toBe(12_500);
    expect(base(s, q, { pricing: { basis: "margin", marginBp: 2_000 } }).marginBp).toBe(2_000);
  });

  it("an option is a PRICE, added after markup (×items): a +$60 option adds $60, not $75", () => {
    const s = [supply({ name: "a", unitCost: 10_000, quantityMilli: 1000, per: "item" })];
    const b = base(s, q, { pricing: { basis: "markup", markupBp: 2_500 }, optionModifiers: [6_000], optionLabels: ["Finish: Matte"], quantity: 2 });
    expect(b.point).toBe(2 * 12_500 + 2 * 6_000);
    expect(b.breakdown.at(-1)).toEqual({ kind: "option", label: "Finish: Matte", quantity: 2, unit: "each", unitCost: 6_000, amount: 12_000 });
  });

  it("the minimum, on the low, the point and the high", () => {
    const s = [supply({ name: "a", unitCost: 100, quantityMilli: 1000, per: "sqFt" })];
    const range = { low: { ...q, sqFt: 5 }, point: { ...q, sqFt: 10 }, high: { ...q, sqFt: 40 } };
    const b = buildPrice({
      quantities: range,
      primaryKey: "sqFt",
      quantityKinds: { sqFt: "area" },
      supplies: s,
      lump: { basePrice: 0, pricePerSqFt: null, pricePerLinearFt: null, laborCost: 0 },
      labor: { hoursPerUnitMilli: 0, setupHoursMilli: 0, rateCents: 0 },
      wasteBp: 0,
      pricing: { basis: "markup", markupBp: 0 },
      optionModifiers: [],
      quantity: 1,
      minimumCharge: 2_000,
      range: { mode: "measured", contingencyBp: 0 },
    });
    expect([b.low, b.point, b.high]).toEqual([2_000, 2_000, 4_000]);
    expect(b.minimumApplied).toBe(true);
    expect(b.breakdown.at(-1)).toEqual({ kind: "minimum", label: "Minimum charge $20.00", quantity: null, unit: null, unitCost: null, amount: 1_000 });
  });
});

describe("the range (rule C)", () => {
  it("measured: priced at the measurement's own low and high; contingency widens what is shown, not the price", () => {
    const b = buildPrice(rampInput({ low: set(21, 0), point: set(21, 0), high: set(24, 0) }, { range: { mode: "measured", contingencyBp: 500 } }));
    expect(b.estimateLow).toBe(cents(644_396 * 0.95));
    expect(b.estimateHigh).toBe(cents(716_352 * 1.05));
    expect(b.lineTotal).toBe(644_396);
    expect(b.reasons).toEqual(["Contingency ±5%"]);
    // Exact + contingency: still a range, around one number.
    const exactPlus = buildPrice(rampInput(exact(set(23, 0)), { range: { mode: "measured", contingencyBp: 500 } }));
    expect(exactPlus.single).toBe(false);
    expect(exactPlus.lineTotal).toBe(692_367);
  });

  it("measured never shows a low below the minimum", () => {
    const b = buildPrice(rampInput(exact(set(1, 0)), { range: { mode: "measured", contingencyBp: 5000 } }));
    expect(b.estimateLow).toBe(150_000);
  });

  it("percent (opt-in): 0.2's band, saved at its midpoint; the low floored at the minimum", () => {
    const b = buildPrice(rampInput(exact(set(21, 0)), { range: { mode: "percent", lowBp: 9_000, highBp: 11_500 } }));
    expect(b.estimateLow).toBe(cents(644_396 * 0.9));
    expect(b.estimateHigh).toBe(cents(644_396 * 1.15));
    expect(b.lineTotal).toBe(Math.round((b.estimateLow + b.estimateHigh) / 2));
    expect(b.reasons).toEqual(["Price band 90%–115% of the price (your setting)"]);
    const floored = buildPrice(rampInput(exact(set(1, 0)), { range: { mode: "percent", lowBp: 9_000, highBp: 11_500 } }));
    expect(floored.estimateLow).toBe(150_000);
  });
});

describe("parity with 0.2's engine (every 0.3 knob at zero, per null)", () => {
  const legacy = (q: Quantities): QuantityRange => exact(q);
  it("the SG Glass shower door", () => {
    const old = calculateEstimatePrice({
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
    const now = buildPrice({
      quantities: legacy({ sqFt: 18, perimeterFt: 0, linearFt: 18, units: 1 }),
      primaryKey: "sqFt",
      quantityKinds: { sqFt: "area", perimeterFt: "length" },
      supplies: [
        supply({ name: "glass", unitType: "per_sqft", unitCost: 800, quantityMilli: 1000, per: null }),
        supply({ name: "hardware", unitType: "flat", unitCost: 5_000, quantityMilli: 1000, per: null }),
      ],
      lump: { basePrice: 15_000, pricePerSqFt: 2_500, pricePerLinearFt: null, laborCost: 7_500 },
      labor: { hoursPerUnitMilli: 0, setupHoursMilli: 0, rateCents: 0 },
      wasteBp: 0,
      pricing: { basis: "markup", markupBp: 0 },
      optionModifiers: [3_500],
      quantity: 1,
      minimumCharge: 0,
      range: { mode: "percent", lowBp: 9_000, highBp: 11_500 },
    });
    expect(now.point).toBe(old.subtotal);
    expect([now.estimateLow, now.estimateHigh]).toEqual([old.estimateLow, old.estimateHigh]);
  });

  it("0.2's ramp on linear feet with waste and markup", () => {
    const old = calculateEstimatePrice({
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
    const now = buildPrice({
      quantities: legacy({ linearFt: 24, sqFt: 0, units: 1 }),
      primaryKey: "linearFt",
      quantityKinds: { linearFt: "length" },
      supplies: [
        supply({ name: "rail", unitType: "per_linear_ft", unitCost: 3_000, quantityMilli: 2000, per: null }),
        supply({ name: "landing", unitType: "flat", unitCost: 25_000, quantityMilli: 1000, per: null }),
        supply({ name: "permit", unitType: "flat", unitCost: 15_000, quantityMilli: 1000, per: null }),
      ],
      lump: { basePrice: 0, pricePerSqFt: null, pricePerLinearFt: 12_000, laborCost: 0 },
      labor: { hoursPerUnitMilli: 0, setupHoursMilli: 0, rateCents: 0 },
      wasteBp: 1_000,
      pricing: { basis: "markup", markupBp: 3_500 },
      optionModifiers: [],
      quantity: 1,
      minimumCharge: 0,
      range: { mode: "percent", lowBp: 9_000, highBp: 11_500 },
    });
    expect(now.point).toBe(old.subtotal);
    expect(now.point).toBe(700_920);
  });
});
