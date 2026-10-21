import Link from "next/link";
import { EstimatesQueue, EstimatesQueueActions } from "__SCOPE__/estimator-widget/admin";
import { CompanyGate } from "@/components/CompanyGate";
import { companyLinksFor } from "@/server/company-links";
import { PageHeader, WORK_MAIN, buttonClass } from "@/components/ui";

export const dynamic = "force-dynamic";

/** The queue's filters a link may open on (?filter=…). */
type EstimateFilter = "leads" | "drafts" | "sent" | "accepted" | "declined" | "expired" | "converted" | "all" | "archived";
const ESTIMATE_FILTERS: ReadonlySet<string> = new Set<EstimateFilter>(["leads", "drafts", "sent", "accepted", "declined", "expired", "converted", "all", "archived"]);

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
 *
 * "New estimate" sits in the page header, beside the title, like every work
 * page's primary action. ?filter=leads (or drafts, sent, accepted, declined,
 * expired, converted, all, archived) opens the queue on that filter — the
 * dashboard's "See all" under Newest leads links here that way.
 */
export default async function CompanyEstimatesPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { filter } = await searchParams;
  const initialFilter = typeof filter === "string" && ESTIMATE_FILTERS.has(filter) ? (filter as EstimateFilter) : undefined;
  return (
    <CompanyGate path="/app/estimates" permission="estimator.view">
      {({ company, can, isStaff, locale }) => (
        <main className={WORK_MAIN}>
          <PageHeader
            title="Estimates"
            description="Requests from your estimate page and website, and the quotes you've sent. Open one to see the customer's answers and photo, adjust the lines and send the quote."
            actions={
              <nav aria-label="Estimates" className="flex flex-wrap items-center gap-2">
                <Link href="/app/price-book" className={buttonClass("secondary")}>
                  Price book
                </Link>
                {/* "Estimate settings", not "Settings": the header's Settings is the
                    company's, and two links with one name go to two places
                    (review T2A-BO-14). */}
                <Link href="/app/estimates/settings" className={buttonClass("secondary")}>
                  Estimate settings
                </Link>
                {can.includes("estimator.estimates.manage") ? <EstimatesQueueActions className={buttonClass("primary")} /> : null}
              </nav>
            }
          />
          <EstimatesQueue
            baseUrl={`/api/app/${company.id}/estimator`}
            estimateHref="/app/estimates/{id}"
            canManage={can.includes("estimator.estimates.manage")}
            initialFilter={initialFilter}
            actionsInHeader
            estimatePageUrl={companyLinksFor(company.slug).estimate}
            title={false}
            showTechnical={isStaff}
            locale={locale}
          />
        </main>
      )}
    </CompanyGate>
  );
}
