import { describe, expect, it } from "vitest";
import {
  InvalidOrderNumberInputError,
  formatOrderNumber,
  verifyOrderNumberCheck,
} from "../order-number.js";

const DAY = new Date("2026-08-28T12:00:00Z");

describe("formatOrderNumber", () => {
  it("produces PREFIX-YYYYMMDD-NNNNNN-CC", () => {
    expect(formatOrderNumber({ prefix: "TC", sequence: 142, date: DAY })).toBe(
      "TC-20260828-000142-61",
    );
  });

  it("pads the check to two digits, so the segment width never varies", () => {
    // 98 - (n mod 97) can land in single digits. An unpadded "8" changes the
    // length of the last segment and every fixed-width parser downstream.
    expect(formatOrderNumber({ prefix: "TC", sequence: 1, date: DAY })).toBe(
      "TC-20260828-000001-08",
    );
  });

  it("is deterministic — the same input always renders the same number", () => {
    const input = { prefix: "TC", sequence: 77, date: DAY } as const;
    expect(formatOrderNumber(input)).toBe(formatOrderNumber(input));
  });

  it("uppercases and trims the prefix", () => {
    expect(formatOrderNumber({ prefix: " tc ", sequence: 1, date: DAY })).toBe(
      "TC-20260828-000001-08",
    );
  });

  it("reads the date in UTC, not the host's local time", () => {
    // A serverless retry runs on whichever region is warm. With getFullYear /
    // getDate, the same order rendered from us-east-1 and from Asia/Tokyo
    // produces two different numbers, one of which is already in the
    // customer's inbox.
    //
    // Both directions are covered: the first date is the previous day in the
    // Americas, the second is the next day in Asia. Whichever timezone the test
    // runner is in, at least one of these fails a local-time implementation.
    expect(
      formatOrderNumber({
        prefix: "TC",
        sequence: 1,
        date: new Date("2026-08-28T00:30:00Z"),
      }),
    ).toContain("-20260828-");
    expect(
      formatOrderNumber({
        prefix: "TC",
        sequence: 1,
        date: new Date("2026-08-28T23:30:00Z"),
      }),
    ).toContain("-20260828-");
  });

  it("sorts lexicographically in the order the sales happened", () => {
    const numbers = [
      formatOrderNumber({ prefix: "TC", sequence: 2, date: DAY }),
      formatOrderNumber({
        prefix: "TC",
        sequence: 1,
        date: new Date("2026-08-29T01:00:00Z"),
      }),
      formatOrderNumber({ prefix: "TC", sequence: 10, date: DAY }),
      formatOrderNumber({ prefix: "TC", sequence: 1, date: DAY }),
    ];

    expect([...numbers].sort()).toEqual([
      "TC-20260828-000001-08",
      "TC-20260828-000002-07",
      "TC-20260828-000010-96",
      "TC-20260829-000001-78",
    ]);
  });

  it("keeps sequence 10 after sequence 2 — the reason for the zero padding", () => {
    // Unpadded, "10" sorts before "2" and the order list is silently wrong.
    const two = formatOrderNumber({ prefix: "TC", sequence: 2, date: DAY });
    const ten = formatOrderNumber({ prefix: "TC", sequence: 10, date: DAY });
    expect(two < ten).toBe(true);
  });

  it("rejects a prefix containing the segment separator", () => {
    // Every parser splits on "-". A prefix with one in it changes the segment
    // count and the check moves to a different index.
    expect(() =>
      formatOrderNumber({ prefix: "TC-EU", sequence: 1, date: DAY }),
    ).toThrow(InvalidOrderNumberInputError);
  });

  it("rejects an empty, spaced or over-long prefix", () => {
    for (const prefix of ["", "   ", "TC EU", "TOOLONGPREFIX"]) {
      expect(() => formatOrderNumber({ prefix, sequence: 1, date: DAY })).toThrow(
        InvalidOrderNumberInputError,
      );
    }
  });

  it("rejects a sequence that is not a positive integer", () => {
    for (const sequence of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        formatOrderNumber({ prefix: "TC", sequence, date: DAY }),
      ).toThrow(InvalidOrderNumberInputError);
    }
  });

  it("grows past the pad rather than truncating the sequence", () => {
    // Truncation would collide with an existing number and hit the
    // (tenant_id, order_number) unique index on a completed sale.
    const number = formatOrderNumber({
      prefix: "TC",
      sequence: 1_234_567,
      date: DAY,
    });
    expect(number).toContain("-1234567-");
    expect(verifyOrderNumberCheck(number)).toBe(true);
  });
});

describe("verifyOrderNumberCheck", () => {
  it("accepts what formatOrderNumber produced", () => {
    for (const sequence of [1, 2, 99, 142, 1_000, 999_999]) {
      expect(
        verifyOrderNumberCheck(
          formatOrderNumber({ prefix: "TC", sequence, date: DAY }),
        ),
      ).toBe(true);
    }
  });

  it("accepts a number typed back in lowercase", () => {
    expect(verifyOrderNumberCheck("tc-20260828-000142-61")).toBe(true);
    expect(verifyOrderNumberCheck("  TC-20260828-000142-61  ")).toBe(true);
  });

  it("catches every single-digit substitution", () => {
    // Without the check, one mistyped digit lands on a DIFFERENT REAL ORDER and
    // support reads a stranger's shipping address back to the caller. mod 97
    // catches all 126 of these because 97 is prime and no single-digit delta
    // times a power of ten is divisible by it.
    const digits = "20260828000142";
    const check = "61";

    for (let index = 0; index < digits.length; index += 1) {
      for (const replacement of "0123456789") {
        if (digits[index] === replacement) continue;
        const mutated =
          digits.slice(0, index) + replacement + digits.slice(index + 1);
        const broken = `TC-${mutated.slice(0, 8)}-${mutated.slice(8)}-${check}`;
        expect(verifyOrderNumberCheck(broken)).toBe(false);
      }
    }
  });

  it("catches a transposition of two adjacent digits", () => {
    // The other half of what mod 97 buys. "000142" read aloud and typed as
    // "000124" is the commonest error a human makes with a number.
    expect(verifyOrderNumberCheck("TC-20260828-000124-61")).toBe(false);
  });

  it("rejects anything that is not shaped like an order number", () => {
    // A caller pasting a UUID gets the same answer as a caller pasting a typo,
    // and both mean "do not run this query".
    for (const value of [
      "",
      "TC-20260828-000142",
      "TC-20260828-000142-6",
      "TC-20260828-000142-611",
      "0198f2a0-0000-7000-8000-000000000000",
      "TC/20260828/000142/61",
    ]) {
      expect(verifyOrderNumberCheck(value)).toBe(false);
    }
  });

  it("is not an authorisation check and does not pretend to be", () => {
    // Unkeyed and public: anyone can compute a valid-looking number for any
    // tenant. A route that loads an order must still check the tenant and the
    // principal; if you need an unguessable handle, use orders.id.
    expect(verifyOrderNumberCheck("ZZ-20260828-000142-61")).toBe(true);
  });
});
