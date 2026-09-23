import { describe, expect, it } from "vitest";
import {
  canTransitionInvoice,
  getInvoice,
  getInvoiceByToken,
  InvoiceStatusTransitionError,
  invoiceItems,
  invoicePayments,
  invoices,
  issuedStatusOf,
  markInvoiceViewed,
  nextInvoiceStatuses,
  setInvoiceStatus,
  settledStatus,
} from "../index.js";
import { createFakeDb } from "./fake-db.js";

function withInvoice(over: Record<string, unknown> = {}) {
  const fake = createFakeDb();
  fake.seed(invoices, [
    {
      id: "inv-1",
      tenantId: "t1",
      invoiceNumber: "INV-2026-0001",
      viewToken: "tok-1",
      status: "draft",
      customerName: "Ada",
      customerEmail: "ada@example.com",
      customerPhone: "555-0100",
      billingAddress: "1 Main St",
      subtotal: 100_000,
      total: 100_000,
      estimateId: "est-1",
      createdBy: "staff-1",
      notes: "internal: slow payer",
      ...over,
    },
  ]);
  fake.seed(invoiceItems, [
    { invoiceId: "inv-1", description: "Install", quantity: 1, unitPrice: 100_000, total: 100_000 },
    { invoiceId: "inv-1", description: "Removed", unitPrice: 5, total: 5, removedAt: new Date() },
  ]);
  const row = () => fake.rows(invoices)[0]!;
  return { fake, row };
}

describe("setInvoiceStatus — the transition table", () => {
  it("walks draft → sent → viewed → void, stamping sentAt and viewedAt once", async () => {
    const { fake, row } = withInvoice();
    expect(await setInvoiceStatus(fake.db, { tenantId: "t1", id: "inv-1", status: "sent" })).toBe(true);
    const sentAt = row().sentAt as Date;
    expect(sentAt).toBeInstanceOf(Date);
    expect(await setInvoiceStatus(fake.db, { tenantId: "t1", id: "inv-1", status: "viewed" })).toBe(true);
    expect(row().viewedAt).toBeInstanceOf(Date);
    expect(row().sentAt).toBe(sentAt);
    expect(await setInvoiceStatus(fake.db, { tenantId: "t1", id: "inv-1", status: "void" })).toBe(true);
    expect(row().status).toBe("void");
  });

  it("refuses moves the table forbids and leaves the row alone", async () => {
    const forbidden: Array<[string, "draft" | "sent" | "viewed" | "void"]> = [
      ["sent", "draft"],
      ["viewed", "sent"],
      ["partial", "void"], // money on it: reverse payments first
      ["partial", "sent"],
      ["paid", "draft"], // the source let staff un-pay a paid invoice
      ["paid", "void"],
      ["void", "sent"], // void is terminal
      ["void", "draft"],
      ["draft", "viewed"],
    ];
    for (const [from, to] of forbidden) {
      const { fake, row } = withInvoice({ status: from });
      await expect(setInvoiceStatus(fake.db, { tenantId: "t1", id: "inv-1", status: to })).rejects.toBeInstanceOf(
        InvoiceStatusTransitionError,
      );
      expect(row().status).toBe(from);
    }
  });

  it("treats re-asserting the current status as a no-op", async () => {
    const { fake, row } = withInvoice({ status: "void" });
    expect(await setInvoiceStatus(fake.db, { tenantId: "t1", id: "inv-1", status: "void" })).toBe(true);
    expect(row().status).toBe("void");
  });

  it("is tenant-scoped: another tenant's id answers false and nothing moves", async () => {
    const { fake, row } = withInvoice({ status: "sent" });
    expect(await setInvoiceStatus(fake.db, { tenantId: "t2", id: "inv-1", status: "void" })).toBe(false);
    expect(row().status).toBe("sent");
  });

  it("exposes the table for a UI to offer only legal moves", () => {
    expect(nextInvoiceStatuses("draft")).toEqual(["sent", "void"]);
    expect(nextInvoiceStatuses("paid")).toEqual([]);
    expect(canTransitionInvoice("sent", "void")).toBe(true);
    expect(canTransitionInvoice("paid", "void")).toBe(false);
  });
});

describe("status derived from money", () => {
  it("settles to paid/partial/issued and remembers where it was issued", () => {
    expect(settledStatus({ total: 100, amountPaid: 100, issued: "sent" })).toBe("paid");
    expect(settledStatus({ total: 100, amountPaid: 150, issued: "sent" })).toBe("paid");
    expect(settledStatus({ total: 100, amountPaid: 1, issued: "viewed" })).toBe("partial");
    expect(settledStatus({ total: 100, amountPaid: 0, issued: "viewed" })).toBe("viewed");
    // A $0 invoice nobody paid is not "paid".
    expect(settledStatus({ total: 0, amountPaid: 0, issued: "sent" })).toBe("sent");
    expect(issuedStatusOf({ status: "paid", viewedAt: new Date() })).toBe("viewed");
    expect(issuedStatusOf({ status: "partial", viewedAt: null })).toBe("sent");
    expect(issuedStatusOf({ status: "draft" })).toBe("draft");
  });
});

describe("getInvoice — tenant scope", () => {
  it("answers null for another tenant's id (the IDOR) and loads live lines only", async () => {
    const { fake } = withInvoice();
    expect(await getInvoice(fake.db, "t2", "inv-1")).toBeNull();
    const detail = await getInvoice(fake.db, "t1", "inv-1");
    expect(detail?.items.map((i) => i.description)).toEqual(["Install"]);
  });

  it("fails loudly on the old (db, id) arity instead of matching nothing forever", async () => {
    const { fake } = withInvoice();
    const legacy = getInvoice as unknown as (db: unknown, id: string) => Promise<unknown>;
    await expect(legacy(fake.db, "inv-1")).rejects.toBeInstanceOf(TypeError);
  });
});

describe("getInvoiceByToken — the customer's link", () => {
  it("answers null for a draft (staff may still be pricing it)", async () => {
    const { fake } = withInvoice({ status: "draft" });
    expect(await getInvoiceByToken(fake.db, "tok-1")).toBeNull();
  });

  it("returns a public projection: no internal ids, contact details, notes or payment references", async () => {
    const { fake } = withInvoice({ status: "partial", amountPaid: 40_000, sentAt: new Date("2026-02-01T00:00:00Z") });
    fake.seed(invoicePayments, [
      { invoiceId: "inv-1", amount: 40_000, method: "check", reference: "chk 1001", recordedBy: "staff-1", externalRef: "x" },
    ]);
    const view = await getInvoiceByToken(fake.db, "tok-1");
    expect(view).not.toBeNull();
    expect(Object.keys(view!.invoice).sort()).toEqual(
      [
        "amountPaid",
        "balanceDue",
        "billingAddress",
        "customerName",
        "discount",
        "dueDate",
        "invoiceNumber",
        "issuedAt",
        "status",
        "subtotal",
        "taxAmount",
        "taxRateBp",
        "total",
      ].sort(),
    );
    expect(view!.invoice).toMatchObject({ balanceDue: 60_000, issuedAt: new Date("2026-02-01T00:00:00Z") });
    expect(view!.items).toEqual([{ description: "Install", quantity: 1, unitPrice: 100_000, total: 100_000 }]);
    expect(view!.payments).toHaveLength(1);
    expect(Object.keys(view!.payments[0]!).sort()).toEqual(["amount", "method", "paidAt"]);
    const serialized = JSON.stringify(view);
    for (const secret of ["t1", "est-1", "staff-1", "chk 1001", "ada@example.com", "555-0100", "slow payer", "inv-1"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("derives overdue for an open invoice past its due date", async () => {
    const { fake } = withInvoice({ status: "sent", dueDate: new Date("2020-01-01T00:00:00Z") });
    expect((await getInvoiceByToken(fake.db, "tok-1"))?.invoice.status).toBe("overdue");
  });
});

describe("markInvoiceViewed", () => {
  it("moves sent → viewed and stamps viewedAt", async () => {
    const { fake, row } = withInvoice({ status: "sent" });
    expect(await markInvoiceViewed(fake.db, "tok-1")).toBe(true);
    expect(row().status).toBe("viewed");
    expect(row().viewedAt).toBeInstanceOf(Date);
    // Only from sent: a second open changes nothing.
    expect(await markInvoiceViewed(fake.db, "tok-1")).toBe(false);
  });

  it("never drags a draft, partial, paid or void invoice to viewed", async () => {
    for (const status of ["draft", "partial", "paid", "void"]) {
      const { fake, row } = withInvoice({ status });
      expect(await markInvoiceViewed(fake.db, "tok-1")).toBe(false);
      expect(row().status).toBe(status);
      expect(row().viewedAt).toBeNull();
    }
    const { fake } = withInvoice({ status: "sent" });
    expect(await markInvoiceViewed(fake.db, "no-such-token")).toBe(false);
  });
});
