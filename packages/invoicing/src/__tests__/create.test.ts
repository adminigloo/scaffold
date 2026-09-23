import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInvoice,
  InvoiceAlreadyExistsForEstimateError,
  InvoiceDiscountError,
  invoiceItems,
  invoiceInputFromEstimate,
  invoices,
  nextInvoiceNumber,
  uniqueViolationConstraint,
} from "../index.js";
import { createFakeDb } from "./fake-db.js";

const base = {
  tenantId: "t1",
  customerName: "Ada",
  items: [{ description: "Install", quantity: 1, unitPrice: 50_000 }],
};

afterEach(() => {
  vi.useRealTimers();
});

describe("createInvoice — one estimate, one invoice", () => {
  it("refuses a second invoice for the same estimate with a typed error", async () => {
    const fake = createFakeDb();
    await createInvoice(fake.db, { ...base, estimateId: "est-1" });
    // The double-click / two-staff-members case. Before the partial unique
    // index this silently wrote a second invoice and billed the customer twice.
    await expect(createInvoice(fake.db, { ...base, estimateId: "est-1" })).rejects.toBeInstanceOf(
      InvoiceAlreadyExistsForEstimateError,
    );
    expect(fake.rows(invoices)).toHaveLength(1);
    // The failed attempt's lines were rolled back with it.
    expect(fake.rows(invoiceItems)).toHaveLength(1);
  });

  it("scopes the rule per tenant and ignores invoices with no estimate", async () => {
    const fake = createFakeDb();
    await createInvoice(fake.db, { ...base, estimateId: "est-1" });
    await createInvoice(fake.db, { ...base, tenantId: "t2", estimateId: "est-1" });
    await createInvoice(fake.db, base);
    await createInvoice(fake.db, base);
    expect(fake.rows(invoices)).toHaveLength(4);
  });

  it("carries labor, tax and discount so the invoice equals the accepted quote", async () => {
    // Estimator math: line total = (unit + labor) × qty, discount before tax.
    // 2 × (300.00 + 200.00) = 1000.00; −100.00; 8.25% tax → 974.25.
    const estimate = {
      id: "est-9",
      status: "approved",
      subtotal: 100_000,
      taxRateBp: 825,
      discount: 10_000,
      customerName: "Ada",
      jobAddress: "1 Main St",
    };
    const lines = [{ description: "Railing", quantity: 2, unitPrice: 30_000, laborPrice: 20_000, total: 100_000 }];
    const fake = createFakeDb();
    const created = await createInvoice(fake.db, {
      tenantId: "t1",
      ...invoiceInputFromEstimate(estimate, lines),
    });
    expect(created.total).toBe(97_425);
    const [row] = fake.rows(invoices);
    expect(row).toMatchObject({ estimateId: "est-9", taxRateBp: 825, discount: 10_000, billingAddress: "1 Main St" });
  });

  it("bills a line-less estimate's PRE-TAX subtotal, not its tax-inclusive total", async () => {
    // subtotal 500.00 at 8.25% → the quote's total is 541.25. The source's
    // fallback used 541.25 as a pre-tax unit price and re-taxed it (585.90).
    const estimate = { id: "est-2", status: "approved", subtotal: 50_000, taxRateBp: 825, discount: 0 };
    const fake = createFakeDb();
    const created = await createInvoice(fake.db, { tenantId: "t1", ...invoiceInputFromEstimate(estimate, []) });
    expect(created.total).toBe(54_125);
  });
});

describe("createInvoice — discount", () => {
  it("rejects a discount larger than the subtotal and writes nothing", async () => {
    const fake = createFakeDb();
    await expect(createInvoice(fake.db, { ...base, discount: 50_001 })).rejects.toBeInstanceOf(
      InvoiceDiscountError,
    );
    expect(fake.rows(invoices)).toHaveLength(0);
  });

  it("allows a discount equal to the subtotal (a comped job totals zero)", async () => {
    const fake = createFakeDb();
    const created = await createInvoice(fake.db, { ...base, discount: 50_000, taxRateBp: 825 });
    expect(created.total).toBe(0);
  });
});

describe("invoice numbers", () => {
  it("are unique per tenant: a lost race retries onto the next number", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-01T12:00:00Z"));
    const fake = createFakeDb();
    // A concurrent create commits INV-2026-0001 between this call's read and
    // its insert — exactly what two staff clicking "New invoice" at once do.
    let raced = false;
    fake.beforeInsert = (table, row) => {
      if (table === invoices && !raced) {
        raced = true;
        fake.seed(invoices, [{ tenantId: "t1", invoiceNumber: row.invoiceNumber, viewToken: "racer" }]);
      }
    };
    const created = await createInvoice(fake.db, base);
    expect(created.invoiceNumber).toBe("INV-2026-0002");
    const numbers = fake.rows(invoices).map((r) => r.invoiceNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("use the UTC year for both the number and the count", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 00:30 UTC on Jan 1 — still Dec 31 in every US time zone.
    vi.setSystemTime(new Date("2027-01-01T00:30:00Z"));
    const fake = createFakeDb();
    fake.seed(invoices, [
      { tenantId: "t1", invoiceNumber: "INV-2026-0007", viewToken: "a", createdAt: new Date("2026-12-31T23:00:00Z") },
      { tenantId: "t1", invoiceNumber: "INV-2027-0001", viewToken: "b", createdAt: new Date("2027-01-01T00:10:00Z") },
    ]);
    expect(await nextInvoiceNumber(fake.db, "t1")).toBe("INV-2027-0002");
    const created = await createInvoice(fake.db, base);
    expect(created.invoiceNumber).toBe("INV-2027-0002");
    // created_at is stamped from the same clock that chose the year.
    const row = fake.rows(invoices).find((r) => r.invoiceNumber === "INV-2027-0002");
    expect((row?.createdAt as Date).toISOString()).toBe("2027-01-01T00:30:00.000Z");
  });

  it("never re-issue a number already taken under this year's prefix", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2027-03-01T00:00:00Z"));
    const fake = createFakeDb();
    // A row written by the old session-time-zone count: numbered 2027 but
    // created (in UTC) in 2026, so a count of 2027 rows alone says 0.
    fake.seed(invoices, [
      { tenantId: "t1", invoiceNumber: "INV-2027-0001", viewToken: "a", createdAt: new Date("2026-12-31T23:59:59Z") },
    ]);
    expect(await nextInvoiceNumber(fake.db, "t1")).toBe("INV-2027-0002");
  });

  it("count per tenant", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-01T12:00:00Z"));
    const fake = createFakeDb();
    await createInvoice(fake.db, base);
    await createInvoice(fake.db, base);
    const other = await createInvoice(fake.db, { ...base, tenantId: "t2" });
    expect(other.invoiceNumber).toBe("INV-2026-0001");
  });
});

describe("uniqueViolationConstraint", () => {
  it("finds the index through drizzle's DrizzleQueryError wrapper", () => {
    const driver = Object.assign(new Error("dup"), { code: "23505", constraint: "invoices_number_uidx" });
    const wrapped = Object.assign(new Error("Failed query: insert ..."), { cause: driver });
    expect(uniqueViolationConstraint(wrapped)).toBe("invoices_number_uidx");
    expect(uniqueViolationConstraint(new Error("boom"))).toBeNull();
    expect(
      uniqueViolationConstraint({
        code: "23505",
        message: 'duplicate key value violates unique constraint "invoices_estimate_uidx"',
      }),
    ).toBe("invoices_estimate_uidx");
  });
});
