import { createRequester, isObject, type Result, type TransportOptions } from "./http.js";
import { parsePublicInvoice } from "./parse.js";
import type { PayBody, PayResponse, PublicInvoiceResponse } from "./types.js";

/**
 * The customer's page's transport: one method per public route of
 * @adminigloo/invoicing's `createInvoicingHandlers`. Never throws.
 */
export interface InvoicePublicTransport {
  invoice(token: string): Promise<Result<PublicInvoiceResponse>>;
  viewed(token: string): Promise<Result<{ viewed: boolean }>>;
  /** 0.2: "Pay now" → the Stripe page to send the customer to. Optional, so a 0.1 transport still fits. */
  pay?(token: string, body: PayBody): Promise<Result<PayResponse>>;
}

export function createInvoicePublicClient(options: TransportOptions): InvoicePublicTransport {
  const http = createRequester(options);
  const at = (token: string) => `/v1/invoice/${encodeURIComponent(token)}`;
  return {
    invoice: (token) => http.get(at(token), parsePublicInvoice),
    pay: (token, body) => http.post(`${at(token)}/pay`, body, (raw) => (isObject(raw) && typeof raw.url === "string" && raw.url.startsWith("https://") ? { url: raw.url } : null)),
    viewed: (token) => http.post(`${at(token)}/viewed`, {}, (raw) => (isObject(raw) && typeof raw.viewed === "boolean" ? { viewed: raw.viewed } : null)),
  };
}
