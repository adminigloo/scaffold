import { InvoiceEditor } from "__SCOPE__/invoicing-widget/admin";
import { CompanyGate } from "@/components/CompanyGate";
import { CustomerLinkSlot } from "@/components/CustomerLinkSlot";
import { RecordFilesSlot } from "@/components/RecordFilesSlot";

export const dynamic = "force-dynamic";

/**
 * One of the company's invoices (Tenancy 2a): its lines (editable until money
 * is against it), Send — emailed to the customer FROM the company, with a link
 * to the company's own invoice page — Copy link and Preview, the status in
 * words, and the payments (record one; reverse one with a reason, keeping
 * both on record).
 *
 * The invoice is read through THIS company's routes; an id from another
 * company is "not found" there, whatever the URL says.
 *
 * Under it, the invoice's photos and files (Tenancy 2b-1): a signed work
 * order, a receipt — the team's, never sent to the customer. RecordFilesSlot
 * is generated: nothing without file storage. Above it, "Customer: Mrs Lee →"
 * (create-app 0.35; CustomerLinkSlot is nothing without the customer list).
 */
export default async function CompanyInvoicePage({ params }: { readonly params: Promise<{ readonly id: string }> }) {
  const { id } = await params;
  return (
    <CompanyGate path={`/app/invoices/${encodeURIComponent(id)}`} permission="invoices.view">
      {({ company }) => (
        <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
          <CustomerLinkSlot tenantId={company.id} kind="invoice" refId={id} />
          <InvoiceEditor baseUrl={`/api/app/${company.id}/invoices`} invoiceId={id} backHref="/app/invoices" />
          <div className="mt-8">
            <RecordFilesSlot
              baseUrl={`/api/app/${company.id}/files`}
              record={{ type: "invoicing.invoice", id }}
              hint="Your team sees these; they aren't sent to the customer."
            />
          </div>
        </main>
      )}
    </CompanyGate>
  );
}
