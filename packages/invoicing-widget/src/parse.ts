import { isObject, listOf, num, str, strOrNull } from "./http.js";
import type {
  BusinessWire,
  DepositWire,
  InvoiceDetailWire,
  InvoiceLineWire,
  InvoiceListWire,
  InvoicePaymentWire,
  InvoiceResponse,
  InvoiceStatusWire,
  InvoiceSummaryWire,
  InvoicingStatusWire,
  MoneyFormatWire,
  PaymentFlagWire,
  PaymentMethodWire,
  PayOptionWire,
  PublicInvoiceResponse,
  SendResponse,
  SettableInvoiceStatusWire,
  StoredInvoiceStatusWire,
} from "./types.js";

/**
 * Narrow shape checks for every answer: a field of the wrong type becomes a
 * safe default, and a body that isn't the shape at all is `null` (the
 * transport turns that into `bad_response`). Never a TypeError mid-render.
 */

const STATUSES: readonly InvoiceStatusWire[] = ["draft", "sent", "viewed", "partial", "paid", "void", "overdue"];
const STORED: readonly StoredInvoiceStatusWire[] = ["draft", "sent", "viewed", "partial", "paid", "void"];
const SETTABLE: readonly SettableInvoiceStatusWire[] = ["draft", "sent", "viewed", "void"];
const METHODS: readonly PaymentMethodWire[] = ["card", "cash", "check", "ach", "other"];

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

export function parseFormat(raw: unknown): MoneyFormatWire {
  const f = isObject(raw) ? raw : {};
  return { currency: str(f.currency, "USD") || "USD", locale: str(f.locale, "en-US") || "en-US", timeZone: str(f.timeZone, "UTC") || "UTC" };
}

function parseSummary(raw: unknown): InvoiceSummaryWire | null {
  if (!isObject(raw) || typeof raw.id !== "string") return null;
  return {
    id: raw.id,
    number: str(raw.number),
    status: pick(raw.status, STATUSES, "draft"),
    customerName: strOrNull(raw.customerName),
    total: num(raw.total),
    amountPaid: num(raw.amountPaid),
    balanceDue: num(raw.balanceDue),
    dueDate: strOrNull(raw.dueDate),
    createdAt: str(raw.createdAt),
  };
}

export function parseList(raw: unknown): InvoiceListWire | null {
  if (!isObject(raw) || !Array.isArray(raw.invoices)) return null;
  return { invoices: listOf(raw.invoices, parseSummary), nextCursor: strOrNull(raw.nextCursor), format: parseFormat(raw.format) };
}

function parseLine(raw: unknown): InvoiceLineWire | null {
  if (!isObject(raw) || typeof raw.id !== "string") return null;
  return { id: raw.id, description: str(raw.description), quantity: num(raw.quantity), unitPrice: num(raw.unitPrice), total: num(raw.total) };
}

/** 0.7: "entered from past records" — when, and by whom (a user id); null when it wasn't. */
function parseEnteredLater(raw: unknown): { at: string; by: string | null } | null {
  if (!isObject(raw) || typeof raw.at !== "string" || !Number.isFinite(Date.parse(raw.at))) return null;
  return { at: raw.at, by: typeof raw.by === "string" ? raw.by : null };
}

function parsePayment(raw: unknown): InvoicePaymentWire | null {
  if (!isObject(raw) || typeof raw.id !== "string") return null;
  return {
    id: raw.id,
    amount: num(raw.amount),
    method: pick(raw.method, METHODS, "other"),
    reference: strOrNull(raw.reference),
    paidAt: str(raw.paidAt),
    reversesPaymentId: strOrNull(raw.reversesPaymentId),
    reversed: raw.reversed === true,
    reason: strOrNull(raw.reason),
    flag: raw.flag === "disputed" || raw.flag === "dispute_lost" ? (raw.flag as PaymentFlagWire) : null,
    reversedAmount: num(raw.reversedAmount),
    enteredLater: parseEnteredLater(raw.enteredLater),
  };
}

function parseDeposit(raw: unknown): DepositWire {
  const d = isObject(raw) ? raw : {};
  return {
    rule: pick(d.rule, ["default", "none", "percent", "amount"] as const, "default"),
    percentBp: typeof d.percentBp === "number" ? d.percentBp : null,
    fixedAmount: typeof d.fixedAmount === "number" ? d.fixedAmount : null,
    amount: num(d.amount),
    defaultPercent: num(d.defaultPercent),
    editable: d.editable === true,
  };
}

/** "Pay now": null unless the server offered it, with every figure the server's. */
export function parsePayOption(raw: unknown): PayOptionWire | null {
  if (!isObject(raw) || typeof raw.amount !== "number" || raw.amount < 1) return null;
  return {
    stage: raw.stage === "deposit" ? "deposit" : "balance",
    amount: raw.amount,
    depositAmount: num(raw.depositAmount),
    allowPartial: raw.allowPartial === true,
    minimum: num(raw.minimum),
    maximum: num(raw.maximum),
    belowMinimum: raw.belowMinimum === true,
  };
}

function parseDetail(raw: unknown): InvoiceDetailWire | null {
  if (!isObject(raw) || typeof raw.id !== "string") return null;
  const can = isObject(raw.can) ? raw.can : {};
  return {
    id: raw.id,
    number: str(raw.number),
    status: pick(raw.status, STATUSES, "draft"),
    storedStatus: pick(raw.storedStatus, STORED, "draft"),
    customerName: strOrNull(raw.customerName),
    customerEmail: strOrNull(raw.customerEmail),
    customerPhone: strOrNull(raw.customerPhone),
    billingAddress: strOrNull(raw.billingAddress),
    subtotal: num(raw.subtotal),
    discount: num(raw.discount),
    taxRateBp: num(raw.taxRateBp),
    taxAmount: num(raw.taxAmount),
    total: num(raw.total),
    amountPaid: num(raw.amountPaid),
    balanceDue: num(raw.balanceDue),
    overpaid: num(raw.overpaid),
    dueDate: strOrNull(raw.dueDate),
    notes: strOrNull(raw.notes),
    fromEstimate: raw.fromEstimate === true,
    sentAt: strOrNull(raw.sentAt),
    viewedAt: strOrNull(raw.viewedAt),
    paidAt: strOrNull(raw.paidAt),
    createdAt: str(raw.createdAt),
    lines: listOf(raw.lines, parseLine),
    payments: listOf(raw.payments, parsePayment),
    editable: raw.editable === true,
    nextStatuses: listOf(raw.nextStatuses, (s) => (SETTABLE.includes(s as SettableInvoiceStatusWire) ? (s as SettableInvoiceStatusWire) : null)),
    can: { manage: can.manage === true, record: can.record === true, reverse: can.reverse === true },
    deposit: parseDeposit(raw.deposit),
    enteredLater: parseEnteredLater(raw.enteredLater),
  };
}

export function parseInvoiceResponse(raw: unknown): InvoiceResponse | null {
  const invoice = isObject(raw) ? parseDetail(raw.invoice) : null;
  return invoice && isObject(raw) ? { invoice, format: parseFormat(raw.format) } : null;
}

export function parseSendResponse(raw: unknown): SendResponse | null {
  const base = parseInvoiceResponse(raw);
  if (!base || !isObject(raw)) return null;
  return { ...base, delivery: pick(raw.delivery, ["sent", "skipped", "failed", "no-email"] as const, "failed"), message: str(raw.message) };
}

export function parseStatus(raw: unknown): InvoicingStatusWire | null {
  if (!isObject(raw) || typeof raw.emails !== "boolean") return null;
  return {
    emails: raw.emails,
    emailsOffReason: strOrNull(raw.emailsOffReason),
    detailsComplete: raw.detailsComplete === true,
    detailsHref: strOrNull(raw.detailsHref),
    format: parseFormat(raw.format),
  };
}

function parseBusiness(raw: unknown): BusinessWire {
  const b = isObject(raw) ? raw : {};
  return {
    name: str(b.name),
    logoUrl: strOrNull(b.logoUrl),
    brandColor: strOrNull(b.brandColor),
    contactEmail: strOrNull(b.contactEmail),
    contactPhone: strOrNull(b.contactPhone),
    paymentInstructions: strOrNull(b.paymentInstructions),
    footer: strOrNull(b.footer),
  };
}

export function parsePublicInvoice(raw: unknown): PublicInvoiceResponse | null {
  if (!isObject(raw) || !isObject(raw.invoice)) return null;
  const inv = raw.invoice;
  return {
    invoice: {
      number: str(inv.number),
      status: pick(inv.status, STATUSES, "sent"),
      customerName: strOrNull(inv.customerName),
      subtotal: num(inv.subtotal),
      discount: num(inv.discount),
      taxRateBp: num(inv.taxRateBp),
      taxAmount: num(inv.taxAmount),
      total: num(inv.total),
      amountPaid: num(inv.amountPaid),
      balanceDue: num(inv.balanceDue),
      dueDate: strOrNull(inv.dueDate),
      issuedAt: str(inv.issuedAt),
      lines: listOf(inv.lines, (l) =>
        isObject(l) ? { description: str(l.description), quantity: num(l.quantity), unitPrice: num(l.unitPrice), total: num(l.total) } : null,
      ),
      payments: listOf(inv.payments, (p) => (isObject(p) ? { amount: num(p.amount), method: pick(p.method, METHODS, "other"), paidAt: str(p.paidAt) } : null)),
      pay: parsePayOption(inv.pay),
      pending:
        isObject(inv.pending) && typeof inv.pending.amount === "number" && inv.pending.amount > 0
          ? { amount: inv.pending.amount, startedAt: str(inv.pending.startedAt) }
          : null,
    },
    business: parseBusiness(raw.business),
    format: parseFormat(raw.format),
  };
}
