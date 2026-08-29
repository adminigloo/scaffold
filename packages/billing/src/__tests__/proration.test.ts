import { describe, expect, it } from "vitest";
import { CurrencyMismatchError, prorateMinor } from "../proration.js";

const DAY = 86_400_000;

/** A clean 30-day period, so halves and sevenths are exact in milliseconds. */
const PERIOD_START = new Date("2026-06-01T00:00:00Z");
const PERIOD_END = new Date("2026-07-01T00:00:00Z");
const HALFWAY = new Date(PERIOD_START.getTime() + 15 * DAY);

const at = (ms: number) => new Date(ms);

describe("prorateMinor — the ordinary cases", () => {
  it("splits an upgrade down the middle", () => {
    expect(
      prorateMinor({
        fromPriceMinor: 1_000n,
        toPriceMinor: 3_000n,
        fromCurrency: "usd",
        toCurrency: "usd",
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        changeAt: HALFWAY,
      }),
    ).toEqual({ creditMinor: 500n, chargeMinor: 1_500n, netMinor: 1_000n });
  });

  it("nets NEGATIVE on a mid-period downgrade", () => {
    // The sign is the whole answer: a positive net here would charge a customer
    // for moving to a cheaper plan, which is the version of this bug that
    // reaches a chargeback rather than a support ticket.
    expect(
      prorateMinor({
        fromPriceMinor: 3_000n,
        toPriceMinor: 1_000n,
        fromCurrency: "usd",
        toCurrency: "usd",
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        changeAt: HALFWAY,
      }),
    ).toEqual({ creditMinor: 1_500n, chargeMinor: 500n, netMinor: -1_000n });
  });

  it("credits the whole old plan for a switch at the very first instant", () => {
    // Switching AT the period start is an ordinary change with the entire
    // period still unused: the old plan is credited in full and the new one is
    // charged in full. This used to take the backdated path and credit
    // nothing, which made the answer jump by a full period's price between
    // periodStart and periodStart + 1ms.
    expect(
      prorateMinor({
        fromPriceMinor: 3_000n,
        toPriceMinor: 1_000n,
        fromCurrency: "usd",
        toCurrency: "usd",
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        changeAt: PERIOD_START,
      }),
    ).toEqual({ creditMinor: 3_000n, chargeMinor: 1_000n, netMinor: -2_000n });
  });

  it("treats a backdated change the same, rather than crediting MORE than a period", () => {
    // Unclamped, `periodEnd - changeAt` exceeds the period length here and the
    // credit runs past the full price of a plan the tenant only ever paid for
    // once.
    expect(
      prorateMinor({
        fromPriceMinor: 3_000n,
        toPriceMinor: 1_000n,
        fromCurrency: "usd",
        toCurrency: "usd",
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        changeAt: at(PERIOD_START.getTime() - 90 * DAY),
      }),
    ).toEqual({ creditMinor: 0n, chargeMinor: 1_000n, netMinor: 1_000n });
  });

  it("charges nothing on the last instant", () => {
    expect(
      prorateMinor({
        fromPriceMinor: 3_000n,
        toPriceMinor: 1_000n,
        fromCurrency: "usd",
        toCurrency: "usd",
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        changeAt: PERIOD_END,
      }),
    ).toEqual({ creditMinor: 0n, chargeMinor: 0n, netMinor: 0n });
  });

  it("charges nothing after the period has ended", () => {
    // Clamped rather than left to go negative: a negative remaining flips the
    // credit into a charge and the charge into a credit, on a stale row nobody
    // is looking at.
    expect(
      prorateMinor({
        fromPriceMinor: 3_000n,
        toPriceMinor: 1_000n,
        fromCurrency: "usd",
        toCurrency: "usd",
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        changeAt: at(PERIOD_END.getTime() + DAY),
      }),
    ).toEqual({ creditMinor: 0n, chargeMinor: 0n, netMinor: 0n });
  });

  it("charges the full new plan when the old one was free", () => {
    expect(
      prorateMinor({
        fromPriceMinor: 0n,
        toPriceMinor: 2_400n,
        fromCurrency: "usd",
        toCurrency: "usd",
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        changeAt: HALFWAY,
      }),
    ).toEqual({ creditMinor: 0n, chargeMinor: 1_200n, netMinor: 1_200n });
  });
});

describe("prorateMinor — degenerate periods", () => {
  it("does not divide by zero on a zero-length period", () => {
    const instant = new Date("2026-06-01T00:00:00Z");
    const result = prorateMinor({
      fromPriceMinor: 3_000n,
      toPriceMinor: 1_000n,
      fromCurrency: "usd",
      toCurrency: "usd",
      periodStart: instant,
      periodEnd: instant,
      changeAt: instant,
    });
    // Zeros, not a full charge: nothing is being sold across zero time, and
    // inventing a charge bills a customer for a period that does not exist.
    expect(result).toEqual({ creditMinor: 0n, chargeMinor: 0n, netMinor: 0n });
  });

  it("refuses a period that ends before it starts instead of inverting the sign", () => {
    expect(
      prorateMinor({
        fromPriceMinor: 3_000n,
        toPriceMinor: 1_000n,
        fromCurrency: "usd",
        toCurrency: "usd",
        periodStart: PERIOD_END,
        periodEnd: PERIOD_START,
        changeAt: HALFWAY,
      }),
    ).toEqual({ creditMinor: 0n, chargeMinor: 0n, netMinor: 0n });
  });

  it("survives an Invalid Date rather than throwing a RangeError about BigInt", () => {
    // Reachable: current_period_start and current_period_end are nullable, and
    // a `once` purchase has no period at all. BigInt(NaN) throws, and the
    // message says nothing about billing.
    const invalid = new Date(Number.NaN);
    for (const input of [
      { periodStart: invalid, periodEnd: PERIOD_END, changeAt: HALFWAY },
      { periodStart: PERIOD_START, periodEnd: invalid, changeAt: HALFWAY },
      { periodStart: PERIOD_START, periodEnd: PERIOD_END, changeAt: invalid },
    ]) {
      expect(
        prorateMinor({
          fromPriceMinor: 3_000n,
          toPriceMinor: 1_000n,
          fromCurrency: "usd",
          toCurrency: "usd",
          ...input,
        }),
      ).toEqual({
        creditMinor: 0n,
        chargeMinor: 0n,
        netMinor: 0n,
      });
    }
  });

  it("prorates a one-second period without losing the half", () => {
    const start = new Date("2026-06-01T00:00:00Z");
    expect(
      prorateMinor({
        fromPriceMinor: 100n,
        toPriceMinor: 200n,
        fromCurrency: "usd",
        toCurrency: "usd",
        periodStart: start,
        periodEnd: at(start.getTime() + 1_000),
        changeAt: at(start.getTime() + 500),
      }),
    ).toEqual({ creditMinor: 50n, chargeMinor: 100n, netMinor: 50n });
  });
});

describe("prorateMinor — rounding", () => {
  it("rounds once at the end, not per day", () => {
    // 1000 over 30 days with 7 days left is 233.33. Rounding a daily rate first
    // gives 33/day and then multiplies its own error by seven: 231. The gap is
    // small, constant, and impossible to find on an invoice.
    const sevenDaysLeft = at(PERIOD_END.getTime() - 7 * DAY);
    expect(
      prorateMinor({
        fromPriceMinor: 1_000n,
        toPriceMinor: 0n,
        fromCurrency: "usd",
        toCurrency: "usd",
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        changeAt: sevenDaysLeft,
      }).creditMinor,
    ).toBe(233n);
  });

  it("rounds a half UP", () => {
    const half = (price: bigint) =>
      prorateMinor({
        fromPriceMinor: price,
        toPriceMinor: 0n,
        fromCurrency: "usd",
        toCurrency: "usd",
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        changeAt: HALFWAY,
      }).creditMinor;

    expect(half(1n)).toBe(1n); // 0.5 -> 1
    expect(half(3n)).toBe(2n); // 1.5 -> 2
    expect(half(5n)).toBe(3n); // 2.5 -> 3
  });

  it("keeps exactness past Number.MAX_SAFE_INTEGER", () => {
    // The reason the whole signature is bigint. As a float, 2^53 + 1 is not
    // even representable, so the half this rounds would never exist.
    expect(
      prorateMinor({
        fromPriceMinor: 9_007_199_254_740_993n,
        toPriceMinor: 0n,
        fromCurrency: "usd",
        toCurrency: "usd",
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        changeAt: HALFWAY,
      }).creditMinor,
    ).toBe(4_503_599_627_370_497n);
  });
});

describe("prorateMinor — invariants across the whole period", () => {
  const everyHour = Array.from({ length: 30 * 24 + 1 }, (_, hour) =>
    at(PERIOD_START.getTime() + hour * 3_600_000),
  );

  const line = (changeAt: Date) =>
    prorateMinor({
      fromPriceMinor: 2_999n,
      toPriceMinor: 9_997n,
      fromCurrency: "usd",
      toCurrency: "usd",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      changeAt,
    });

  it("always shows a total that equals the charge minus the credit", () => {
    // Rounding the net from its own rational would let it disagree with the two
    // lines above it by a cent. An invoice whose numbers do not add up is a
    // support ticket that cannot be answered.
    for (const changeAt of everyHour) {
      const { creditMinor, chargeMinor, netMinor } = line(changeAt);
      expect(netMinor).toBe(chargeMinor - creditMinor);
    }
  });

  it("never credits more than the old plan cost, nor charges more than the new one", () => {
    for (const changeAt of everyHour) {
      const { creditMinor, chargeMinor } = line(changeAt);
      expect(creditMinor >= 0n && creditMinor <= 2_999n).toBe(true);
      expect(chargeMinor >= 0n && chargeMinor <= 9_997n).toBe(true);
    }
  });

  it("never grows as the change moves later — waiting cannot cost more", () => {
    // A non-monotonic rounding rule shows up as a customer who is charged more
    // for changing plans an hour later, which is indefensible in a refund
    // conversation even when the amount is one cent.
    let previous = line(everyHour[1] ?? HALFWAY);
    for (const changeAt of everyHour.slice(2)) {
      const current = line(changeAt);
      expect(current.creditMinor <= previous.creditMinor).toBe(true);
      expect(current.chargeMinor <= previous.chargeMinor).toBe(true);
      previous = current;
    }
  });
});


describe("currency", () => {
  const PERIOD = {
    periodStart: new Date("2026-01-01T00:00:00Z"),
    periodEnd: new Date("2026-01-31T00:00:00Z"),
    changeAt: new Date("2026-01-16T00:00:00Z"),
  };

  it("refuses to prorate across two currencies", () => {
    // netMinor is chargeMinor - creditMinor. Subtracting euros from dollars
    // produces a number that looks entirely plausible and is meaningless.
    expect(() =>
      prorateMinor({
        fromPriceMinor: 1000n,
        toPriceMinor: 2000n,
        fromCurrency: "usd",
        toCurrency: "eur",
        ...PERIOD,
      }),
    ).toThrow(CurrencyMismatchError);
  });

  it("names both currencies so the error is actionable", () => {
    try {
      prorateMinor({
        fromPriceMinor: 1000n,
        toPriceMinor: 2000n,
        fromCurrency: "usd",
        toCurrency: "gbp",
        ...PERIOD,
      });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain("USD");
      expect((err as Error).message).toContain("GBP");
    }
  });

  it("ignores case — usd and USD are one currency", () => {
    expect(() =>
      prorateMinor({
        fromPriceMinor: 1000n,
        toPriceMinor: 2000n,
        fromCurrency: "usd",
        toCurrency: "USD",
        ...PERIOD,
      }),
    ).not.toThrow();
  });
});

describe("the period-start boundary", () => {
  const BASE = {
    fromPriceMinor: 2999n,
    toPriceMinor: 9997n,
    fromCurrency: "usd",
    toCurrency: "usd",
    periodStart: new Date("2026-01-01T00:00:00Z"),
    periodEnd: new Date("2026-01-31T00:00:00Z"),
  };

  it("does not jump a full period's price across one millisecond", () => {
    // changeAt === periodStart used to take the "backdated" path (no credit,
    // full charge) while periodStart + 1ms credited essentially the whole old
    // plan. A discontinuity of a full period across 1ms is a billing bug, not
    // a rounding artefact.
    const atStart = prorateMinor({ ...BASE, changeAt: BASE.periodStart });
    const justAfter = prorateMinor({
      ...BASE,
      changeAt: new Date(BASE.periodStart.getTime() + 1),
    });

    const jump =
      atStart.netMinor > justAfter.netMinor
        ? atStart.netMinor - justAfter.netMinor
        : justAfter.netMinor - atStart.netMinor;

    expect(jump).toBeLessThan(10n);
  });

  it("credits the whole old plan for a switch at the very first instant", () => {
    const result = prorateMinor({ ...BASE, changeAt: BASE.periodStart });
    expect(result.creditMinor).toBe(BASE.fromPriceMinor);
    expect(result.chargeMinor).toBe(BASE.toPriceMinor);
  });

  it("still refuses to credit more than a period for a backdated change", () => {
    const backdated = prorateMinor({
      ...BASE,
      changeAt: new Date("2025-12-01T00:00:00Z"),
    });
    expect(backdated.creditMinor).toBe(0n);
    expect(backdated.chargeMinor).toBe(BASE.toPriceMinor);
  });
});
