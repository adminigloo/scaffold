import type { Metadata } from "next";
import { EstimateTool } from "__SCOPE__/estimator-widget";
import { PublicCompanyGate, publicCompanyMetadata } from "@/components/PublicCompanyGate";
import { estimateBookHref } from "@/server/estimator-features";

/**
 * Not indexed (D17): a company's public pages stay out of search engines in
 * this release.
 *
 * The tab title and link preview are the __TENANT_LABEL_LOWER__'s: "Instant estimate · {name}" (review
 * T2A-BO-01), never this site's name. Not indexed (D17).
 */
export async function generateMetadata({ params }: { readonly params: Promise<{ readonly slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return publicCompanyMetadata(slug, "Instant estimate");
}

export const dynamic = "force-dynamic";

/**
 * A company's instant estimate (Tenancy 2a): a customer picks what they need,
 * answers what they know, and sees a live price from THE COMPANY'S price book,
 * with the working shown in plain words. Every number is worked out on the
 * server by the package's code; the page shows what the server sends.
 *
 * Headed by the company's name, logo and colour (<PublicCompanyGate>); a
 * suspended company's page says it isn't taking requests, with no form. Until
 * the company has built its price book and saved its estimate settings once,
 * the page says the estimator isn't set up yet.
 *
 * Saving files a lead in the company's /app/estimates and, with email, sends
 * the company's office a notice and the customer a copy — from the company.
 * "Book a visit to measure" appears when this project has scheduling
 * (`estimateBookHref`).
 */
export default async function CompanyEstimatePage({ params }: { readonly params: Promise<{ readonly slug: string }> }) {
  const { slug } = await params;
  return (
    <PublicCompanyGate slug={slug} path="/estimate">
      {(company) => (
        <EstimateTool
          baseUrl={`/api/t/${company.slug}/estimator`}
          bookHref={estimateBookHref(company.publicPath)}
          accentColor={company.brandColor}
        />
      )}
    </PublicCompanyGate>
  );
}
