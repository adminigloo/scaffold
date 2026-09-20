/**
 * Photo-assisted takeoff — turn a picture into the measurement the pricing
 * engine needs. Pure prompt-building and response-parsing only: the package
 * owns WHAT to ask a vision model and how to read its answer, the consuming app
 * owns the model call itself and the metering, exactly as the assistant package
 * keeps the provider at arm's length. That keeps an AI SDK out of this package
 * and lets each app meter and rate-limit the call its own way.
 */

export type MeasurementMode = "area" | "linear" | "unit";

export interface TakeoffResult {
  /** Estimated square feet, when the product is priced by area. */
  sqFt: number | null;
  /** Estimated linear feet, when priced by length (a ramp's run). */
  linearFt: number | null;
  /** Estimated count, when priced per unit. */
  units: number | null;
  confidence: "low" | "medium" | "high";
  /** One plain sentence a customer can read. */
  summary: string;
  /** The assumptions the estimate rests on — shown so a person can correct them. */
  assumptions: string[];
}

/**
 * The system instruction. The model must answer with STRICT JSON and nothing
 * else, must never invent precision it cannot see, and must lower its own
 * confidence when the photo is ambiguous — an honest "low, here's why" beats a
 * confident wrong number a customer then anchors on.
 */
export const TAKEOFF_SYSTEM_PROMPT =
  "You are a careful estimator's assistant. Look at the photo and estimate ONLY the " +
  "measurement asked for, for the described job. Never invent precision you cannot " +
  "see: if the image lacks a scale reference, say so in an assumption and lower your " +
  "confidence. It is far better to return a rough range with low confidence than a " +
  "confident wrong number. Reply with STRICT JSON only — no prose, no code fence.";

/**
 * The per-request instruction, tailored to how the product is measured. For a
 * ramp (linear), it walks the model through the ADA relationship — estimate the
 * total rise, then run_feet ≈ rise_inches at a 1:12 slope — because that is the
 * takeoff a ramp installer actually does from a photo of the steps.
 */
export function buildTakeoffPrompt(mode: MeasurementMode, context?: string): string {
  const job = context ? `The job: ${context}.` : "";
  const shape =
    mode === "linear"
      ? "Estimate the LINEAR FEET needed. If this is a wheelchair ramp over steps or a " +
        "porch, first estimate the total vertical rise in inches, then compute the ramp " +
        "run at the ADA 1:12 slope (run in feet ≈ rise in inches). Put the run in `linearFt`."
      : mode === "area"
        ? "Estimate the AREA in SQUARE FEET of the relevant surface. Put it in `sqFt`."
        : "Estimate the COUNT of items. Put it in `units`.";
  return (
    `${job} ${shape}\n\n` +
    "Return STRICT JSON with exactly these keys:\n" +
    '{"sqFt": number|null, "linearFt": number|null, "units": number|null, ' +
    '"confidence": "low"|"medium"|"high", "summary": string, "assumptions": string[]}\n' +
    "Only the field for the requested measurement should be non-null."
  );
}

/**
 * Parse the model's reply into a TakeoffResult, or null if it isn't usable.
 * Tolerant of a stray code fence or leading prose: it reads the first balanced
 * JSON object it finds. Never throws.
 */
export function parseTakeoff(text: string): TakeoffResult | null {
  const json = extractJsonObject(text);
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

  const confidence =
    o.confidence === "high" || o.confidence === "medium" || o.confidence === "low"
      ? o.confidence
      : "low";

  const sqFt = num(o.sqFt);
  const linearFt = num(o.linearFt);
  const units = num(o.units);
  if (sqFt === null && linearFt === null && units === null) return null;

  return {
    sqFt,
    linearFt,
    units,
    confidence,
    summary: typeof o.summary === "string" ? o.summary.slice(0, 500) : "",
    assumptions: Array.isArray(o.assumptions)
      ? o.assumptions.filter((a): a is string => typeof a === "string").slice(0, 8)
      : [],
  };
}

/** Read the first balanced {...} object from a string, ignoring braces in strings. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
