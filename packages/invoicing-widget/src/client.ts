import { createRequester, isObject, type Result, type TransportOptions } from "./http.js";
import { parsePublicInvoice } from "./parse.js";
import type { PublicInvoiceResponse } from "./types.js";

/**
 * The customer's page's transport: one method per public route of
 * @adminigloo/invoicing's `createInvoicingHandlers`. Never throws.
 */
export interface InvoicePublicTransport {
  invoice(token: string): Promise<Result<PublicInvoiceResponse>>;
  viewed(token: string): Promise<Result<{ viewed: boolean }>>;
}

export function createInvoicePublicClient(options: TransportOptions): InvoicePublicTransport {
  const http = createRequester(options);
  const at = (token: string) => `/v1/invoice/${encodeURIComponent(token)}`;
  return {
    invoice: (token) => http.get(at(token), parsePublicInvoice),
    viewed: (token) => http.post(`${at(token)}/viewed`, {}, (raw) => (isObject(raw) && typeof raw.viewed === "boolean" ? { viewed: raw.viewed } : null)),
  };
}
