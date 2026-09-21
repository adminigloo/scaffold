import { describe, expect, it } from "vitest";
import { applyPayment, calculateInvoiceTotals, isOverdue } from "../money.js";

describe("calculateInvoiceTotals", () => {
  it("sums items and applies tax", () => {
    const t = calculateInvoiceTotals({ itemTotals: [50_000, 20_000], taxRateBp: 825 });
    expect(t.subtotal).toBe(70_000);
    expect(t.taxAmount).toBe(5_775); // 70000 × 8.25%
    expect(t.total).toBe(75_775);
  });
  it("applies a discount before tax", () => {
    const t = calculateInvoiceTotals({ itemTotals: [100_000], taxRateBp: 0, discount: 10_000 });
    expect(t.taxableAmount).toBe(90_000);
    expect(t.total).toBe(90_000);
  });
});

describe("applyPayment", () => {
  it("tracks partial then paid, clamping overpayment", () => {
    const partial = applyPayment(0, 100_000, 40_000);
    expect(partial).toEqual({ amountPaid: 40_000, balanceDue: 60_000, status: "partial" });
    const paid = applyPayment(40_000, 100_000, 60_000);
    expect(paid).toEqual({ amountPaid: 100_000, balanceDue: 0, status: "paid" });
    const over = applyPayment(0, 100_000, 120_000);
    expect(over.balanceDue).toBe(0);
    expect(over.status).toBe("paid");
  });
});

describe("isOverdue", () => {
  const past = new Date("2026-01-01T00:00:00Z");
  const now = new Date("2026-02-01T00:00:00Z");
  const future = new Date("2026-03-01T00:00:00Z");
  it("is true only for an issued, unpaid, past-due invoice", () => {
    expect(isOverdue("sent", past, now)).toBe(true);
    expect(isOverdue("sent", future, now)).toBe(false);
    expect(isOverdue("paid", past, now)).toBe(false);
    expect(isOverdue("draft", past, now)).toBe(false);
    expect(isOverdue("void", past, now)).toBe(false);
    expect(isOverdue("sent", null, now)).toBe(false);
  });
});
