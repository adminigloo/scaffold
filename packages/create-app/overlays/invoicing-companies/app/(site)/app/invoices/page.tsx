import { InvoicesLedger, InvoicesLedgerActions } from "__SCOPE__/invoicing-widget/admin";
import { CompanyGate } from "@/components/CompanyGate";
import { PageHeader, WORK_MAIN, buttonClass } from "@/components/ui";

export const dynamic = "force-dynamic";

/** The ledger's filters a link may open on (?status=…). */
type InvoiceFilter = "draft" | "sent" | "viewed" | "partial" | "overdue" | "paid" | "void";
const INVOICE_FILTERS: ReadonlySet<string> = new Set<InvoiceFilter>(["draft", "sent", "viewed", "partial", "overdue", "paid", "void"]);

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
 *
 * "New invoice" sits in the page header, beside the title, like every work
 * page's primary action (<InvoicesLedgerActions> opens the ledger's own
 * form). ?status=overdue (or draft, sent, viewed, partial, paid, void) opens
 * the ledger on that filter — the dashboard's "See all" under Overdue
 * invoices links here that way.
 */
export default async function CompanyInvoicesPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { status } = await searchParams;
  const initialFilter = typeof status === "string" && INVOICE_FILTERS.has(status) ? (status as InvoiceFilter) : null;
  return (
    <CompanyGate path="/app/invoices" permission="invoices.view">
      {({ company, can, isStaff, locale }) => (
        <main className={WORK_MAIN}>
          <PageHeader
            title="Invoices"
            description="What's owed, what's overdue and what's paid. Send an invoice, and customers pay it from a link."
            actions={can.includes("invoices.manage") ? <InvoicesLedgerActions className={buttonClass("primary")} /> : null}
          />
          <InvoicesLedger
            baseUrl={`/api/app/${company.id}/invoices`}
            invoiceHref="/app/invoices/{id}"
            canManage={can.includes("invoices.manage")}
            initialFilter={initialFilter}
            actionsInHeader
            title={false}
            showTechnical={isStaff}
            locale={locale}
          />
        </main>
      )}
    </CompanyGate>
  );
}
