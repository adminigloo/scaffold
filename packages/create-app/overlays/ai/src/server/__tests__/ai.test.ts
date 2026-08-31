import { describe, expect, it } from "vitest";
import { estimateCostMicros, costMinorUnits } from "__SCOPE__/ai";
import { AI_MAX_TOKENS, AI_MODEL, MODEL_RATES, describeStreamError } from "../ai";

/**
 * The arithmetic and the table, not the provider.
 *
 * Nothing here calls a model. What is worth testing in this file is the pair of
 * facts that go wrong silently: a rate table that has drifted from the model
 * the route actually calls, and a cost that reconciles against the invoice to
 * the wrong number. Both are invisible in production until somebody compares a
 * dashboard with a bill, which is why they are pinned here.
 */
describe("the model rate table", () => {
  it("prices the model the route actually calls", () => {
    // The failure this prevents: somebody upgrades AI_MODEL, the new id is
    // absent from MODEL_RATES, and every ai_usage row afterwards carries a null
    // cost. Nothing breaks, nothing is logged, and the spend chart simply goes
    // flat.
    expect(
      MODEL_RATES[AI_MODEL],
      `AI_MODEL is "${AI_MODEL}" and MODEL_RATES has no row for it, so every ` +
        `usage row would be written with an unknown cost. Add the rate, or ` +
        `point AI_MODEL back at a model that has one.`,
    ).toBeDefined();
  });

  it.each(Object.entries(MODEL_RATES))(
    "%s is priced in whole micros per million tokens",
    (_model, rate) => {
      // `estimateCostMicros` rejects a fractional rate, and it does so at
      // request time, from inside the usage writer, where the throw would be
      // swallowed. Catching it here is the difference between a failing test
      // and a month of rows with no cost on them.
      for (const value of [
        rate.inputMicrosPerMTok,
        rate.outputMicrosPerMTok,
        rate.cachedInputMicrosPerMTok ?? 0,
      ]) {
        expect(Number.isSafeInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    },
  );

  it("prices cache reads below fresh input", () => {
    // Not a law of the universe, but true of every provider so far, and the
    // typo it catches is a cached rate pasted into the wrong field — which
    // over-reports cache-heavy traffic by an order of magnitude.
    for (const rate of Object.values(MODEL_RATES)) {
      const cached = rate.cachedInputMicrosPerMTok;
      if (cached === undefined) continue;
      expect(cached).toBeLessThanOrEqual(rate.inputMicrosPerMTok);
    }
  });

  it("costs one full-length answer at what the comment claims", () => {
    // The number in ai.ts's block comment — AI_MAX_TOKENS times the output rate
    // — is the sentence a reader uses to reason about the worst-case bill. If
    // the rate moves and the prose does not, that sentence becomes a lie about
    // money, so the arithmetic is pinned here rather than left in a comment.
    const rate = MODEL_RATES[AI_MODEL];
    if (!rate) throw new Error("covered by the first test in this block");

    const micros = estimateCostMicros({
      inputTokens: 0,
      outputTokens: AI_MAX_TOKENS,
      rate,
    });
    // Forty cents at $25 per million output tokens.
    expect(costMinorUnits(micros)).toBe(40n);
  });
});

describe("describeStreamError", () => {
  it("is null when there was no error, rather than an empty string", () => {
    // The column is nullable so that "no error" and "an error with no message"
    // stay distinguishable in a query.
    expect(describeStreamError(undefined)).toBeNull();
  });

  it("bounds what a provider can write into the busiest table here", () => {
    const huge = describeStreamError(new Error("x".repeat(10_000)));
    expect(huge).not.toBeNull();
    expect(huge?.length).toBe(2_000);
  });

  it("keeps a non-Error rejection rather than dropping it", () => {
    expect(describeStreamError("socket hang up")).toBe("socket hang up");
  });
});
