import type { TakeoffResult } from "__SCOPE__/estimator";

/**
 * Photo takeoff — read a measurement off a customer's photo — for both the
 * same-origin tool and the cross-origin embed handler, which share this one
 * runner.
 *
 * SHIPPED AS A DEGRADING STUB, on purpose. Photo takeoff calls a vision model,
 * and which model on whose account is the app's decision, not the package's — so
 * it is left unwired and returns `available: false`, which every caller already
 * treats as "fall back to manual entry" (the same contract a missing key
 * honours). Nothing throws; the estimator works fully by hand out of the box.
 *
 * TO TURN IT ON: generate with `--ai`, then implement `runEstimatorTakeoff` the
 * way the dogfood site does — order the work configured? → within a fail-closed
 * per-IP minute AND day budget (@/server/rate-limit + __SCOPE__/observability's
 * RATE_LIMIT_POLICIES)? → call the model with `buildTakeoffPrompt(mode, context)`
 * and an image block, parse with `parseTakeoff`, and record spend on the AI
 * rails whatever the outcome. `@/server/ai` (from --ai) is the model client to
 * use; return `{ available: true, result }` on success.
 */
export interface TakeoffOutcome {
  available: boolean;
  result: TakeoffResult | null;
  rateLimited: boolean;
  headers?: Record<string, string>;
}

export interface RunTakeoffInput {
  tenantId: string;
  measurementMode: string;
  productContext: string;
  imageBase64: string;
  mediaType: string;
  ip: string | null;
}

export async function runEstimatorTakeoff(_input: RunTakeoffInput): Promise<TakeoffOutcome> {
  // Unwired: callers fall back to manual entry. See the file header to turn on
  // real photo takeoff.
  return { available: false, result: null, rateLimited: false };
}
