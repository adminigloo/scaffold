import { bigint, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createdAt, idColumn, updatedAt } from "@adminigloo/db";

/**
 * Invoicing tables. Money is `bigint` minor units (cents), marshalled to plain
 * numbers; `tenantId` and the optional `estimateId` link are plain text with no
 * cross-package FK. Payments are their own append-only rows so the ledger is
 * auditable, with the running `amountPaid` denormalized onto the invoice.
 */

const money = (name: string) => bigint(name, { mode: "number" }).notNull().default(0);

export const invoices = pgTable(
  "invoices",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    invoiceNumber: text("invoice_number").notNull(),
    /** draft | sent | viewed | partial | paid | overdue | void */
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("invoices_tenant_idx").on(t.tenantId, t.status),
    index("invoices_token_idx").on(t.viewToken),
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
    createdAt: createdAt(),
  },
  (t) => [index("invoice_items_invoice_idx").on(t.invoiceId)],
);

export const invoicePayments = pgTable(
  "invoice_payments",
  {
    id: idColumn(),
    invoiceId: text("invoice_id").notNull(),
    amount: money("amount"),
    /** "card", "cash", "check", "ach", "other". */
    method: text("method").notNull().default("other"),
    reference: text("reference"),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull().defaultNow(),
    recordedBy: text("recorded_by"),
    createdAt: createdAt(),
  },
  (t) => [index("invoice_payments_invoice_idx").on(t.invoiceId)],
);
