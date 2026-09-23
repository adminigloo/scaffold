import { EstimateNotConvertibleError } from "./errors.js";

/**
 * Estimate → invoice, as a pure mapping. Structural on purpose: invoicing does
 * not depend on @adminigloo/estimator (it stands alone), but an estimator
 * `getEstimate` result satisfies these shapes as-is. The router that wires the
 * two supplies the rows; this owns the arithmetic, which is where the source
 * went wrong twice.
 */

export interface EstimateForInvoice {
  id: string;
  status: string;
  estimateNumber?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  jobAddress?: string | null;
  /** Pre-tax, pre-discount cents. */
  subtotal: number;
  taxRateBp: number;
  discount: number;
}

export interface EstimateLineForInvoice {
  description: string;
  quantity: number;
  /** Material/product cents per unit. */
  unitPrice: number;
  /** Labor cents per unit, billed on top of unitPrice. */
  laborPrice?: number | null;
  /** The line's total as quoted, cents. */
  total?: number | null;
}

export interface EstimateInvoiceInput {
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  billingAddress: string | null;
  taxRateBp: number;
  discount: number;
  estimateId: string;
  items: Array<{ description: string; quantity: number; unitPrice: number }>;
}

/** Only a quote the customer accepted is billed. `converted` is already invoiced. */
export const CONVERTIBLE_ESTIMATE_STATUSES: readonly string[] = ["approved"];

const MAX_DESCRIPTION = 500;

/**
 * One estimate line as one invoice line, with the quoted line total preserved
 * to the cent. An invoice line has one unit price, so labor folds into it —
 * the source copied `unitPrice` alone, and a line quoted at $300 parts + $200
 * labor billed $300. When the quoted total isn't (unit + labor) × qty (a
 * minimum charge, a hand-adjusted total) and doesn't divide evenly by the
 * quantity, the line is billed as one unit of the whole total rather than
 * rounding a unit price and drifting the invoice off the quote.
 */
export function invoiceLineFromEstimateLine(
  line: EstimateLineForInvoice,
): { description: string; quantity: number; unitPrice: number } {
  const quantity = Math.max(1, Math.trunc(line.quantity));
  const merged = line.unitPrice + (line.laborPrice ?? 0);
  const lineTotal = line.total ?? merged * quantity;
  if (merged * quantity === lineTotal) {
    return { description: line.description, quantity, unitPrice: merged };
  }
  if (lineTotal % quantity === 0) {
    return { description: line.description, quantity, unitPrice: lineTotal / quantity };
  }
  const described = `${line.description} (×${quantity})`;
  return {
    description: described.length > MAX_DESCRIPTION ? line.description : described,
    quantity: 1,
    unitPrice: lineTotal,
  };
}

/**
 * The `createInvoice` input (minus tenantId) for an estimate. Refuses anything
 * but an approved estimate (configurable via `allowStatuses`), carries the
 * tax rate and the discount (dropping the discount re-taxed the full subtotal
 * and billed more than the accepted quote), and — for an estimate with no
 * lines — bills the PRE-TAX subtotal. The source's fallback used the
 * estimate's `total`, which already includes tax, as a pre-tax unit price; the
 * invoice then applied the rate again and double-taxed the customer.
 */
export function invoiceInputFromEstimate(
  estimate: EstimateForInvoice,
  lines: readonly EstimateLineForInvoice[],
  options: { allowStatuses?: readonly string[] } = {},
): EstimateInvoiceInput {
  const allowed = options.allowStatuses ?? CONVERTIBLE_ESTIMATE_STATUSES;
  if (estimate.status === "converted" || !allowed.includes(estimate.status)) {
    throw new EstimateNotConvertibleError(estimate.status);
  }
  const items =
    lines.length > 0
      ? lines.map(invoiceLineFromEstimateLine)
      : [
          {
            description: estimate.estimateNumber
              ? `Work per estimate ${estimate.estimateNumber}`
              : "Work per estimate",
            quantity: 1,
            unitPrice: estimate.subtotal,
          },
        ];
  return {
    customerName: estimate.customerName ?? null,
    customerEmail: estimate.customerEmail ? estimate.customerEmail : null,
    customerPhone: estimate.customerPhone ?? null,
    billingAddress: estimate.jobAddress ?? null,
    taxRateBp: estimate.taxRateBp,
    discount: estimate.discount,
    estimateId: estimate.id,
    items,
  };
}
