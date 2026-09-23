/**
 * Typed refusals. Every business rule the package enforces throws one of these
 * rather than a bare Error, so a router can map them to a 4xx with the message
 * intact (`err instanceof InvoicingError` → BAD_REQUEST/CONFLICT) instead of a
 * 500 that tells staff nothing. "Not found in this tenant" is NOT an error —
 * it stays `null`/`false`, the same as every read.
 */
export type InvoicingErrorCode =
  | "estimate_already_invoiced"
  | "estimate_not_convertible"
  | "discount_exceeds_subtotal"
  | "invoice_not_editable"
  | "invalid_status_transition"
  | "payment_refused"
  | "reversal_refused"
  | "invoice_number_conflict";

export class InvoicingError extends Error {
  constructor(
    readonly code: InvoicingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * The (tenant, estimate) unique index fired: this estimate already has an
 * invoice. A double-click on "convert", or two staff converting the same quote,
 * used to bill the customer twice.
 */
export class InvoiceAlreadyExistsForEstimateError extends InvoicingError {
  constructor(readonly estimateId: string) {
    super("estimate_already_invoiced", `Estimate ${estimateId} has already been invoiced.`);
  }
}

/** Only an approved estimate becomes an invoice (see `invoiceInputFromEstimate`). */
export class EstimateNotConvertibleError extends InvoicingError {
  constructor(readonly estimateStatus: string) {
    super(
      "estimate_not_convertible",
      estimateStatus === "converted"
        ? "This estimate has already been invoiced."
        : `Only an approved estimate can be invoiced (this one is "${estimateStatus}").`,
    );
  }
}

/**
 * A discount larger than the lines it discounts makes a negative taxable
 * amount — negative tax, a negative total, and a "balance due" the business
 * owes the customer.
 */
export class InvoiceDiscountError extends InvoicingError {
  constructor(
    readonly discount: number,
    readonly subtotal: number,
  ) {
    super(
      "discount_exceeds_subtotal",
      `The discount (${discount}¢) is larger than the subtotal (${subtotal}¢).`,
    );
  }
}

/** Lines are frozen once money is against the invoice (partial/paid) or it is void. */
export class InvoiceNotEditableError extends InvoicingError {
  constructor(readonly status: string) {
    super(
      "invoice_not_editable",
      `A ${status} invoice's lines can't be changed — reverse its payments or void and reissue it.`,
    );
  }
}

export class InvoiceStatusTransitionError extends InvoicingError {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(
      "invalid_status_transition",
      from === "partial" || from === "paid"
        ? `A ${from} invoice's status follows its payments — record or reverse a payment instead.`
        : `An invoice can't move from "${from}" to "${to}".`,
    );
  }
}

export type PaymentRefusal = "void" | "paid" | "draft";

export class PaymentRefusedError extends InvoicingError {
  constructor(readonly reason: PaymentRefusal) {
    super(
      "payment_refused",
      reason === "void"
        ? "This invoice is void — a payment would resurrect a cancelled bill."
        : reason === "paid"
          ? "This invoice is already paid in full."
          : "This invoice is still a draft — send it first, or record with allowDraft.",
    );
  }
}

export type ReversalRefusal = "already_reversed" | "is_reversal";

export class PaymentReversalError extends InvoicingError {
  constructor(readonly reason: ReversalRefusal) {
    super(
      "reversal_refused",
      reason === "already_reversed"
        ? "This payment has already been reversed."
        : "A reversal can't itself be reversed — record a new payment instead.",
    );
  }
}

/** The per-tenant invoice-number sequence kept colliding past every retry. */
export class InvoiceNumberConflictError extends InvoicingError {
  constructor(readonly invoiceNumber: string) {
    super(
      "invoice_number_conflict",
      `Could not allocate an invoice number (last tried ${invoiceNumber}); try again.`,
    );
  }
}

/**
 * The unique index a Postgres 23505 names, or null when the error is not a
 * unique violation. Walks `cause`: drizzle ≥0.44 wraps every driver error in a
 * DrizzleQueryError whose own `code` is undefined, so a check on the outer
 * error alone never matches and the violation escapes as a 500. Duck-typed
 * rather than `instanceof` — the driver's error class is not a stable export,
 * and pnpm can install two copies of it.
 */
export function uniqueViolationConstraint(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const c = current as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
    if (c.code === "23505") {
      if (typeof c.constraint === "string") return c.constraint;
      // A driver that omits `constraint` still names the index in the message.
      const named = typeof c.message === "string" ? /constraint "([^"]+)"/.exec(c.message) : null;
      return named?.[1] ?? "";
    }
    current = c.cause;
  }
  return null;
}
