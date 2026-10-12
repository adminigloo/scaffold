import { z } from "zod";
import { resolveMeasurement, type Measurement } from "./pricing.js";
import { CONTROL_CHARS, oneLine } from "./text.js";
import type {
  AreaRecipeConfig,
  ChoiceField,
  CountRecipeConfig,
  CustomerField,
  CustomerInputs,
  LinearRecipeConfig,
  NumberField,
  RampRecipeConfig,
  RecipeConfig,
  RecipeInfo,
  RecipeKey,
  StepperField,
} from "./wire.js";

/**
 * Measurement recipes: where every number comes from (section 3 of the 0.3
 * contract). Pure — no I/O.
 *
 * WHY THIS EXISTS. 0.2 asked the customer for the engine's measurement: "length
 * of run (ft)" for a wheelchair ramp. A homeowner knows how many steps go up to
 * the door; almost nobody knows that a 1:12 ramp needs a foot of ramp per inch
 * of rise. And the photo path had the MODEL do that arithmetic, so the number a
 * customer saw came from a language model's sums. The founder's rules:
 *
 *   - A. The AI does no math, ever. It reports what it SEES (counts, a height
 *     range, a confidence); these named functions do every calculation, and
 *     every sentence that explains a number is generated here from the values.
 *   - C. A range comes from the measurement's own uncertainty (a step is 7–8 in
 *     → 21–24 in of rise → priced at 21 ft and at 24 ft), not a flat band.
 *   - E. Customers answer what they know — how many steps, the height of one
 *     step if they measured it — and the code derives what is priced. No text a
 *     customer reads for a ramp says "length of run".
 *
 * A recipe is: a config schema with defaults (the owner's labels, help text and
 * assumptions), a customer-input schema, the field specs the widget renders
 * VERBATIM (the widget never re-derives a number), the formulas, and the
 * sentences. Every derivation produces three quantity sets — low, point, high —
 * which the price build (build.ts) prices separately.
 */

export type { RecipeKey } from "./wire.js";

export const RECIPE_KEYS: readonly RecipeKey[] = Object.freeze(["ramp_over_steps", "area", "linear", "count"]);

// --- Numbers and words ------------------------------------------------------------

/** Snap float noise to six decimals: 22.0000000001 → 22, so a ceil never adds a foot. */
export function snap(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** To 0.01, after the snap (2.675 stays 2.68, not 2.67). */
export function round2(value: number): number {
  return Math.round(snap(value) * 100) / 100;
}

/** `n` rounded to 2 decimals, trailing zeros dropped: 7, 7.5, 7.25, 22.5. */
export function fmt(value: number): string {
  const rounded = round2(value);
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

/** `fmt(a)` when the two read the same, else "a–b" (an en dash, no spaces). */
export function fmtRange(low: number, high: number): string {
  const a = fmt(low);
  const b = fmt(high);
  return a === b ? a : `${a}–${b}`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

// --- The formulas (named, each unit-tested) -------------------------------------------

/** steps × height, to 0.01 in. */
export function riseFromSteps(steps: number, stepHeightIn: number): number {
  return round2(steps * stepHeightIn);
}

/**
 * Feet of ramp for a rise: `riseIn × slopeRatio / 12` (at 1:12, one foot of
 * ramp per inch of rise), rounded UP to a multiple of `roundUpToFt` (0 = no
 * rounding), to 0.01. The snap comes before the ceil — `ceil(snap(x / step)) ×
 * step` — so float noise (22.0000000001) never becomes an extra foot.
 */
export function rampLengthFt(riseIn: number, slopeRatio: number, roundUpToFt: number): number {
  const raw = (riseIn * slopeRatio) / 12;
  if (!(roundUpToFt > 0)) return round2(raw);
  return round2(Math.ceil(snap(raw / roundUpToFt)) * roundUpToFt);
}

/**
 * Resting landings a ramp needs: one run may rise at most `landingEveryRiseIn`
 * (ADA: 30 in), so `max(0, ceil(rise / every) − 1)`: 30 in → 0, 30.25 → 1,
 * 60 → 1, 61 → 2.
 */
export function restingLandings(riseIn: number, landingEveryRiseIn: number): number {
  return Math.max(0, Math.ceil(snap(riseIn / landingEveryRiseIn)) - 1);
}

/** A length in the recipe's unit, in feet (inches ÷ 12). Unrounded. */
export function toFeet(value: number, unit: "ft" | "in"): number {
  return unit === "in" ? value / 12 : value;
}

/** Width × length in square feet, to 0.01. */
export function areaSqFt(width: number, length: number, unit: "ft" | "in"): number {
  return round2(toFeet(width, unit) * toFeet(length, unit));
}

/** The edge of a width × length rectangle in feet, to 0.01. */
export function perimeterFt(width: number, length: number, unit: "ft" | "in"): number {
  return round2(2 * (toFeet(width, unit) + toFeet(length, unit)));
}

// --- Quantity keys -----------------------------------------------------------------------

export type QuantityKind = "length" | "area" | "count";
export type Quantities = Record<string, number>;
export interface QuantityRange {
  low: Quantities;
  point: Quantities;
  high: Quantities;
}

/**
 * What each recipe's derivation produces, for the price build. The primary key
 * (first) is what labor and "per unit of measure" are per; the kind decides
 * waste (cut-off and spare are bought by the foot or square foot, not on a
 * permit or a landing). Every set also carries 0.2's legacy keys `sqFt`,
 * `linearFt` and `units`, so a 0.2 attachment (`per` null) and the lump costs
 * keep pricing as before.
 */
export const RECIPE_QUANTITY_KEYS: Readonly<
  Record<RecipeKey, ReadonlyArray<{ key: string; kind: QuantityKind; label: string }>>
> = Object.freeze({
  ramp_over_steps: [
    { key: "rampFt", kind: "length", label: "ft of ramp" },
    { key: "landings", kind: "count", label: "resting landing" },
  ],
  area: [
    { key: "sqFt", kind: "area", label: "sq ft" },
    { key: "perimeterFt", kind: "length", label: "ft of edge" },
  ],
  linear: [{ key: "linearFt", kind: "length", label: "ft" }],
  count: [{ key: "item", kind: "count", label: "item" }],
});

/** The supply bases a product on this recipe may use: its quantity keys, then `item`, then `job`. */
export function supplyBasesFor(recipe: RecipeKey): string[] {
  const keys = RECIPE_QUANTITY_KEYS[recipe].map((q) => q.key);
  for (const extra of ["item", "job"]) if (!keys.includes(extra)) keys.push(extra);
  return keys;
}

/** Is `per` something a supply on this recipe may be per? (`null` — 0.2's unit-type scaling — always is.) */
export function isValidSupplyBasis(recipe: RecipeKey, per: string | null | undefined): boolean {
  return per === null || per === undefined || supplyBasesFor(recipe).includes(per);
}

/**
 * The `per` an attach call that names none gets (the 0.3 admin always names
 * one; this is for API callers): a per-ft supply goes per the recipe's length
 * (`rampFt`, `perimeterFt`, `linearFt`; `item` for a count), a per-sq-ft one
 * per `sqFt` (area only — null, a refusal, elsewhere), an "each" per item, a
 * flat one once per job.
 */
export function defaultSupplyBasis(recipe: RecipeKey, unitType: string): string | null {
  switch (unitType) {
    case "per_linear_ft":
      return recipe === "ramp_over_steps"
        ? "rampFt"
        : recipe === "area"
          ? "perimeterFt"
          : recipe === "linear"
            ? "linearFt"
            : "item";
    case "per_sqft":
      return recipe === "area" ? "sqFt" : null;
    case "per_unit":
      return "item";
    case "flat":
      return "job";
    default:
      return null;
  }
}

const UNIT_WORDS: Record<string, string> = {
  per_linear_ft: "ft",
  per_sqft: "sq ft",
  per_unit: "each",
  flat: "flat",
};

/** The supplier unit as the admin says it: "ft", "sq ft", "each", "flat". */
export function unitTypeLabel(unitType: string): string {
  return UNIT_WORDS[unitType] ?? unitType;
}

/**
 * The words for a supply's basis: "per ft of ramp", "per resting landing",
 * "per sq ft", "per item" (a count's noun when given: "per doorway"), "once
 * per job". A null basis (a 0.2 attachment) reads by the supply's own unit.
 */
export function supplyBasisLabel(
  recipe: RecipeKey,
  per: string | null,
  options: { config?: RecipeConfig; unitType?: string } = {},
): string {
  if (per === null) {
    const unit = options.unitType ? unitTypeLabel(options.unitType) : "unit";
    return options.unitType === "flat" || options.unitType === "per_unit"
      ? "per item (by the supply's unit)"
      : `per ${unit} (by the supply's unit)`;
  }
  if (per === "job") return "once per job";
  if (per === "item") {
    if (recipe === "count" && options.config) return `per ${(options.config as CountRecipeConfig).noun.one}`;
    return "per item";
  }
  const found = RECIPE_QUANTITY_KEYS[recipe].find((q) => q.key === per);
  return found ? `per ${found.label}` : per;
}

// --- The recipe definitions -------------------------------------------------------------

export interface RecipeDefinition {
  key: RecipeKey;
  /** For the admin: "Steps up to a door (ramp)". */
  label: string;
  /** One admin sentence. */
  description: string;
  primaryKey: string;
  quantityKeys: ReadonlyArray<{ key: string; kind: QuantityKind; label: string }>;
  /**
   * Whether this recipe CAN read a photo: true for `ramp_over_steps` and for
   * `count` — which reads one only when its config names a `photoSubject`
   * (`recipeReadsPhotos`). Areas and lengths never: a size guessed from a
   * photo without a scale isn't a number to price from.
   */
  photoReading: boolean;
}

export const MEASUREMENT_RECIPES: Readonly<Record<RecipeKey, RecipeDefinition>> = Object.freeze({
  ramp_over_steps: {
    key: "ramp_over_steps",
    label: "Steps up to a door (ramp)",
    description:
      "The customer counts the steps up to the door (and can give the height of one); we work out the rise, the feet of ramp at your slope and any resting landings.",
    primaryKey: "rampFt",
    quantityKeys: RECIPE_QUANTITY_KEYS.ramp_over_steps,
    photoReading: true,
  },
  area: {
    key: "area",
    label: "Width × length",
    description: "The customer gives a width and a length, or picks a common size; we price the square feet and the edge.",
    primaryKey: "sqFt",
    quantityKeys: RECIPE_QUANTITY_KEYS.area,
    photoReading: false,
  },
  linear: {
    key: "linear",
    label: "A length",
    description: "The customer gives one length they can measure with a tape; we price it by the foot.",
    primaryKey: "linearFt",
    quantityKeys: RECIPE_QUANTITY_KEYS.linear,
    photoReading: false,
  },
  count: {
    key: "count",
    label: "A count",
    description: "The customer says how many; each one is priced the same.",
    primaryKey: "item",
    quantityKeys: RECIPE_QUANTITY_KEYS.count,
    photoReading: true,
  },
});

/** Does this product's recipe read photos, with this config? (A count only with a `photoSubject`.) */
export function recipeReadsPhotos(recipe: RecipeKey, config: RecipeConfig): boolean {
  if (recipe === "ramp_over_steps") return true;
  if (recipe === "count") return Boolean((config as CountRecipeConfig).photoSubject);
  return false;
}

/** The admin's `RecipeInfo` for a product: the definition plus its supply bases in words. */
export function recipeInfoFor(recipe: RecipeKey, config: RecipeConfig): RecipeInfo {
  const def = MEASUREMENT_RECIPES[recipe];
  return {
    key: recipe,
    label: def.label,
    description: def.description,
    primaryKey: def.primaryKey,
    bases: supplyBasesFor(recipe).map((key) => ({ key, label: supplyBasisLabel(recipe, key, { config }) })),
    photoReading: recipeReadsPhotos(recipe, config),
  };
}

/** The recipe a product prices with: its own, or (a product from before 0.3) the one its `measurementMode` implies. */
export function effectiveRecipe(product: { recipe: string | null; measurementMode: string }): RecipeKey {
  if (product.recipe && (RECIPE_KEYS as readonly string[]).includes(product.recipe)) return product.recipe as RecipeKey;
  if (product.measurementMode === "linear") return "linear";
  if (product.measurementMode === "unit") return "count";
  return "area";
}

/** `measurement_mode` kept in step with the recipe (0.1 widgets and 0.2 hosts still read it). */
export function measurementModeFor(recipe: RecipeKey): "area" | "linear" | "unit" {
  return recipe === "area" ? "area" : recipe === "count" ? "unit" : "linear";
}

// --- Configs: defaults and the write-side schemas ---------------------------------------

export const DEFAULT_RAMP_CONFIG: Readonly<RampRecipeConfig> = Object.freeze({
  stepsLabel: "How many steps go up to the door?",
  // The example is the founder's porch: a homeowner looking at two treads
  // says "2"; the rise onto the deck is the third (review EST-R04).
  stepsHelp: "Count every step up, including the last one onto the porch or landing: 2 steps and the porch is 3.",
  stepHeightLabel: "Height of one step (optional)",
  stepHeightHelp: "Measure from the top of one step to the top of the next.",
  allowTotalRise: true,
  totalRiseLabel: "Or the total height, ground to door threshold (optional)",
  totalRiseHelp: "If you measured the whole height instead, enter it here.",
  // The point price is at the TYPICAL height, so it sits in the middle of the
  // band: at 7 (= the low end) every unmeasured lead and quote was priced at
  // the cheapest end of its own range (review EST-R05).
  stepHeightIn: Object.freeze({ typical: 7.5, low: 7, high: 8 }),
  usePhotoStepHeight: true,
  slopeRatio: 12,
  roundUpToFt: 1,
  landingEveryRiseIn: 30,
  maxSteps: 20,
  photoSubject: "the steps up to the door",
  photoTip: "Stand to the side so every step shows.",
  resultNoun: Object.freeze({ one: "ramp", many: "ramps" }),
}) as RampRecipeConfig;

/** The largest width/length an area or a length may take, by unit. A config may lower it, never raise it. */
export const AREA_MAX = { ft: 1000, in: 12_000 } as const;
export const LINEAR_MAX = { ft: 5000, in: 60_000 } as const;

export function defaultAreaConfig(unit: "ft" | "in" = "ft"): AreaRecipeConfig {
  return {
    unit,
    widthLabel: "Width",
    lengthLabel: "Length",
    help: null,
    presets: [],
    maxWidth: AREA_MAX[unit],
    maxLength: AREA_MAX[unit],
    resultNoun: { one: "area", many: "areas" },
  };
}

export function defaultLinearConfig(unit: "ft" | "in" = "ft"): LinearRecipeConfig {
  return {
    unit,
    lengthLabel: "Length",
    help: null,
    maxLength: LINEAR_MAX[unit],
    resultNoun: { one: "run", many: "runs" },
  };
}

export const DEFAULT_COUNT_CONFIG: Readonly<CountRecipeConfig> = Object.freeze({
  countLabel: "How many?",
  help: null,
  noun: Object.freeze({ one: "item", many: "items" }),
  maxCount: 50,
  photoSubject: null,
  photoTip: null,
}) as CountRecipeConfig;

/** An owner-typed label a customer reads: one line, trimmed, `min`–`max` characters. */
function labelText(max: number, min = 1) {
  return z
    .string()
    .trim()
    .min(min, "Fill this in.")
    .max(max, `Keep it to ${max} characters.`)
    .refine((value) => !CONTROL_CHARS.test(value), "Keep this on one line.");
}
const helpText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? null : value),
    labelText(max).nullable(),
  );
const nounSchema = z.object({ one: labelText(40), many: labelText(40) });
const heightIn = z.number().min(3, "Use 3 to 12 inches.").max(12, "Use 3 to 12 inches.");

const rampFields = {
  stepsLabel: labelText(120),
  stepsHelp: helpText(300),
  stepHeightLabel: labelText(120),
  stepHeightHelp: helpText(300),
  allowTotalRise: z.boolean(),
  totalRiseLabel: labelText(120),
  totalRiseHelp: helpText(300),
  stepHeightIn: z
    .object({ typical: heightIn, low: heightIn, high: heightIn })
    .refine((h) => h.low <= h.typical && h.typical <= h.high, "The low height can't be above the typical one, nor the typical above the high."),
  usePhotoStepHeight: z.boolean(),
  slopeRatio: z.number().int("Use a whole number, like 12.").min(8, "Use a slope from 1:8 to 1:20.").max(20, "Use a slope from 1:8 to 1:20."),
  roundUpToFt: z.number().int("Use a whole number of feet.").min(0).max(10, "Round to at most 10 ft."),
  landingEveryRiseIn: z.number().min(12, "Use 12 to 60 inches.").max(60, "Use 12 to 60 inches."),
  maxSteps: z.number().int().min(1, "Allow at least 1 step.").max(30, "Allow at most 30 steps."),
  photoSubject: labelText(80),
  photoTip: helpText(120),
  resultNoun: nounSchema,
};

const presetSchema = z.object({
  label: labelText(60),
  width: z.number().positive("Use a size above 0."),
  length: z.number().positive("Use a size above 0."),
});

const areaFields = {
  unit: z.enum(["ft", "in"]),
  widthLabel: labelText(120),
  lengthLabel: labelText(120),
  help: helpText(300),
  presets: z.array(presetSchema).max(12, "Up to 12 common sizes."),
  maxWidth: z.number().positive().max(AREA_MAX.in),
  maxLength: z.number().positive().max(AREA_MAX.in),
  resultNoun: nounSchema,
};

const linearFields = {
  unit: z.enum(["ft", "in"]),
  lengthLabel: labelText(120),
  help: helpText(300),
  maxLength: z.number().positive().max(LINEAR_MAX.in),
  resultNoun: nounSchema,
};

const countFields = {
  countLabel: labelText(120),
  help: helpText(300),
  noun: nounSchema,
  maxCount: z.number().int().min(1, "Allow at least 1.").max(500, "Allow at most 500."),
  photoSubject: helpText(80),
  photoTip: helpText(120),
};

const FIELD_SCHEMAS: Record<RecipeKey, Record<string, z.ZodType>> = {
  ramp_over_steps: rampFields,
  area: areaFields,
  linear: linearFields,
  count: countFields,
};

/**
 * The write-side validator: a PARTIAL config, each key checked against its
 * limits (unknown keys dropped). How the keys fit together once merged over
 * the stored config (a maximum above the unit's ceiling, presets beyond the
 * maximum) is `recipeConfigProblem`'s job, because a patch alone can't know.
 */
export function recipeConfigSchema(recipe: RecipeKey): z.ZodType<Partial<RecipeConfig>> {
  return z.object(FIELD_SCHEMAS[recipe]).partial() as unknown as z.ZodType<Partial<RecipeConfig>>;
}

function defaultsFor(recipe: RecipeKey, unit?: "ft" | "in"): RecipeConfig {
  switch (recipe) {
    case "ramp_over_steps":
      return {
        ...DEFAULT_RAMP_CONFIG,
        stepHeightIn: { ...DEFAULT_RAMP_CONFIG.stepHeightIn },
        resultNoun: { ...DEFAULT_RAMP_CONFIG.resultNoun },
      };
    case "area":
      return defaultAreaConfig(unit);
    case "linear":
      return defaultLinearConfig(unit);
    case "count":
      return { ...DEFAULT_COUNT_CONFIG, noun: { ...DEFAULT_COUNT_CONFIG.noun } };
  }
}

/**
 * A recipe's config: its defaults under whatever VALID keys are stored. Never
 * throws — a hand-edited row with a bad key reads that key's default. A
 * pre-0.3 area product (`legacy`) is in inches, 0.2's unit; the maximums
 * follow the unit and are never above its ceiling.
 */
export function resolveRecipeConfig(recipe: RecipeKey, stored: unknown, options: { legacy?: boolean } = {}): RecipeConfig {
  const source = stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  const fields = FIELD_SCHEMAS[recipe];
  let unit: "ft" | "in" | undefined;
  if (recipe === "area" || recipe === "linear") {
    const parsedUnit = z.enum(["ft", "in"]).safeParse(source["unit"]);
    unit = parsedUnit.success ? parsedUnit.data : recipe === "area" && options.legacy ? "in" : "ft";
  }
  const config = defaultsFor(recipe, unit) as unknown as Record<string, unknown>;
  for (const [key, schema] of Object.entries(fields)) {
    if (!(key in source) || key === "unit") continue;
    const parsed = schema.safeParse(source[key]);
    if (parsed.success) config[key] = parsed.data;
  }
  if (recipe === "area" && unit) {
    const ceiling = AREA_MAX[unit];
    config["maxWidth"] = Math.min(config["maxWidth"] as number, ceiling);
    config["maxLength"] = Math.min(config["maxLength"] as number, ceiling);
    config["presets"] = (config["presets"] as AreaRecipeConfig["presets"]).filter(
      (p) => p.width <= (config["maxWidth"] as number) && p.length <= (config["maxLength"] as number),
    );
  }
  if (recipe === "linear" && unit) {
    config["maxLength"] = Math.min(config["maxLength"] as number, LINEAR_MAX[unit]);
  }
  return config as unknown as RecipeConfig;
}

/**
 * A plain sentence when a MERGED config doesn't hang together, else null —
 * the write paths refuse it as `invalid_recipe_config` rather than store
 * something `resolveRecipeConfig` would quietly correct.
 */
export function recipeConfigProblem(recipe: RecipeKey, merged: Record<string, unknown>): string | null {
  if (recipe === "area" || recipe === "linear") {
    const unit = merged["unit"] === "in" ? "in" : "ft";
    const ceilings = recipe === "area" ? AREA_MAX : LINEAR_MAX;
    for (const key of recipe === "area" ? ["maxWidth", "maxLength"] : ["maxLength"]) {
      const value = merged[key];
      if (typeof value === "number" && value > ceilings[unit]) {
        return `The largest ${key === "maxWidth" ? "width" : "length"} in ${unit === "ft" ? "feet" : "inches"} is ${ceilings[unit]}.`;
      }
    }
    if (recipe === "area" && Array.isArray(merged["presets"])) {
      const maxWidth = typeof merged["maxWidth"] === "number" ? merged["maxWidth"] : AREA_MAX[unit];
      const maxLength = typeof merged["maxLength"] === "number" ? merged["maxLength"] : AREA_MAX[unit];
      for (const preset of merged["presets"] as Array<{ label?: string; width?: number; length?: number }>) {
        if ((preset.width ?? 0) > maxWidth || (preset.length ?? 0) > maxLength) {
          return `The common size "${preset.label ?? ""}" is bigger than the largest size customers may enter.`;
        }
      }
    }
  }
  return null;
}

/**
 * The step height a total rise may imply before it is questioned: a total
 * that works out under 4.5 in or over 9 in a step disagrees with the step
 * count (a total typed in feet, or the wrong number of steps). Review EST-R03:
 * "3" meant as 3 ft became a 3 in rise and a 3 ft ramp, thousands under.
 */
export const PLAUSIBLE_STEP_IN = Object.freeze({ low: 4.5, high: 9 });

/** The customer's sentence for the price note: what to do for a tighter estimate. */
export const MEASURE_PROMPT = "Measure one step and enter it for a tighter estimate.";
/** The same, for an email, which has no field to enter it in (review EST-R14). */
export const EMAIL_MEASURE_PROMPT =
  "Reply with the height of one step (from the top of one step to the top of the next) for a tighter price.";

/** An assumption as an email says it: the measure-and-enter prompt becomes "reply with it". */
export function assumptionForEmail(assumption: string): string {
  return assumption.endsWith(MEASURE_PROMPT) ? `${assumption.slice(0, -MEASURE_PROMPT.length)}${EMAIL_MEASURE_PROMPT}` : assumption;
}

// --- What the customer is asked ------------------------------------------------------------

const MIN_STEP = { ft: 0.5, in: 0.25 } as const;

/**
 * The fields the widget renders, in render order — the ONLY description of
 * what a customer is asked. The admin's live preview shows the same list.
 */
export function customerFieldsFor(recipe: RecipeKey, config: RecipeConfig): CustomerField[] {
  switch (recipe) {
    case "ramp_over_steps": {
      const c = config as RampRecipeConfig;
      const fields: CustomerField[] = [
        {
          key: "steps",
          kind: "stepper",
          label: c.stepsLabel,
          help: c.stepsHelp,
          required: true,
          min: 1,
          max: c.maxSteps,
          presentation: "primary",
        } satisfies StepperField,
        {
          key: "stepHeightIn",
          kind: "number",
          label: c.stepHeightLabel,
          help: c.stepHeightHelp,
          required: false,
          min: 3,
          max: 12,
          step: 0.25,
          unit: "in",
          // CONTRACT: the placeholder follows the owner's typical height
          // ("e.g. 7" with the defaults, as the contract writes it).
          placeholder: `e.g. ${fmt(c.stepHeightIn.typical)}`,
          presentation: "primary",
        } satisfies NumberField,
      ];
      if (c.allowTotalRise) {
        fields.push({
          key: "totalRiseIn",
          kind: "number",
          label: c.totalRiseLabel,
          help: c.totalRiseHelp,
          required: false,
          min: 3,
          max: 360,
          step: 0.25,
          unit: "in",
          placeholder: null,
          presentation: "secondary",
        } satisfies NumberField);
      }
      return fields;
    }
    case "area": {
      const c = config as AreaRecipeConfig;
      const fields: CustomerField[] = [];
      if (c.presets.length > 0) {
        fields.push({
          key: "preset",
          kind: "choice",
          // CONTRACT: the contract names no label for the preset chooser.
          label: "Common sizes",
          help: null,
          required: false,
          presentation: "primary",
          choices: c.presets.map((preset, index) => ({
            value: String(index),
            label: preset.label,
            sets: { width: preset.width, length: preset.length },
          })),
        } satisfies ChoiceField);
      }
      const step = MIN_STEP[c.unit];
      fields.push(
        {
          key: "width",
          kind: "number",
          label: c.widthLabel,
          help: c.help,
          required: true,
          min: step,
          max: c.maxWidth,
          step,
          unit: c.unit,
          placeholder: null,
          presentation: "primary",
        } satisfies NumberField,
        {
          key: "length",
          kind: "number",
          label: c.lengthLabel,
          help: null,
          required: true,
          min: step,
          max: c.maxLength,
          step,
          unit: c.unit,
          placeholder: null,
          presentation: "primary",
        } satisfies NumberField,
      );
      return fields;
    }
    case "linear": {
      const c = config as LinearRecipeConfig;
      const step = MIN_STEP[c.unit];
      return [
        {
          key: "length",
          kind: "number",
          label: c.lengthLabel,
          help: c.help,
          required: true,
          min: step,
          max: c.maxLength,
          step,
          unit: c.unit,
          placeholder: null,
          presentation: "primary",
        } satisfies NumberField,
      ];
    }
    case "count": {
      const c = config as CountRecipeConfig;
      return [
        {
          key: "count",
          kind: "stepper",
          label: c.countLabel,
          help: c.help,
          required: true,
          min: 1,
          max: c.maxCount,
          presentation: "primary",
        } satisfies StepperField,
      ];
    }
  }
}

/** The product-level "How many ramps?" (null when the product isn't sold in multiples, and always for a count). */
export function quantityQuestion(
  recipe: RecipeKey,
  config: RecipeConfig,
  product: { allowMultiple: boolean; multipleLabel: string | null; maxQuantity: number },
): { label: string; max: number } | null {
  if (recipe === "count" || !product.allowMultiple) return null;
  const noun = (config as { resultNoun?: { many: string } }).resultNoun?.many ?? "items";
  return { label: product.multipleLabel?.trim() || `How many ${noun}?`, max: product.maxQuantity };
}

// --- Parsing what the customer sent --------------------------------------------------------

type InputIssue = { path: Array<string | number>; message: string };

function inputsError(issues: InputIssue[]): z.ZodError {
  return new z.ZodError(issues.map((issue) => ({ code: "custom" as const, input: undefined, ...issue })) as never);
}

/** A present value: a finite number. Absent: undefined, null or "". Anything else is "bad". */
function readValue(raw: Record<string, unknown>, key: string): number | null | "bad" {
  const value = raw[key];
  if (value === undefined || value === null || value === "") return null;
  return typeof value === "number" && Number.isFinite(value) ? value : "bad";
}

/**
 * The customer's answers, checked. A required answer that is missing is NOT
 * an error — a half-typed form is normal — so it comes back as
 * `{ ok: false, missing }` (the handler's `needs_inputs`). A value that is out
 * of range or not a number throws a ZodError whose issue paths are
 * `["inputs", key]`, so the widget puts the message on the field. Unknown keys
 * are dropped.
 */
export function parseCustomerInputs(
  recipe: RecipeKey,
  config: RecipeConfig,
  raw: unknown,
): { ok: true; inputs: CustomerInputs } | { ok: false; missing: string[] } {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const issues: InputIssue[] = [];
  const values: CustomerInputs = {};

  const take = (key: string, check: (n: number) => boolean, message: string): number | null => {
    const value = readValue(source, key);
    if (value === "bad") {
      issues.push({ path: ["inputs", key], message: "Enter a number." });
      return null;
    }
    if (value !== null && !check(value)) {
      issues.push({ path: ["inputs", key], message });
      return null;
    }
    return value;
  };
  const between = (min: number, max: number) => (n: number) => n >= min && n <= max;
  const wholeBetween = (min: number, max: number) => (n: number) => Number.isInteger(n) && n >= min && n <= max;

  let missing: string[] = [];
  switch (recipe) {
    case "ramp_over_steps": {
      const c = config as RampRecipeConfig;
      values["steps"] = take("steps", wholeBetween(1, c.maxSteps), `Enter a whole number from 1 to ${c.maxSteps}.`);
      values["stepHeightIn"] = take("stepHeightIn", between(3, 12), "Enter a number from 3 to 12.");
      values["totalRiseIn"] = c.allowTotalRise
        ? take("totalRiseIn", between(3, 360), "Enter a number from 3 to 360.")
        : null;
      if (values["steps"] === null && values["totalRiseIn"] === null && readValue(source, "steps") === null) {
        missing = ["steps"];
      }
      // A total AND a step count must agree: the total wins in the
      // derivation, so a total that can't be those steps is questioned on its
      // own field rather than silently pricing a different ramp.
      const steps = values["steps"];
      const total = values["totalRiseIn"];
      if (typeof steps === "number" && typeof total === "number") {
        const each = total / steps;
        if (each < PLAUSIBLE_STEP_IN.low || each > PLAUSIBLE_STEP_IN.high) {
          issues.push({
            path: ["inputs", "totalRiseIn"],
            message: `That's about ${fmt(Math.round(each * 2) / 2)} in a step for ${steps} ${plural(steps, "step", "steps")}. Check the total height: it's in inches, from the ground to the door threshold.`,
          });
        }
      }
      break;
    }
    case "area": {
      const c = config as AreaRecipeConfig;
      const min = MIN_STEP[c.unit];
      values["width"] = take("width", between(min, c.maxWidth), `Enter a number from ${fmt(min)} to ${fmt(c.maxWidth)}.`);
      values["length"] = take("length", between(min, c.maxLength), `Enter a number from ${fmt(min)} to ${fmt(c.maxLength)}.`);
      missing = ["width", "length"].filter((key) => readValue(source, key) === null);
      break;
    }
    case "linear": {
      const c = config as LinearRecipeConfig;
      const min = MIN_STEP[c.unit];
      values["length"] = take("length", between(min, c.maxLength), `Enter a number from ${fmt(min)} to ${fmt(c.maxLength)}.`);
      missing = readValue(source, "length") === null ? ["length"] : [];
      break;
    }
    case "count": {
      const c = config as CountRecipeConfig;
      values["count"] = take("count", wholeBetween(1, c.maxCount), `Enter a whole number from 1 to ${c.maxCount}.`);
      missing = readValue(source, "count") === null ? ["count"] : [];
      break;
    }
  }
  if (issues.length > 0) throw inputsError(issues);
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, inputs: values };
}

/**
 * A 0.1.x widget (and a 0.2 host) sends `measurement` instead of `inputs`.
 * This maps it, where it can be: an area's width × height in inches, a
 * length in feet, a count's line quantity. A ramp can't be (0.2 sent the run
 * the customer worked out, which is exactly the number 0.3 no longer asks
 * for), so it answers null → `needs_inputs`. A public `sqFt`, `units` or stray
 * key is ignored, as in 0.2.
 */
export function legacyInputs(
  recipe: RecipeKey,
  config: RecipeConfig,
  measurement: Measurement | null | undefined,
  quantity: number,
): { inputs: CustomerInputs; quantity: number } | null {
  const m = measurement ?? {};
  switch (recipe) {
    case "area": {
      const c = config as AreaRecipeConfig;
      const { widthIn, heightIn } = m;
      if (typeof widthIn !== "number" || typeof heightIn !== "number" || !(widthIn > 0) || !(heightIn > 0)) return null;
      return c.unit === "in"
        ? { inputs: { width: widthIn, length: heightIn }, quantity }
        : { inputs: { width: widthIn / 12, length: heightIn / 12 }, quantity };
    }
    case "linear": {
      const c = config as LinearRecipeConfig;
      if (typeof m.linearFt !== "number" || !(m.linearFt > 0)) return null;
      return { inputs: { length: c.unit === "in" ? m.linearFt * 12 : m.linearFt }, quantity };
    }
    case "count":
      return { inputs: { count: quantity }, quantity: 1 };
    case "ramp_over_steps":
      return null;
  }
}

// --- Deriving the priced quantities ---------------------------------------------------------

/** What the model said, after `normalizeObservation` (takeoff.ts). Declared here so recipes stay import-free of it. */
export type NormalizedObservation =
  | {
      recipe: "ramp_over_steps";
      seen: boolean;
      risers: number | null;
      riserHeightIn: { low: number; high: number } | null;
      confidence: "low" | "medium" | "high";
    }
  | { recipe: "count"; seen: boolean; count: number | null; confidence: "low" | "medium" | "high" };

/**
 * The height range a reading may price with: a ramp reading that saw the
 * steps, judged their height, and is at least medium confidence. A low-
 * confidence guess is shown to the customer as a prompt to check, never priced.
 */
export function usableHeightRange(reading: NormalizedObservation | null | undefined): { low: number; high: number } | null {
  if (!reading || reading.recipe !== "ramp_over_steps" || !reading.seen) return null;
  if (reading.confidence === "low" || !reading.riserHeightIn) return null;
  return { low: reading.riserHeightIn.low, high: reading.riserHeightIn.high };
}

export interface LineDerivation {
  recipe: RecipeKey;
  quantities: QuantityRange;
  /** low === high for every key. */
  exact: boolean;
  basis: "measured" | "total" | "photo" | "assumed" | "exact";
  /** The sentences, in order. */
  explanation: string[];
  assumption: string | null;
  resultPhrase: string | null;
  /** Why the range is wide; [] when exact. */
  reasons: string[];
  /**
   * What the POINT price is priced at, in one line, for a quote's line
   * details and the staff's send warning: "3 steps, 7.5 in each (estimated),
   * 23 ft of ramp" (review EST-R05: the quote said only "3 steps", so the
   * business couldn't point to the assumption when the crew measured). Null
   * where the inputs say it all (a width × length, a length, a count).
   */
  quoteBasis: string | null;
}

/**
 * The step heights a photo reading may price with, inside the owner's own
 * band (review EST-R10): a height judged from a photo with no scale is a
 * guess, so it can narrow the owner's range, never move the price outside it.
 *
 *   - `use`: the overlap of the reading's range and the owner's low–high.
 *   - `outside`: the reading is entirely outside the owner's band — the
 *     owner's band is priced, and the customer is told what the photo showed.
 *   - null: no usable reading, or the owner switched photo heights off.
 */
export function photoHeightFor(
  reading: NormalizedObservation | null | undefined,
  config: Pick<RampRecipeConfig, "stepHeightIn" | "usePhotoStepHeight">,
): { kind: "use"; low: number; high: number } | { kind: "outside"; low: number; high: number } | null {
  if (!config.usePhotoStepHeight) return null;
  const photo = usableHeightRange(reading);
  if (!photo) return null;
  const low = Math.max(photo.low, config.stepHeightIn.low);
  const high = Math.min(photo.high, config.stepHeightIn.high);
  if (low > high) return { kind: "outside", low: photo.low, high: photo.high };
  return { kind: "use", low, high };
}

function sameSets(range: QuantityRange): boolean {
  const keys = new Set([...Object.keys(range.low), ...Object.keys(range.high)]);
  for (const key of keys) if (snap(range.low[key] ?? 0) !== snap(range.high[key] ?? 0)) return false;
  return true;
}

function quantityLine(quantity: number, many: string): string[] {
  return quantity > 1 ? [`× ${quantity} ${many}`] : [];
}

function deriveRamp(
  config: RampRecipeConfig,
  inputs: CustomerInputs,
  reading: NormalizedObservation | null,
  quantity: number,
): LineDerivation {
  const steps = inputs["steps"] ?? null;
  const total = config.allowTotalRise ? (inputs["totalRiseIn"] ?? null) : null;
  const height = inputs["stepHeightIn"] ?? null;
  let basis: LineDerivation["basis"];
  let rise: [number, number, number];
  let heights: [number, number, number] | null = null;
  let photoOutside: { low: number; high: number } | null = null;

  if (total !== null) {
    basis = "total";
    const r = round2(total);
    rise = [r, r, r];
  } else {
    if (steps === null) throw new Error("deriveQuantities: a ramp needs steps or a total rise (parse the inputs first)");
    if (height !== null) {
      basis = "measured";
      const r = riseFromSteps(steps, height);
      rise = [r, r, r];
      heights = [height, height, height];
    } else {
      const photo = photoHeightFor(reading, config);
      if (photo && photo.kind === "use") {
        basis = "photo";
        heights = [photo.low, Math.round(((photo.low + photo.high) / 2) * 4) / 4, photo.high];
      } else {
        basis = "assumed";
        if (photo && photo.kind === "outside") photoOutside = { low: photo.low, high: photo.high };
        heights = [config.stepHeightIn.low, config.stepHeightIn.typical, config.stepHeightIn.high];
      }
      rise = [riseFromSteps(steps, heights[0]), riseFromSteps(steps, heights[1]), riseFromSteps(steps, heights[2])];
    }
  }

  const ft = rise.map((r) => rampLengthFt(r, config.slopeRatio, config.roundUpToFt)) as [number, number, number];
  const raw = rise.map((r) => round2((r * config.slopeRatio) / 12));
  // The note is about the range shown (the low and high ends), not the point between them.
  const rounded = ft[0] !== raw[0] || ft[2] !== raw[2];
  const landings = rise.map((r) => restingLandings(r, config.landingEveryRiseIn)) as [number, number, number];
  const set = (i: 0 | 1 | 2): Quantities => ({
    rampFt: ft[i],
    landings: landings[i],
    sqFt: 0,
    linearFt: ft[i],
    units: 1,
  });
  const quantities: QuantityRange = { low: set(0), point: set(1), high: set(2) };

  const stepWord = (n: number) => `${n} ${plural(n, "step", "steps")}`;
  const explanation: string[] = [];
  if (basis === "total") {
    explanation.push(`${fmt(rise[0])} in total rise (measured)`);
  } else if (basis === "measured") {
    explanation.push(`${stepWord(steps as number)} × ${fmt(height as number)} in = ${fmt(rise[0])} in rise`);
  } else {
    const h = heights as [number, number, number];
    const source = basis === "photo" ? "from your photo" : "estimated";
    explanation.push(
      `${stepWord(steps as number)} × ${fmtRange(h[0], h[2])} in each (${source}) = ${fmtRange(rise[0], rise[2])} in rise`,
    );
  }
  const slope =
    config.slopeRatio === 12
      ? "ADA 1:12 slope (1 ft of ramp per inch of rise)"
      : `1:${config.slopeRatio} slope`;
  const roundNote = rounded
    ? config.roundUpToFt === 1
      ? " (rounded up to whole feet)"
      : ` (rounded up to ${fmt(config.roundUpToFt)}-ft sections)`
    : "";
  explanation.push(`${slope} → ${fmtRange(ft[0], ft[2])} ft of ramp${roundNote}`);
  if (landings[2] > 0) {
    // CONTRACT: "landing"/"landings" follows the number as the worked examples
    // write it: "1 resting landing", but "0–1 resting landings".
    const one = landings[0] === 1 && landings[2] === 1;
    explanation.push(
      `${fmtRange(landings[0], landings[2])} resting ${one ? "landing" : "landings"}: ramps need one for every ${fmt(config.landingEveryRiseIn)} in of rise`,
    );
  }
  explanation.push(...quantityLine(quantity, config.resultNoun.many));

  const h = heights;
  const looked = photoOutside ? ` (your photo's steps looked ${fmtRange(photoOutside.low, photoOutside.high)} in)` : "";
  const assumption =
    basis === "assumed" && h
      ? `Based on an estimated step height of ${fmtRange(h[0], h[2])} in${looked}. ${MEASURE_PROMPT}`
      : basis === "photo" && h
        ? `Based on a step height of about ${fmtRange(h[0], h[2])} in, from your photo. ${MEASURE_PROMPT}`
        : null;
  const landingText = landings[1] > 0 ? `, ${landings[1]} resting ${plural(landings[1], "landing", "landings")}` : "";
  const quoteBasis =
    basis === "total"
      ? `${fmt(rise[1])} in total rise, ${fmt(ft[1])} ft of ramp${landingText}`
      : basis === "measured"
        ? `${stepWord(steps as number)}, ${fmt(height as number)} in each, ${fmt(ft[1])} ft of ramp${landingText}`
        : h
          ? `${stepWord(steps as number)}, ${fmt(h[1])} in each (${basis === "photo" ? "from the photo" : "estimated"}), ${fmt(ft[1])} ft of ramp${landingText}`
          : null;
  const resultPhrase =
    fmt(ft[0]) === fmt(ft[2])
      ? `That's about a ${fmt(ft[0])}-ft ${config.resultNoun.one}.`
      : `That's about a ${fmtRange(ft[0], ft[2])} ft ${config.resultNoun.one}.`;

  const exact = sameSets(quantities);
  const reasons: string[] = [];
  if (!exact) {
    if (h && fmt(h[0]) !== fmt(h[2])) {
      reasons.push(
        basis === "photo"
          ? `Step height ${fmtRange(h[0], h[2])} in (from the photo)`
          : `Step height ${fmtRange(h[0], h[2])} in (estimated)`,
      );
    }
    if (landings[0] !== landings[2]) {
      reasons.push(`A resting landing may be needed (over ${fmt(config.landingEveryRiseIn)} in of rise)`);
    }
  }
  return { recipe: "ramp_over_steps", quantities, exact, basis, explanation, assumption, resultPhrase, reasons, quoteBasis };
}

function exactRange(set: Quantities): QuantityRange {
  return { low: { ...set }, point: { ...set }, high: { ...set } };
}

/**
 * The three quantity sets a line is priced at, and the sentences that explain
 * them. Pass PARSED inputs (`parseCustomerInputs`). For a ramp with neither a
 * typed height nor a total, a medium/high-confidence photo reading's height
 * range is used (basis "photo"), else the owner's assumed step height
 * ("assumed"). `quantity` only adds the "× 2 ramps" line; the build multiplies.
 */
export function deriveQuantities(
  recipe: RecipeKey,
  config: RecipeConfig,
  inputs: CustomerInputs,
  options: { reading?: NormalizedObservation | null; quantity?: number } = {},
): LineDerivation {
  const quantity = Math.max(1, Math.trunc(options.quantity ?? 1));
  switch (recipe) {
    case "ramp_over_steps":
      return deriveRamp(config as RampRecipeConfig, inputs, options.reading ?? null, quantity);
    case "area": {
      const c = config as AreaRecipeConfig;
      const width = inputs["width"];
      const length = inputs["length"];
      if (typeof width !== "number" || typeof length !== "number") {
        throw new Error("deriveQuantities: an area needs a width and a length (parse the inputs first)");
      }
      const sqFt = areaSqFt(width, length, c.unit);
      const edge = perimeterFt(width, length, c.unit);
      return {
        recipe,
        quantities: exactRange({ sqFt, perimeterFt: edge, linearFt: edge, units: 1 }),
        exact: true,
        basis: "exact",
        explanation: [`${fmt(width)} ${c.unit} × ${fmt(length)} ${c.unit} = ${fmt(sqFt)} sq ft`, ...quantityLine(quantity, c.resultNoun.many)],
        assumption: null,
        resultPhrase: `That's ${fmt(sqFt)} sq ft.`,
        reasons: [],
        quoteBasis: null,
      };
    }
    case "linear": {
      const c = config as LinearRecipeConfig;
      const length = inputs["length"];
      if (typeof length !== "number") throw new Error("deriveQuantities: a length is needed (parse the inputs first)");
      const linearFt = round2(toFeet(length, c.unit));
      return {
        recipe,
        quantities: exactRange({ linearFt, sqFt: 0, units: 1 }),
        exact: true,
        basis: "exact",
        explanation: [
          `${fmt(length)} ${c.unit}${c.unit === "in" ? ` = ${fmt(linearFt)} ft` : ""}`,
          ...quantityLine(quantity, c.resultNoun.many),
        ],
        assumption: null,
        resultPhrase: null,
        reasons: [],
        quoteBasis: null,
      };
    }
    case "count": {
      const c = config as CountRecipeConfig;
      const count = inputs["count"];
      if (typeof count !== "number") throw new Error("deriveQuantities: a count is needed (parse the inputs first)");
      return {
        recipe,
        quantities: exactRange({ item: 1, sqFt: 0, linearFt: 0, units: 1 }),
        exact: true,
        basis: "exact",
        explanation: [`${count} ${plural(count, c.noun.one, c.noun.many)}`],
        assumption: null,
        resultPhrase: null,
        reasons: [],
        quoteBasis: null,
      };
    }
  }
}

/**
 * A STAFF line that carries a full 0.2 measurement and no inputs is priced the
 * 0.2 way: `resolveMeasurement` gives the legacy keys, every recipe key is 0,
 * and there is nothing to explain.
 */
export function legacyDerivation(recipe: RecipeKey, measurement: Measurement): LineDerivation {
  const r = resolveMeasurement(measurement);
  const set: Quantities = { sqFt: r.sqFt, linearFt: r.linearFt, units: r.units };
  for (const q of RECIPE_QUANTITY_KEYS[recipe]) if (!(q.key in set)) set[q.key] = 0;
  return {
    recipe,
    quantities: exactRange(set),
    exact: true,
    basis: "exact",
    explanation: [],
    assumption: null,
    resultPhrase: null,
    reasons: [],
    quoteBasis: null,
  };
}

/** One plain line for lists and quotes: "4 steps, 7.25 in each" / "3 steps" / "36 in total rise" / "12 ft × 20 ft" / "120 ft" / "3 doorways". */
export function inputsSummary(recipe: RecipeKey, config: RecipeConfig, inputs: CustomerInputs): string {
  switch (recipe) {
    case "ramp_over_steps": {
      const c = config as RampRecipeConfig;
      const total = c.allowTotalRise ? (inputs["totalRiseIn"] ?? null) : null;
      if (total !== null) return `${fmt(total)} in total rise`;
      const steps = inputs["steps"] ?? 0;
      const height = inputs["stepHeightIn"] ?? null;
      const stepText = `${steps} ${plural(steps, "step", "steps")}`;
      return height !== null ? `${stepText}, ${fmt(height)} in each` : stepText;
    }
    case "area": {
      const c = config as AreaRecipeConfig;
      return `${fmt(inputs["width"] ?? 0)} ${c.unit} × ${fmt(inputs["length"] ?? 0)} ${c.unit}`;
    }
    case "linear": {
      const c = config as LinearRecipeConfig;
      return `${fmt(inputs["length"] ?? 0)} ${c.unit}`;
    }
    case "count": {
      const c = config as CountRecipeConfig;
      const count = inputs["count"] ?? 0;
      return `${count} ${plural(count, c.noun.one, c.noun.many)}`;
    }
  }
}

/**
 * An everyday answer for a product, for the price book's list ("3 steps:
 * $6,924"), so an owner sees at a glance what each product prices at — and a
 * product that prices at $0 stands out (review EST-R14 / EST-R01). The first
 * common size for an area, else 10 × 10 ft; 20 ft of a length; one of a count.
 */
export function exampleInputsFor(recipe: RecipeKey, config: RecipeConfig): CustomerInputs {
  switch (recipe) {
    case "ramp_over_steps":
      return { steps: 3 };
    case "area": {
      const c = config as AreaRecipeConfig;
      const preset = c.presets[0];
      if (preset) return { width: preset.width, length: preset.length };
      return c.unit === "in" ? { width: 120, length: 120 } : { width: 10, length: 10 };
    }
    case "linear":
      return { length: (config as LinearRecipeConfig).unit === "in" ? 240 : 20 };
    case "count":
      return { count: 1 };
  }
}

/** The field labels a correction or a summary names ("Steps"). */
export function inputLabel(key: string): string {
  const labels: Record<string, string> = {
    steps: "Steps",
    stepHeightIn: "Step height",
    totalRiseIn: "Total height",
    width: "Width",
    length: "Length",
    count: "Count",
  };
  return labels[key] ?? key;
}

/** The subject line the takeoff prompt names: the owner's words, on one line. */
export function photoSubjectFor(recipe: RecipeKey, config: RecipeConfig): string | null {
  if (recipe === "ramp_over_steps") return oneLine((config as RampRecipeConfig).photoSubject);
  if (recipe === "count") {
    const subject = (config as CountRecipeConfig).photoSubject;
    return subject ? oneLine(subject) : null;
  }
  return null;
}
