import { describe, expect, it } from "vitest";
import {
  calculateInvoiceTotals,
  EstimateNotConvertibleError,
  invoiceInputFromEstimate,
  invoiceLineFromEstimateLine,
} from "../index.js";

const approved = {
  id: "est-1",
  status: "approved",
  estimateNumber: "EST-2026-0004",
  customerName: "Ada",
  customerEmail: "",
  customerPhone: null,
  jobAddress: "1 Main St",
  subtotal: 100_000,
  taxRateBp: 825,
  discount: 5_000,
};

describe("invoiceLineFromEstimateLine", () => {
  it("folds labor into the unit price (the source billed parts only)", () => {
    expect(
      invoiceLineFromEstimateLine({ description: "Door", quantity: 3, unitPrice: 30_000, laborPrice: 20_000, total: 150_000 }),
    ).toEqual({ description: "Door", quantity: 3, unitPrice: 50_000 });
  });

  it("preserves a quoted total that isn't (unit + labor) × qty", () => {
    // A minimum charge lifted the line to 1000.00 for qty 4 → 250.00 each.
    expect(
      invoiceLineFromEstimateLine({ description: "Caulk", quantity: 4, unitPrice: 1_000, laborPrice: 0, total: 100_000 }),
    ).toEqual({ description: "Caulk", quantity: 4, unitPrice: 25_000 });
    // …and when it doesn't divide by the quantity, one unit of the whole total.
    expect(
      invoiceLineFromEstimateLine({ description: "Trim", quantity: 3, unitPrice: 1_000, total: 10_000 }),
    ).toEqual({ description: "Trim (×3)", quantity: 1, unitPrice: 10_000 });
  });
});

describe("invoiceInputFromEstimate", () => {
  it("carries customer, tax rate, discount and the estimate link", () => {
    const input = invoiceInputFromEstimate(approved, [
      { description: "Door", quantity: 2, unitPrice: 30_000, laborPrice: 20_000, total: 100_000 },
    ]);
    expect(input).toMatchObject({
      customerName: "Ada",
      customerEmail: null,
      billingAddress: "1 Main St",
      taxRateBp: 825,
      discount: 5_000,
      estimateId: "est-1",
    });
    // Same money as the quote: (100000 − 5000) × 1.0825.
    const totals = calculateInvoiceTotals({
      itemTotals: input.items.map((i) => i.unitPrice * i.quantity),
      taxRateBp: input.taxRateBp,
      discount: input.discount,
    });
    expect(totals.total).toBe(102_838);
  });

  it("bills a line-less estimate at its pre-tax subtotal", () => {
    const input = invoiceInputFromEstimate(approved, []);
    expect(input.items).toEqual([{ description: "Work per estimate EST-2026-0004", quantity: 1, unitPrice: 100_000 }]);
  });

  it("refuses an estimate that isn't approved, and one already converted", () => {
    for (const status of ["draft", "sent", "viewed", "rejected", "expired", "converted"]) {
      expect(() => invoiceInputFromEstimate({ ...approved, status }, [])).toThrow(EstimateNotConvertibleError);
    }
    // Configurable — but never for an already-converted one.
    expect(() => invoiceInputFromEstimate({ ...approved, status: "sent" }, [], { allowStatuses: ["sent"] })).not.toThrow();
    expect(() =>
      invoiceInputFromEstimate({ ...approved, status: "converted" }, [], { allowStatuses: ["converted"] }),
    ).toThrow(/already been invoiced/);
  });
});
