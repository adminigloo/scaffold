import { InvoicesLedger, InvoicesLedgerActions } from "__SCOPE__/invoicing-widget/admin";
import { PaymentsAttention } from "@/components/PaymentsAttention";
import { PageHeader, buttonClass } from "@/components/ui";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";

export const dynamic = "force-dynamic";

/** The ledger's filters a link may open on (?status=…). */
type InvoiceFilter = "draft" | "sent" | "viewed" | "partial" | "overdue" | "paid" | "void";
const INVOICE_FILTERS: ReadonlySet<string> = new Set<InvoiceFilter>(["draft", "sent", "viewed", "partial", "overdue", "paid", "void"]);

/**
 * The business's invoices: raise one (or open the one an accepted quote
 * became), filter by where each stands, and open one to send it, copy the
 * customer's link, and record what they paid.
 *
 * __SCOPE__/invoicing-widget's <InvoicesLedger>, talking to
 * /api/admin/invoices — the package's own handlers, which check this
 * project's staff keys on every call (`staff.invoices.view` to look,
 * `staff.invoices.manage` to raise, send and take payments). Before Tenancy 2a
 * this page was copied source over a tRPC router; now a fix to the ledger
 * reaches this project with `pnpm update`.
 *
 * `invoiceHref` is a pattern ({id} is filled in by the widget), because a
 * server page can't hand a function to a client component.
 *
 * `canManage` is read from the same staff permissions the admin layout
 * already resolved (the Messages page's rule), so someone who may only look
 * isn't offered "New invoice"; the server refuses it anyway without the key.
 */
export default async function InvoicesPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;
  const manage = can?.can("staff.invoices.manage") ?? false;
  // ?status=overdue (or any filter of the ledger's) opens on it.
  const { status } = await searchParams;
  const initialFilter = typeof status === "string" && INVOICE_FILTERS.has(status) ? (status as InvoiceFilter) : null;
  return (
    <>
      {/* New invoice beside the title, like every page's primary action (polish 3). */}
      <PageHeader
        title="Invoices"
        description="Raise an invoice, send it, and record what customers pay."
        actions={manage ? <InvoicesLedgerActions className={buttonClass("primary")} /> : null}
      />
      <InvoicesLedger
        baseUrl="/api/admin/invoices"
        invoiceHref="/admin/invoices/{id}"
        canManage={manage}
        initialFilter={initialFilter}
        actionsInHeader
        title={false}
      />
      {/* Card payments that need you: refunds, disputes, money that couldn't be recorded as it was. */}
      {can?.can("staff.invoices.manage") ? (
        <div className="mt-10">
          <PaymentsAttention baseUrl="/api/admin/invoices" />
        </div>
      ) : null}
    </>
  );
}
