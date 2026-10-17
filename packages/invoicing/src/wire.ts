/**
 * THE WIRE TYPES — what `createInvoicingAdminHandlers` and
 * `createInvoicingHandlers` send and accept, as JSON (Tenancy 2a contract,
 * 10.8).
 *
 * SHARED WITH @adminigloo/invoicing-widget (its src/types.ts declares the same
 * region); change both or neither. Neither package imports the other, so the
 * widget's wire-parity test reads BOTH files from disk and fails if the region
 * between the WIRE markers differs by a single byte (line endings aside).
 *
 * Money is integer cents, rates are basis points, instants are ISO strings,
 * and a due date the person types is a calendar date ("YYYY-MM-DD"): the
 * server turns it into the end of that day in the business's zone.
 */

// WIRE:BEGIN
export type Instant = string;
export type DateString = string;   // "YYYY-MM-DD"
export type InvoicingErrorCodeWire =
  | "invalid" | "not_found" | "forbidden" | "cross_site" | "rate_limited" | "unavailable" | "transition_not_allowed" | "internal"
  | "estimate_already_invoiced" | "estimate_not_convertible" | "discount_exceeds_subtotal" | "invoice_not_editable"
  | "invoice_has_no_lines" | "invalid_status_transition" | "payment_refused" | "reversal_refused" | "invoice_number_conflict"
  | "payment_unavailable";
export interface WireIssue { path: (string | number)[]; message: string }
export interface WireErrorBody { error: { code: InvoicingErrorCodeWire; message: string; issues?: WireIssue[] } }

export type InvoiceStatusWire = "draft" | "sent" | "viewed" | "partial" | "paid" | "void" | "overdue";
export type StoredInvoiceStatusWire = "draft" | "sent" | "viewed" | "partial" | "paid" | "void";
export type SettableInvoiceStatusWire = "draft" | "sent" | "viewed" | "void";
export type PaymentMethodWire = "card" | "cash" | "check" | "ach" | "other";

/** How to show money and dates for this business. */
export interface MoneyFormatWire { currency: string; locale: string; timeZone: string }

export interface InvoiceSummaryWire {
  id: string; number: string; status: InvoiceStatusWire;
  customerName: string | null;
  total: number; amountPaid: number; balanceDue: number;   // cents
  dueDate: Instant | null; createdAt: Instant;
}
export interface InvoiceListWire { invoices: InvoiceSummaryWire[]; nextCursor: string | null; format: MoneyFormatWire }

export interface InvoiceLineWire { id: string; description: string; quantity: number; unitPrice: number; total: number }
export interface InvoicePaymentWire {
  id: string; amount: number; method: PaymentMethodWire; reference: string | null; paidAt: Instant;
  /** A reversal row names the payment it undoes; `reversed` marks a payment that has been undone. */
  reversesPaymentId: string | null; reversed: boolean; reason: string | null;
  /** A card payment the customer's bank disputed: still open, or lost (then a reversal took it off). */
  flag: PaymentFlagWire | null;
  /** Cents reversed of this payment so far: a part refund shows "Partly refunded $X"; `reversed` is all of it (or a lost dispute). */
  reversedAmount: number;
}
/** A card payment that needs the owner ("Needs your attention" on the payments screen). */
export interface CardAlertWire {
  id: string;
  kind: string;
  /** The sentence the owner reads: what happened, the amount, what to do. */
  message: string;
  amount: number | null; currency: string | null;
  invoiceId: string | null;
  /** The payment in the company's Stripe dashboard. */
  stripeUrl: string | null;
  createdAt: Instant; resolvedAt: Instant | null;
}
export interface CardAlertsWire { open: CardAlertWire[]; handled: CardAlertWire[] }
export type PaymentFlagWire = "disputed" | "dispute_lost";
/** The deposit asked first: the company's default, none, a percent (basis points) or a fixed amount (cents). */
export type DepositRuleWire = "default" | "none" | "percent" | "amount";
export interface DepositWire {
  rule: DepositRuleWire; percentBp: number | null; fixedAmount: number | null;
  /** Cents: what the deposit comes to on this invoice now (0 = no deposit). */
  amount: number;
  /** The company's own default, 0–100 percent. */
  defaultPercent: number;
  editable: boolean;
}
export type DepositBody =
  | { rule: "default" } | { rule: "none" }
  | { rule: "percent"; percentBp: number }     // 1..10000
  | { rule: "amount"; amount: number };        // cents, at least 1
export interface InvoiceDetailWire {
  id: string; number: string; status: InvoiceStatusWire; storedStatus: StoredInvoiceStatusWire;
  customerName: string | null; customerEmail: string | null; customerPhone: string | null; billingAddress: string | null;
  subtotal: number; discount: number; taxRateBp: number; taxAmount: number; total: number;
  amountPaid: number; balanceDue: number; overpaid: number;
  dueDate: Instant | null; notes: string | null; fromEstimate: boolean;
  sentAt: Instant | null; viewedAt: Instant | null; paidAt: Instant | null; createdAt: Instant;
  lines: InvoiceLineWire[]; payments: InvoicePaymentWire[];
  editable: boolean; nextStatuses: SettableInvoiceStatusWire[];
  can: { manage: boolean; record: boolean; reverse: boolean };
  deposit: DepositWire;
}
export interface InvoiceResponse { invoice: InvoiceDetailWire; format: MoneyFormatWire }

export interface CreateInvoiceBody {
  customerName: string;                       // 1..200
  customerEmail?: string | null; customerPhone?: string | null; billingAddress?: string | null;
  taxRateBp?: number; discount?: number;      // basis points; cents
  dueDate?: DateString | null; notes?: string | null;
  items: { description: string; quantity: number; unitPrice: number }[];   // 1..200
}
export interface ItemBody { description: string; quantity: number; unitPrice: number }
export interface ItemPatchBody { description?: string; quantity?: number; unitPrice?: number }
export interface StatusBody { status: SettableInvoiceStatusWire }
export interface PaymentBody { amount: number; method: PaymentMethodWire; reference?: string | null }
export interface ReverseBody { reason: string }   // 1..500
export interface SendResponse extends InvoiceResponse { delivery: "sent" | "skipped" | "failed" | "no-email"; message: string }
export interface InvoiceLinkWire { url: string; previewUrl: string }
export interface InvoicingStatusWire {
  emails: boolean; emailsOffReason: string | null;
  /** Payment instructions are filled in. */
  detailsComplete: boolean; detailsHref: string | null;
  format: MoneyFormatWire;
}

// public
export interface BusinessWire {
  name: string; logoUrl: string | null; brandColor: string | null;
  contactEmail: string | null; contactPhone: string | null;
  paymentInstructions: string | null; footer: string | null;
}
export interface PublicInvoiceWire {
  number: string; status: InvoiceStatusWire; customerName: string | null;
  subtotal: number; discount: number; taxRateBp: number; taxAmount: number; total: number;
  amountPaid: number; balanceDue: number;
  dueDate: Instant | null; issuedAt: Instant;
  lines: { description: string; quantity: number; unitPrice: number; total: number }[];
  payments: { amount: number; method: PaymentMethodWire; paidAt: Instant }[];
  /** "Pay now", when this business takes card payments and something is owed; null otherwise. */
  pay: PayOptionWire | null;
  /** A bank payment on its way (not yet cleared): its amount and when it started. */
  pending: { amount: number; startedAt: Instant } | null;
}
export interface PayOptionWire {
  /** "deposit": the deposit (or what is left of it) comes first; "balance": the rest. */
  stage: "deposit" | "balance";
  /** Cents the button pays: decided by the server, never by the page. */
  amount: number;
  /** Cents: the whole deposit (0 when there is none). */
  depositAmount: number;
  /** The business lets customers choose how much to pay, between minimum and maximum (cents). */
  allowPartial: boolean; minimum: number; maximum: number;
  /** What is due is below the card minimum: "Please contact {business} to pay this small amount." */
  belowMinimum: boolean;
}
export interface PayBody { amount?: number }    // cents; only read when allowPartial
export interface PayResponse { url: string }
export interface PublicInvoiceResponse { invoice: PublicInvoiceWire; business: BusinessWire; format: MoneyFormatWire }
// WIRE:END
