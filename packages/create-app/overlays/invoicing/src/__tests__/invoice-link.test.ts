import { describe, expect, it } from "vitest";
import { invoiceLinkPath, invoicePreviewPath, isInvoicePreview } from "@/invoice-link";

const origin = "https://example.com";

/**
 * The customer's link and the staff preview of it. Small, but it is the one
 * definition two overlays agree on: the ledger builds the links, the customer
 * page decides from them whether an open was the customer's.
 */
describe("invoice links", () => {
  it("names the page the [token] route serves", () => {
    expect(invoiceLinkPath("inv_abc")).toBe("/invoice/inv_abc");
  });

  it("marks staff's own click as a preview, so it doesn't count as the customer opening it", () => {
    // The ledger linked straight to the customer page, and the page reports
    // every open as sent → viewed. Staff checking the link they were about to
    // send marked the invoice "viewed", and nobody chased a customer who had
    // never seen it.
    const preview = new URL(invoicePreviewPath("inv_abc"), origin);
    expect(isInvoicePreview(preview.search)).toBe(true);
    // Same page, only the flag differs.
    expect(preview.pathname).toBe(invoiceLinkPath("inv_abc"));
    // The link a customer is sent never carries it.
    expect(isInvoicePreview(new URL(invoiceLinkPath("inv_abc"), origin).search)).toBe(false);
    expect(isInvoicePreview("")).toBe(false);
  });

  it("keeps a token inside one path segment", () => {
    // A `/`, `?` or `#` in a token would address another route or cut the
    // token short, and the page would answer "not found" for a real invoice.
    expect(invoiceLinkPath("a/b?c#d")).toBe("/invoice/a%2Fb%3Fc%23d");
  });
});
