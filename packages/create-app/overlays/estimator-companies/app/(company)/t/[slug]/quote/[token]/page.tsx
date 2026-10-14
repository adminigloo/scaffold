import type { Metadata } from "next";
import { QuoteView } from "__SCOPE__/estimator-widget";
import { PublicCompanyGate, publicCompanyMetadata } from "@/components/PublicCompanyGate";
import { estimateBookHref } from "@/server/estimator-features";

/**
 * Never indexed, and never handing its address to the next site: the token is
 * the customer's whole key to their quote (anybody holding it can accept it).
 * The API sends the same two headers on every route that carries one.
 *
 * The tab title and link preview are the __TENANT_LABEL_LOWER__'s: "Your quote · {name}" (review
 * T2A-BO-01), never this site's name. Not indexed (D17); the address carries
 * the customer's token, so it never goes to the next site (no-referrer).
 */
export async function generateMetadata({ params }: { readonly params: Promise<{ readonly slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return publicCompanyMetadata(slug, "Your quote", { noReferrer: true });
}

export const dynamic = "force-dynamic";

/**
 * The page behind the link in every quote email from a company (Tenancy 2a):
 * the company's name and logo, the lines, the total with tax, the date it is
 * good until, and Accept or Decline. With scheduling, accepting offers "Pick a
 * time for the work" on the company's own booking page.
 *
 * The quote is read INSIDE the company whose web address is in the URL: a
 * token from another company's email is "not found" here. Nothing is looked up
 * on the server, so a mail scanner fetching the link learns nothing.
 */
export default async function CompanyQuotePage({
  params,
}: {
  readonly params: Promise<{ readonly slug: string; readonly token: string }>;
}) {
  const { slug, token } = await params;
  return (
    <PublicCompanyGate slug={slug} path={`/quote/${encodeURIComponent(token)}`}>
      {(company) => (
        <QuoteView
          baseUrl={`/api/t/${company.slug}/estimator`}
          token={token}
          bookHref={estimateBookHref(company.publicPath)}
          accentColor={company.brandColor}
        />
      )}
    </PublicCompanyGate>
  );
}
