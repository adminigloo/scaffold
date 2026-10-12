import { ScheduleCalendar } from "__SCOPE__/scheduling-widget/admin";
import { PageHeader } from "@/components/ui";
import { schedulingUrls } from "@/server/scheduling";

export const dynamic = "force-dynamic";

/**
 * The schedule: every crew's visits on a day or week calendar, in the
 * business's time zone, with the requests waiting for an answer.
 *
 * __SCOPE__/scheduling-widget's <ScheduleCalendar>, talking to
 * /api/admin/schedule (which checks the signed-in person's staff permissions
 * on every call — this page's layout gate is a convenience, not the boundary).
 *
 *   - Requests from /book-visit arrive in the Requests list. Accept or decline;
 *     the customer is emailed the answer with a link to their visit.
 *   - Drag a visit to move it, or to another crew's column to reassign it;
 *     you're asked whether to email the customer first. A move that clashes
 *     with another visit or the crew's hours is put back with the reason.
 *   - Click a visit for its details, to mark it started, done or a no-show,
 *     to move it, change the crew or edit the details.
 *   - New visit books one for a customer on the phone, with suggested times.
 *
 * ?date=YYYY-MM-DD opens the calendar on that day — how a visit listed on an
 * estimate (/admin/estimates/[id]) links here. Anything else is ignored.
 *
 * Unanswered requests are released after the hours set in Schedule settings.
 */
export default async function SchedulePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { date } = await searchParams;
  const initialDate = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
  return (
    <>
      <PageHeader
        title="Schedule"
        description="Every crew's visits, in your business's time zone. Online requests wait in Requests until you accept or decline them; drag a visit to move it."
      />
      <ScheduleCalendar baseUrl="/api/admin/schedule" bookingPageUrl={schedulingUrls.book} initialDate={initialDate} />
    </>
  );
}
