import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createdAt, idColumn, updatedAt } from "@adminigloo/db";

/**
 * Invoicing tables. Money is `bigint` minor units (cents), marshalled to plain
 * numbers; `tenantId` and the optional `estimateId` link are plain text with no
 * cross-package FK. Payments are their own append-only rows so the ledger is
 * auditable, with the running `amountPaid` denormalized onto the invoice (and
 * recomputed from the ledger, never incremented from a stale read).
 */

const money = (name: string) => bigint(name, { mode: "number" }).notNull().default(0);

export const invoices = pgTable(
  "invoices",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    invoiceNumber: text("invoice_number").notNull(),
    /** draft | sent | viewed | partial | paid | void ("overdue" is derived on read, never stored) */
    status: text("status").notNull().default("draft"),
    customerName: text("customer_name"),
    customerEmail: text("customer_email"),
    customerPhone: text("customer_phone"),
    billingAddress: text("billing_address"),
    subtotal: money("subtotal"),
    taxRateBp: integer("tax_rate_bp").notNull().default(0),
    taxAmount: money("tax_amount"),
    discount: money("discount"),
    total: money("total"),
    amountPaid: money("amount_paid"),
    dueDate: timestamp("due_date", { withTimezone: true }),
    /** A capability token so a customer can view/pay without an account. */
    viewToken: text("view_token").notNull(),
    /** Optional link to the estimate this invoice was converted from. */
    estimateId: text("estimate_id"),
    notes: text("notes"),
    createdBy: text("created_by"),
    /** First move to "sent" — stamped once, never moved. */
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** First time the customer opened a sent invoice by its link. */
    viewedAt: timestamp("viewed_at", { withTimezone: true }),
    /** When a payment settled it; cleared if a reversal re-opens the balance. */
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("invoices_tenant_idx").on(t.tenantId, t.status),
    index("invoices_token_idx").on(t.viewToken),
    // The ledger's newest-first cursor (createdAt, id) within a tenant.
    index("invoices_tenant_created_idx").on(t.tenantId, t.createdAt, t.id),
    // Two invoices with one number is a bookkeeping error a customer can see.
    // The count-based allocator is best-effort under concurrency; this index
    // is the arbiter, and createInvoice retries the loser.
    uniqueIndex("invoices_number_uidx").on(t.tenantId, t.invoiceNumber),
    // ONE estimate, ONE invoice. A double-click or two staff converting the
    // same quote billed the customer twice; an app-level "already converted?"
    // check races, this cannot.
    uniqueIndex("invoices_estimate_uidx")
      .on(t.tenantId, t.estimateId)
      .where(sql`${t.estimateId} is not null`),
  ],
);

export const invoiceItems = pgTable(
  "invoice_items",
  {
    id: idColumn(),
    invoiceId: text("invoice_id").notNull(),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull().default(1),
    unitPrice: money("unit_price"),
    total: money("total"),
    sortOrder: integer("sort_order").notNull().default(0),
    /**
     * Removed from the invoice (soft — the row stays, so what a sent invoice
     * once said is still on record). Every read and every total skips it.
     */
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("invoice_items_invoice_idx").on(t.invoiceId)],
);

export const invoicePayments = pgTable(
  "invoice_payments",
  {
    id: idColumn(),
    invoiceId: text("invoice_id").notNull(),
    /** Cents. Positive for a payment; negative for a reversal row. */
    amount: money("amount"),
    /** "card", "cash", "check", "ach", "other". */
    method: text("method").notNull().default("other"),
    reference: text("reference"),
    /**
     * The processor's id for this payment (a PaymentIntent, a webhook event) —
     * the idempotency key. A retried webhook carrying the same ref on the same
     * invoice is recognised, not recorded twice.
     */
    externalRef: text("external_ref"),
    /** On a reversal row: the payment it reverses. The original is never edited. */
    reversesPaymentId: text("reverses_payment_id"),
    /** Why a reversal happened (bounced check, chargeback, keyed in error). */
    reason: text("reason"),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull().defaultNow(),
    recordedBy: text("recorded_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("invoice_payments_invoice_idx").on(t.invoiceId),
    uniqueIndex("invoice_payments_external_ref_uidx")
      .on(t.invoiceId, t.externalRef)
      .where(sql`${t.externalRef} is not null`),
    // A payment can be reversed once. Two reversals of one $500 payment would
    // take $1,000 off the ledger.
    uniqueIndex("invoice_payments_reverses_uidx")
      .on(t.reversesPaymentId)
      .where(sql`${t.reversesPaymentId} is not null`),
  ],
);
