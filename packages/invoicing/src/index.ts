import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { z } from "zod";
import { applyPayment, calculateInvoiceTotals } from "./money.js";
import { invoiceItems, invoicePayments, invoices } from "./schema.js";

export * from "./money.js";
export { invoiceItems, invoicePayments, invoices } from "./schema.js";

export type InvoicingDb = PgDatabase<any, any, any>;

export type InvoiceRow = typeof invoices.$inferSelect;
export type InvoiceItemRow = typeof invoiceItems.$inferSelect;
export type InvoicePaymentRow = typeof invoicePayments.$inferSelect;

const centsField = z.number().int().min(0);

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return "inv_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function nextInvoiceNumber(db: InvoicingDb, tenantId: string): Promise<string> {
  const year = new Date().getUTCFullYear();
  const [row] = await db
    // ::int — the serverless driver returns count() (int8) as a STRING; without
    // the cast `n + 1` concatenates ("5"+1 = "51") and invoice numbers corrupt.
    .select({ n: sql<number>`count(*)::int` })
    .from(invoices)
    .where(
      and(
        eq(invoices.tenantId, tenantId),
        sql`extract(year from ${invoices.createdAt}) = ${year}`,
      ),
    );
  const next = ((row as { n: number } | undefined)?.n ?? 0) + 1;
  return `INV-${year}-${String(next).padStart(4, "0")}`;
}

export const createInvoiceItemSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: z.number().int().min(1).max(100000).default(1),
  unitPrice: centsField.default(0),
});

export const createInvoiceSchema = z.object({
  tenantId: z.string().min(1).max(200),
  customerName: z.string().max(200).nullish(),
  customerEmail: z.string().max(320).nullish(),
  customerPhone: z.string().max(60).nullish(),
  billingAddress: z.string().max(500).nullish(),
  taxRateBp: z.number().int().min(0).max(1_000_000).default(0),
  discount: centsField.default(0),
  dueDate: z.coerce.date().nullish(),
  estimateId: z.string().nullish(),
  notes: z.string().max(2000).nullish(),
  items: z.array(createInvoiceItemSchema).min(1).max(200),
});
export type CreateInvoiceInput = z.input<typeof createInvoiceSchema>;

export interface CreatedInvoice {
  id: string;
  invoiceNumber: string;
  viewToken: string;
  total: number;
}

export async function createInvoice(
  db: InvoicingDb,
  input: CreateInvoiceInput,
  createdBy?: string,
): Promise<CreatedInvoice> {
  const parsed = createInvoiceSchema.parse(input);
  const priced = parsed.items.map((item) => ({
    ...item,
    total: item.unitPrice * item.quantity,
  }));
  const totals = calculateInvoiceTotals({
    itemTotals: priced.map((p) => p.total),
    taxRateBp: parsed.taxRateBp,
    discount: parsed.discount,
  });
  const invoiceNumber = await nextInvoiceNumber(db, parsed.tenantId);
  const viewToken = randomToken();

  const [invoice] = await db
    .insert(invoices)
    .values({
      tenantId: parsed.tenantId,
      invoiceNumber,
      status: "draft",
      customerName: parsed.customerName ?? null,
      customerEmail: parsed.customerEmail ?? null,
      customerPhone: parsed.customerPhone ?? null,
      billingAddress: parsed.billingAddress ?? null,
      subtotal: totals.subtotal,
      taxRateBp: parsed.taxRateBp,
      taxAmount: totals.taxAmount,
      discount: parsed.discount,
      total: totals.total,
      dueDate: parsed.dueDate ?? null,
      viewToken,
      estimateId: parsed.estimateId ?? null,
      notes: parsed.notes ?? null,
      createdBy: createdBy ?? null,
    })
    .returning();

  const invoiceId = (invoice as InvoiceRow).id;
  await db.insert(invoiceItems).values(
    priced.map((p, index) => ({
      invoiceId,
      description: p.description,
      quantity: p.quantity,
      unitPrice: p.unitPrice,
      total: p.total,
      sortOrder: index,
    })),
  );

  return { id: invoiceId, invoiceNumber, viewToken, total: totals.total };
}

export async function listInvoices(db: InvoicingDb, tenantId: string, limit = 100): Promise<InvoiceRow[]> {
  return (await db
    .select()
    .from(invoices)
    .where(eq(invoices.tenantId, tenantId))
    .orderBy(desc(invoices.createdAt), desc(invoices.id))
    .limit(limit)) as InvoiceRow[];
}

export interface InvoiceDetail {
  invoice: InvoiceRow;
  items: InvoiceItemRow[];
  payments: InvoicePaymentRow[];
}

async function loadDetail(db: InvoicingDb, invoice: InvoiceRow): Promise<InvoiceDetail> {
  const items = (await db
    .select()
    .from(invoiceItems)
    .where(eq(invoiceItems.invoiceId, invoice.id))
    .orderBy(asc(invoiceItems.sortOrder))) as InvoiceItemRow[];
  const payments = (await db
    .select()
    .from(invoicePayments)
    .where(eq(invoicePayments.invoiceId, invoice.id))
    .orderBy(asc(invoicePayments.paidAt))) as InvoicePaymentRow[];
  return { invoice, items, payments };
}

export async function getInvoice(db: InvoicingDb, id: string): Promise<InvoiceDetail | null> {
  const [invoice] = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
  if (!invoice) return null;
  return loadDetail(db, invoice as InvoiceRow);
}

/** Public view — a customer opens their invoice by its token, no account. */
export async function getInvoiceByToken(db: InvoicingDb, token: string): Promise<InvoiceDetail | null> {
  const [invoice] = await db.select().from(invoices).where(eq(invoices.viewToken, token)).limit(1);
  if (!invoice) return null;
  return loadDetail(db, invoice as InvoiceRow);
}

export const recordPaymentSchema = z.object({
  invoiceId: z.string().min(1),
  amount: z.number().int().min(1),
  method: z.enum(["card", "cash", "check", "ach", "other"]).default("other"),
  reference: z.string().max(200).nullish(),
});

export async function recordPayment(
  db: InvoicingDb,
  input: z.input<typeof recordPaymentSchema>,
  recordedBy?: string,
): Promise<{ amountPaid: number; balanceDue: number; status: string } | null> {
  const parsed = recordPaymentSchema.parse(input);
  const [invoice] = await db.select().from(invoices).where(eq(invoices.id, parsed.invoiceId)).limit(1);
  if (!invoice) return null;
  const inv = invoice as InvoiceRow;
  // A voided invoice is closed. Recording a payment would flip it back to
  // partial/paid and resurrect a cancelled bill — refuse it.
  if (inv.status === "void") return null;

  await db.insert(invoicePayments).values({
    invoiceId: inv.id,
    amount: parsed.amount,
    method: parsed.method,
    reference: parsed.reference ?? null,
    recordedBy: recordedBy ?? null,
  });

  const result = applyPayment(inv.amountPaid, inv.total, parsed.amount);
  await db
    .update(invoices)
    .set({ amountPaid: result.amountPaid, status: result.status, updatedAt: new Date() })
    .where(eq(invoices.id, inv.id));

  return { amountPaid: result.amountPaid, balanceDue: result.balanceDue, status: result.status };
}

const SETTABLE_STATUSES = ["draft", "sent", "viewed", "void"] as const;

export const setInvoiceStatusSchema = z.object({
  id: z.string().min(1),
  status: z.enum(SETTABLE_STATUSES),
});

export async function setInvoiceStatus(
  db: InvoicingDb,
  input: z.infer<typeof setInvoiceStatusSchema>,
): Promise<boolean> {
  const parsed = setInvoiceStatusSchema.parse(input);
  const [row] = await db
    .update(invoices)
    .set({ status: parsed.status, updatedAt: new Date() })
    .where(eq(invoices.id, parsed.id))
    .returning({ id: invoices.id });
  return row !== undefined;
}
