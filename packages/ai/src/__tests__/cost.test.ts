import { describe, expect, it } from "vitest";
import { costMinorUnits, estimateCostMicros, InvalidCostInputError } from "../cost.js";

/** $3.00 in, $15.00 out, $0.30 per MTok for cache reads. Shape only. */
const RATE = {
  inputMicrosPerMTok: 3_000_000,
  outputMicrosPerMTok: 15_000_000,
  cachedInputMicrosPerMTok: 300_000,
} as const;

describe("estimateCostMicros", () => {
  it("prices a million tokens at exactly the per-MTok rate", () => {
    expect(
      estimateCostMicros({ inputTokens: 1_000_000, outputTokens: 0, rate: RATE }),
    ).toBe(3_000_000n);
    expect(
      estimateCostMicros({ inputTokens: 0, outputTokens: 1_000_000, rate: RATE }),
    ).toBe(15_000_000n);
  });

  it("sums the three components", () => {
    expect(
      estimateCostMicros({
        inputTokens: 1_000,
        outputTokens: 500,
        cachedInputTokens: 2_000,
        rate: RATE,
      }),
    ).toBe(3_000n + 7_500n + 600n);
  });

  it("costs nothing when nothing was used", () => {
    expect(estimateCostMicros({ inputTokens: 0, outputTokens: 0, rate: RATE })).toBe(0n);
  });

  it("multiplies in bigint, because re-pricing a month overflows a double", () => {
    const monthly = estimateCostMicros({
      inputTokens: 4_000_000_000,
      outputTokens: 900_000_000,
      rate: RATE,
    });
    expect(typeof monthly).toBe("bigint");
    expect(monthly).toBe(12_000_000_000n + 13_500_000_000n);
    // The intermediate, before the single divide: 1.2e16, past the point where
    // a double still represents every integer.
    expect(Number.isSafeInteger(4_000_000_000 * 3_000_000)).toBe(false);
  });
});

describe("estimateCostMicros - the precision this exists for", () => {
  it("beats the naive per-token float on a case that rounds the wrong way", () => {
    // 25 tokens at 0.58 micros each is exactly 14.5 micros, which rounds to 15.
    // The naive path cannot see that: 580_000 / 1e6 is not representable in
    // binary, 25 times it comes to 14.499999999999998, and Math.round gives 14.
    // One micro, on one call, biased the same way on every call, against an
    // invoice the provider computed in integers.
    const rate = { inputMicrosPerMTok: 580_000, outputMicrosPerMTok: 0 } as const;
    const naive = Math.round(25 * (rate.inputMicrosPerMTok / 1e6));

    expect(estimateCostMicros({ inputTokens: 25, outputTokens: 0, rate })).toBe(15n);
    expect(naive).toBe(14);
  });

  it("rounds once at the end, not once per component", () => {
    // Half a micro of input and half a micro of output. Rounding each line
    // gives 1 + 1 = 2; the true total is exactly 1 micro. Per-line rounding is
    // what a `costOf(tokens, rate)` helper called three times produces, and it
    // over-reports every row.
    const rate = { inputMicrosPerMTok: 500_000, outputMicrosPerMTok: 500_000 } as const;
    expect(estimateCostMicros({ inputTokens: 1, outputTokens: 1, rate })).toBe(1n);
  });

  it("rounds half up rather than truncating toward zero", () => {
    // Truncation reports 0 for every sub-micro call, which on a cheap model is
    // most calls, and the table then says a busy tenant cost nothing.
    const half = { inputMicrosPerMTok: 500_000, outputMicrosPerMTok: 0 } as const;
    const under = { inputMicrosPerMTok: 499_999, outputMicrosPerMTok: 0 } as const;
    expect(estimateCostMicros({ inputTokens: 1, outputTokens: 0, rate: half })).toBe(1n);
    expect(estimateCostMicros({ inputTokens: 1, outputTokens: 0, rate: under })).toBe(0n);
  });
});

describe("estimateCostMicros - cached input", () => {
  it("prices cache reads at their own rate when one is given", () => {
    expect(
      estimateCostMicros({
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 1_000_000,
        rate: RATE,
      }),
    ).toBe(300_000n);
  });

  it("falls back to the FULL input rate when no cached rate is configured", () => {
    // Never zero. An app that reports cached tokens without pricing them has
    // not said cache reads are free, it has said nothing, and "unpriced
    // therefore free" under-reports silently - the failure you find at the
    // invoice instead of on the dashboard.
    const rate = { inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 0 } as const;
    expect(
      estimateCostMicros({
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 1_000_000,
        rate,
      }),
    ).toBe(3_000_000n);
  });

  it("honours an explicit zero, which is a decision rather than an omission", () => {
    const rate = {
      inputMicrosPerMTok: 3_000_000,
      outputMicrosPerMTok: 0,
      cachedInputMicrosPerMTok: 0,
    } as const;
    expect(
      estimateCostMicros({
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 1_000_000,
        rate,
      }),
    ).toBe(0n);
  });

  it("treats absent cached tokens as zero, not as an error", () => {
    expect(estimateCostMicros({ inputTokens: 10, outputTokens: 10, rate: RATE })).toBe(
      estimateCostMicros({
        inputTokens: 10,
        outputTokens: 10,
        cachedInputTokens: 0,
        rate: RATE,
      }),
    );
  });
});

describe("estimateCostMicros - rejected inputs", () => {
  it("refuses a per-token rate mistaken for a per-MTok rate", () => {
    // A rate of 3.5 means $0.0000035 per million tokens, six orders of
    // magnitude below the intended $3.50, and every call would be recorded as
    // free. Fractions are refused because they are the float the micros column
    // exists to keep out.
    expect(() =>
      estimateCostMicros({
        inputTokens: 1,
        outputTokens: 0,
        rate: { inputMicrosPerMTok: 3.5, outputMicrosPerMTok: 0 },
      }),
    ).toThrow(InvalidCostInputError);
  });

  it("names the field that was wrong", () => {
    try {
      estimateCostMicros({
        inputTokens: 1,
        outputTokens: 0,
        rate: {
          inputMicrosPerMTok: 0,
          outputMicrosPerMTok: 0,
          cachedInputMicrosPerMTok: 0.5,
        },
      });
      expect.unreachable("a fractional cached rate must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidCostInputError);
      expect((error as InvalidCostInputError).field).toBe(
        "rate.cachedInputMicrosPerMTok",
      );
    }
  });

  it("refuses a negative token count instead of issuing a credit", () => {
    // Providers report an unknown count as -1. Multiplied by a rate that is a
    // negative cost, which subtracts from the tenant's total and makes a broken
    // meter look like a cheap month.
    expect(() =>
      estimateCostMicros({ inputTokens: -1, outputTokens: 0, rate: RATE }),
    ).toThrow(InvalidCostInputError);
    expect(() =>
      estimateCostMicros({ inputTokens: 0, outputTokens: -1, rate: RATE }),
    ).toThrow(InvalidCostInputError);
    expect(() =>
      estimateCostMicros({
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: -1,
        rate: RATE,
      }),
    ).toThrow(InvalidCostInputError);
  });

  it("refuses a fractional token count", () => {
    expect(() =>
      estimateCostMicros({ inputTokens: 1.5, outputTokens: 0, rate: RATE }),
    ).toThrow(InvalidCostInputError);
  });

  it("refuses NaN and Infinity, which the arithmetic would carry silently", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        estimateCostMicros({ inputTokens: bad, outputTokens: 0, rate: RATE }),
      ).toThrow(InvalidCostInputError);
    }
  });

  it("refuses a token count beyond the safe integer range", () => {
    expect(() =>
      estimateCostMicros({
        inputTokens: Number.MAX_SAFE_INTEGER + 2,
        outputTokens: 0,
        rate: RATE,
      }),
    ).toThrow(InvalidCostInputError);
  });
});

describe("costMinorUnits", () => {
  it("converts micros to cents", () => {
    expect(costMinorUnits(10_000n)).toBe(1n);
    expect(costMinorUnits(1_000_000n)).toBe(100n);
  });

  it("rounds half up at the half-cent", () => {
    expect(costMinorUnits(4_999n)).toBe(0n);
    expect(costMinorUnits(5_000n)).toBe(1n);
    expect(costMinorUnits(15_000n)).toBe(2n);
  });

  it("survives a total no 32-bit cents column would", () => {
    expect(costMinorUnits(987_654_321_000_000n)).toBe(98_765_432_100n);
  });

  it("refuses a negative total", () => {
    expect(() => costMinorUnits(-1n)).toThrow(InvalidCostInputError);
  });
});
