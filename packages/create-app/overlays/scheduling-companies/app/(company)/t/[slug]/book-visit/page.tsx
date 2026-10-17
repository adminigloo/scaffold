import type { Metadata } from "next";
import { VisitPicker } from "__SCOPE__/scheduling-widget";
import { PublicCompanyGate, publicCompanyMetadata } from "@/components/PublicCompanyGate";

/**
 * The tab title and link preview are the __TENANT_LABEL_LOWER__'s: "Book a visit · {name}" (review
 * T2A-BO-01), never this site's name. In search, `publicCompanyMetadata` decides: kept out unless the project
 * was made with --seo, and then only while the __TENANT_LABEL_LOWER__ is taking requests.
 */
export async function generateMetadata({ params }: { readonly params: Promise<{ readonly slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return publicCompanyMetadata(slug, "Book a visit", { path: "/book-visit" });
}

export const dynamic = "force-dynamic";

/**
 * A company's booking page (Tenancy 2a): a customer picks a service, a day and
 * a time — offered in the COMPANY's time zone, from its crews' real hours —
 * and leaves their details. The company's name, logo and colour head the page
 * (<PublicCompanyGate>), and a suspended company's page says plainly it isn't
 * taking requests and how to reach it, with no form at all.
 *
 * __SCOPE__/scheduling-widget's <VisitPicker>, talking to this company's
 * public routes (/api/t/{web address}/schedule). Every email it causes comes
 * from the company and links back to the company's own pages.
 *
 * Two optional query parameters for links from elsewhere: ?service=<key> opens
 * on that service; ?estimate=<id> ties the visit to an estimate (the quote's
 * "Pick a time for the work").
 */
export default async function CompanyBookVisitPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly slug: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const single = (value: string | string[] | undefined): string | undefined =>
    typeof value === "string" && value.trim() !== "" ? value : undefined;
  return (
    <PublicCompanyGate slug={slug} path="/book-visit" query={query}>
      {(company) => (
        <VisitPicker
          baseUrl={`/api/t/${company.slug}/schedule`}
          service={single(query.service)}
          estimateId={single(query.estimate)}
          accentColor={company.brandColor}
        />
      )}
    </PublicCompanyGate>
  );
}
