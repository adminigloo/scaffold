import type {
  InvoiceDetailWire,
  InvoiceResponse,
  InvoiceSummaryWire,
  InvoicingStatusWire,
  MoneyFormatWire,
  PublicInvoiceResponse,
} from "../types.js";

export const FORMAT: MoneyFormatWire = { currency: "USD", locale: "en-US", timeZone: "America/Denver" };

export function detail(extra: Partial<InvoiceDetailWire> = {}): InvoiceDetailWire {
  return {
    id: "inv-1",
    number: "INV-2026-0001",
    status: "draft",
    storedStatus: "draft",
    customerName: "Pat Customer",
    customerEmail: "pat@example.com",
    customerPhone: null,
    billingAddress: null,
    subtotal: 25_000,
    discount: 0,
    taxRateBp: 825,
    taxAmount: 2_063,
    total: 27_063,
    amountPaid: 0,
    balanceDue: 27_063,
    overpaid: 0,
    dueDate: "2026-11-03T06:59:59.999Z",
    notes: null,
    fromEstimate: false,
    sentAt: null,
    viewedAt: null,
    paidAt: null,
    createdAt: "2026-10-13T18:00:00.000Z",
    lines: [{ id: "line-1", description: "Spring cleanup", quantity: 2, unitPrice: 12_500, total: 25_000 }],
    payments: [],
    editable: true,
    nextStatuses: ["sent", "void"],
    can: { manage: true, record: true, reverse: true },
    ...extra,
  };
}

export const response = (extra: Partial<InvoiceDetailWire> = {}): InvoiceResponse => ({ invoice: detail(extra), format: FORMAT });

export function summary(extra: Partial<InvoiceSummaryWire> = {}): InvoiceSummaryWire {
  return {
    id: "inv-1",
    number: "INV-2026-0001",
    status: "sent",
    customerName: "Pat Customer",
    total: 27_063,
    amountPaid: 0,
    balanceDue: 27_063,
    dueDate: "2026-11-03T06:59:59.999Z",
    createdAt: "2026-10-13T18:00:00.000Z",
    ...extra,
  };
}

export function statusWire(extra: Partial<InvoicingStatusWire> = {}): InvoicingStatusWire {
  return { emails: true, emailsOffReason: null, detailsComplete: true, detailsHref: "/settings/company#invoicing", format: FORMAT, ...extra };
}

export function publicInvoice(extra: Partial<PublicInvoiceResponse["invoice"]> = {}, business: Partial<PublicInvoiceResponse["business"]> = {}): PublicInvoiceResponse {
  return {
    invoice: {
      number: "INV-2026-0001",
      status: "sent",
      customerName: "Pat Customer",
      subtotal: 25_000,
      discount: 1_000,
      taxRateBp: 825,
      taxAmount: 1_980,
      total: 25_980,
      amountPaid: 0,
      balanceDue: 25_980,
      dueDate: "2026-11-03T06:59:59.999Z",
      issuedAt: "2026-10-13T18:00:00.000Z",
      lines: [{ description: "Spring cleanup", quantity: 2, unitPrice: 12_500, total: 25_000 }],
      payments: [],
      ...extra,
    },
    business: {
      name: "Green Acres",
      logoUrl: "https://cdn.test/green.png",
      brandColor: "#1f7a3a",
      contactEmail: "gail@greenacres.test",
      contactPhone: "(801) 555-0100",
      paymentInstructions: "Pay by check to Green Acres LLC.",
      footer: "Thanks for your business.",
      ...business,
    },
    format: FORMAT,
  };
}
