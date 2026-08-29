export class CurrencyMismatchError extends Error {
  readonly name = "CurrencyMismatchError";
  constructor(
    readonly fromCurrency: string,
    readonly toCurrency: string,
  ) {
    super(
      `Cannot prorate between a ${fromCurrency.toUpperCase()} plan and a ` +
        `${toCurrency.toUpperCase()} plan: the credit and the charge are ` +
        `denominated differently, so subtracting them is arithmetic on two ` +
        `different units. Convert to one currency before calling, or refuse ` +
        `the plan change.`,
    );
  }
}

export interface ProrationInput {
  /** Whole-period price of the plan being left, in minor units. */
  readonly fromPriceMinor: bigint;
  /** Whole-period price of the plan being moved to, in minor units. */
  readonly toPriceMinor: bigint;
  /**
   * Currency of the plan being left. Required, because `plans.currency` is
   * per-plan by design — a tenant-level currency misbills by the exchange rate
   * the first time a USD plan and a EUR plan share a catalog. Without this,
   * `netMinor` silently subtracts euros from dollars and the answer looks
   * perfectly plausible.
   */
  readonly fromCurrency: string;
  /** Currency of the plan being moved to. Must equal `fromCurrency`. */
  readonly toCurrency: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly changeAt: Date;
}

export interface Proration {
  /** Unused time on the old plan, handed back. */
  readonly creditMinor: bigint;
  /** Remaining time on the new plan, charged for. */
  readonly chargeMinor: bigint;
  /** `chargeMinor - creditMinor`. Negative means the tenant is owed money. */
  readonly netMinor: bigint;
}

/** Nothing to credit and nothing to charge. */
const NOTHING: Proration = { creditMinor: 0n, chargeMinor: 0n, netMinor: 0n };

/**
 * Money for a plan change part-way through a billing period.
 *
 * Unused time on the old plan is credited; the same slice of the new plan is
 * charged. Integers the whole way down — prices are bigint minor units and the
 * clock is integer milliseconds, so nothing here can drift the way `0.1 + 0.2`
 * does. A float pipeline is fine until the invoice that is off by one cent, and
 * then it is a reconciliation nobody can close, because no single line is
 * wrong.
 *
 * Rounded HALF UP exactly once per line, at the end. Rounding an intermediate
 * rate first is the classic version of this bug: 1000 over 30 days is 33.33 a
 * day, which truncates to 33 and then multiplies its own error by the 7 days
 * remaining — 231 where the answer is 233.
 *
 * `netMinor` is derived by subtraction rather than rounded from its own
 * rational. Rounding it separately lets the total disagree with the two lines
 * above it by a cent, and an invoice whose credit, charge and total do not add
 * up is a support ticket that cannot be answered.
 */
export function prorateMinor(input: ProrationInput): Proration {
  if (input.fromCurrency.toLowerCase() !== input.toCurrency.toLowerCase()) {
    throw new CurrencyMismatchError(input.fromCurrency, input.toCurrency);
  }

  const startMs = input.periodStart.getTime();
  const endMs = input.periodEnd.getTime();
  const changeMs = input.changeAt.getTime();

  // An Invalid Date reads as NaN here, and `BigInt(NaN)` throws a RangeError
  // with nothing in it about billing. It is reachable: `current_period_start`
  // and `current_period_end` are nullable, and a `once` purchase has no period
  // at all. There is no proration without a period, so take the same exit as a
  // zero-length one rather than crashing the request that renders the invoice.
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !Number.isFinite(changeMs)) {
    return NOTHING;
  }

  // A period of no length cannot be divided, and nothing is being sold across
  // zero time — inventing a full charge here bills a customer for a period that
  // does not exist. `periodEnd` before `periodStart` is corrupt data and takes
  // the same exit: refusing to produce a number beats producing a negative one
  // that lands on an invoice.
  if (endMs <= startMs) return NOTHING;

  // At or before the first instant, this is a renewal-time switch rather than a
  // mid-period change: the new plan covers the whole period, and there is no
  // old-plan invoice for a period that has not begun. Crediting
  // `fromPriceMinor` here would hand back money nobody has paid — and a
  // backdated `changeAt`, which is where this branch is actually reached from,
  // would otherwise credit MORE than a full period.
  // Strictly BEFORE the period starts. `changeAt === periodStart` is a real,
  // ordinary switch at renewal time and belongs on the normal path: treating it
  // as backdated returned chargeMinor = toPriceMinor with no credit, while one
  // millisecond later the same change credited essentially the whole old plan.
  // A discontinuity of a full period's price across 1ms is not a rounding
  // artefact, it is a billing bug.
  if (changeMs < startMs) {
    return {
      creditMinor: 0n,
      chargeMinor: input.toPriceMinor,
      netMinor: input.toPriceMinor,
    };
  }

  // At or after the last instant there is nothing left to sell and nothing left
  // to credit: the old plan ran the period out. Clamped rather than allowed to
  // go negative, because a negative remaining flips the credit into a charge
  // and the charge into a credit.
  if (changeMs >= endMs) return NOTHING;

  const totalMs = BigInt(endMs - startMs);
  const remainingMs = BigInt(endMs - changeMs);

  const creditMinor = divideRoundHalfUp(input.fromPriceMinor * remainingMs, totalMs);
  const chargeMinor = divideRoundHalfUp(input.toPriceMinor * remainingMs, totalMs);

  return { creditMinor, chargeMinor, netMinor: chargeMinor - creditMinor };
}

/**
 * `numerator / denominator`, rounded half up. `denominator` must be positive.
 *
 * Half UP specifically, and stated in one place: the point is not which way the
 * half-cent falls, it is that two systems reconciling the same invoice round it
 * the same way. A difference of one cent that nobody can attribute costs more
 * to investigate than every half-cent ever rounded.
 *
 * BigInt division truncates toward ZERO, which rounds a negative dividend the
 * wrong way, so the floor is corrected explicitly. Negative numerators are
 * reachable — a credit-shaped plan price, or an over-refunded line — and this
 * is the kind of error that only ever shows up on refunds, where it is noticed.
 */
function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const twiceDenominator = denominator * 2n;
  const shifted = numerator * 2n + denominator;
  const quotient = shifted / twiceDenominator;
  return shifted % twiceDenominator < 0n ? quotient - 1n : quotient;
}
