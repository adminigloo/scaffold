/**
 * The ledger's enumerations, in a module with no imports. They used to sit in
 * the barrel; the HTTP handlers (Tenancy 2a) build zod schemas from them at
 * load time, and a handler module importing the barrel that re-exports it is
 * a cycle in which the constants are still undefined when the schema is
 * built. A leaf module has no cycle. The barrel re-exports both, unchanged.
 */

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

export const PAYMENT_METHODS = ["card", "cash", "check", "ach", "other"] as const;
