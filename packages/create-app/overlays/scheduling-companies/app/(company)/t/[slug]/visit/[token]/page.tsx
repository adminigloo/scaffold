import type { Metadata } from "next";
import { ManageVisit } from "__SCOPE__/scheduling-widget";
import { PublicCompanyGate, publicCompanyMetadata } from "@/components/PublicCompanyGate";

/**
 * Never indexed, and never handing its address to the next site. The token in
 * this URL is the customer's whole key to their visit — anybody holding it can
 * move or cancel it — so the page tells search engines to forget it and the
 * browser to send no Referer. The API sends the same two headers.
 *
 * The tab title and link preview are the __TENANT_LABEL_LOWER__'s: "Your visit · {name}" (review
 * T2A-BO-01), never this site's name. Not indexed (D17); the address carries
 * the customer's token, so it never goes to the next site (no-referrer).
 */
export async function generateMetadata({ params }: { readonly params: Promise<{ readonly slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return publicCompanyMetadata(slug, "Your visit", { noReferrer: true });
}

export const dynamic = "force-dynamic";

/**
 * The page behind the link in every visit email from a company (Tenancy 2a):
 * the visit in plain words, with Reschedule and Cancel while it is still early
 * enough, and the company's phone number when it is not.
 *
 * The visit is read INSIDE the company whose web address is in the URL: a
 * link from another company's email opened here says "not found", never the
 * other company's visit under this one's name. Nothing is looked up on the
 * server — the widget reads it in the browser, so a link previewer learns
 * nothing and changes nothing.
 */
export default async function CompanyManageVisitPage({
  params,
}: {
  readonly params: Promise<{ readonly slug: string; readonly token: string }>;
}) {
  const { slug, token } = await params;
  return (
    <PublicCompanyGate slug={slug} path={`/visit/${encodeURIComponent(token)}`}>
      {(company) => (
        <ManageVisit
          baseUrl={`/api/t/${company.slug}/schedule`}
          token={token}
          bookHref={`${company.publicPath}/book-visit`}
          accentColor={company.brandColor}
        />
      )}
    </PublicCompanyGate>
  );
}
