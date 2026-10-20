import { PriceBook } from "__SCOPE__/estimator-widget/admin";
import { CompanyGate } from "@/components/CompanyGate";
import { PageHeader, WORK_MAIN } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The company's price book (Tenancy 2a): its products, priced from its own
 * supplies, labor and markup, with a live test quote and exactly what a
 * customer will be asked. It starts EMPTY — the owner builds it, or loads the
 * sample on purpose from here; nothing on a public page is ever priced from a
 * list the company didn't write.
 *
 * Viewing is everybody's who can see estimates; changing it is
 * `estimator.pricebook.manage` (owners and admins), and costs and margins
 * show only with `estimator.costs.view`. The server strips and refuses; the
 * screen shows what it was told — and, for someone whose role can't change
 * it (a member who quotes from it), offers no add, edit, retire or sample
 * button that would only be refused (`canManage`, a runtime permission of
 * the person, not a feature switch).
 */
export default async function CompanyPriceBookPage() {
  return (
    <CompanyGate path="/app/price-book" permission="estimator.view">
      {({ company, can, isStaff, locale }) => (
        <main className={WORK_MAIN}>
          <PageHeader
            title="Price book"
            description="Your products, priced from your own supplies, labor and markup. Test a quote to see the price before a customer does."
          />
          <PriceBook
            baseUrl={`/api/app/${company.id}/estimator`}
            canManage={can.includes("estimator.pricebook.manage")}
            title={false}
            showTechnical={isStaff}
            locale={locale}
          />
        </main>
      )}
    </CompanyGate>
  );
}
