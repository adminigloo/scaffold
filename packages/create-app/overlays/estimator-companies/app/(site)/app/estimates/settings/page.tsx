import { EmbedKeys, EstimatorSettings } from "__SCOPE__/estimator-widget/admin";
import { CompanyGate } from "@/components/CompanyGate";
import { PageHeader } from "@/components/ui";
import { companyLinksFor } from "@/server/company-links";

export const dynamic = "force-dynamic";

/**
 * The company's estimate settings (Tenancy 2a): tax rate, quote rules, who
 * hears about new leads, photo reading and its daily budget — and the keys
 * that put the estimate on the company's own website (#embed).
 *
 * The company's name, contact, time zone and brand colour are shown here
 * read-only, with a link to company settings, where they are typed once for
 * every feature. The photo-reading budget is held under this site's ceiling
 * (the form says how much). Instant estimates stay closed until the owner
 * saves these once.
 *
 * Anyone who can see estimates can read this page; only owners and admins
 * (`estimator.settings.manage`) can change it — the server decides, and for
 * everyone else the page is read-only (`canManage`: every value shown, no
 * Save and no key to make), rather than offering forms that would be refused.
 */
export default async function CompanyEstimateSettingsPage() {
  return (
    <CompanyGate path="/app/estimates/settings" permission="estimator.view">
      {({ company, can }) => (
        <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
          <PageHeader
            title="Estimate settings"
            description="Tax, quote rules, who hears about new leads, photo reading and its budget, and the estimate on your own website."
          />
          <EstimatorSettings baseUrl={`/api/app/${company.id}/estimator`} canManage={can.includes("estimator.settings.manage")} />
          <div className="mt-8">
            {/* Your website (review T2A-BO-02): a button and a page frame any
                site takes — Wix, Squarespace, WordPress — pointing at the
                company's own estimate page, in its colour; the keyed React
                snippet folded under "For developers". The notices are shown
                once, by the settings above (T2A-BO-06). */}
            <EmbedKeys
              baseUrl={`/api/app/${company.id}/estimator`}
              canManage={can.includes("estimator.settings.manage")}
              publicPageUrl={companyLinksFor(company.slug).estimate}
              buttonColor={company.brandColor}
              notices={false}
            />
          </div>
        </main>
      )}
    </CompanyGate>
  );
}
