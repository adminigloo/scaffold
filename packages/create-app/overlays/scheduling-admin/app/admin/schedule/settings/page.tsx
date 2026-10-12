import { SchedulingSettings } from "__SCOPE__/scheduling-widget/admin";
import { PageHeader } from "@/components/ui";
import { schedulingUrls } from "@/server/scheduling";

export const dynamic = "force-dynamic";

/**
 * Everything a business owner decides about scheduling, on one page, saved
 * to the database — no developer, no deploy:
 *
 *   Business          name, time zone, phone and email customers see
 *   Online booking    on or off, services and their lengths, notice, how far
 *                     ahead, auto-confirm, how long a request waits
 *   Customer messages the reminder, the change/cancel cutoff, who in the
 *                     office hears about new requests
 *   Crews             add, rename, pause online booking, and pick who opens
 *                     the crew's route — picking somebody gives them their
 *                     own route and nothing else (a crew-only staff role),
 *                     so a crew member needs no developer to get started
 *   Hours             each crew's week (split shifts allowed) and days off,
 *                     with a warning when a day off lands on booked visits
 *
 * Changing the time zone keeps every visit at its clock time; with visits
 * booked the page says how many and offers to email those customers. The booking page's address is shown with a copy button, for the
 * website, a Google Business profile or an email signature.
 */
export default function ScheduleSettingsPage() {
  return (
    <>
      <PageHeader
        title="Schedule settings"
        description="Your business, online booking, customer messages, crews and hours. Changes apply as soon as you save."
      />
      <SchedulingSettings baseUrl="/api/admin/schedule" bookingPageUrl={schedulingUrls.book} signInUrl={schedulingUrls.signIn} />
    </>
  );
}
