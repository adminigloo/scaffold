import { InvoiceEditor } from "__SCOPE__/invoicing-widget/admin";

export const dynamic = "force-dynamic";

/**
 * One invoice: its lines (editable until money is against it), Send — emailed
 * to the customer when this project sends email — Copy link and Preview, the
 * status in words, and the payments (record one; reverse one with a reason,
 * keeping both on record). __SCOPE__/invoicing-widget's <InvoiceEditor>, over
 * /api/admin/invoices.
 *
 * An estimate's page links here for the invoice it became.
 */
export default async function InvoicePage({ params }: { readonly params: Promise<{ readonly id: string }> }) {
  const { id } = await params;
  return <InvoiceEditor baseUrl="/api/admin/invoices" invoiceId={id} backHref="/admin/invoices" />;
}
