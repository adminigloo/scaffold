import { InvoiceEditor } from "__SCOPE__/invoicing-widget/admin";
import { CustomerLinkSlot } from "@/components/CustomerLinkSlot";
import { RecordFilesSlot } from "@/components/RecordFilesSlot";

export const dynamic = "force-dynamic";

/**
 * One invoice: its lines (editable until money is against it), Send — emailed
 * to the customer when this project sends email — Copy link and Preview, the
 * status in words, and the payments (record one; reverse one with a reason,
 * keeping both on record). __SCOPE__/invoicing-widget's <InvoiceEditor>, over
 * /api/admin/invoices.
 *
 * An estimate's page links here for the invoice it became.
 *
 * Under it, the invoice's photos and files (Tenancy 2b-1): the team's, never
 * sent to the customer. RecordFilesSlot is generated: nothing without file
 * storage.
 */
export default async function InvoicePage({ params }: { readonly params: Promise<{ readonly id: string }> }) {
  const { id } = await params;
  return (
    <>
      {/* "Customer: Mrs Lee →" (create-app 0.35): nothing without the customer list. */}
      <CustomerLinkSlot kind="invoice" refId={id} />
      <InvoiceEditor baseUrl="/api/admin/invoices" invoiceId={id} backHref="/admin/invoices" />
      <div className="mt-8">
        <RecordFilesSlot
          baseUrl="/api/admin/files"
          record={{ type: "invoicing.invoice", id }}
          hint="Your team sees these; they aren't sent to the customer."
        />
      </div>
    </>
  );
}
