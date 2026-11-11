import { describe, expect, it } from "vitest";
import { estimateCostMicros, costMinorUnits } from "__SCOPE__/ai";
import { aiCallCostMicros } from "__SCOPE__/ai/server";
import {
  AI_MAX_TOKENS,
  AI_MODEL,
  AI_SITE_DAILY_CENTS,
  MODEL_RATES,
  describeStreamError,
  newSpend,
  spendFromUsage,
} from "../ai";

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
    // A cent at Haiku 4.5's $5 per million output tokens.
    expect(costMinorUnits(micros)).toBe(1n);
  });
});

describe("the cheapest capable model, and a ceiling on the site's day", () => {
  it("calls Claude Haiku 4.5 by default", () => {
    expect(AI_MODEL).toBe("claude-haiku-4-5");
  });

  it("caps the whole site's AI per day", () => {
    expect(Number.isSafeInteger(AI_SITE_DAILY_CENTS)).toBe(true);
    expect(AI_SITE_DAILY_CENTS).toBeGreaterThan(0);
  });

  it("prices cache writes above fresh input (a write the ledger can't see under-reports the bill)", () => {
    for (const rate of Object.values(MODEL_RATES)) {
      expect(rate.cachedWriteMicrosPerMTok ?? 0).toBeGreaterThan(rate.inputMicrosPerMTok);
    }
  });
});

describe("what a route records from the provider", () => {
  it("prices the snapshot the provider reports, not only the alias the route asked for", () => {
    // The request names AI_MODEL, the alias; the response reports the dated
    // snapshot that answered, and that is the id the row records. Unpriced,
    // every row for the default model would carry a null cost.
    const reported = `${AI_MODEL}-20251001`;
    const usage = { inputTokens: 1_000, outputTokens: 100, reported: true } as const;
    expect(aiCallCostMicros(MODEL_RATES, { model: reported, ...usage })).toBe(
      aiCallCostMicros(MODEL_RATES, { model: AI_MODEL, ...usage }),
    );
    expect(aiCallCostMicros(MODEL_RATES, { model: reported, ...usage })).not.toBeNull();
  });

  it("keeps every count the provider bills: cache writes and web searches too", () => {
    const spend = newSpend();
    spendFromUsage(spend, `${AI_MODEL}-20251001`, {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 40,
      server_tool_use: { web_search_requests: 2 },
    });
    expect(spend).toEqual({
      model: `${AI_MODEL}-20251001`,
      inputTokens: 10,
      outputTokens: 20,
      cachedInputTokens: 30,
      cachedWriteTokens: 40,
      feesMicros: 20_000n,
      reported: true,
    });
  });

  it("treats a usage report without cache or search fields as none of either", () => {
    const spend = newSpend();
    spendFromUsage(spend, AI_MODEL, { input_tokens: 5, output_tokens: 6 });
    expect(spend.cachedInputTokens).toBe(0);
    expect(spend.cachedWriteTokens).toBe(0);
    expect(spend.feesMicros).toBe(0n);
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
