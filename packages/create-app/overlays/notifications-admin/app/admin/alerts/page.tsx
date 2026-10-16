import Link from "next/link";
import { AlertsInbox } from "__SCOPE__/notifications-widget/admin";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Your alerts (Tenancy 2b-1): every alert of yours — new estimate requests,
 * visit requests and customers' changes, invoices opened, paid or overdue,
 * emails that didn't go — grouped by day, unread first in bold, each opening
 * the thing it is about. "Mark all as read", "Load more", and a link to Alert
 * settings.
 *
 * __SCOPE__/notifications-widget's <AlertsInbox>, over /api/admin/alerts
 * (which checks your staff keys on every call — the admin layout's gate is a
 * convenience, not the boundary). The bell in the header follows what is read.
 * `hideTitle` (review BO-11): the header above already says "Alerts" and
 * links to Alert settings, so the inbox draws neither again.
 */
export default function AlertsPage() {
  return (
    <>
      <PageHeader
        title="Alerts"
        description="What happened that you asked to hear about."
        actions={
          <Link href="/admin/alerts/settings" className="text-sm text-accent underline underline-offset-2">
            Alert settings
          </Link>
        }
      />
      <AlertsInbox baseUrl="/api/admin/alerts" hideTitle />
    </>
  );
}
