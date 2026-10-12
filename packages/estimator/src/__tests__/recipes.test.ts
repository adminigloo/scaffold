import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  areaSqFt,
  customerFieldsFor,
  defaultSupplyBasis,
  deriveQuantities,
  effectiveRecipe,
  fmt,
  fmtRange,
  inputsSummary,
  legacyDerivation,
  legacyInputs,
  parseCustomerInputs,
  perimeterFt,
  quantityQuestion,
  rampLengthFt,
  recipeConfigProblem,
  recipeConfigSchema,
  recipeInfoFor,
  recipeReadsPhotos,
  resolveRecipeConfig,
  restingLandings,
  riseFromSteps,
  supplyBasesFor,
  toFeet,
  type NormalizedObservation,
} from "../recipes.js";
import type { AreaRecipeConfig, CustomerField, RampRecipeConfig } from "../wire.js";

/**
 * The recipes: every number a customer sees comes from these named functions
 * (rule A), and every sentence that explains it is written here from the
 * values. The worked examples are section 3.3's table, asserted exactly.
 */

const ramp = resolveRecipeConfig("ramp_over_steps", null) as RampRecipeConfig;
const reading = (low: number, high: number, confidence: "low" | "medium" | "high" = "medium"): NormalizedObservation => ({
  recipe: "ramp_over_steps",
  seen: true,
  risers: 3,
  riserHeightIn: { low, high },
  confidence,
});

describe("the formulas, at their edges", () => {
  it("riseFromSteps is steps × height, to 0.01", () => {
    expect(riseFromSteps(3, 7)).toBe(21);
    expect(riseFromSteps(3, 7.5)).toBe(22.5);
    expect(riseFromSteps(4, 7.25)).toBe(29);
    expect(riseFromSteps(3, 7.333)).toBe(22);
    expect(riseFromSteps(1, 3)).toBe(3);
  });

  it("rampLengthFt: a foot of ramp per inch of rise at 1:12, rounded UP to the step", () => {
    expect(rampLengthFt(21, 12, 1)).toBe(21);
    expect(rampLengthFt(22.5, 12, 1)).toBe(23);
    expect(rampLengthFt(22.5, 12, 0)).toBe(22.5); // 0 = no rounding
    expect(rampLengthFt(22.5, 12, 2)).toBe(24); // 2-ft sections
    expect(rampLengthFt(21, 12, 2)).toBe(22);
    expect(rampLengthFt(20, 16, 1)).toBe(27); // 1:16 → 26.67 → 27
    // The snap: float noise never becomes an extra foot.
    expect(rampLengthFt(22.0000000001, 12, 1)).toBe(22);
    expect(rampLengthFt(0.1 + 0.2, 12, 0)).toBe(0.3);
  });

  it("restingLandings: one run rises at most 30 in", () => {
    expect(restingLandings(30, 30)).toBe(0);
    expect(restingLandings(30.25, 30)).toBe(1);
    expect(restingLandings(60, 30)).toBe(1);
    expect(restingLandings(61, 30)).toBe(2);
    expect(restingLandings(0, 30)).toBe(0);
  });

  it("toFeet, areaSqFt and perimeterFt in feet and in inches", () => {
    expect(toFeet(24, "in")).toBe(2);
    expect(toFeet(24, "ft")).toBe(24);
    expect(areaSqFt(12, 20, "ft")).toBe(240);
    expect(perimeterFt(12, 20, "ft")).toBe(64);
    expect(areaSqFt(72, 36, "in")).toBe(18);
    expect(perimeterFt(72, 36, "in")).toBe(18);
    expect(areaSqFt(50, 37, "in")).toBe(12.85); // 12.847… to 0.01
  });

  it("fmt and fmtRange write numbers the way a person does", () => {
    expect(fmt(7)).toBe("7");
    expect(fmt(7.5)).toBe("7.5");
    expect(fmt(7.25)).toBe("7.25");
    expect(fmt(22.499999999)).toBe("22.5");
    expect(fmtRange(7, 8)).toBe("7–8");
    expect(fmtRange(21, 21)).toBe("21");
  });
});

describe("ramp_over_steps: section 3.3's worked examples, sentences exact", () => {
  const RUN = "ADA 1:12 slope (1 ft of ramp per inch of rise) →";

  it("{ steps: 3 } — the owner's assumed 7–8 in step, priced in the middle (7.5 in)", () => {
    const d = deriveQuantities("ramp_over_steps", ramp, { steps: 3 });
    // The point is at the TYPICAL height, 7.5 in: 22.5 in of rise → 23 ft (review EST-R05).
    expect([d.quantities.low.rampFt, d.quantities.point.rampFt, d.quantities.high.rampFt]).toEqual([21, 23, 24]);
    expect([d.quantities.low.landings, d.quantities.high.landings]).toEqual([0, 0]);
    expect(d.basis).toBe("assumed");
    expect(d.exact).toBe(false);
    expect(d.explanation).toEqual(["3 steps × 7–8 in each (estimated) = 21–24 in rise", `${RUN} 21–24 ft of ramp`]);
    expect(d.assumption).toBe(
      "Based on an estimated step height of 7–8 in. Measure one step and enter it for a tighter estimate.",
    );
    expect(d.resultPhrase).toBe("That's about a 21–24 ft ramp.");
    expect(d.reasons).toEqual(["Step height 7–8 in (estimated)"]);
  });

  it("{ steps: 3, stepHeightIn: 7.5 } — measured: exact, rounded up to whole feet", () => {
    const d = deriveQuantities("ramp_over_steps", ramp, { steps: 3, stepHeightIn: 7.5 });
    expect([d.quantities.low.rampFt, d.quantities.point.rampFt, d.quantities.high.rampFt]).toEqual([23, 23, 23]);
    expect(d.basis).toBe("measured");
    expect(d.exact).toBe(true);
    expect(d.explanation).toEqual(["3 steps × 7.5 in = 22.5 in rise", `${RUN} 23 ft of ramp (rounded up to whole feet)`]);
    expect(d.assumption).toBeNull();
    expect(d.resultPhrase).toBe("That's about a 23-ft ramp.");
    expect(d.reasons).toEqual([]);
  });

  it("{ steps: 3 } + a medium reading of 7.5–8.5 in — from the photo, kept inside the owner's 7–8 in", () => {
    const d = deriveQuantities("ramp_over_steps", ramp, { steps: 3 }, { reading: reading(7.5, 8.5) });
    // The photo narrows the owner's band to 7.5–8; it can't price above it (review EST-R10).
    expect([d.quantities.low.rampFt, d.quantities.point.rampFt, d.quantities.high.rampFt]).toEqual([23, 24, 24]);
    expect(d.basis).toBe("photo");
    expect(d.explanation).toEqual([
      "3 steps × 7.5–8 in each (from your photo) = 22.5–24 in rise",
      `${RUN} 23–24 ft of ramp (rounded up to whole feet)`,
    ]);
    expect(d.assumption).toBe(
      "Based on a step height of about 7.5–8 in, from your photo. Measure one step and enter it for a tighter estimate.",
    );
    expect(d.reasons).toEqual(["Step height 7.5–8 in (from the photo)"]);
    expect(d.quoteBasis).toBe("3 steps, 7.75 in each (from the photo), 24 ft of ramp");
  });

  it("{ steps: 4 } + the same reading — a resting landing may be needed", () => {
    const d = deriveQuantities("ramp_over_steps", ramp, { steps: 4 }, { reading: reading(7.5, 8.5) });
    expect([d.quantities.low.rampFt, d.quantities.point.rampFt, d.quantities.high.rampFt]).toEqual([30, 31, 32]);
    expect([d.quantities.low.landings, d.quantities.point.landings, d.quantities.high.landings]).toEqual([0, 1, 1]);
    expect(d.explanation).toEqual([
      "4 steps × 7.5–8 in each (from your photo) = 30–32 in rise",
      `${RUN} 30–32 ft of ramp`,
      "0–1 resting landings: ramps need one for every 30 in of rise",
    ]);
    expect(d.reasons).toEqual(["Step height 7.5–8 in (from the photo)", "A resting landing may be needed (over 30 in of rise)"]);
    expect(d.quoteBasis).toBe("4 steps, 7.75 in each (from the photo), 31 ft of ramp, 1 resting landing");
  });

  it("{ steps: 4, stepHeightIn: 7.25 } — 29 in, no rounding needed", () => {
    const d = deriveQuantities("ramp_over_steps", ramp, { steps: 4, stepHeightIn: 7.25 });
    expect([d.quantities.low.rampFt, d.quantities.high.rampFt]).toEqual([29, 29]);
    expect(d.explanation).toEqual(["4 steps × 7.25 in = 29 in rise", `${RUN} 29 ft of ramp`]);
  });

  it("{ totalRiseIn: 36 } — the total wins; one resting landing", () => {
    const d = deriveQuantities("ramp_over_steps", ramp, { totalRiseIn: 36 });
    expect([d.quantities.low.rampFt, d.quantities.high.rampFt]).toEqual([36, 36]);
    expect([d.quantities.low.landings, d.quantities.high.landings]).toEqual([1, 1]);
    expect(d.basis).toBe("total");
    expect(d.explanation).toEqual([
      "36 in total rise (measured)",
      `${RUN} 36 ft of ramp`,
      "1 resting landing: ramps need one for every 30 in of rise",
    ]);
    // Given with a height too, the total still wins.
    expect(deriveQuantities("ramp_over_steps", ramp, { steps: 3, stepHeightIn: 7, totalRiseIn: 36 }).quantities.point.rampFt).toBe(36);
  });

  it("the founder's porch: 2 steps + the deck = 3 risers; 2 risers is 15 ft at 7.5 in", () => {
    const porch = deriveQuantities("ramp_over_steps", ramp, { steps: 3, stepHeightIn: 7.5 });
    expect(porch.explanation[0]).toBe("3 steps × 7.5 in = 22.5 in rise");
    expect(deriveQuantities("ramp_over_steps", { ...ramp, roundUpToFt: 0 }, { steps: 3, stepHeightIn: 7.5 }).quantities.point.rampFt).toBe(22.5);
    expect(deriveQuantities("ramp_over_steps", ramp, { steps: 2, stepHeightIn: 7.5 }).quantities.point.rampFt).toBe(15);
  });

  it("which step height: the four bases in order", () => {
    const r = reading(7.5, 8.5);
    expect(deriveQuantities("ramp_over_steps", ramp, { steps: 3, totalRiseIn: 20, stepHeightIn: 7 }, { reading: r }).basis).toBe("total");
    expect(deriveQuantities("ramp_over_steps", ramp, { steps: 3, stepHeightIn: 7 }, { reading: r }).basis).toBe("measured");
    expect(deriveQuantities("ramp_over_steps", ramp, { steps: 3 }, { reading: r }).basis).toBe("photo");
    expect(deriveQuantities("ramp_over_steps", ramp, { steps: 3 }).basis).toBe("assumed");
    // A low-confidence reading, or one with no height, is never priced from.
    expect(deriveQuantities("ramp_over_steps", ramp, { steps: 3 }, { reading: reading(7.5, 8.5, "low") }).basis).toBe("assumed");
    expect(
      deriveQuantities("ramp_over_steps", ramp, { steps: 3 }, { reading: { ...r, riserHeightIn: null } as NormalizedObservation }).basis,
    ).toBe("assumed");
  });

  it("other slopes, sections, the owner's assumption and the quantity line", () => {
    const d = deriveQuantities(
      "ramp_over_steps",
      { ...ramp, slopeRatio: 16, roundUpToFt: 2, stepHeightIn: { typical: 6, low: 6, high: 6 } },
      { steps: 2 },
      { quantity: 2 },
    );
    expect(d.explanation).toEqual(["2 steps × 6 in each (estimated) = 12 in rise", "1:16 slope → 16 ft of ramp", "× 2 ramps"]);
    expect(d.exact).toBe(true);
    expect(d.reasons).toEqual([]); // an exact assumption is still an assumption…
    expect(d.assumption).toBe("Based on an estimated step height of 6 in. Measure one step and enter it for a tighter estimate.");
    const sections = deriveQuantities("ramp_over_steps", { ...ramp, roundUpToFt: 2 }, { steps: 3, stepHeightIn: 7 });
    expect(sections.explanation[1]).toBe("ADA 1:12 slope (1 ft of ramp per inch of rise) → 22 ft of ramp (rounded up to 2-ft sections)");
    expect(deriveQuantities("ramp_over_steps", ramp, { steps: 1, stepHeightIn: 7 }).explanation[0]).toBe("1 step × 7 in = 7 in rise");
  });

  it("carries 0.2's legacy keys: linearFt = rampFt, sqFt 0, units 1", () => {
    const d = deriveQuantities("ramp_over_steps", ramp, { steps: 3, stepHeightIn: 8 });
    expect(d.quantities.point).toEqual({ rampFt: 24, landings: 0, sqFt: 0, linearFt: 24, units: 1 });
  });
});

describe("area, linear and count", () => {
  const area = resolveRecipeConfig("area", { presets: [{ label: "5 × 5 ft", width: 5, length: 5 }] }) as AreaRecipeConfig;

  it("area: width × length, exact", () => {
    const d = deriveQuantities("area", area, { width: 12, length: 20 });
    expect(d.quantities.point).toEqual({ sqFt: 240, perimeterFt: 64, linearFt: 64, units: 1 });
    expect(d.explanation).toEqual(["12 ft × 20 ft = 240 sq ft"]);
    expect(d.resultPhrase).toBe("That's 240 sq ft.");
    expect(d.basis).toBe("exact");
    const inches = deriveQuantities("area", resolveRecipeConfig("area", {}, { legacy: true }), { width: 72, length: 36 });
    expect(inches.explanation).toEqual(["72 in × 36 in = 18 sq ft"]);
  });

  it("linear: the length, in feet", () => {
    const ft = deriveQuantities("linear", resolveRecipeConfig("linear", {}), { length: 120 }, { quantity: 2 });
    expect(ft.quantities.point.linearFt).toBe(120);
    expect(ft.explanation).toEqual(["120 ft", "× 2 runs"]);
    const inch = deriveQuantities("linear", resolveRecipeConfig("linear", { unit: "in" }), { length: 30 });
    expect(inch.explanation).toEqual(["30 in = 2.5 ft"]);
    expect(inch.resultPhrase).toBeNull();
  });

  it("count: the count is the quantity", () => {
    const config = resolveRecipeConfig("count", { noun: { one: "doorway", many: "doorways" } });
    expect(deriveQuantities("count", config, { count: 3 }).explanation).toEqual(["3 doorways"]);
    expect(deriveQuantities("count", config, { count: 1 }).explanation).toEqual(["1 doorway"]);
    expect(deriveQuantities("count", config, { count: 3 }).quantities.point.item).toBe(1);
  });

  it("a staff line with a full 0.2 measurement is priced the 0.2 way", () => {
    const d = legacyDerivation("ramp_over_steps", { linearFt: 24, units: 2 });
    expect(d.quantities.point).toEqual({ sqFt: 0, linearFt: 24, units: 2, rampFt: 0, landings: 0 });
    expect(d.explanation).toEqual([]);
  });
});

describe("what the customer is asked: customerFieldsFor", () => {
  it("the ramp asks the three questions of 3.3, in order", () => {
    expect(customerFieldsFor("ramp_over_steps", ramp)).toEqual([
      {
        key: "steps",
        kind: "stepper",
        label: "How many steps go up to the door?",
        help: "Count every step up, including the last one onto the porch or landing: 2 steps and the porch is 3.",
        required: true,
        min: 1,
        max: 20,
        presentation: "primary",
      },
      {
        key: "stepHeightIn",
        kind: "number",
        label: "Height of one step (optional)",
        help: "Measure from the top of one step to the top of the next.",
        required: false,
        min: 3,
        max: 12,
        step: 0.25,
        unit: "in",
        placeholder: "e.g. 7.5",
        presentation: "primary",
      },
      {
        key: "totalRiseIn",
        kind: "number",
        label: "Or the total height, ground to door threshold (optional)",
        help: "If you measured the whole height instead, enter it here.",
        required: false,
        min: 3,
        max: 360,
        step: 0.25,
        unit: "in",
        placeholder: null,
        presentation: "secondary",
      },
    ]);
    expect(customerFieldsFor("ramp_over_steps", { ...ramp, allowTotalRise: false }).map((f) => f.key)).toEqual(["steps", "stepHeightIn"]);
  });

  it("area (presets first), linear and count", () => {
    const area = resolveRecipeConfig("area", { presets: [{ label: "4 × 4 ft", width: 4, length: 4 }] });
    expect(customerFieldsFor("area", area)).toEqual([
      {
        key: "preset",
        kind: "choice",
        label: "Common sizes",
        help: null,
        required: false,
        presentation: "primary",
        choices: [{ value: "0", label: "4 × 4 ft", sets: { width: 4, length: 4 } }],
      },
      { key: "width", kind: "number", label: "Width", help: null, required: true, min: 0.5, max: 1000, step: 0.5, unit: "ft", placeholder: null, presentation: "primary" },
      { key: "length", kind: "number", label: "Length", help: null, required: true, min: 0.5, max: 1000, step: 0.5, unit: "ft", placeholder: null, presentation: "primary" },
    ]);
    expect(customerFieldsFor("linear", resolveRecipeConfig("linear", {}))).toEqual([
      { key: "length", kind: "number", label: "Length", help: null, required: true, min: 0.5, max: 5000, step: 0.5, unit: "ft", placeholder: null, presentation: "primary" },
    ]);
    expect(customerFieldsFor("count", resolveRecipeConfig("count", {}))).toEqual([
      { key: "count", kind: "stepper", label: "How many?", help: null, required: true, min: 1, max: 50, presentation: "primary" },
    ]);
  });

  it("no field label, help, placeholder or key a customer reads says 'run' or 'linear'", () => {
    const words = (fields: CustomerField[]) =>
      fields.flatMap((f) => [f.key, f.label, f.help ?? "", "placeholder" in f ? (f.placeholder ?? "") : ""]);
    for (const recipe of ["ramp_over_steps", "area", "count"] as const) {
      for (const text of words(customerFieldsFor(recipe, resolveRecipeConfig(recipe, {})))) {
        expect(text).not.toMatch(/\brun\b|linear/i);
      }
    }
  });

  it("'How many …?' only for a product sold in multiples, never for a count", () => {
    const product = { allowMultiple: true, multipleLabel: null, maxQuantity: 4 };
    expect(quantityQuestion("ramp_over_steps", ramp, product)).toEqual({ label: "How many ramps?", max: 4 });
    expect(quantityQuestion("ramp_over_steps", ramp, { ...product, multipleLabel: "How many doors?" })?.label).toBe("How many doors?");
    expect(quantityQuestion("ramp_over_steps", ramp, { ...product, allowMultiple: false })).toBeNull();
    expect(quantityQuestion("count", resolveRecipeConfig("count", {}), product)).toBeNull();
  });
});

describe("parseCustomerInputs", () => {
  it("a missing required answer is needs_inputs, not an error", () => {
    expect(parseCustomerInputs("ramp_over_steps", ramp, {})).toEqual({ ok: false, missing: ["steps"] });
    expect(parseCustomerInputs("ramp_over_steps", ramp, { stepHeightIn: 7 })).toEqual({ ok: false, missing: ["steps"] });
    expect(parseCustomerInputs("area", resolveRecipeConfig("area", {}), { width: 4 })).toEqual({ ok: false, missing: ["length"] });
    expect(parseCustomerInputs("count", resolveRecipeConfig("count", {}), { count: null })).toEqual({ ok: false, missing: ["count"] });
  });

  it("a bad value throws a ZodError on ['inputs', key]", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ steps: 0 }, "steps"],
      [{ steps: 2.5 }, "steps"],
      [{ steps: 21 }, "steps"],
      [{ steps: "3" }, "steps"],
      [{ steps: 3, stepHeightIn: 13 }, "stepHeightIn"],
      [{ totalRiseIn: 400 }, "totalRiseIn"],
    ];
    for (const [raw, key] of cases) {
      let error: unknown;
      try {
        parseCustomerInputs("ramp_over_steps", ramp, raw);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ZodError);
      expect((error as ZodError).issues[0]?.path).toEqual(["inputs", key]);
    }
  });

  it("keeps the recipe's keys, drops strays, and lets a total stand alone", () => {
    expect(parseCustomerInputs("ramp_over_steps", ramp, { steps: 4, sneaky: 1 })).toEqual({
      ok: true,
      inputs: { steps: 4, stepHeightIn: null, totalRiseIn: null },
    });
    expect(parseCustomerInputs("ramp_over_steps", ramp, { totalRiseIn: 36 })).toEqual({
      ok: true,
      inputs: { steps: null, stepHeightIn: null, totalRiseIn: 36 },
    });
    // A total the owner doesn't offer is ignored, so the steps are needed.
    expect(parseCustomerInputs("ramp_over_steps", { ...ramp, allowTotalRise: false }, { totalRiseIn: 36 })).toEqual({
      ok: false,
      missing: ["steps"],
    });
  });
});

describe("legacyInputs: 0.2 measurements still arrive", () => {
  const legacyArea = resolveRecipeConfig("area", {}, { legacy: true });
  const ftArea = resolveRecipeConfig("area", {});

  it("maps each row of 3.8", () => {
    expect(legacyInputs("area", legacyArea, { widthIn: 72, heightIn: 36 }, 1)).toEqual({ inputs: { width: 72, length: 36 }, quantity: 1 });
    expect(legacyInputs("area", ftArea, { widthIn: 72, heightIn: 36 }, 2)).toEqual({ inputs: { width: 6, length: 3 }, quantity: 2 });
    expect(legacyInputs("linear", resolveRecipeConfig("linear", {}), { linearFt: 24 }, 1)).toEqual({ inputs: { length: 24 }, quantity: 1 });
    expect(legacyInputs("linear", resolveRecipeConfig("linear", { unit: "in" }), { linearFt: 2 }, 1)).toEqual({ inputs: { length: 24 }, quantity: 1 });
    expect(legacyInputs("count", resolveRecipeConfig("count", {}), {}, 3)).toEqual({ inputs: { count: 3 }, quantity: 1 });
    expect(legacyInputs("ramp_over_steps", ramp, { linearFt: 24 }, 1)).toBeNull();
  });

  it("a bare sqFt (or a stray units) is not an area", () => {
    expect(legacyInputs("area", legacyArea, { sqFt: 18 }, 1)).toBeNull();
    expect(legacyInputs("area", legacyArea, { widthIn: 72 }, 1)).toBeNull();
  });
});

describe("configs: defaults, the legacy unit, the write-side schema", () => {
  it("resolveRecipeConfig: defaults under valid stored keys; never throws", () => {
    expect(resolveRecipeConfig("ramp_over_steps", null)).toEqual(ramp);
    const custom = resolveRecipeConfig("ramp_over_steps", { stepsLabel: "Steps to the porch?", slopeRatio: 99, stepHeightIn: { typical: 7, low: 8, high: 9 } }) as RampRecipeConfig;
    expect(custom.stepsLabel).toBe("Steps to the porch?");
    expect(custom.slopeRatio).toBe(12); // 99 is out of range: the default
    expect(custom.stepHeightIn).toEqual({ typical: 7.5, low: 7, high: 8 }); // out of order: the default
    expect(resolveRecipeConfig("area", "junk")).toEqual(resolveRecipeConfig("area", {}));
  });

  it("a pre-0.3 area product is in inches; the maximums follow the unit", () => {
    const legacy = resolveRecipeConfig("area", null, { legacy: true }) as AreaRecipeConfig;
    expect(legacy.unit).toBe("in");
    expect(legacy.maxWidth).toBe(12_000);
    const ft = resolveRecipeConfig("area", { maxWidth: 5000 }) as AreaRecipeConfig;
    expect(ft.maxWidth).toBe(1000); // never above the unit's ceiling
  });

  it("recipeConfigSchema checks each key; recipeConfigProblem the merged whole", () => {
    expect(recipeConfigSchema("ramp_over_steps").safeParse({ slopeRatio: 7 }).success).toBe(false);
    expect(recipeConfigSchema("ramp_over_steps").safeParse({ stepsLabel: "" }).success).toBe(false);
    expect(recipeConfigSchema("ramp_over_steps").safeParse({ stepsLabel: "Steps?" }).success).toBe(true);
    expect(recipeConfigProblem("area", { unit: "ft", maxWidth: 5000 })).toMatch(/1000/);
    expect(recipeConfigProblem("area", { unit: "in", maxWidth: 5000 })).toBeNull();
  });

  it("effectiveRecipe follows measurementMode for a product from before 0.3", () => {
    expect(effectiveRecipe({ recipe: null, measurementMode: "linear" })).toBe("linear");
    expect(effectiveRecipe({ recipe: null, measurementMode: "unit" })).toBe("count");
    expect(effectiveRecipe({ recipe: null, measurementMode: "area" })).toBe("area");
    expect(effectiveRecipe({ recipe: "ramp_over_steps", measurementMode: "linear" })).toBe("ramp_over_steps");
  });
});

describe("supply bases and recipe info", () => {
  it("supplyBasesFor: the keys, then item, then job", () => {
    expect(supplyBasesFor("ramp_over_steps")).toEqual(["rampFt", "landings", "item", "job"]);
    expect(supplyBasesFor("area")).toEqual(["sqFt", "perimeterFt", "item", "job"]);
    expect(supplyBasesFor("count")).toEqual(["item", "job"]);
  });

  it("defaultSupplyBasis by the supplier's unit", () => {
    expect(defaultSupplyBasis("ramp_over_steps", "per_linear_ft")).toBe("rampFt");
    expect(defaultSupplyBasis("area", "per_linear_ft")).toBe("perimeterFt");
    expect(defaultSupplyBasis("count", "per_linear_ft")).toBe("item");
    expect(defaultSupplyBasis("area", "per_sqft")).toBe("sqFt");
    expect(defaultSupplyBasis("ramp_over_steps", "per_sqft")).toBeNull();
    expect(defaultSupplyBasis("ramp_over_steps", "per_unit")).toBe("item");
    expect(defaultSupplyBasis("ramp_over_steps", "flat")).toBe("job");
  });

  it("recipeInfoFor: the bases in words, and whether it reads photos", () => {
    const info = recipeInfoFor("ramp_over_steps", ramp);
    expect(info.bases).toEqual([
      { key: "rampFt", label: "per ft of ramp" },
      { key: "landings", label: "per resting landing" },
      { key: "item", label: "per item" },
      { key: "job", label: "once per job" },
    ]);
    expect(info.photoReading).toBe(true);
    expect(recipeReadsPhotos("count", resolveRecipeConfig("count", {}))).toBe(false);
    expect(recipeReadsPhotos("count", resolveRecipeConfig("count", { photoSubject: "the doorways" }))).toBe(true);
    expect(recipeReadsPhotos("area", resolveRecipeConfig("area", {}))).toBe(false);
  });
});

describe("inputsSummary", () => {
  it("one plain line per recipe", () => {
    expect(inputsSummary("ramp_over_steps", ramp, { steps: 4, stepHeightIn: 7.25 })).toBe("4 steps, 7.25 in each");
    expect(inputsSummary("ramp_over_steps", ramp, { steps: 3 })).toBe("3 steps");
    expect(inputsSummary("ramp_over_steps", ramp, { totalRiseIn: 36 })).toBe("36 in total rise");
    expect(inputsSummary("area", resolveRecipeConfig("area", {}), { width: 12, length: 20 })).toBe("12 ft × 20 ft");
    expect(inputsSummary("linear", resolveRecipeConfig("linear", {}), { length: 120 })).toBe("120 ft");
    expect(inputsSummary("count", resolveRecipeConfig("count", { noun: { one: "doorway", many: "doorways" } }), { count: 3 })).toBe("3 doorways");
  });
});
