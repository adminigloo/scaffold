import { EstimateEditor } from "__SCOPE__/estimator-widget/admin";
import { CompanyGate } from "@/components/CompanyGate";

export const dynamic = "force-dynamic";

/**
 * One of the company's estimates (Tenancy 2a): the customer and their photo,
 * the priced lines to edit, and Send quote — then the quote's life (viewed,
 * accepted, declined), the visit booked from it and, with invoicing, the
 * invoice it became.
 *
 * The estimate is read through THIS company's routes; an id from another
 * company is "not found" there, whatever the URL says. `estimateHref` opens a
 * duplicate on its own page.
 *
 * Someone who may only LOOK (a viewer: `estimator.view` without
 * `estimator.estimates.manage`) sees the whole estimate read-only
 * (`canManage`): no Send quote, no edits, no photo added — rather than buttons
 * the server would refuse.
 */
export default async function CompanyEstimatePage({ params }: { readonly params: Promise<{ readonly id: string }> }) {
  const { id } = await params;
  return (
    <CompanyGate path={`/app/estimates/${encodeURIComponent(id)}`} permission="estimator.view">
      {({ company, can }) => (
        <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
          <EstimateEditor
            baseUrl={`/api/app/${company.id}/estimator`}
            estimateId={id}
            backHref="/app/estimates"
            estimateHref="/app/estimates/{id}"
            canManage={can.includes("estimator.estimates.manage")}
          />
        </main>
      )}
    </CompanyGate>
  );
}
