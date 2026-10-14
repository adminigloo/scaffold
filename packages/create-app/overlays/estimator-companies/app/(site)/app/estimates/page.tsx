import Link from "next/link";
import { EstimatesQueue } from "__SCOPE__/estimator-widget/admin";
import { CompanyGate } from "@/components/CompanyGate";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The company's estimates (Tenancy 2a): new leads from its estimate page and
 * its own website, and the quotes it has sent — search, filter by where each
 * stands, archive. Opening one shows the customer's photo, what the AI saw in
 * it beside what the customer said, and the priced lines to edit and send.
 *
 * __SCOPE__/estimator-widget's <EstimatesQueue>, talking to THIS company's
 * routes (/api/app/{company id}/estimator), which check the person's company
 * role on every call. `estimateHref` is a pattern ({id} is filled in by the
 * widget), because a server page can't hand a function to a client component.
 *
 * Someone who may only LOOK (a viewer: `estimator.view` without
 * `estimator.estimates.manage`) gets the list without "New estimate"
 * (`canManage`) — the server would refuse the create; this stops offering it.
 */
export default async function CompanyEstimatesPage() {
  return (
    <CompanyGate path="/app/estimates" permission="estimator.view">
      {({ company, can }) => (
        <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
          <PageHeader
            title="Estimates"
            description="New leads from your estimate page and website, and the quotes you've sent. Open one to see the customer's photo, edit the lines and send the quote."
            actions={
              <nav aria-label="Estimates" className="flex items-center gap-3 text-sm">
                <Link href="/app/price-book" className="text-accent underline underline-offset-2">
                  Price book
                </Link>
                <span aria-hidden="true" className="text-ink-muted">
                  ·
                </span>
                {/* "Estimate settings", not "Settings": the header's Settings is the
                    company's, and two links with one name go to two places
                    (review T2A-BO-14). */}
                <Link href="/app/estimates/settings" className="text-accent underline underline-offset-2">
                  Estimate settings
                </Link>
              </nav>
            }
          />
          <EstimatesQueue
            baseUrl={`/api/app/${company.id}/estimator`}
            estimateHref="/app/estimates/{id}"
            canManage={can.includes("estimator.estimates.manage")}
          />
        </main>
      )}
    </CompanyGate>
  );
}
