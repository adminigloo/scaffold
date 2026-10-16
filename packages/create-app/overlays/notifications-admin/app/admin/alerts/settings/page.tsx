import { AlertSettings } from "__SCOPE__/notifications-widget/admin";
import { PageHeader } from "@/components/ui";
import { SITE_NAME } from "@/seo";

export const dynamic = "force-dynamic";

/**
 * Alert settings (Tenancy 2b-1): how YOU get each alert ("In the app", or
 * "In the app and by email"), and — for whoever holds
 * `staff.alerts.manage` — who hears about new estimate requests, visit
 * requests and invoices. With nothing chosen, every staff administrator gets
 * them. It replaces the schedule's and the estimator's own "send new-request
 * alerts to" lists, so a lead is never emailed twice.
 *
 * __SCOPE__/notifications-widget's <AlertSettings>, over /api/admin/alerts.
 * `hideTitle` (review BO-11): the header above is the heading.
 */
export default function AlertSettingsPage() {
  return (
    <>
      <PageHeader title="Alert settings" description={`How you hear about what happens at ${SITE_NAME}.`} />
      <AlertSettings baseUrl="/api/admin/alerts" hideTitle />
    </>
  );
}
