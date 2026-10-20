import Link from "next/link";
import { AlertsInbox } from "__SCOPE__/notifications-widget/admin";
import { CompanyGate } from "@/components/CompanyGate";
import { PageHeader, WORK_MAIN, buttonClass } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The company's alerts, for the person reading them (Tenancy 2b-1): every
 * alert of theirs in THIS company — new estimate requests, visit requests and
 * customers' changes, invoices opened, paid or overdue, emails that didn't go,
 * teammates who joined or left — grouped by day, unread first in bold, each
 * opening the thing it is about. "Mark all as read", "Load more", and a link
 * to Alert settings.
 *
 * __SCOPE__/notifications-widget's <AlertsInbox>, talking to THIS company's
 * routes (/api/app/{company id}/alerts). Someone in two companies sees this
 * company's alerts here; the bell in the header follows what is read.
 *
 * `hideTitle` (review BO-11): this page's own header already says "Alerts"
 * and links to Alert settings, so the inbox draws neither again.
 */
export default async function CompanyAlertsPage() {
  return (
    <CompanyGate path="/app/alerts" permission="alerts.view">
      {({ company }) => (
        <main className={WORK_MAIN}>
          <PageHeader
            title="Alerts"
            description={`What happened at ${company.name} that you asked to hear about.`}
            actions={
              <Link href="/app/alerts/settings" className={buttonClass("secondary")}>
                Alert settings
              </Link>
            }
          />
          <AlertsInbox baseUrl={`/api/app/${company.id}/alerts`} hideTitle />
        </main>
      )}
    </CompanyGate>
  );
}
