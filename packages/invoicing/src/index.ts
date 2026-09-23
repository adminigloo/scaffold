import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  InvoiceAlreadyExistsForEstimateError,
  InvoiceDiscountError,
  InvoiceNotEditableError,
  InvoiceNumberConflictError,
  InvoiceStatusTransitionError,
  PaymentRefusedError,
  PaymentReversalError,
  uniqueViolationConstraint,
} from "./errors.js";
import { balanceOf, calculateInvoiceTotals, isOverdue, type InvoiceStatus } from "./money.js";
import {
  canTransitionInvoice,
  isInvoiceEditable,
  issuedStatusOf,
  settledStatus,
  type StoredInvoiceStatus,
} from "./status.js";
import { invoiceItems, invoicePayments, invoices } from "./schema.js";

export * from "./money.js";
export * from "./status.js";
export * from "./errors.js";
export * from "./estimate.js";
export { invoiceItems, invoicePayments, invoices } from "./schema.js";

export type InvoicingDb = PgDatabase<any, any, any>;

export type InvoiceRow = typeof invoices.$inferSelect;
export type InvoiceItemRow = typeof invoiceItems.$inferSelect;
export type InvoicePaymentRow = typeof invoicePayments.$inferSelect;

const centsField = z.number().int().min(0);
const tenantField = z.string().min(1).max(200);

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return "inv_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Every read and write by id is tenant-scoped (0.2.0). A positional id that
 * arrives undefined means a caller still on the old `(db, id)` signature — it
 * would otherwise run as `id = NULL`, match nothing, and look like "not found"
 * forever. Fail loudly instead.
 */
function requireIds(signature: string, ...ids: unknown[]): void {
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0) {
      throw new TypeError(`${signature}: every id must be a non-empty string (the tenant is required).`);
    }
  }
}

/**
 * The invoice row, locked FOR UPDATE for the rest of the transaction. Every
 * money or line change takes this lock first, so two payments (or a payment
 * and a line edit) on one invoice serialize instead of both reading the same
 * `amountPaid` and the second overwriting the first — the lost update the
 * read-then-write recordPayment had.
 */
async function lockInvoice(
  tx: InvoicingDb,
  tenantId: string,
  invoiceId: string,
): Promise<InvoiceRow | null> {
  const [row] = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId)))
    .limit(1)
    .for("update");
  return (row as InvoiceRow | undefined) ?? null;
}

/** amountPaid, recomputed from the append-only ledger — never incremented from a read. */
async function ledgerTotal(tx: InvoicingDb, invoiceId: string): Promise<number> {
  const rows = (await tx
    .select({ amount: invoicePayments.amount })
    .from(invoicePayments)
    .where(eq(invoicePayments.invoiceId, invoiceId))) as Array<{ amount: number }>;
  let sum = 0;
  for (const r of rows) sum += Number(r.amount);
  return sum;
}

/**
 * Status + paidAt the ledger implies. `void` is terminal and keeps its status
 * (a refund on a cancelled bill changes the money, not the lifecycle); paidAt
 * is stamped when the invoice first settles and cleared if it re-opens.
 */
function settle(
  inv: InvoiceRow,
  total: number,
  amountPaid: number,
  now: Date,
): { status: StoredInvoiceStatus; paidAt: Date | null } {
  if (inv.status === "void") return { status: "void", paidAt: inv.paidAt };
  const status = settledStatus({ total, amountPaid, issued: issuedStatusOf(inv) });
  return { status, paidAt: status === "paid" ? (inv.paidAt ?? now) : null };
}

// --- Numbering --------------------------------------------------------------

/**
 * `INV-2026-0001`, sequential per tenant per UTC year. The year is decided
 * ONCE, in UTC, from `now`, and both reads use it:
 *
 *   - the count filters created_at by the UTC range [Jan 1, next Jan 1). The
 *     old `extract(year from created_at)` ran in the SESSION time zone, so on a
 *     non-UTC connection the first hours of a year counted toward the previous
 *     one and the new year's sequence restarted on top of numbers already
 *     issued;
 *   - the highest number already issued under this year's prefix is a floor,
 *     so a skewed or imported row can push the sequence forward but never back
 *     onto an existing number.
 *
 * Concurrent creates can still pick the same next number; the unique index
 * decides and createInvoice retries the loser.
 */
export async function nextInvoiceNumber(
  db: InvoicingDb,
  tenantId: string,
  now: Date = new Date(),
): Promise<string> {
  const year = now.getUTCFullYear();
  const prefix = `INV-${year}-`;
  const [counted] = await db
    // ::int — the serverless driver returns count() (int8) as a STRING; without
    // the cast `n + 1` concatenates ("5"+1 = "51") and invoice numbers corrupt.
    .select({ n: sql<number>`count(*)::int` })
    .from(invoices)
    .where(
      and(
        eq(invoices.tenantId, tenantId),
        gte(invoices.createdAt, new Date(Date.UTC(year, 0, 1))),
        lt(invoices.createdAt, new Date(Date.UTC(year + 1, 0, 1))),
      ),
    );
  const [highest] = await db
    .select({
      top: sql<number>`coalesce(max(substring(${invoices.invoiceNumber} from ${prefix.length + 1}::int)::int), 0)::int`,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.tenantId, tenantId),
        // Only well-formed numbers of this year — a hand-typed "INV-2026-A" must
        // not break the ::int cast. {1,9} keeps the cast inside int4.
        sql`${invoices.invoiceNumber} ~ ${`^${prefix}[0-9]{1,9}$`}`,
      ),
    );
  const n = Number((counted as { n: number } | undefined)?.n ?? 0);
  const top = Number((highest as { top: number } | undefined)?.top ?? 0);
  return `${prefix}${String(Math.max(n, top) + 1).padStart(4, "0")}`;
}

// --- Create ------------------------------------------------------------------

export const createInvoiceItemSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: z.number().int().min(1).max(100000).default(1),
  unitPrice: centsField.default(0),
});

export const createInvoiceSchema = z.object({
  tenantId: tenantField,
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

/** Enough for a real race (each retry re-reads the committed winner); a loop past it is a bug. */
const NUMBER_ATTEMPTS = 5;

/**
 * Create an invoice and its lines in ONE transaction (a failed line insert used
 * to leave an invoice with no lines behind). Throws
 * `InvoiceDiscountError` when the discount exceeds the subtotal and
 * `InvoiceAlreadyExistsForEstimateError` when `estimateId` already has an
 * invoice in this tenant. Safe to call inside a caller's transaction (each
 * attempt is a savepoint there).
 */
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
  if (parsed.discount > totals.subtotal) {
    throw new InvoiceDiscountError(parsed.discount, totals.subtotal);
  }
  const viewToken = randomToken();

  let lastNumber = "";
  for (let attempt = 0; attempt < NUMBER_ATTEMPTS; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        // created_at comes from the same clock that picked the number's year,
        // so a row's number and its created_at can never land in different
        // years (the DB's now() and this process's clock can disagree across
        // midnight on Dec 31) — and it's millisecond-exact for the list cursor.
        const createdAt = new Date();
        const invoiceNumber = await nextInvoiceNumber(tx, parsed.tenantId, createdAt);
        lastNumber = invoiceNumber;
        const [invoice] = await tx
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
            createdAt,
            updatedAt: createdAt,
          })
          .returning({ id: invoices.id });

        const invoiceId = (invoice as { id: string }).id;
        await tx.insert(invoiceItems).values(
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
      });
    } catch (error) {
      const constraint = uniqueViolationConstraint(error);
      if (constraint === "invoices_estimate_uidx" && parsed.estimateId) {
        throw new InvoiceAlreadyExistsForEstimateError(parsed.estimateId);
      }
      // Lost the race for this number: the winner has committed (the unique
      // index waits for it), so the next attempt's read sees it and moves on.
      if (constraint === "invoices_number_uidx") continue;
      throw error;
    }
  }
  throw new InvoiceNumberConflictError(lastNumber);
}

// --- List --------------------------------------------------------------------

/** Stored statuses plus the derived "overdue". */
export const INVOICE_LIST_STATUSES = [
  "draft",
  "sent",
  "viewed",
  "partial",
  "paid",
  "void",
  "overdue",
] as const;
export type InvoiceListStatus = (typeof INVOICE_LIST_STATUSES)[number];

/** Issued and not settled — the statuses a due date can make overdue. */
const OPEN_STATUSES = ["sent", "viewed", "partial"] as const;

/**
 * An opaque page cursor for `listInvoices`: the last row's (createdAt, id).
 * createdAt is millisecond-exact for every row createInvoice writes; a row
 * from before 0.2.0 carries microseconds, so a page boundary between two
 * legacy invoices created in the same millisecond could skip one.
 */
export function invoiceCursor(row: { createdAt: Date; id: string }): string {
  return `${new Date(row.createdAt).toISOString()}|${row.id}`;
}

function parseCursor(cursor: string): { createdAt: Date; id: string } | null {
  const bar = cursor.indexOf("|");
  if (bar <= 0) return null;
  const createdAt = new Date(cursor.slice(0, bar));
  const id = cursor.slice(bar + 1);
  if (Number.isNaN(createdAt.getTime()) || id.length === 0) return null;
  return { createdAt, id };
}

export const listInvoicesOptionsSchema = z.object({
  limit: z.number().int().min(1).max(500).default(100),
  cursor: z
    .string()
    .max(300)
    .refine((c) => parseCursor(c) !== null, "Invalid invoice cursor")
    .nullish(),
  status: z.enum(INVOICE_LIST_STATUSES).nullish(),
});
export type ListInvoicesOptions = z.input<typeof listInvoicesOptionsSchema>;

/**
 * The status filter, in SQL — so a page of "overdue" is a page of overdue
 * invoices, not a page of 100 filtered down to 3 in JS. Overdue is derived
 * (open + past due), and the open statuses exclude their overdue rows so the
 * filters partition the ledger the same way the badges do.
 */
function statusCondition(status: InvoiceListStatus): SQL | undefined {
  if (status === "overdue") {
    return and(inArray(invoices.status, [...OPEN_STATUSES]), lt(invoices.dueDate, sql`now()`));
  }
  if ((OPEN_STATUSES as readonly string[]).includes(status)) {
    return and(
      eq(invoices.status, status),
      or(isNull(invoices.dueDate), gte(invoices.dueDate, sql`now()`)),
    );
  }
  return eq(invoices.status, status);
}

/**
 * A tenant's invoices, newest first, one page at a time. Pass the previous
 * page's `invoiceCursor(lastRow)` as `cursor` for the next page; a page shorter
 * than `limit` is the last. (A bare number is still accepted as the limit.)
 */
export async function listInvoices(
  db: InvoicingDb,
  tenantId: string,
  options: number | ListInvoicesOptions = {},
): Promise<InvoiceRow[]> {
  const parsed = listInvoicesOptionsSchema.parse(
    typeof options === "number" ? { limit: options } : options,
  );
  const cursor = parsed.cursor ? parseCursor(parsed.cursor) : null;
  return (await db
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.tenantId, tenantId),
        parsed.status ? statusCondition(parsed.status) : undefined,
        cursor
          ? or(
              lt(invoices.createdAt, cursor.createdAt),
              and(eq(invoices.createdAt, cursor.createdAt), lt(invoices.id, cursor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(invoices.createdAt), desc(invoices.id))
    .limit(parsed.limit)) as InvoiceRow[];
}

// --- Read --------------------------------------------------------------------

export interface InvoiceDetail {
  invoice: InvoiceRow;
  items: InvoiceItemRow[];
  payments: InvoicePaymentRow[];
}

async function loadDetail(db: InvoicingDb, invoice: InvoiceRow): Promise<InvoiceDetail> {
  const items = (await db
    .select()
    .from(invoiceItems)
    .where(and(eq(invoiceItems.invoiceId, invoice.id), isNull(invoiceItems.removedAt)))
    .orderBy(asc(invoiceItems.sortOrder), asc(invoiceItems.createdAt))) as InvoiceItemRow[];
  const payments = (await db
    .select()
    .from(invoicePayments)
    .where(eq(invoicePayments.invoiceId, invoice.id))
    .orderBy(asc(invoicePayments.paidAt), asc(invoicePayments.createdAt))) as InvoicePaymentRow[];
  return { invoice, items, payments };
}

/**
 * Staff view of one invoice, scoped to the tenant: an id from another tenant
 * answers null, exactly like an id that doesn't exist.
 */
export async function getInvoice(
  db: InvoicingDb,
  tenantId: string,
  id: string,
): Promise<InvoiceDetail | null> {
  requireIds("getInvoice(db, tenantId, id)", tenantId, id);
  const [invoice] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, id), eq(invoices.tenantId, tenantId)))
    .limit(1);
  if (!invoice) return null;
  return loadDetail(db, invoice as InvoiceRow);
}

/**
 * What a customer's link may show — a projection, not the row. The staff
 * detail carries payment references (check numbers, processor ids), who
 * recorded them, internal ids and the estimate link; a forwarded link must
 * leak none of it. Contact details are left off too: the bearer of the link is
 * not necessarily the customer.
 */
export interface PublicInvoice {
  invoice: {
    invoiceNumber: string;
    /** Stored status, or "overdue" when an open invoice is past due. */
    status: InvoiceStatus;
    customerName: string | null;
    billingAddress: string | null;
    subtotal: number;
    discount: number;
    taxRateBp: number;
    taxAmount: number;
    total: number;
    amountPaid: number;
    balanceDue: number;
    dueDate: Date | null;
    /** When it was sent (created, for a legacy row sent before the stamp existed). */
    issuedAt: Date;
  };
  items: Array<{ description: string; quantity: number; unitPrice: number; total: number }>;
  payments: Array<{ amount: number; method: string; paidAt: Date }>;
}

/**
 * Public view — a customer opens their invoice by its token, no account. A
 * DRAFT answers null: staff may still be pricing it, and a link that leaked
 * early must not show a half-built bill. Viewing does not mark it viewed; call
 * `markInvoiceViewed` from the page (a mutation), so a link-preview bot's GET
 * doesn't count as the customer opening it.
 */
export async function getInvoiceByToken(
  db: InvoicingDb,
  token: string,
): Promise<PublicInvoice | null> {
  if (typeof token !== "string" || token.length === 0) return null;
  const [row] = await db.select().from(invoices).where(eq(invoices.viewToken, token)).limit(1);
  if (!row) return null;
  const invoice = row as InvoiceRow;
  if (invoice.status === "draft") return null;
  const detail = await loadDetail(db, invoice);
  return {
    invoice: {
      invoiceNumber: invoice.invoiceNumber,
      status: isOverdue(invoice.status as InvoiceStatus, invoice.dueDate)
        ? "overdue"
        : (invoice.status as InvoiceStatus),
      customerName: invoice.customerName,
      billingAddress: invoice.billingAddress,
      subtotal: invoice.subtotal,
      discount: invoice.discount,
      taxRateBp: invoice.taxRateBp,
      taxAmount: invoice.taxAmount,
      total: invoice.total,
      amountPaid: invoice.amountPaid,
      balanceDue: balanceOf(invoice.total, invoice.amountPaid).balanceDue,
      dueDate: invoice.dueDate,
      issuedAt: invoice.sentAt ?? invoice.createdAt,
    },
    items: detail.items.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      total: item.total,
    })),
    payments: detail.payments.map((p) => ({ amount: p.amount, method: p.method, paidAt: p.paidAt })),
  };
}

/**
 * The customer opened their link: sent → viewed, stamping viewedAt. Only from
 * "sent" — a draft isn't visible, a partial/paid/void invoice has moved on and
 * must not be dragged back. True when it moved.
 */
export async function markInvoiceViewed(db: InvoicingDb, token: string): Promise<boolean> {
  if (typeof token !== "string" || token.length === 0) return false;
  const now = new Date();
  const rows = await db
    .update(invoices)
    .set({ status: "viewed", viewedAt: now, updatedAt: now })
    .where(and(eq(invoices.viewToken, token), eq(invoices.status, "sent")))
    .returning({ id: invoices.id });
  return rows.length > 0;
}

// --- Lines after creation ----------------------------------------------------

export interface InvoiceTotalsResult {
  subtotal: number;
  taxAmount: number;
  discount: number;
  total: number;
  amountPaid: number;
  balanceDue: number;
  overpayment: number;
  status: StoredInvoiceStatus;
}

/**
 * Re-sum the live lines and the ledger onto a LOCKED invoice row: subtotal,
 * tax, total, amountPaid, and the status those imply. The source recomputed
 * the money and forgot the status, so an invoice whose total dropped below
 * what was already paid still read "partial". Throws InvoiceDiscountError (and
 * so rolls back the caller's edit) if the lines no longer cover the discount.
 */
async function recalculateLocked(tx: InvoicingDb, inv: InvoiceRow): Promise<InvoiceTotalsResult> {
  const lines = (await tx
    .select({ total: invoiceItems.total })
    .from(invoiceItems)
    .where(and(eq(invoiceItems.invoiceId, inv.id), isNull(invoiceItems.removedAt)))) as Array<{
    total: number;
  }>;
  const totals = calculateInvoiceTotals({
    itemTotals: lines.map((l) => Number(l.total)),
    taxRateBp: inv.taxRateBp,
    discount: inv.discount,
  });
  if (inv.discount > totals.subtotal) throw new InvoiceDiscountError(inv.discount, totals.subtotal);
  const amountPaid = await ledgerTotal(tx, inv.id);
  const now = new Date();
  const { status, paidAt } = settle(inv, totals.total, amountPaid, now);
  await tx
    .update(invoices)
    .set({
      subtotal: totals.subtotal,
      taxAmount: totals.taxAmount,
      total: totals.total,
      amountPaid,
      status,
      paidAt,
      updatedAt: now,
    })
    .where(eq(invoices.id, inv.id));
  return {
    subtotal: totals.subtotal,
    taxAmount: totals.taxAmount,
    discount: inv.discount,
    total: totals.total,
    amountPaid,
    status,
    ...balanceOf(totals.total, amountPaid),
  };
}

/**
 * Recompute an invoice's totals and status from its lines and its ledger, in
 * one transaction. The line functions call this themselves; it's exported to
 * repair a row written by anything else.
 */
export async function recalculateInvoiceTotals(
  db: InvoicingDb,
  tenantId: string,
  invoiceId: string,
): Promise<InvoiceTotalsResult | null> {
  requireIds("recalculateInvoiceTotals(db, tenantId, invoiceId)", tenantId, invoiceId);
  return db.transaction(async (tx) => {
    const inv = await lockInvoice(tx, tenantId, invoiceId);
    if (!inv) return null;
    return recalculateLocked(tx, inv);
  });
}

export const addInvoiceItemSchema = createInvoiceItemSchema.extend({
  tenantId: tenantField,
  invoiceId: z.string().min(1),
});
export type AddInvoiceItemInput = z.input<typeof addInvoiceItemSchema>;

export const updateInvoiceItemSchema = z.object({
  tenantId: tenantField,
  itemId: z.string().min(1),
  description: z.string().min(1).max(500).optional(),
  quantity: z.number().int().min(1).max(100000).optional(),
  unitPrice: centsField.optional(),
});
export type UpdateInvoiceItemInput = z.input<typeof updateInvoiceItemSchema>;

export interface InvoiceItemChange {
  item: InvoiceItemRow;
  totals: InvoiceTotalsResult;
}

/**
 * Add a line to an editable invoice (draft/sent/viewed — see
 * EDITABLE_INVOICE_STATUSES) and recompute its totals, atomically. Null when
 * the invoice isn't in this tenant; InvoiceNotEditableError once it's
 * partial/paid/void.
 */
export async function addInvoiceItem(
  db: InvoicingDb,
  input: AddInvoiceItemInput,
): Promise<InvoiceItemChange | null> {
  const parsed = addInvoiceItemSchema.parse(input);
  return db.transaction(async (tx) => {
    const inv = await lockInvoice(tx, parsed.tenantId, parsed.invoiceId);
    if (!inv) return null;
    if (!isInvoiceEditable(inv.status)) throw new InvoiceNotEditableError(inv.status);
    // max + 1, not count: after a removal the count points at a slot already
    // taken and two lines share a position.
    const [last] = (await tx
      .select({ sortOrder: invoiceItems.sortOrder })
      .from(invoiceItems)
      .where(eq(invoiceItems.invoiceId, inv.id))
      .orderBy(desc(invoiceItems.sortOrder))
      .limit(1)) as Array<{ sortOrder: number }>;
    const [item] = await tx
      .insert(invoiceItems)
      .values({
        invoiceId: inv.id,
        description: parsed.description,
        quantity: parsed.quantity,
        unitPrice: parsed.unitPrice,
        total: parsed.unitPrice * parsed.quantity,
        sortOrder: (last?.sortOrder ?? -1) + 1,
      })
      .returning();
    const totals = await recalculateLocked(tx, inv);
    return { item: item as InvoiceItemRow, totals };
  });
}

/** The live line with this id and the locked invoice it belongs to, in this tenant. */
async function lockLine(
  tx: InvoicingDb,
  tenantId: string,
  itemId: string,
): Promise<{ line: InvoiceItemRow; inv: InvoiceRow } | null> {
  const [line] = await tx
    .select()
    .from(invoiceItems)
    .where(and(eq(invoiceItems.id, itemId), isNull(invoiceItems.removedAt)))
    .limit(1);
  if (!line) return null;
  // Tenant scope rides on the invoice: another tenant's line finds no invoice.
  const inv = await lockInvoice(tx, tenantId, (line as InvoiceItemRow).invoiceId);
  if (!inv) return null;
  return { line: line as InvoiceItemRow, inv };
}

/**
 * Change a line's description, quantity or unit price; its total and the
 * invoice's are recomputed. A price of 0 is a real change (the source's
 * `if (unitPrice || quantity)` skipped the recompute for it).
 */
export async function updateInvoiceItem(
  db: InvoicingDb,
  input: UpdateInvoiceItemInput,
): Promise<InvoiceItemChange | null> {
  const parsed = updateInvoiceItemSchema.parse(input);
  return db.transaction(async (tx) => {
    const found = await lockLine(tx, parsed.tenantId, parsed.itemId);
    if (!found) return null;
    const { line, inv } = found;
    if (!isInvoiceEditable(inv.status)) throw new InvoiceNotEditableError(inv.status);
    const quantity = parsed.quantity ?? line.quantity;
    const unitPrice = parsed.unitPrice ?? line.unitPrice;
    const [item] = await tx
      .update(invoiceItems)
      .set({
        description: parsed.description ?? line.description,
        quantity,
        unitPrice,
        total: unitPrice * quantity,
      })
      // Re-checked under the invoice lock: removed by a concurrent edit → null.
      .where(and(eq(invoiceItems.id, line.id), isNull(invoiceItems.removedAt)))
      .returning();
    if (!item) return null;
    const totals = await recalculateLocked(tx, inv);
    return { item: item as InvoiceItemRow, totals };
  });
}

/**
 * Take a line off an editable invoice. Soft: the row is stamped removedAt and
 * skipped by every read and total, so what a sent invoice once said stays on
 * record.
 */
export async function removeInvoiceItem(
  db: InvoicingDb,
  tenantId: string,
  itemId: string,
): Promise<InvoiceTotalsResult | null> {
  requireIds("removeInvoiceItem(db, tenantId, itemId)", tenantId, itemId);
  return db.transaction(async (tx) => {
    const found = await lockLine(tx, tenantId, itemId);
    if (!found) return null;
    const { line, inv } = found;
    if (!isInvoiceEditable(inv.status)) throw new InvoiceNotEditableError(inv.status);
    const removed = await tx
      .update(invoiceItems)
      .set({ removedAt: new Date() })
      .where(and(eq(invoiceItems.id, line.id), isNull(invoiceItems.removedAt)))
      .returning({ id: invoiceItems.id });
    if (removed.length === 0) return null;
    return recalculateLocked(tx, inv);
  });
}

// --- Payments ----------------------------------------------------------------

export const PAYMENT_METHODS = ["card", "cash", "check", "ach", "other"] as const;

export const recordPaymentSchema = z.object({
  tenantId: tenantField,
  invoiceId: z.string().min(1),
  amount: z.number().int().min(1),
  method: z.enum(PAYMENT_METHODS).default("other"),
  reference: z.string().max(200).nullish(),
  /**
   * The processor's id for this payment (PaymentIntent, webhook event). A
   * retry carrying the same ref on the same invoice returns the original
   * outcome with `duplicate: true` instead of recording the money twice.
   */
  externalRef: z.string().min(1).max(200).nullish(),
});
export type RecordPaymentInput = z.input<typeof recordPaymentSchema>;

export interface RecordPaymentOptions {
  /**
   * Take money against a draft (a deposit before the invoice goes out). Off by
   * default — a payment on a draft is usually the wrong invoice picked. When
   * allowed, the draft is stamped sent: money changing hands means it was
   * issued.
   */
  allowDraft?: boolean;
}

export interface PaymentOutcome {
  amountPaid: number;
  balanceDue: number;
  /** amountPaid − total when positive: money to refund or credit. */
  overpayment: number;
  status: StoredInvoiceStatus;
}

export interface RecordedPayment extends PaymentOutcome {
  paymentId: string;
  /** The externalRef was already on this invoice; nothing new was written. */
  duplicate: boolean;
}

/**
 * Record a payment, atomically: lock the invoice, insert the ledger row,
 * recompute amountPaid from the ledger, derive the status — one transaction,
 * so two concurrent payments can't both read the old amountPaid and lose one.
 * Null when the invoice isn't in this tenant. Throws PaymentRefusedError for a
 * void or already-paid invoice, and for a draft unless `allowDraft`.
 */
export async function recordPayment(
  db: InvoicingDb,
  input: RecordPaymentInput,
  recordedBy?: string,
  options: RecordPaymentOptions = {},
): Promise<RecordedPayment | null> {
  const parsed = recordPaymentSchema.parse(input);
  return db.transaction(async (tx) => {
    const inv = await lockInvoice(tx, parsed.tenantId, parsed.invoiceId);
    if (!inv) return null;

    // Idempotency BEFORE the status checks: a webhook retried after its own
    // payment settled the invoice must hear "already recorded", not "invoice
    // is paid" — or the processor keeps retrying money that is on the books.
    if (parsed.externalRef) {
      const [existing] = (await tx
        .select({ id: invoicePayments.id })
        .from(invoicePayments)
        .where(
          and(
            eq(invoicePayments.invoiceId, inv.id),
            eq(invoicePayments.externalRef, parsed.externalRef),
          ),
        )
        .limit(1)) as Array<{ id: string }>;
      if (existing) {
        return {
          paymentId: existing.id,
          duplicate: true,
          amountPaid: inv.amountPaid,
          status: inv.status as StoredInvoiceStatus,
          ...balanceOf(inv.total, inv.amountPaid),
        };
      }
    }

    // A void invoice is closed: a payment would flip it to partial/paid and
    // resurrect a cancelled bill. A paid one is settled: more money is an
    // accidental double charge, not a payment.
    if (inv.status === "void") throw new PaymentRefusedError("void");
    if (inv.status === "paid") throw new PaymentRefusedError("paid");
    if (inv.status === "draft" && !options.allowDraft) throw new PaymentRefusedError("draft");

    const now = new Date();
    const [payment] = (await tx
      .insert(invoicePayments)
      .values({
        invoiceId: inv.id,
        amount: parsed.amount,
        method: parsed.method,
        reference: parsed.reference ?? null,
        externalRef: parsed.externalRef ?? null,
        paidAt: now,
        recordedBy: recordedBy ?? null,
      })
      .returning({ id: invoicePayments.id })) as Array<{ id: string }>;

    const amountPaid = await ledgerTotal(tx, inv.id);
    const { status, paidAt } = settle(inv, inv.total, amountPaid, now);
    await tx
      .update(invoices)
      .set({
        amountPaid,
        status,
        paidAt,
        ...(inv.status === "draft" && !inv.sentAt ? { sentAt: now } : {}),
        updatedAt: now,
      })
      .where(eq(invoices.id, inv.id));

    return {
      paymentId: payment!.id,
      duplicate: false,
      amountPaid,
      status,
      ...balanceOf(inv.total, amountPaid),
    };
  });
}

export const reversePaymentSchema = z.object({
  tenantId: tenantField,
  paymentId: z.string().min(1),
  reason: z.string().min(1).max(500),
});

export interface ReversedPayment extends PaymentOutcome {
  /** The new reversal row. */
  reversalId: string;
  /** The payment it reverses. */
  paymentId: string;
}

/**
 * Undo a payment (a bounced check, a chargeback, money keyed onto the wrong
 * invoice) WITHOUT editing the ledger: append a reversal row for the negative
 * amount, linked by reversesPaymentId, then recompute amountPaid and status
 * from the ledger — a paid invoice re-opens to partial or back to sent/viewed.
 * Null when the payment isn't on an invoice in this tenant. Throws
 * PaymentReversalError for a reversal row or an already-reversed payment.
 */
export async function reversePayment(
  db: InvoicingDb,
  tenantId: string,
  paymentId: string,
  reason: string,
  recordedBy?: string,
): Promise<ReversedPayment | null> {
  const parsed = reversePaymentSchema.parse({ tenantId, paymentId, reason });
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(invoicePayments)
      .where(eq(invoicePayments.id, parsed.paymentId))
      .limit(1);
    if (!row) return null;
    const payment = row as InvoicePaymentRow;
    // Tenant scope rides on the invoice: another tenant's payment finds no
    // invoice here and answers "not found".
    const inv = await lockInvoice(tx, parsed.tenantId, payment.invoiceId);
    if (!inv) return null;
    if (payment.reversesPaymentId) throw new PaymentReversalError("is_reversal");
    // Under the invoice lock, so two concurrent reversals serialize and the
    // second sees the first (the partial unique index is the backstop).
    const [already] = await tx
      .select({ id: invoicePayments.id })
      .from(invoicePayments)
      .where(eq(invoicePayments.reversesPaymentId, payment.id))
      .limit(1);
    if (already) throw new PaymentReversalError("already_reversed");

    const now = new Date();
    const [reversal] = (await tx
      .insert(invoicePayments)
      .values({
        invoiceId: inv.id,
        amount: -payment.amount,
        method: payment.method,
        reference: payment.reference,
        reversesPaymentId: payment.id,
        reason: parsed.reason,
        paidAt: now,
        recordedBy: recordedBy ?? null,
      })
      .returning({ id: invoicePayments.id })) as Array<{ id: string }>;

    const amountPaid = await ledgerTotal(tx, inv.id);
    const { status, paidAt } = settle(inv, inv.total, amountPaid, now);
    await tx
      .update(invoices)
      .set({ amountPaid, status, paidAt, updatedAt: now })
      .where(eq(invoices.id, inv.id));

    return {
      reversalId: reversal!.id,
      paymentId: payment.id,
      amountPaid,
      status,
      ...balanceOf(inv.total, amountPaid),
    };
  });
}

// --- Status ------------------------------------------------------------------

const SETTABLE_STATUSES = ["draft", "sent", "viewed", "void"] as const;

export const setInvoiceStatusSchema = z.object({
  tenantId: tenantField,
  id: z.string().min(1),
  status: z.enum(SETTABLE_STATUSES),
});
export type SetInvoiceStatusInput = z.infer<typeof setInvoiceStatusSchema>;

/**
 * A staff move along INVOICE_STATUS_TRANSITIONS, stamping sentAt on the first
 * move to sent and viewedAt on the first to viewed. False when the invoice
 * isn't in this tenant; InvoiceStatusTransitionError for a move the table
 * forbids (anything out of partial/paid/void, anything back to draft).
 * Re-asserting the current status is a no-op that returns true.
 */
export async function setInvoiceStatus(
  db: InvoicingDb,
  input: SetInvoiceStatusInput,
): Promise<boolean> {
  const parsed = setInvoiceStatusSchema.parse(input);
  let seen = "";
  // Optimistic, not locked: the UPDATE is conditioned on the status just
  // judged, so a payment landing between the read and the write (sent →
  // partial) makes it match nothing rather than voiding a bill that now has
  // money on it. Re-read and re-judge; a real race settles in a round or two.
  for (let round = 0; round < 3; round++) {
    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, parsed.id), eq(invoices.tenantId, parsed.tenantId)))
      .limit(1);
    if (!row) return false;
    const current = row as InvoiceRow;
    seen = current.status;
    if (current.status === parsed.status) return true;
    if (!canTransitionInvoice(current.status, parsed.status)) {
      throw new InvoiceStatusTransitionError(current.status, parsed.status);
    }
    const now = new Date();
    const moved = await db
      .update(invoices)
      .set({
        status: parsed.status,
        ...(parsed.status === "sent" ? { sentAt: current.sentAt ?? now } : {}),
        ...(parsed.status === "viewed"
          ? { viewedAt: current.viewedAt ?? now, sentAt: current.sentAt ?? now }
          : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(invoices.id, current.id),
          eq(invoices.tenantId, parsed.tenantId),
          eq(invoices.status, current.status),
        ),
      )
      .returning({ id: invoices.id });
    if (moved.length > 0) return true;
  }
  throw new InvoiceStatusTransitionError(seen, parsed.status);
}
