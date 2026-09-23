import { describe, expect, it } from "vitest";
import {
  addInvoiceItem,
  createInvoice,
  getInvoice,
  InvoiceDiscountError,
  invoiceItems,
  InvoiceNotEditableError,
  invoicePayments,
  invoices,
  recalculateInvoiceTotals,
  removeInvoiceItem,
  updateInvoiceItem,
} from "../index.js";
import { createFakeDb } from "./fake-db.js";

/** A draft with one $500 line at 8.25%. */
async function draft(fake = createFakeDb(), over: Record<string, unknown> = {}) {
  const created = await createInvoice(fake.db, {
    tenantId: "t1",
    taxRateBp: 825,
    items: [{ description: "Install", quantity: 1, unitPrice: 50_000 }],
    ...over,
  });
  return { fake, id: created.id };
}

function invoiceRow(fake: ReturnType<typeof createFakeDb>, id: string) {
  return fake.rows(invoices).find((r) => r.id === id)!;
}

describe("line items after creation", () => {
  it("adds a line to a draft and recomputes subtotal, tax and total in the row", async () => {
    const { fake, id } = await draft();
    const change = await addInvoiceItem(fake.db, {
      tenantId: "t1",
      invoiceId: id,
      description: "Haul-away",
      quantity: 2,
      unitPrice: 10_000,
    });
    expect(change?.item).toMatchObject({ description: "Haul-away", total: 20_000, sortOrder: 1 });
    // 700.00 + 8.25% = 757.75
    expect(change?.totals).toMatchObject({ subtotal: 70_000, taxAmount: 5_775, total: 75_775, status: "draft" });
    expect(invoiceRow(fake, id)).toMatchObject({ subtotal: 70_000, taxAmount: 5_775, total: 75_775 });
  });

  it("recomputes a line priced down to $0 (the source's truthiness check skipped it)", async () => {
    const { fake, id } = await draft();
    const [line] = fake.rows(invoiceItems);
    const change = await updateInvoiceItem(fake.db, { tenantId: "t1", itemId: String(line!.id), unitPrice: 0 });
    expect(change?.item.total).toBe(0);
    expect(invoiceRow(fake, id)).toMatchObject({ subtotal: 0, total: 0 });
  });

  it("removes a line softly: the row stays, the invoice and its detail no longer count it", async () => {
    const { fake, id } = await draft();
    const added = await addInvoiceItem(fake.db, {
      tenantId: "t1",
      invoiceId: id,
      description: "Extra",
      unitPrice: 25_000,
    });
    const totals = await removeInvoiceItem(fake.db, "t1", added!.item.id);
    expect(totals).toMatchObject({ subtotal: 50_000, total: 54_125 });
    expect(fake.rows(invoiceItems)).toHaveLength(2);
    expect(fake.rows(invoiceItems).find((r) => r.id === added!.item.id)?.removedAt).toBeInstanceOf(Date);
    const detail = await getInvoice(fake.db, "t1", id);
    expect(detail?.items.map((i) => i.description)).toEqual(["Install"]);
    // Removing it again finds nothing live.
    expect(await removeInvoiceItem(fake.db, "t1", added!.item.id)).toBeNull();
  });

  it("gives the next line max+1, not count, after a removal", async () => {
    const { fake, id } = await draft();
    const b = await addInvoiceItem(fake.db, { tenantId: "t1", invoiceId: id, description: "B", unitPrice: 1 });
    await removeInvoiceItem(fake.db, "t1", b!.item.id);
    const c = await addInvoiceItem(fake.db, { tenantId: "t1", invoiceId: id, description: "C", unitPrice: 1 });
    expect(c?.item.sortOrder).toBe(2);
  });

  it("allows edits while sent/viewed but refuses once money is against it or it is void", async () => {
    for (const status of ["sent", "viewed"]) {
      const { fake, id } = await draft();
      invoiceRow(fake, id).status = status;
      await expect(
        addInvoiceItem(fake.db, { tenantId: "t1", invoiceId: id, description: "x", unitPrice: 100 }),
      ).resolves.not.toBeNull();
    }
    for (const status of ["partial", "paid", "void"]) {
      const { fake, id } = await draft();
      invoiceRow(fake, id).status = status;
      const [line] = fake.rows(invoiceItems);
      await expect(
        addInvoiceItem(fake.db, { tenantId: "t1", invoiceId: id, description: "x", unitPrice: 100 }),
      ).rejects.toBeInstanceOf(InvoiceNotEditableError);
      await expect(
        updateInvoiceItem(fake.db, { tenantId: "t1", itemId: String(line!.id), unitPrice: 1 }),
      ).rejects.toBeInstanceOf(InvoiceNotEditableError);
      await expect(removeInvoiceItem(fake.db, "t1", String(line!.id))).rejects.toBeInstanceOf(
        InvoiceNotEditableError,
      );
      expect(fake.rows(invoiceItems)).toHaveLength(1);
      expect(invoiceRow(fake, id).total).toBe(54_125);
    }
  });

  it("rolls back an edit that would leave the discount larger than the lines", async () => {
    const { fake, id } = await draft(undefined, { discount: 40_000 });
    const [line] = fake.rows(invoiceItems);
    await expect(
      updateInvoiceItem(fake.db, { tenantId: "t1", itemId: String(line!.id), unitPrice: 30_000 }),
    ).rejects.toBeInstanceOf(InvoiceDiscountError);
    // The line kept its price — the whole edit rolled back, not just the total.
    expect(fake.rows(invoiceItems)[0]).toMatchObject({ unitPrice: 50_000, total: 50_000 });
    await expect(removeInvoiceItem(fake.db, "t1", String(line!.id))).rejects.toBeInstanceOf(
      InvoiceDiscountError,
    );
    expect(fake.rows(invoiceItems)[0]?.removedAt).toBeNull();
  });

  it("is tenant-scoped: another tenant's invoice or line answers null and nothing changes", async () => {
    const { fake, id } = await draft();
    const [line] = fake.rows(invoiceItems);
    expect(
      await addInvoiceItem(fake.db, { tenantId: "t2", invoiceId: id, description: "x", unitPrice: 1 }),
    ).toBeNull();
    expect(await updateInvoiceItem(fake.db, { tenantId: "t2", itemId: String(line!.id), unitPrice: 1 })).toBeNull();
    expect(await removeInvoiceItem(fake.db, "t2", String(line!.id))).toBeNull();
    expect(await recalculateInvoiceTotals(fake.db, "t2", id)).toBeNull();
    expect(fake.rows(invoiceItems)).toHaveLength(1);
    expect(fake.rows(invoiceItems)[0]).toMatchObject({ unitPrice: 50_000, removedAt: null });
  });

  it("builds an edit from the line as it stands under the lock, not from a read taken before it", async () => {
    // 1 × $500, no tax. Staff A sets the quantity to 3 while staff B prices
    // the line at $0. A reads the line, then waits on the invoice lock B
    // holds; B commits first. Built from A's pre-lock read, A wrote B's
    // price back over it: 3 × $500 = $1,500 instead of 3 × $0.
    const { fake, id } = await draft(undefined, { taxRateBp: 0 });
    const itemId = String(fake.rows(invoiceItems)[0]!.id);
    let raced = false;
    fake.beforeSelect = async (table, { forUpdate }) => {
      if (table !== invoices || !forUpdate || raced) return;
      raced = true;
      await updateInvoiceItem(fake.db, { tenantId: "t1", itemId, unitPrice: 0 });
    };
    const change = await updateInvoiceItem(fake.db, { tenantId: "t1", itemId, quantity: 3 });
    expect(raced).toBe(true);
    expect(change?.item).toMatchObject({ quantity: 3, unitPrice: 0, total: 0 });
    expect(invoiceRow(fake, id)).toMatchObject({ subtotal: 0, total: 0 });
  });

  it("keeps what a sent invoice said: an edit replaces the line and the old row stays, removed", async () => {
    const { fake, id } = await draft();
    invoiceRow(fake, id).status = "sent";
    const original = fake.rows(invoiceItems)[0]!;
    const change = await updateInvoiceItem(fake.db, { tenantId: "t1", itemId: String(original.id), quantity: 2 });

    // The customer's link already showed 1 × $500. Overwriting the row in
    // place left no trace that it ever did.
    expect(change?.item.id).not.toBe(original.id);
    expect(change?.item).toMatchObject({ description: "Install", quantity: 2, unitPrice: 50_000, total: 100_000 });
    // Same slot on the bill, and one instant: a point-in-time read of the
    // lines sees exactly one of the two rows.
    expect(change?.item.sortOrder).toBe(original.sortOrder);
    expect(change?.item.createdAt).toEqual(original.removedAt);
    expect(fake.rows(invoiceItems)).toHaveLength(2);
    expect(original).toMatchObject({ quantity: 1, unitPrice: 50_000, total: 50_000 });
    expect(original.removedAt).toBeInstanceOf(Date);

    const detail = await getInvoice(fake.db, "t1", id);
    expect(detail?.items.map((i) => [i.description, i.quantity])).toEqual([["Install", 2]]);
    // 1000.00 + 8.25% = 1082.50
    expect(invoiceRow(fake, id)).toMatchObject({ subtotal: 100_000, total: 108_250, status: "sent" });
    // The superseded id is history now, not a line to edit.
    expect(await updateInvoiceItem(fake.db, { tenantId: "t1", itemId: String(original.id), quantity: 5 })).toBeNull();
  });

  it("edits a draft's line in place — no customer has seen it yet", async () => {
    const { fake } = await draft();
    const original = fake.rows(invoiceItems)[0]!;
    const change = await updateInvoiceItem(fake.db, { tenantId: "t1", itemId: String(original.id), quantity: 2 });
    expect(change?.item.id).toBe(original.id);
    expect(fake.rows(invoiceItems)).toHaveLength(1);
    expect(original).toMatchObject({ quantity: 2, total: 100_000, removedAt: null });
  });
});

describe("recalculateInvoiceTotals", () => {
  it("re-derives the status from the ledger — the source recomputed money and forgot status", async () => {
    const fake = createFakeDb();
    // A partial invoice whose stored total (1000.00) no longer matches its one
    // live line (400.00) — and 600.00 is already paid. The bill is settled.
    fake.seed(invoices, [
      {
        id: "inv-1",
        tenantId: "t1",
        invoiceNumber: "INV-2026-0001",
        viewToken: "tok",
        status: "partial",
        sentAt: new Date("2026-01-01T00:00:00Z"),
        subtotal: 100_000,
        total: 100_000,
        amountPaid: 60_000,
      },
    ]);
    fake.seed(invoiceItems, [{ invoiceId: "inv-1", description: "Work", quantity: 1, unitPrice: 40_000, total: 40_000 }]);
    fake.seed(invoicePayments, [{ invoiceId: "inv-1", amount: 60_000 }]);
    const totals = await recalculateInvoiceTotals(fake.db, "t1", "inv-1");
    expect(totals).toMatchObject({
      subtotal: 40_000,
      total: 40_000,
      amountPaid: 60_000,
      balanceDue: 0,
      overpayment: 20_000,
      status: "paid",
    });
    expect(invoiceRow(fake, "inv-1")).toMatchObject({ status: "paid", total: 40_000 });
    expect(invoiceRow(fake, "inv-1").paidAt).toBeInstanceOf(Date);
  });

  it("keeps a void invoice void", async () => {
    const fake = createFakeDb();
    fake.seed(invoices, [
      { id: "inv-v", tenantId: "t1", invoiceNumber: "INV-2026-0002", viewToken: "v", status: "void", total: 5_000 },
    ]);
    fake.seed(invoiceItems, [{ invoiceId: "inv-v", description: "Work", unitPrice: 5_000, total: 5_000 }]);
    fake.seed(invoicePayments, [{ invoiceId: "inv-v", amount: 5_000 }]);
    expect((await recalculateInvoiceTotals(fake.db, "t1", "inv-v"))?.status).toBe("void");
  });
});
