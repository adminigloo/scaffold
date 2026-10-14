import { InvoicesLedger } from "__SCOPE__/invoicing-widget/admin";
import { CompanyGate } from "@/components/CompanyGate";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The company's invoices (Tenancy 2a): raise one (or open the one an accepted
 * quote became), filter by where each stands — draft, sent, viewed, partly
 * paid, overdue, paid, void — and open one to send it, copy the customer's
 * link, and record what they paid.
 *
 * __SCOPE__/invoicing-widget's <InvoicesLedger>, talking to THIS company's
 * routes (/api/app/{company id}/invoices). Money is in the company's currency
 * and dates in its time zone; "how customers pay you" comes from company
 * settings (the ledger says so until it's filled in).
 *
 * Someone who may only LOOK (a viewer: `invoices.view` without
 * `invoices.manage`) gets the ledger without "New invoice" (`canManage`); each
 * invoice's page already offers only what the server says they may do.
 */
export default async function CompanyInvoicesPage() {
  return (
    <CompanyGate path="/app/invoices" permission="invoices.view">
      {({ company, can }) => (
        <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
          <PageHeader title="Invoices" description="Raise an invoice, send it, and record what customers pay." />
          <InvoicesLedger
            baseUrl={`/api/app/${company.id}/invoices`}
            invoiceHref="/app/invoices/{id}"
            canManage={can.includes("invoices.manage")}
          />
        </main>
      )}
    </CompanyGate>
  );
}
