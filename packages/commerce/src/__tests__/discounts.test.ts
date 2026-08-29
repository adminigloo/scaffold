import { describe, expect, it } from "vitest";
import {
  computeDiscountMinor,
  discountState,
  normaliseDiscountCode,
} from "../discounts.js";
import type { DiscountCodeState } from "../discounts.js";

const NOW = new Date("2026-08-28T12:00:00Z");
const PAST = new Date("2026-08-01T00:00:00Z");
const FUTURE = new Date("2026-09-30T00:00:00Z");

function code(overrides: Partial<DiscountCodeState> = {}): DiscountCodeState {
  return {
    kind: "percent",
    value: 10,
    isActive: true,
    startsAt: null,
    endsAt: null,
    maxRedemptions: null,
    timesRedeemed: 0,
    minSubtotalMinor: 0n,
    ...overrides,
  };
}

const RICH = { now: NOW, subtotalMinor: 100_000n } as const;

describe("discountState — the single-condition cases", () => {
  it("a live code with nothing set is valid", () => {
    expect(discountState(code(), RICH)).toBe("valid");
  });

  it("switched off", () => {
    expect(discountState(code({ isActive: false }), RICH)).toBe("inactive");
  });

  it("redemption cap reached", () => {
    expect(
      discountState(code({ maxRedemptions: 100, timesRedeemed: 100 }), RICH),
    ).toBe("exhausted");
  });

  it("window has not opened", () => {
    expect(discountState(code({ startsAt: FUTURE }), RICH)).toBe("not-started");
  });

  it("window has closed", () => {
    expect(discountState(code({ endsAt: PAST }), RICH)).toBe("expired");
  });

  it("cart is too small", () => {
    expect(
      discountState(code({ minSubtotalMinor: 5_000n }), {
        now: NOW,
        subtotalMinor: 4_999n,
      }),
    ).toBe("below-minimum");
  });
});

// ---------------------------------------------------------------------------
// Precedence, pairwise. inactive > exhausted > not-started > expired >
// below-minimum. Every ordering below is a support ticket that does not get
// written.
// ---------------------------------------------------------------------------

describe("discountState — precedence", () => {
  it("inactive beats exhausted", () => {
    // The merchant switched it off. "Exhausted" invites support to raise the
    // cap on a code that was pulled deliberately.
    expect(
      discountState(
        code({ isActive: false, maxRedemptions: 1, timesRedeemed: 9 }),
        RICH,
      ),
    ).toBe("inactive");
  });

  it("inactive beats not-started", () => {
    expect(
      discountState(code({ isActive: false, startsAt: FUTURE }), RICH),
    ).toBe("inactive");
  });

  it("inactive beats expired", () => {
    expect(discountState(code({ isActive: false, endsAt: PAST }), RICH)).toBe(
      "inactive",
    );
  });

  it("inactive beats below-minimum", () => {
    expect(
      discountState(code({ isActive: false, minSubtotalMinor: 10_000n }), {
        now: NOW,
        subtotalMinor: 1n,
      }),
    ).toBe("inactive");
  });

  it("exhausted beats not-started", () => {
    // times_redeemed only goes up, so exhaustion is permanent; a start date is
    // one admin edit from being wrong. Report the unrecoverable condition.
    expect(
      discountState(
        code({ maxRedemptions: 5, timesRedeemed: 5, startsAt: FUTURE }),
        RICH,
      ),
    ).toBe("exhausted");
  });

  it("exhausted beats expired", () => {
    // Reporting "expired" sends support to push out ends_at, after which the
    // code still fails and the ticket is reopened.
    expect(
      discountState(
        code({ maxRedemptions: 5, timesRedeemed: 5, endsAt: PAST }),
        RICH,
      ),
    ).toBe("exhausted");
  });

  it("exhausted beats below-minimum", () => {
    expect(
      discountState(
        code({
          maxRedemptions: 5,
          timesRedeemed: 5,
          minSubtotalMinor: 10_000n,
        }),
        { now: NOW, subtotalMinor: 1n },
      ),
    ).toBe("exhausted");
  });

  it("not-started beats expired on a window nothing can fall inside", () => {
    // starts_at in the future AND ends_at in the past: somebody typed a date
    // wrong. "Not started" points at the future date, which is the field that
    // is wrong; "expired" points at a past date and reads as normal.
    expect(
      discountState(code({ startsAt: FUTURE, endsAt: PAST }), RICH),
    ).toBe("not-started");
  });

  it("not-started beats below-minimum", () => {
    expect(
      discountState(code({ startsAt: FUTURE, minSubtotalMinor: 10_000n }), {
        now: NOW,
        subtotalMinor: 1n,
      }),
    ).toBe("not-started");
  });

  it("expired beats below-minimum", () => {
    // THE EXPENSIVE ONE. "Add 20.00 to unlock this code" for a code that
    // expired last week asks the customer to spend more money for nothing.
    expect(
      discountState(code({ endsAt: PAST, minSubtotalMinor: 10_000n }), {
        now: NOW,
        subtotalMinor: 1n,
      }),
    ).toBe("expired");
  });
});

describe("discountState — boundaries", () => {
  it("is live at the instant it starts", () => {
    expect(discountState(code({ startsAt: NOW }), RICH)).toBe("valid");
  });

  it("is not live one millisecond before it starts", () => {
    expect(
      discountState(code({ startsAt: new Date(NOW.getTime() + 1) }), RICH),
    ).toBe("not-started");
  });

  it("is dead at the instant it ends", () => {
    // Closed boundary, matching invitationState in @adminigloo/tenancy. The
    // open form leaves a code valid for the one millisecond it is stamped dead.
    expect(discountState(code({ endsAt: NOW }), RICH)).toBe("expired");
  });

  it("is still live one millisecond before it ends", () => {
    expect(
      discountState(code({ endsAt: new Date(NOW.getTime() + 1) }), RICH),
    ).toBe("valid");
  });

  it("exhausts at the cap, not one redemption past it", () => {
    expect(
      discountState(code({ maxRedemptions: 100, timesRedeemed: 99 }), RICH),
    ).toBe("valid");
    expect(
      discountState(code({ maxRedemptions: 100, timesRedeemed: 100 }), RICH),
    ).toBe("exhausted");
    expect(
      discountState(code({ maxRedemptions: 100, timesRedeemed: 101 }), RICH),
    ).toBe("exhausted");
  });

  it("a null cap is unlimited, not zero", () => {
    // The failure this rules out: treating NULL as 0 and exhausting every
    // uncapped code the moment it is used once.
    expect(
      discountState(code({ maxRedemptions: null, timesRedeemed: 9_999 }), RICH),
    ).toBe("valid");
  });

  it("a cap of zero is exhausted from the start", () => {
    expect(
      discountState(code({ maxRedemptions: 0, timesRedeemed: 0 }), RICH),
    ).toBe("exhausted");
  });

  it("the minimum is inclusive", () => {
    expect(
      discountState(code({ minSubtotalMinor: 5_000n }), {
        now: NOW,
        subtotalMinor: 5_000n,
      }),
    ).toBe("valid");
    expect(
      discountState(code({ minSubtotalMinor: 5_000n }), {
        now: NOW,
        subtotalMinor: 4_999n,
      }),
    ).toBe("below-minimum");
  });

  it("an open-ended window is valid forever in both directions", () => {
    expect(
      discountState(code({ startsAt: null, endsAt: null }), {
        now: new Date("2099-01-01T00:00:00Z"),
        subtotalMinor: 1n,
      }),
    ).toBe("valid");
  });
});

describe("computeDiscountMinor", () => {
  it("percent, rounded half up in minor units", () => {
    expect(computeDiscountMinor({ kind: "percent", value: 50 }, 101n)).toBe(51n);
    expect(computeDiscountMinor({ kind: "percent", value: 33 }, 100n)).toBe(33n);
  });

  it("fixed, in minor units", () => {
    expect(computeDiscountMinor({ kind: "fixed", value: 500 }, 5_000n)).toBe(500n);
  });

  it("never exceeds the subtotal", () => {
    expect(computeDiscountMinor({ kind: "fixed", value: 99_999 }, 3_000n)).toBe(
      3_000n,
    );
  });

  it("agrees with applyDiscount to the cent, by construction", () => {
    for (const value of [0, 1, 7, 33, 50, 99, 100]) {
      for (const subtotal of [1n, 3n, 101n, 9_999n, 123_456n]) {
        const off = computeDiscountMinor({ kind: "percent", value }, subtotal);
        expect(off).toBeGreaterThanOrEqual(0n);
        expect(off).toBeLessThanOrEqual(subtotal);
      }
    }
  });

  it("still prices a code that has since expired", () => {
    // The reconciliation case. An order placed in March against a code that
    // ended in April has to be re-priceable when a refund is issued in June;
    // returning 0 here would refund the undiscounted amount.
    const expired = code({ endsAt: PAST, kind: "fixed", value: 750 });
    expect(discountState(expired, RICH)).toBe("expired");
    expect(computeDiscountMinor(expired, 5_000n)).toBe(750n);
  });

  it("ignores the minimum — that is a state, not a smaller discount", () => {
    const gated = code({ minSubtotalMinor: 10_000n, kind: "fixed", value: 500 });
    expect(discountState(gated, { now: NOW, subtotalMinor: 1_000n })).toBe(
      "below-minimum",
    );
    expect(computeDiscountMinor(gated, 1_000n)).toBe(500n);
  });
});

describe("normaliseDiscountCode", () => {
  it("uppercases, so one code is one row and one counter", () => {
    // The unique index on (tenant_id, code) compares bytes. Two rows means two
    // redemption counters, and a code capped at 100 quietly allows 200.
    expect(normaliseDiscountCode("spring25")).toBe("SPRING25");
  });

  it("strips whitespace, including the space pasted from a PDF", () => {
    expect(normaliseDiscountCode("  spring25 ")).toBe("SPRING25");
    expect(normaliseDiscountCode("SPRING 25")).toBe("SPRING25");
    expect(normaliseDiscountCode("SPRING\t25\n")).toBe("SPRING25");
  });

  it("is idempotent, so re-normalising a stored code is a no-op", () => {
    expect(normaliseDiscountCode(normaliseDiscountCode("spring 25"))).toBe(
      "SPRING25",
    );
  });
});
