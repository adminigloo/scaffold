import { AlertSettings } from "__SCOPE__/notifications-widget/admin";
import { CompanyGate } from "@/components/CompanyGate";
import { PageHeader, WORK_MAIN } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Alert settings (Tenancy 2b-1), two parts:
 *
 *   1. How YOU get each alert: "In the app", or "In the app and by email",
 *      kind by kind. A change saves at once.
 *   2. Who hears about new work — owners and admins only (`alerts.manage`):
 *      ONE card each for new estimate requests, visit requests and invoices,
 *      "The owner" (with nothing chosen, the owner gets them, at the business
 *      email in __TENANT_LABEL_LOWER__ settings) or "These people", and up to five more
 *      addresses. It replaces the per-feature "send new-request alerts to"
 *      lists, so a lead is never emailed twice.
 *
 * __SCOPE__/notifications-widget's <AlertSettings>, talking to THIS company's
 * routes. Everyone who gets alerts may open it (`alerts.view`); the routes
 * decide who may change the second part. `hideTitle` (review BO-11): the
 * page's own header is the heading, so the settings draw none of their own.
 * `businessEmailSettings`: the business email is set on THIS project's
 * __TENANT_LABEL_LOWER__ settings page, so the sentences that say the owner's emails go
 * there name that page in the project's own word.
 */
export default async function CompanyAlertSettingsPage() {
  return (
    <CompanyGate path="/app/alerts/settings" permission="alerts.view">
      {({ company }) => (
        <main className={WORK_MAIN}>
          <PageHeader title="Alert settings" description={`How you hear about what happens at ${company.name}.`} />
          <AlertSettings baseUrl={`/api/app/${company.id}/alerts`} hideTitle businessEmailSettings="__TENANT_LABEL_LOWER__ settings" />
        </main>
      )}
    </CompanyGate>
  );
}
