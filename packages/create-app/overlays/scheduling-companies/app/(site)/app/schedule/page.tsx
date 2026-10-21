import Link from "next/link";
import { ScheduleCalendar, ScheduleCalendarActions } from "__SCOPE__/scheduling-widget/admin";
import { CompanyGate } from "@/components/CompanyGate";
import { PageHeader, WORK_MAIN, buttonClass } from "@/components/ui";
import { companyLinksFor } from "@/server/company-links";
import { VISIT_FILES_HREF } from "@/server/visit-files";

export const dynamic = "force-dynamic";

/**
 * The company's schedule (Tenancy 2a): every crew's visits on a day or week
 * calendar, in the company's own time zone, with the online requests waiting
 * for an answer.
 *
 * __SCOPE__/scheduling-widget's <ScheduleCalendar>, talking to THIS company's
 * routes — /api/app/{company id}/schedule — which ask on every call whether
 * the signed-in person may (`schedule.view` to look, `schedule.manage` to book,
 * accept, move or cancel). <CompanyGate> picks the company the person has
 * switched to and refuses someone whose role can't see the schedule.
 *
 *   - Requests from the company's booking page (/t/{web address}/book-visit)
 *     arrive in Requests. Accept or decline; the customer is emailed the
 *     answer, from the company, with a link to their visit.
 *   - Drag a visit to move it or give it to another crew; New visit books one
 *     for a customer on the phone.
 *   - Someone who may only LOOK (a viewer: `schedule.view` without
 *     `schedule.manage`) gets the same calendar read-only (`canManage`): no
 *     Accept or Decline, no dragging, no New visit — rather than buttons the
 *     server would refuse. The server still decides; this only stops offering.
 *
 * ?date=YYYY-MM-DD opens the calendar on that day (how a visit listed on an
 * estimate links here), ?view=day or ?view=week picks the view (the
 * dashboard's "Today" opens today's day), and ?visit={id} opens that visit
 * (how an alert about it links here; Tenancy 2b-1). "New visit" sits in the
 * page header, beside the title, like every work page's primary action. A visit's "Photos and files" opens its own
 * page (VISIT_FILES_HREF, generated: nothing without file storage).
 */
export default async function CompanySchedulePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { date, visit, view } = await searchParams;
  const initialDate = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
  const initialView = view === "day" || view === "week" ? view : undefined;
  // An id's shape only (1–128 of letters, digits, _ and -); the calendar asks
  // THIS company's routes for it, so another company's id is simply not found.
  const initialVisitId = typeof visit === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(visit) ? visit : undefined;
  return (
    <CompanyGate path="/app/schedule" permission="schedule.view">
      {({ company, can, isStaff, locale }) => (
        <main className={WORK_MAIN}>
          <PageHeader
            title="Schedule"
            description="Every crew's visits, in your time zone. Online requests wait in Requests for your answer; drag a visit to move it."
            actions={
              <>
                <Link href="/app/schedule/settings" className={buttonClass("secondary")}>
                  Schedule settings
                </Link>
                {can.includes("schedule.manage") ? <ScheduleCalendarActions className={buttonClass("primary")} /> : null}
              </>
            }
          />
          <ScheduleCalendar
            baseUrl={`/api/app/${company.id}/schedule`}
            bookingPageUrl={companyLinksFor(company.slug).bookVisit()}
            initialDate={initialDate}
            initialView={initialView}
            initialVisitId={initialVisitId}
            actionsInHeader
            visitFilesHref={VISIT_FILES_HREF}
            canManage={can.includes("schedule.manage")}
            showTechnical={isStaff}
            locale={locale}
          />
        </main>
      )}
    </CompanyGate>
  );
}
