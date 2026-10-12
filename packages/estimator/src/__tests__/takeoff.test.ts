import { describe, expect, it } from "vitest";
import { resolveRecipeConfig } from "../recipes.js";
import type { NormalizedObservation } from "../recipes.js";
import {
  buildTakeoffPrompt,
  correctionsFor,
  maxTakeoffCallMicros,
  normalizeObservation,
  observationJsonSchema,
  suggestFromObservation,
  TAKEOFF_MODEL_RATES,
  TAKEOFF_SYSTEM_PROMPT,
  takeoffCostMicros,
} from "../takeoff.js";

/**
 * Photo reading, the pure half (replaces 0.2's suite, which asked the model
 * for measurements). Rule A: the model reports what it SEES; these functions
 * check it and write its words.
 */

const ramp = resolveRecipeConfig("ramp_over_steps", null);
/** The fields of either observation shape, for assertions. */
type AnyObservation = {
  recipe?: NormalizedObservation["recipe"];
  seen?: boolean;
  risers?: number | null;
  count?: number | null;
  riserHeightIn?: { low: number; high: number } | null;
  confidence?: string;
};
const norm = (recipe: "ramp_over_steps" | "count", raw: unknown) => normalizeObservation(recipe, raw) as AnyObservation | null;
const doorways = resolveRecipeConfig("count", { noun: { one: "doorway", many: "doorways" }, photoSubject: "the doorways", maxCount: 10 });

describe("the prompts (exact: the eval runs these)", () => {
  it("the ramp asks for risers and one riser's height, nothing to add up", () => {
    expect(buildTakeoffPrompt("ramp_over_steps", ramp)).toBe(
      [
        "Photo of: the steps up to the door.",
        "Count the risers: each vertical rise from the ground up to the door or porch floor, including the last one onto the porch or deck.",
        "Give the height of one riser in inches as a low and high value, or null if you can't judge it.",
        "Set seen to false if no steps are visible.",
      ].join("\n"),
    );
  });

  it("a count asks for the count of the owner's noun", () => {
    expect(buildTakeoffPrompt("count", doorways)).toBe(
      ["Photo of: the doorways.", "Count the doorways you can see.", "Set seen to false if there are none."].join("\n"),
    );
  });

  it("the subject is one line, whatever the owner typed", () => {
    expect(buildTakeoffPrompt("ramp_over_steps", { ...ramp, photoSubject: "the\nporch steps" } as never).split("\n")[0]).toBe(
      "Photo of: the porch steps.",
    );
  });

  it("the system line never asks for a number it would have to work out", () => {
    expect(TAKEOFF_SYSTEM_PROMPT).toBe(
      "You look at one photo for a contractor and report only what you can see. Count and describe; never calculate totals, lengths, areas or prices. If you can't see something clearly, say so with low confidence.",
    );
    // Lengths, areas and prices appear only in the clause that forbids them.
    const withoutTheBan = TAKEOFF_SYSTEM_PROMPT.replace("never calculate totals, lengths, areas or prices", "");
    expect(withoutTheBan).not.toMatch(/feet|\bft\b|length|area|price|total|rise|run|slope/i);
    for (const recipe of ["ramp_over_steps", "count"] as const) {
      const prompt = buildTakeoffPrompt(recipe, recipe === "count" ? doorways : ramp);
      expect(prompt).not.toMatch(/feet|\bft\b|length|area|price|total|slope|1:12|ramp/i);
    }
  });
});

describe("observationJsonSchema: strict structured output", () => {
  const walk = (node: unknown, visit: (object: Record<string, unknown>) => void) => {
    if (Array.isArray(node)) node.forEach((child) => walk(child, visit));
    else if (node && typeof node === "object") {
      visit(node as Record<string, unknown>);
      Object.values(node).forEach((child) => walk(child, visit));
    }
  };

  for (const recipe of ["ramp_over_steps", "count"] as const) {
    it(`${recipe}: every object closed, every property required, no numeric limits`, () => {
      const schema = observationJsonSchema(recipe);
      walk(schema, (object) => {
        if (object["type"] === "object") {
          expect(object["additionalProperties"]).toBe(false);
          expect([...(object["required"] as string[])].sort()).toEqual(Object.keys(object["properties"] as object).sort());
        }
        for (const banned of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]) {
          expect(object).not.toHaveProperty(banned);
        }
      });
    });
  }

  it("the ramp's shape", () => {
    expect(observationJsonSchema("ramp_over_steps")).toMatchObject({
      required: ["seen", "risers", "riserHeightIn", "confidence"],
      properties: {
        seen: { type: "boolean" },
        risers: { anyOf: [{ type: "integer" }, { type: "null" }] },
        confidence: { type: "string", enum: ["low", "medium", "high"] },
      },
    });
  });
});

describe("normalizeObservation: what the code may use, never the model's text", () => {
  it("junk is unusable", () => {
    expect(normalizeObservation("ramp_over_steps", null)).toBeNull();
    expect(normalizeObservation("ramp_over_steps", "3 steps")).toBeNull();
    expect(normalizeObservation("ramp_over_steps", [1, 2])).toBeNull();
    expect(normalizeObservation("ramp_over_steps", { risers: 3 })).toBeNull(); // seen missing
    expect(normalizeObservation("ramp_over_steps", { seen: "yes", risers: 3 })).toBeNull();
  });

  it("a clean reading, with unknown keys dropped", () => {
    expect(
      normalizeObservation("ramp_over_steps", {
        seen: true,
        risers: 3,
        riserHeightIn: { low: 7.5, high: 8.5, note: "x" },
        confidence: "medium",
        lengthFt: 24,
        summary: "about a 24 ft ramp",
      }),
    ).toEqual({ recipe: "ramp_over_steps", seen: true, risers: 3, riserHeightIn: { low: 7.5, high: 8.5 }, confidence: "medium" });
  });

  it("confidence outside the enum is low; risers must be a whole 1–30", () => {
    expect(norm("ramp_over_steps", { seen: true, risers: 3, riserHeightIn: null, confidence: "certain" })?.confidence).toBe("low");
    expect(norm("ramp_over_steps", { seen: true, risers: 2.5, riserHeightIn: null, confidence: "high" })?.risers).toBeNull();
    expect(norm("ramp_over_steps", { seen: true, risers: 31, riserHeightIn: null, confidence: "high" })?.risers).toBeNull();
  });

  it("a count of 0, or seen: false, is not seen, with no count and no height", () => {
    expect(normalizeObservation("ramp_over_steps", { seen: true, risers: 0, riserHeightIn: { low: 7, high: 8 }, confidence: "high" })).toEqual({
      recipe: "ramp_over_steps",
      seen: false,
      risers: null,
      riserHeightIn: null,
      confidence: "high",
    });
    expect(norm("ramp_over_steps", { seen: false, risers: 3, riserHeightIn: { low: 7, high: 8 }, confidence: "high" })?.risers).toBeNull();
    expect(normalizeObservation("count", { seen: true, count: 0, confidence: "high" })).toEqual({ recipe: "count", seen: false, count: null, confidence: "high" });
    expect(norm("count", { seen: true, count: 501, confidence: "high" })?.count).toBeNull();
  });

  it("riser heights must be finite, 3–12 in, low ≤ high, at most 3 in apart", () => {
    const h = (riserHeightIn: unknown) =>
      norm("ramp_over_steps", { seen: true, risers: 3, riserHeightIn, confidence: "high" })?.riserHeightIn;
    expect(h({ low: 7, high: 8 })).toEqual({ low: 7, high: 8 });
    expect(h({ low: 8, high: 7 })).toBeNull();
    expect(h({ low: 2, high: 8 })).toBeNull();
    expect(h({ low: 7, high: 13 })).toBeNull();
    expect(h({ low: 5, high: 9 })).toBeNull();
    expect(h({ low: Number.NaN, high: 8 })).toBeNull();
    expect(h("7-8")).toBeNull();
  });
});

describe("suggestFromObservation: the reading's words (exact, 5.5)", () => {
  const obs = (over: Record<string, unknown>) =>
    normalizeObservation("ramp_over_steps", { seen: true, risers: 3, riserHeightIn: null, confidence: "medium", ...over });

  it("read, with a usable height", () => {
    expect(suggestFromObservation("ramp_over_steps", ramp, obs({ riserHeightIn: { low: 7.5, high: 8.5 } }))).toEqual({
      suggested: { steps: 3 },
      heightRangeIn: { low: 7.5, high: 8.5 },
      lowConfidence: false,
      usable: true,
      lines: ["We counted 3 steps up, including the last one onto the porch or landing.", "Each step looks about 7.5–8.5 in tall.", "You can change the count if it's wrong."],
      fewerCheck: "Did you count the step up onto the porch or landing? 2 steps and the porch is 3.",
    });
    // Staff read what the photo showed, without the customer's instruction (review EST-R11).
    expect(suggestFromObservation("ramp_over_steps", ramp, obs({ riserHeightIn: { low: 7.5, high: 8.5 } }), "staff").lines).toEqual([
      "We counted 3 steps up, including the last one onto the porch or landing.",
      "Each step looks about 7.5–8.5 in tall.",
    ]);
  });

  it("one step, no height", () => {
    expect(suggestFromObservation("ramp_over_steps", ramp, obs({ risers: 1 })).lines).toEqual([
      "We counted 1 step up, including the last one onto the porch or landing.",
      "You can change the count if it's wrong.",
    ]);
  });

  it("low confidence: never a height to price from, and says so", () => {
    const s = suggestFromObservation("ramp_over_steps", ramp, obs({ confidence: "low", riserHeightIn: { low: 7, high: 8 } }));
    expect(s.heightRangeIn).toBeNull();
    expect(s.lowConfidence).toBe(true);
    expect(s.lines).toEqual([
      "We counted 3 steps up, including the last one onto the porch or landing.",
      "We're not sure about this photo, so please check the count.",
      "You can change the count if it's wrong.",
    ]);
  });

  it("not seen, no count, or more than the form takes", () => {
    expect(suggestFromObservation("ramp_over_steps", ramp, obs({ seen: false })).lines).toEqual([
      "We couldn't count the steps in this photo, so please enter the number.",
    ]);
    expect(suggestFromObservation("ramp_over_steps", ramp, null).usable).toBe(false);
    const tooMany = suggestFromObservation("ramp_over_steps", ramp, obs({ risers: 25 }));
    expect(tooMany).toMatchObject({ usable: false, suggested: {}, lines: ["We counted more than this form takes, so please enter the number yourself."] });
  });

  it("a count reading uses the owner's noun", () => {
    const read = normalizeObservation("count", { seen: true, count: 2, confidence: "high" });
    expect(suggestFromObservation("count", doorways, read).lines).toEqual(["We counted 2 doorways.", "You can change the count if it's wrong."]);
    expect(suggestFromObservation("count", doorways, read).suggested).toEqual({ count: 2 });
    const none = normalizeObservation("count", { seen: false, count: null, confidence: "high" });
    expect(suggestFromObservation("count", doorways, none).lines).toEqual(["We couldn't count the doorways in this photo, so please enter the number."]);
  });
});

describe("corrections and cost", () => {
  it("correctionsFor: one entry per suggested key whose final value differs", () => {
    expect(correctionsFor("ramp_over_steps", { steps: 3 }, { steps: 4, stepHeightIn: null })).toEqual([
      { field: "steps", label: "Steps", from: 3, to: 4 },
    ]);
    expect(correctionsFor("ramp_over_steps", { steps: 3 }, { steps: 3 })).toEqual([]);
    expect(correctionsFor("ramp_over_steps", {}, { steps: 3 })).toEqual([]);
  });

  it("takeoffCostMicros and the per-call ceiling at Haiku 4.5's $1 / $5", () => {
    const rates = TAKEOFF_MODEL_RATES["claude-haiku-4-5"]!;
    expect(takeoffCostMicros({ inputTokens: 4_000, outputTokens: 50 }, rates)).toBe(4_250);
    expect(takeoffCostMicros({ inputTokens: 690, outputTokens: 40 }, rates)).toBe(890); // ≈ a tenth of a cent
    expect(maxTakeoffCallMicros({ rates }, 150)).toBe(2_750);
  });
});
