/**
 * What a provider charges, as integers.
 *
 * Rates are supplied by the app and never baked into this package. A price
 * compiled into a library is wrong the week after it ships, and the way you
 * find out is a reconciliation meeting where our number and the invoice differ
 * by a rounding error nobody can attribute. The app owns its rate table, keyed
 * however it likes, and passes the row for the model it actually called.
 *
 * `…MicrosPerMTok` is micros per MILLION tokens, and every field must be a
 * whole number: $3.00 per MTok is `3_000_000`, $0.80 is `800_000`, $0.30 is
 * `300_000`. That unit is chosen so no published price needs a fraction.
 */
export interface TokenRate {
  readonly inputMicrosPerMTok: number;
  readonly outputMicrosPerMTok: number;
  /**
   * Cache reads, which every provider prices below fresh input.
   *
   * Optional, and the fallback is the FULL input rate — never zero. Omitting a
   * cached rate means the app has not told us what cache reads cost, and
   * "unpriced therefore free" turns every cached token into silent
   * under-reporting that only surfaces at the invoice. Over-reporting is
   * visible in the dashboard the same day. Pass an explicit `0` if reads
   * genuinely are free; `??` honours it.
   */
  readonly cachedInputMicrosPerMTok?: number;
}

export interface CostInput {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
  readonly rate: TokenRate;
}

export class InvalidCostInputError extends Error {
  readonly name = "InvalidCostInputError";
  constructor(
    readonly field: string,
    readonly value: number,
  ) {
    super(
      `${field} must be a non-negative safe integer, received ${String(value)}. ` +
        `Rates are micros per MILLION tokens precisely so every input is whole: ` +
        `$3.00 per MTok is 3_000_000, not 3 and not 0.000003. A fraction here is ` +
        `the float this module exists to keep out of the total, and a negative is ` +
        `a provider reporting "unknown" as -1, which must not become a credit.`,
    );
  }
}

/** Micros per million tokens -> micros. One division, at the very end. */
const TOKENS_PER_MTOK = 1_000_000n;

/** A micro is a millionth of a major unit, so a cent is 10_000 of them. */
const MICROS_PER_MINOR_UNIT = 10_000n;

/**
 * What this call cost, in micros.
 *
 * Integer arithmetic the whole way: multiply token counts by per-MTok rates in
 * bigint, sum, then divide ONCE and round half up.
 *
 * The naive version — `tokens * (ratePerMTok / 1e6)` — loses on exactly the
 * volumes that matter. `580_000 / 1e6` is not representable in binary, so 25
 * tokens comes to 14.499999999999998 and rounds to 14 where the true answer is
 * 14.5, which rounds to 15. At a handful of tokens that is a rounding error; at
 * a month of traffic it is a systematic drift, always in the same direction,
 * against a Stripe invoice that did the sum in integers.
 *
 * Rounding once at the end matters just as much as rounding correctly. Costing
 * input, output and cache separately and adding the rounded parts rounds three
 * times: two components of exactly half a micro become 1 + 1 = 2, when the
 * combined total is exactly 1.
 *
 * Returns bigint because `ai_usage.cost_micros` is bigint. A month of traffic
 * summed in micros passes 2^53 long before it is a large bill.
 */
export function estimateCostMicros(input: CostInput): bigint {
  const inputTokens = wholeNonNegative("inputTokens", input.inputTokens);
  const outputTokens = wholeNonNegative("outputTokens", input.outputTokens);
  const cachedInputTokens = wholeNonNegative(
    "cachedInputTokens",
    input.cachedInputTokens ?? 0,
  );

  const inputRate = wholeNonNegative(
    "rate.inputMicrosPerMTok",
    input.rate.inputMicrosPerMTok,
  );
  const outputRate = wholeNonNegative(
    "rate.outputMicrosPerMTok",
    input.rate.outputMicrosPerMTok,
  );
  // Validated only when supplied, so the error names the field the caller
  // actually passed rather than blaming the fallback.
  const cachedRate =
    input.rate.cachedInputMicrosPerMTok === undefined
      ? inputRate
      : wholeNonNegative(
          "rate.cachedInputMicrosPerMTok",
          input.rate.cachedInputMicrosPerMTok,
        );

  const scaled =
    inputTokens * inputRate +
    outputTokens * outputRate +
    cachedInputTokens * cachedRate;

  return divideRoundHalfUp(scaled, TOKENS_PER_MTOK);
}

/**
 * Micros -> minor units (cents), for the one place a cost has to line up with
 * an amount somebody is actually charged.
 *
 * Deliberately a separate call rather than a second return value. Every
 * intermediate stays in micros; the moment you round to cents you have thrown
 * away the precision that lets a thousand sub-cent calls add up to the right
 * number, so this runs once, on a total, at the boundary.
 */
export function costMinorUnits(micros: bigint): bigint {
  if (micros < 0n) {
    throw new InvalidCostInputError("micros", Number(micros));
  }
  return divideRoundHalfUp(micros, MICROS_PER_MINOR_UNIT);
}

function wholeNonNegative(field: string, value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidCostInputError(field, value);
  }
  return BigInt(value);
}

/**
 * Half up, not banker's rounding and not truncation.
 *
 * Every input is non-negative — negatives are rejected above — so bigint
 * division truncating toward zero is the same as flooring, and adding half the
 * divisor first is exactly "round half up". With signed values the sign would
 * have to be handled, which is a second reason not to accept them.
 */
function divideRoundHalfUp(numerator: bigint, divisor: bigint): bigint {
  return (numerator + divisor / 2n) / divisor;
}
