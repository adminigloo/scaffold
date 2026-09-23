import type { InvoiceStatus } from "./money.js";

/**
 * The invoice lifecycle, pure. Two kinds of move, kept apart on purpose:
 *
 *   - STAFF moves (setInvoiceStatus) follow INVOICE_STATUS_TRANSITIONS.
 *   - MONEY moves — into and out of `partial`/`paid` — happen only when the
 *     ledger changes (recordPayment / reversePayment), derived by
 *     `settledStatus`. A status someone can pick from a menu is a status that
 *     can disagree with the ledger: the source let staff mark an unpaid invoice
 *     "paid" (and a paid one "draft"), and its books then said otherwise.
 *
 * `overdue` is never stored — it's a fact about the clock, derived on read
 * (`isOverdue`).
 */

/** Every status an invoice row can actually hold. */
export type StoredInvoiceStatus = Exclude<InvoiceStatus, "overdue">;

/** The statuses a staff move may target. */
export type SettableInvoiceStatus = "draft" | "sent" | "viewed" | "void";

/** Before any money: the "issued" half of the lifecycle. */
export type IssuedInvoiceStatus = "draft" | "sent" | "viewed";

/**
 * draft → sent | void; sent → viewed | void; viewed → void. `partial`/`paid`
 * move only with money. `void` is terminal: a cancelled bill that can be
 * un-voided is a bill that can be collected twice. Nothing moves back to
 * `draft` — once a customer has the link, recalling it doesn't unsend it.
 */
export const INVOICE_STATUS_TRANSITIONS: Readonly<
  Record<StoredInvoiceStatus, readonly SettableInvoiceStatus[]>
> = {
  draft: ["sent", "void"],
  sent: ["viewed", "void"],
  viewed: ["void"],
  partial: [],
  paid: [],
  void: [],
};

/**
 * Whether a staff move is allowed. Re-asserting the current status (sent →
 * sent, a "resend") is an allowed no-op, so a retried request never errors.
 */
export function canTransitionInvoice(from: string, to: string): boolean {
  if (from === to) return true;
  const allowed = INVOICE_STATUS_TRANSITIONS[from as StoredInvoiceStatus];
  return allowed !== undefined && (allowed as readonly string[]).includes(to);
}

/** The statuses a staff UI should offer from `status` (excluding itself). */
export function nextInvoiceStatuses(status: string): readonly SettableInvoiceStatus[] {
  return INVOICE_STATUS_TRANSITIONS[status as StoredInvoiceStatus] ?? [];
}

/**
 * Lines may change while nothing has been paid: draft, sent or viewed (the
 * customer's link is live, so a sent invoice corrected before payment simply
 * shows the corrected bill). Once money is against it (`partial`/`paid`) the
 * lines are what the customer paid against, and `void` is closed — reverse the
 * payments, or void and reissue.
 */
export const EDITABLE_INVOICE_STATUSES: readonly IssuedInvoiceStatus[] = ["draft", "sent", "viewed"];

export function isInvoiceEditable(status: string): boolean {
  return (EDITABLE_INVOICE_STATUSES as readonly string[]).includes(status);
}

/**
 * Where an invoice sits in the issued half of its lifecycle, for re-deriving
 * a status after the money changes. A partial/paid row carries its history in
 * the stamps: viewed if the customer opened it, otherwise sent. (A payment on a
 * draft stamps sentAt — money changing hands means it was issued — so falling
 * back to "sent" is right for every row the package wrote, and for legacy rows
 * with no stamps it keeps the customer's link alive rather than hiding it as a
 * draft.)
 */
export function issuedStatusOf(invoice: {
  status: string;
  viewedAt?: Date | null;
}): IssuedInvoiceStatus {
  if (invoice.status === "draft" || invoice.status === "sent" || invoice.status === "viewed") {
    return invoice.status;
  }
  return invoice.viewedAt ? "viewed" : "sent";
}

/**
 * The status the ledger implies. Paid when the money covers the bill,
 * partial when some has landed, otherwise wherever it was in the issued half.
 * A $0 invoice with nothing paid is not "paid" — nothing settled it.
 */
export function settledStatus(input: {
  total: number;
  amountPaid: number;
  issued: IssuedInvoiceStatus;
}): Exclude<StoredInvoiceStatus, "void"> {
  if (input.amountPaid > 0 && input.amountPaid >= input.total) return "paid";
  if (input.amountPaid > 0) return "partial";
  return input.issued;
}
