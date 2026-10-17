import { createRequester, isObject, str, type Result, type TransportOptions } from "../http.js";
import { parseInvoiceResponse, parseList, parseSendResponse, parseStatus } from "../parse.js";
import type {
  CardAlertsWire,
  CreateInvoiceBody,
  DepositBody,
  InvoiceLinkWire,
  InvoiceListWire,
  InvoiceResponse,
  InvoiceStatusWire,
  InvoicingStatusWire,
  ItemBody,
  ItemPatchBody,
  PaymentBody,
  ReverseBody,
  SendResponse,
  StatusBody,
} from "../types.js";

/**
 * The staff screens' transport: one method per route of
 * @adminigloo/invoicing's `createInvoicingAdminHandlers` (contract 10.9). A
 * host backing the ledger with something else passes its own object of this
 * shape as `transport`. Never throws.
 */
export interface InvoicingTransport {
  status(): Promise<Result<InvoicingStatusWire>>;
  list(q?: { status?: InvoiceStatusWire; cursor?: string }): Promise<Result<InvoiceListWire>>;
  create(body: CreateInvoiceBody): Promise<Result<InvoiceResponse>>;
  get(id: string): Promise<Result<InvoiceResponse>>;
  addItem(id: string, body: ItemBody): Promise<Result<InvoiceResponse>>;
  updateItem(itemId: string, body: ItemPatchBody): Promise<Result<InvoiceResponse>>;
  removeItem(itemId: string): Promise<Result<InvoiceResponse>>;
  setStatus(id: string, body: StatusBody): Promise<Result<InvoiceResponse>>;
  send(id: string): Promise<Result<SendResponse>>;
  link(id: string): Promise<Result<InvoiceLinkWire>>;
  recordPayment(id: string, body: PaymentBody): Promise<Result<InvoiceResponse>>;
  reversePayment(paymentId: string, body: ReverseBody): Promise<Result<InvoiceResponse>>;
  /** 0.2: the deposit the customer pays online first. Optional, so a 0.1 transport still fits. */
  setDeposit?(id: string, body: DepositBody): Promise<Result<InvoiceResponse>>;
  /** 0.2: the card payments that need the owner, and "Mark as handled". Optional, so a 0.1 transport still fits. */
  attention?(): Promise<Result<CardAlertsWire>>;
  resolveAttention?(alertId: string): Promise<Result<{ ok: true }>>;
}

const seg = (value: string) => encodeURIComponent(value);

function parseLink(raw: unknown): InvoiceLinkWire | null {
  return isObject(raw) && typeof raw.url === "string" ? { url: raw.url, previewUrl: str(raw.previewUrl, raw.url) } : null;
}

export function createInvoicingClient(options: TransportOptions): InvoicingTransport {
  const http = createRequester(options);
  return {
    status: () => http.get("/v1/admin/status", parseStatus),
    list: (q = {}) => {
      const params = new URLSearchParams();
      if (q.status) params.set("status", q.status);
      if (q.cursor) params.set("cursor", q.cursor);
      const query = params.toString();
      return http.get(`/v1/admin/invoices${query ? `?${query}` : ""}`, parseList);
    },
    create: (body) => http.post("/v1/admin/invoices", body, parseInvoiceResponse),
    get: (id) => http.get(`/v1/admin/invoices/${seg(id)}`, parseInvoiceResponse),
    addItem: (id, body) => http.post(`/v1/admin/invoices/${seg(id)}/items`, body, parseInvoiceResponse),
    updateItem: (itemId, body) => http.post(`/v1/admin/items/${seg(itemId)}`, body, parseInvoiceResponse),
    removeItem: (itemId) => http.post(`/v1/admin/items/${seg(itemId)}/remove`, {}, parseInvoiceResponse),
    setStatus: (id, body) => http.post(`/v1/admin/invoices/${seg(id)}/status`, body, parseInvoiceResponse),
    send: (id) => http.post(`/v1/admin/invoices/${seg(id)}/send`, {}, parseSendResponse),
    link: (id) => http.get(`/v1/admin/invoices/${seg(id)}/link`, parseLink),
    recordPayment: (id, body) => http.post(`/v1/admin/invoices/${seg(id)}/payments`, body, parseInvoiceResponse),
    attention: () =>
      http.get("/v1/admin/attention", (raw) =>
        isObject(raw) && Array.isArray(raw.open) && Array.isArray(raw.handled) ? (raw as unknown as CardAlertsWire) : null,
      ),
    resolveAttention: (alertId) => http.post(`/v1/admin/attention/${seg(alertId)}/resolve`, {}, (raw) => (isObject(raw) ? { ok: true as const } : null)),
    setDeposit: (id, body) => http.post(`/v1/admin/invoices/${seg(id)}/deposit`, body, parseInvoiceResponse),
    reversePayment: (paymentId, body) => http.post(`/v1/admin/payments/${seg(paymentId)}/reverse`, body, parseInvoiceResponse),
  };
}
