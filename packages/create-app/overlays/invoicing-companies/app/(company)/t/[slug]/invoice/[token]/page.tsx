import type { Metadata } from "next";
import { InvoiceView } from "__SCOPE__/invoicing-widget";
import { PublicCompanyGate, publicCompanyMetadata } from "@/components/PublicCompanyGate";

/**
 * Never indexed, and never handing its address to the next site: the token is
 * the customer's whole key to their invoice. The API sends the same headers.
 *
 * The tab title and link preview are the __TENANT_LABEL_LOWER__'s: "Your invoice · {name}" (review
 * T2A-BO-01), never this site's name. Not indexed (D17); the address carries
 * the customer's token, so it never goes to the next site (no-referrer).
 */
export async function generateMetadata({ params }: { readonly params: Promise<{ readonly slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return publicCompanyMetadata(slug, "Your invoice", { noReferrer: true });
}

export const dynamic = "force-dynamic";

/**
 * The page behind the link in a company's invoice email (Tenancy 2a): the
 * company's name and logo, the invoice in plain words ("Due Nov 12", "Paid"),
 * the lines and totals, what has been paid, and "How to pay" — the company's
 * own payment instructions from its settings.
 *
 * The invoice is read INSIDE the company whose web address is in the URL
 * (D13): a token from another company's invoice says "isn't available" here,
 * never that company's invoice under this one's name. Opening it marks it
 * viewed — except with ?preview=1, the link the company's own "Preview"
 * button opens, so checking the link never counts as the customer reading it.
 */
export default async function CompanyInvoicePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly slug: string; readonly token: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug, token } = await params;
  const query = await searchParams;
  return (
    <PublicCompanyGate slug={slug} path={`/invoice/${encodeURIComponent(token)}`} query={query}>
      {(company) => (
        <InvoiceView
          baseUrl={`/api/t/${company.slug}/invoices`}
          token={token}
          preview={query.preview === "1"}
          accentColor={company.brandColor}
        />
      )}
    </PublicCompanyGate>
  );
}
