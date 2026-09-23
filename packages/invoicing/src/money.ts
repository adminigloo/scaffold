/**
 * The invoicing math — pure, in integer minor units (cents), ratios in basis
 * points (10_000 = 100%). Money never touches a float in storage; these round
 * to whole cents at the boundary a person reads.
 */

export interface InvoiceTotalsInput {
  /** Each line's total, in cents. */
  itemTotals: number[];
  /** Tax in basis points (825 = 8.25%). */
  taxRateBp?: number | null;
  /** Discount in cents, applied before tax. */
  discount?: number | null;
}

export interface InvoiceTotals {
  subtotal: number;
  taxableAmount: number;
  taxAmount: number;
  total: number;
}

export function calculateInvoiceTotals(input: InvoiceTotalsInput): InvoiceTotals {
  let subtotal = 0;
  for (const t of input.itemTotals) subtotal += t;
  const taxRateBp = input.taxRateBp ?? 0;
  const discount = input.discount ?? 0;
  const taxableAmount = subtotal - discount;
  const taxAmount = Math.round(taxableAmount * (taxRateBp / 10_000));
  return { subtotal, taxableAmount, taxAmount, total: taxableAmount + taxAmount };
}

export type InvoiceStatus =
  | "draft"
  | "sent"
  | "viewed"
  | "partial"
  | "paid"
  | "overdue"
  | "void";

export interface PaymentResult {
  amountPaid: number;
  balanceDue: number;
  /**
   * Money taken beyond the bill (amountPaid − total), 0 when none. Reported,
   * not swallowed: clamping the balance at zero made a $1,200 payment on a
   * $1,000 invoice look identical to an exact one, and the $200 the business
   * owes back was visible nowhere.
   */
  overpayment: number;
  status: Extract<InvoiceStatus, "partial" | "paid">;
}

/** What's still owed and what was over-collected, from the two stored figures. */
export function balanceOf(
  total: number,
  amountPaid: number,
): { balanceDue: number; overpayment: number } {
  return {
    balanceDue: Math.max(0, total - amountPaid),
    overpayment: Math.max(0, amountPaid - total),
  };
}

/**
 * The invoice's state after a payment. Balance due is floored at zero and any
 * excess is reported as `overpayment`; it's paid when nothing is left.
 */
export function applyPayment(
  currentAmountPaid: number,
  total: number,
  payment: number,
): PaymentResult {
  const amountPaid = currentAmountPaid + payment;
  const { balanceDue, overpayment } = balanceOf(total, amountPaid);
  return { amountPaid, balanceDue, overpayment, status: balanceDue <= 0 ? "paid" : "partial" };
}

/**
 * Whether an issued, unpaid invoice is past due. A draft, a paid, or a voided
 * invoice is never overdue.
 */
export function isOverdue(
  status: InvoiceStatus,
  dueDate: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!dueDate) return false;
  if (status === "paid" || status === "void" || status === "draft") return false;
  return now.getTime() > dueDate.getTime();
}

export function formatCents(value: number, currency = "USD", locale = "en-US"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(value / 100);
}
