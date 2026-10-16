import { EstimateEditor } from "__SCOPE__/estimator-widget/admin";
import { CompanyGate } from "@/components/CompanyGate";
import { RecordFilesSlot } from "@/components/RecordFilesSlot";

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
/**
 * The estimate's "Other files" card (Tenancy 2b-1; reviews BO-13, BO-22):
 * the editor above already has its own "Photos" panel — the job's photos the
 * estimate reads — so this card is for everything else (a site plan, a
 * permit). RecordFilesSlot is generated: nothing without file storage.
 */
const ESTIMATE_FILES_HINT =
  "Photos of the job go in Photos above, so the estimate can read them. Your team sees these; they aren't sent to the customer.";

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
          <div className="mt-8">
            <RecordFilesSlot
              baseUrl={`/api/app/${company.id}/files`}
              record={{ type: "estimator.estimate", id }}
              title="Other files"
              hint={ESTIMATE_FILES_HINT}
            />
          </div>
        </main>
      )}
    </CompanyGate>
  );
}
