/**
 * The customer's invoice link, and staff's PREVIEW of it — one definition for
 * the two overlays that meet here: the ledger (invoicing-admin) builds the
 * links, the customer page (`app/(site)/invoice/[token]`) decides from the URL
 * whether an open was the customer's.
 *
 * Why a preview exists at all: the customer page reports every open as
 * sent → viewed. The ledger used to link straight to it, so staff checking the
 * link they were about to send marked the invoice "viewed" themselves, and the
 * status the business chases on ("they've seen it — call them") was a lie.
 *
 * Pure and dependency-free on purpose: the customer page is a client
 * component, and importing the invoicing package there would ship its server
 * code (drizzle, the schema) to every customer's browser.
 */

/** The query flag that marks an open as staff previewing, not the customer. */
export const INVOICE_PREVIEW_PARAM = "preview";

/** The page a customer is sent: `/invoice/<token>`, the token kept in one segment. */
export function invoiceLinkPath(token: string): string {
  return `/invoice/${encodeURIComponent(token)}`;
}

/** The same page, flagged so opening it never counts as the customer viewing it. */
export function invoicePreviewPath(token: string): string {
  return `${invoiceLinkPath(token)}?${INVOICE_PREVIEW_PARAM}=1`;
}

/** Whether a page's `location.search` carries the staff-preview flag. */
export function isInvoicePreview(search: string): boolean {
  return new URLSearchParams(search).has(INVOICE_PREVIEW_PARAM);
}
