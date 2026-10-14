import type { Metadata } from "next";
import { InvoiceView } from "__SCOPE__/invoicing-widget";

/**
 * Never indexed, and never handing its address to the next site: the token in
 * this URL is the customer's whole key to their invoice. The API sends the
 * same two headers on both of its routes.
 */
export const metadata: Metadata = {
  title: "Your invoice",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

/**
 * A customer's own invoice, opened from the link in their email — no account.
 * The business's name, the lines and totals, what has been paid, and how to
 * pay. __SCOPE__/invoicing-widget's <InvoiceView>, talking to /api/invoices.
 *
 * Opening it marks it viewed (a POST the page makes, never the GET, so a mail
 * scanner fetching the link doesn't count) — except with ?preview=1, which is
 * the link the ledger's "Preview" button opens, so staff checking it never
 * mark it viewed themselves.
 */
export default async function CustomerInvoicePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly token: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  const { preview } = await searchParams;
  return (
    <main className="mx-auto max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
      <InvoiceView baseUrl="/api/invoices" token={token} preview={preview === "1"} />
    </main>
  );
}
