import { InvoicesLedger } from "__SCOPE__/invoicing-widget/admin";
import { PageHeader } from "@/components/ui";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";

export const dynamic = "force-dynamic";

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
export default async function InvoicesPage() {
  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;
  return (
    <>
      <PageHeader title="Invoices" description="Raise an invoice, send it, and record what customers pay." />
      <InvoicesLedger
        baseUrl="/api/admin/invoices"
        invoiceHref="/admin/invoices/{id}"
        canManage={can?.can("staff.invoices.manage") ?? false}
      />
    </>
  );
}
