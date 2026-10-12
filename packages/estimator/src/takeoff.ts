import { z } from "zod";
import {
  fmtRange,
  inputLabel,
  photoSubjectFor,
  usableHeightRange,
  type NormalizedObservation,
} from "./recipes.js";
import type { Confidence, CountRecipeConfig, Correction, CustomerInputs, RampRecipeConfig, RecipeConfig, RecipeKey } from "./wire.js";

/**
 * Photo reading: OBSERVATIONS ONLY, as cheap as possible (section 5 of the 0.3
 * contract). Pure: the prompts, the strict output schema, the normalizer, and
 * the code that turns an observation into a pre-filled form.
 *
 * RULE A — THE AI DOES NO MATH, EVER. 0.2 asked the model for "linear feet" and
 * walked it through "rise in inches → run at 1:12"; the number the customer saw
 * was the model's arithmetic, and it surprised the founder on his own porch.
 * Now the model returns a tiny strict JSON of what it SEES — how many risers,
 * a height range for one, a confidence — and nothing it could do sums on goes
 * into the prompt (no product description, no customer text, no prices).
 * recipes.ts does every calculation; the reading's own words are written here,
 * by code, from the values.
 *
 * RULE B — SPEND AS LITTLE AS POSSIBLE. A few short prompt lines, structured
 * outputs, 150 output tokens at most, no thinking, no tools, Claude Haiku 4.5
 * by default ($1 / $5 per million tokens): about a tenth of a cent a photo.
 * The pipeline (takeoff-run.ts) adds the cache, the budget and the limits.
 *
 * 0.2's `parseTakeoff`, `TakeoffResult` and the measurement prompt are gone;
 * the names `buildTakeoffPrompt` and `TAKEOFF_SYSTEM_PROMPT` are reused with
 * the new meaning.
 */

/** 0.2's measurement modes, still the `measurementMode` a product carries. */
export type MeasurementMode = "area" | "linear" | "unit";

export const TAKEOFF_SYSTEM_PROMPT =
  "You look at one photo for a contractor and report only what you can see. " +
  "Count and describe; never calculate totals, lengths, areas or prices. " +
  "If you can't see something clearly, say so with low confidence.";

/** Recipes that read photos at all. */
export type ReadingRecipe = "ramp_over_steps" | "count";

/**
 * The whole per-photo request text (exact; the eval runs these). `{subject}`
 * is the owner's `photoSubject`, on one line. Nothing a customer typed.
 */
export function buildTakeoffPrompt(recipe: ReadingRecipe, config: RecipeConfig): string {
  const subject = photoSubjectFor(recipe, config) ?? "the photo";
  if (recipe === "ramp_over_steps") {
    return [
      `Photo of: ${subject}.`,
      "Count the risers: each vertical rise from the ground up to the door or porch floor, including the last one onto the porch or deck.",
      "Give the height of one riser in inches as a low and high value, or null if you can't judge it.",
      "Set seen to false if no steps are visible.",
    ].join("\n");
  }
  const many = (config as CountRecipeConfig).noun.many;
  return [`Photo of: ${subject}.`, `Count the ${many} you can see.`, "Set seen to false if there are none."].join("\n");
}

/**
 * The JSON schema sent as the structured output: every object
 * `additionalProperties: false`, every property required, nullable values as
 * `anyOf [..., null]`, and NO numeric limits (the API doesn't take them; the
 * server checks them in `normalizeObservation`).
 */
export function observationJsonSchema(recipe: ReadingRecipe): Record<string, unknown> {
  const confidence = { type: "string", enum: ["low", "medium", "high"] };
  if (recipe === "ramp_over_steps") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["seen", "risers", "riserHeightIn", "confidence"],
      properties: {
        seen: { type: "boolean" },
        risers: { anyOf: [{ type: "integer" }, { type: "null" }] },
        riserHeightIn: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["low", "high"],
              properties: { low: { type: "number" }, high: { type: "number" } },
            },
            { type: "null" },
          ],
        },
        confidence,
      },
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["seen", "count", "confidence"],
    properties: {
      seen: { type: "boolean" },
      count: { anyOf: [{ type: "integer" }, { type: "null" }] },
      confidence,
    },
  };
}

const looseObject = z.record(z.string(), z.unknown());

function confidenceOf(value: unknown): Confidence {
  return value === "low" || value === "medium" || value === "high" ? value : "low";
}

function wholeIn(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

/**
 * The model's output, checked and cut down to what the code may use — the
 * only form an observation is ever stored in (never the model's text). Never
 * throws; null = unusable (not an object, or `seen` not a boolean).
 *
 *   - `confidence` outside the enum reads "low".
 *   - `risers` must be a whole 1–30 and `count` a whole 1–500; otherwise null.
 *     A count of 0, or `seen: false`, reads `seen: false` with no count.
 *   - `riserHeightIn` must be finite, low ≤ high, both 3–12 in, at most 3 in
 *     apart; otherwise null (and always null when not seen).
 *   - Unknown keys are dropped.
 */
export function normalizeObservation(recipe: ReadingRecipe, raw: unknown): NormalizedObservation | null {
  const parsed = looseObject.safeParse(raw);
  if (!parsed.success) return null;
  const o = parsed.data;
  if (typeof o["seen"] !== "boolean") return null;
  const confidence = confidenceOf(o["confidence"]);
  if (recipe === "ramp_over_steps") {
    const seen = (o["seen"] as boolean) && o["risers"] !== 0;
    const risers = seen ? wholeIn(o["risers"], 1, 30) : null;
    let riserHeightIn: { low: number; high: number } | null = null;
    const h = o["riserHeightIn"];
    if (seen && h && typeof h === "object" && !Array.isArray(h)) {
      const low = (h as Record<string, unknown>)["low"];
      const high = (h as Record<string, unknown>)["high"];
      if (
        typeof low === "number" &&
        typeof high === "number" &&
        Number.isFinite(low) &&
        Number.isFinite(high) &&
        low <= high &&
        low >= 3 &&
        high <= 12 &&
        high - low <= 3
      ) {
        riserHeightIn = { low, high };
      }
    }
    return { recipe, seen, risers, riserHeightIn, confidence };
  }
  const seen = (o["seen"] as boolean) && o["count"] !== 0;
  return { recipe: "count", seen, count: seen ? wholeIn(o["count"], 1, 500) : null, confidence };
}

export interface TakeoffSuggestion {
  /** What to pre-fill: `{ steps: 3 }` / `{ count: 4 }`. */
  suggested: CustomerInputs;
  /** Usable for the price only at medium/high confidence. */
  heightRangeIn: { low: number; high: number } | null;
  lowConfidence: boolean;
  /** A count was read and fits the field (≤ maxSteps / maxCount). */
  usable: boolean;
  /** The reading in plain words, shown beside the photo. */
  lines: string[];
  /**
   * Shown when the customer LOWERS the count the photo filled in: the
   * miscount a homeowner makes is two treads and forgetting the rise onto
   * the porch (review EST-R04). Null where there is nothing to check.
   */
  fewerCheck: string | null;
}

/**
 * An observation → the form: what to pre-fill and the reading's words
 * (exact, 5.5). The customer sees the count in the SAME stepper they can
 * change; the price follows whatever they leave there.
 *
 * WHO READS IT. The customer's lines end with what they can do ("You can
 * change the count if it's wrong."); staff read the same reading beside the
 * customer's final answer, where an instruction to the customer is noise
 * (review EST-R11), so `audience: "staff"` leaves those sentences out. No
 * sentence gives a direction ("below"): on a phone the stepper the count went
 * into is ABOVE the photo (review EST-R07).
 */
export function suggestFromObservation(
  recipe: ReadingRecipe,
  config: RecipeConfig,
  observation: NormalizedObservation | null,
  audience: "customer" | "staff" = "customer",
): TakeoffSuggestion {
  const customer = audience === "customer";
  const lowConfidence = !observation || observation.confidence === "low";
  const notSure = customer ? "We're not sure about this photo, so please check the count." : "Not sure about this photo.";
  const change = "You can change the count if it's wrong.";
  const tooMany = customer
    ? "We counted more than this form takes, so please enter the number yourself."
    : "Counted more than the form takes.";
  const tail = (lines: string[]) => (customer ? [...lines, change] : lines);
  if (recipe === "ramp_over_steps") {
    const c = config as RampRecipeConfig;
    const obs = observation && observation.recipe === "ramp_over_steps" ? observation : null;
    const heightRangeIn = usableHeightRange(obs);
    if (!obs || !obs.seen || obs.risers === null) {
      return {
        suggested: {},
        heightRangeIn: null,
        lowConfidence,
        usable: false,
        lines: [customer ? "We couldn't count the steps in this photo, so please enter the number." : "Couldn't count the steps in this photo."],
        fewerCheck: null,
      };
    }
    if (obs.risers > c.maxSteps) {
      return { suggested: {}, heightRangeIn, lowConfidence, usable: false, lines: [tooMany], fewerCheck: null };
    }
    // Says WHAT it counted: the risers, the last one onto the porch included,
    // so "3" isn't read as "the AI saw a step that isn't there".
    const lines = [
      `We counted ${obs.risers} ${obs.risers === 1 ? "step" : "steps"} up, including the last one onto the porch or landing.`,
    ];
    if (heightRangeIn) lines.push(`Each step looks about ${fmtRange(heightRangeIn.low, heightRangeIn.high)} in tall.`);
    if (lowConfidence) lines.push(notSure);
    return {
      suggested: { steps: obs.risers },
      heightRangeIn,
      lowConfidence,
      usable: true,
      lines: tail(lines),
      fewerCheck: "Did you count the step up onto the porch or landing? 2 steps and the porch is 3.",
    };
  }
  const c = config as CountRecipeConfig;
  const obs = observation && observation.recipe === "count" ? observation : null;
  if (!obs || !obs.seen || obs.count === null) {
    return {
      suggested: {},
      heightRangeIn: null,
      lowConfidence,
      usable: false,
      lines: [customer ? `We couldn't count the ${c.noun.many} in this photo, so please enter the number.` : `Couldn't count the ${c.noun.many} in this photo.`],
      fewerCheck: null,
    };
  }
  if (obs.count > c.maxCount) return { suggested: {}, heightRangeIn: null, lowConfidence, usable: false, lines: [tooMany], fewerCheck: null };
  const lines = [`We counted ${obs.count} ${obs.count === 1 ? c.noun.one : c.noun.many}.`];
  if (lowConfidence) lines.push(notSure);
  return { suggested: { count: obs.count }, heightRangeIn: null, lowConfidence, usable: true, lines: tail(lines), fewerCheck: null };
}

/**
 * Where the customer's final answer differs from what the reading suggested:
 * one entry per suggested key (`{ field: "steps", label: "Steps", from: 3,
 * to: 4 }`). Saved on the line, and shown to staff as "The customer changed:
 * steps 3 → 4".
 */
export function correctionsFor(_recipe: RecipeKey, suggested: CustomerInputs, finalInputs: CustomerInputs): Correction[] {
  const out: Correction[] = [];
  for (const [field, from] of Object.entries(suggested)) {
    if (typeof from !== "number") continue;
    const to = finalInputs[field] ?? null;
    if (to !== from) out.push({ field, label: inputLabel(field), from, to });
  }
  return out;
}

// --- The model seam and what it costs ---------------------------------------------------

/** Provider prices: micro-dollars (millionths of a US dollar) per million tokens. */
export interface TakeoffRates {
  inputMicrosPerMTok: number;
  outputMicrosPerMTok: number;
}

/** The founder's choice: the cheapest capable model. Configurable per install. */
export const DEFAULT_TAKEOFF_MODEL = "claude-haiku-4-5";

export const TAKEOFF_MODEL_RATES: Readonly<Record<string, TakeoffRates>> = Object.freeze({
  "claude-haiku-4-5": { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 5_000_000 },
});

export interface TakeoffModelRequest {
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  image: { base64: string; mediaType: "image/jpeg" | "image/png" | "image/webp" };
  maxTokens: number;
}

export interface TakeoffModelResponse {
  /** The parsed JSON object; null on a refusal, on max_tokens, or on text that isn't JSON. */
  output: unknown;
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
}

/**
 * What reads a photo. `@adminigloo/estimator/anthropic` builds one on Claude;
 * the tests inject a fake. `read` may throw (network, timeout, 5xx) — the
 * pipeline records the failure and answers "enter it by hand".
 */
export interface TakeoffModel {
  /** The exact model id called; recorded on every ledger row. */
  model: string;
  rates: TakeoffRates;
  read(request: TakeoffModelRequest): Promise<TakeoffModelResponse>;
}

/** round((input × inputRate + output × outputRate) / 1 000 000), in micro-dollars. */
export function takeoffCostMicros(usage: { inputTokens: number; outputTokens: number }, rates: TakeoffRates): number {
  return Math.round((usage.inputTokens * rates.inputMicrosPerMTok + usage.outputTokens * rates.outputMicrosPerMTok) / 1_000_000);
}

/**
 * The input tokens assumed for the most one call can cost: a 1024-px photo
 * (the largest the server accepts), the prompt and the schema, rounded up.
 */
export const MAX_TAKEOFF_INPUT_TOKENS = 2_000;

/**
 * The most one call can cost, for the budget check and for a call that failed
 * before usage came back: `MAX_TAKEOFF_INPUT_TOKENS` of input plus `maxTokens`
 * of output, at the model's rates.
 */
export function maxTakeoffCallMicros(model: Pick<TakeoffModel, "rates">, maxTokens: number): number {
  return takeoffCostMicros({ inputTokens: MAX_TAKEOFF_INPUT_TOKENS, outputTokens: maxTokens }, model.rates);
}

/** One reading's spend, for the host's usage recorder (create-app writes it to `ai_usage`). */
export interface TakeoffUsage {
  tenantId: string;
  takeoffId: string;
  operation: "estimator_takeoff";
  model: string;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  costEstimated: boolean;
  outcome: "read" | "unreadable" | "errored";
  durationMs: number;
}
