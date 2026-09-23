import { describe, expect, it } from "vitest";
import {
  invoicePayments,
  invoices,
  PaymentRefusedError,
  PaymentReversalError,
  recordPayment,
  reversePayment,
} from "../index.js";
import { createFakeDb } from "./fake-db.js";

/** A sent $1,000.00 invoice in tenant t1. */
function sentInvoice(over: Record<string, unknown> = {}) {
  const fake = createFakeDb();
  fake.seed(invoices, [
    {
      id: "inv-1",
      tenantId: "t1",
      invoiceNumber: "INV-2026-0001",
      viewToken: "tok",
      status: "sent",
      sentAt: new Date("2026-01-01T00:00:00Z"),
      subtotal: 100_000,
      total: 100_000,
      ...over,
    },
  ]);
  const row = () => fake.rows(invoices)[0]!;
  return { fake, row };
}

const pay = (amount: number, over: Record<string, unknown> = {}) => ({
  tenantId: "t1",
  invoiceId: "inv-1",
  amount,
  method: "card" as const,
  ...over,
});

describe("recordPayment — refusals", () => {
  it("refuses a void invoice and a paid one, writing nothing", async () => {
    for (const status of ["void", "paid"] as const) {
      const { fake, row } = sentInvoice({ status, amountPaid: status === "paid" ? 100_000 : 0 });
      await expect(recordPayment(fake.db, pay(5_000))).rejects.toMatchObject({
        constructor: PaymentRefusedError,
        reason: status,
      });
      expect(fake.rows(invoicePayments)).toHaveLength(0);
      expect(row().status).toBe(status);
    }
  });

  it("refuses a draft unless allowDraft, which then stamps it sent", async () => {
    const { fake, row } = sentInvoice({ status: "draft", sentAt: null });
    await expect(recordPayment(fake.db, pay(5_000))).rejects.toMatchObject({ reason: "draft" });
    const result = await recordPayment(fake.db, pay(5_000), "staff-1", { allowDraft: true });
    expect(result).toMatchObject({ status: "partial", amountPaid: 5_000, duplicate: false });
    expect(row().sentAt).toBeInstanceOf(Date);
  });

  it("is tenant-scoped: another tenant's invoice id answers null", async () => {
    const { fake, row } = sentInvoice();
    expect(await recordPayment(fake.db, pay(5_000, { tenantId: "t2" }))).toBeNull();
    expect(fake.rows(invoicePayments)).toHaveLength(0);
    expect(row().amountPaid).toBe(0);
  });
});

describe("recordPayment — the money", () => {
  it("reports an overpayment instead of clamping it away, and stamps paidAt", async () => {
    const { fake, row } = sentInvoice();
    const result = await recordPayment(fake.db, pay(120_000));
    expect(result).toMatchObject({ status: "paid", amountPaid: 120_000, balanceDue: 0, overpayment: 20_000 });
    expect(row().paidAt).toBeInstanceOf(Date);
  });

  it("recomputes amountPaid from the ledger, not from a stale denormalized figure", async () => {
    // The invoice row says 0 paid, but a $300 payment is on the ledger — the
    // aftermath of a lost update. Incrementing the stale row would say $200.
    const { fake, row } = sentInvoice();
    fake.seed(invoicePayments, [{ invoiceId: "inv-1", amount: 30_000 }]);
    const result = await recordPayment(fake.db, pay(20_000));
    expect(result?.amountPaid).toBe(50_000);
    expect(row().amountPaid).toBe(50_000);
    // The invoice row was read FOR UPDATE, so concurrent payments serialize.
    expect(fake.log.some((l) => l.op === "select" && l.table === "invoices" && l.forUpdate)).toBe(true);
  });

  it("does not lose a payment when two land at once", async () => {
    const { fake, row } = sentInvoice();
    await Promise.all([recordPayment(fake.db, pay(20_000)), recordPayment(fake.db, pay(30_000))]);
    expect(row().amountPaid).toBe(50_000);
    expect(row().status).toBe("partial");
  });

  it("records a retried webhook once (externalRef), even after it settled the invoice", async () => {
    const { fake, row } = sentInvoice();
    const first = await recordPayment(fake.db, pay(100_000, { externalRef: "pi_123" }));
    expect(first).toMatchObject({ status: "paid", duplicate: false });
    const retry = await recordPayment(fake.db, pay(100_000, { externalRef: "pi_123" }));
    // Not PaymentRefusedError("paid") — the processor must hear "already have it".
    expect(retry).toMatchObject({ duplicate: true, paymentId: first!.paymentId, status: "paid", amountPaid: 100_000 });
    expect(fake.rows(invoicePayments)).toHaveLength(1);
    expect(row().amountPaid).toBe(100_000);
  });

  it("backs idempotency with a unique index on (invoice, external_ref)", async () => {
    const fake = createFakeDb();
    await fake.db.insert(invoicePayments).values({ invoiceId: "inv-1", amount: 1, externalRef: "pi_1" });
    await expect(
      fake.db.insert(invoicePayments).values({ invoiceId: "inv-1", amount: 1, externalRef: "pi_1" }),
    ).rejects.toMatchObject({ cause: { code: "23505", constraint: "invoice_payments_external_ref_uidx" } });
    // No ref, or the same ref on a different invoice, is fine.
    await fake.db.insert(invoicePayments).values({ invoiceId: "inv-1", amount: 1 });
    await fake.db.insert(invoicePayments).values({ invoiceId: "inv-1", amount: 1 });
    await fake.db.insert(invoicePayments).values({ invoiceId: "inv-2", amount: 1, externalRef: "pi_1" });
  });
});

describe("reversePayment", () => {
  it("appends a negative reversal row and re-opens a paid invoice", async () => {
    const { fake, row } = sentInvoice();
    const paid = await recordPayment(fake.db, pay(100_000, { reference: "chk 1001" }));
    const reversed = await reversePayment(fake.db, "t1", paid!.paymentId, "Check bounced", "staff-1");
    expect(reversed).toMatchObject({ amountPaid: 0, balanceDue: 100_000, status: "sent", paymentId: paid!.paymentId });
    const ledger = fake.rows(invoicePayments);
    expect(ledger).toHaveLength(2);
    // Append-only: the original row is untouched.
    expect(ledger[0]).toMatchObject({ id: paid!.paymentId, amount: 100_000, reversesPaymentId: null });
    expect(ledger[1]).toMatchObject({
      id: reversed!.reversalId,
      amount: -100_000,
      reversesPaymentId: paid!.paymentId,
      reason: "Check bounced",
      recordedBy: "staff-1",
    });
    expect(row()).toMatchObject({ status: "sent", amountPaid: 0, paidAt: null });
  });

  it("returns to partial when other payments remain, and to viewed if the customer had opened it", async () => {
    const { fake, row } = sentInvoice({ viewedAt: new Date("2026-01-02T00:00:00Z") });
    const a = await recordPayment(fake.db, pay(40_000));
    const b = await recordPayment(fake.db, pay(60_000));
    expect(row().status).toBe("paid");
    expect((await reversePayment(fake.db, "t1", b!.paymentId, "Chargeback"))?.status).toBe("partial");
    expect((await reversePayment(fake.db, "t1", a!.paymentId, "Refunded"))?.status).toBe("viewed");
  });

  it("refuses to reverse twice or to reverse a reversal", async () => {
    const { fake, row } = sentInvoice();
    const p = await recordPayment(fake.db, pay(50_000));
    const r = await reversePayment(fake.db, "t1", p!.paymentId, "Bounced");
    await expect(reversePayment(fake.db, "t1", p!.paymentId, "Again")).rejects.toMatchObject({
      constructor: PaymentReversalError,
      reason: "already_reversed",
    });
    await expect(reversePayment(fake.db, "t1", r!.reversalId, "Undo the undo")).rejects.toMatchObject({
      reason: "is_reversal",
    });
    expect(fake.rows(invoicePayments)).toHaveLength(2);
    expect(row().amountPaid).toBe(0);
  });

  it("backs single reversal with a unique index", async () => {
    const fake = createFakeDb();
    await fake.db.insert(invoicePayments).values({ invoiceId: "i", amount: -1, reversesPaymentId: "p1" });
    await expect(
      fake.db.insert(invoicePayments).values({ invoiceId: "i", amount: -1, reversesPaymentId: "p1" }),
    ).rejects.toMatchObject({ cause: { constraint: "invoice_payments_reverses_uidx" } });
  });

  it("is tenant-scoped, and keeps a (legacy) void invoice void", async () => {
    const { fake, row } = sentInvoice({ status: "void", amountPaid: 10_000 });
    fake.seed(invoicePayments, [{ id: "pay-legacy", invoiceId: "inv-1", amount: 10_000 }]);
    expect(await reversePayment(fake.db, "t2", "pay-legacy", "x")).toBeNull();
    expect(fake.rows(invoicePayments)).toHaveLength(1);
    expect(await reversePayment(fake.db, "t1", "pay-legacy", "Refund on a cancelled job")).toMatchObject({
      status: "void",
      amountPaid: 0,
    });
    expect(row().status).toBe("void");
  });
});
