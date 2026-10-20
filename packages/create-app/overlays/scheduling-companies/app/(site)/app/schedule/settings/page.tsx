import { SchedulingSettings } from "__SCOPE__/scheduling-widget/admin";
import { CompanyGate } from "@/components/CompanyGate";
import { PageHeader, WORK_MAIN } from "@/components/ui";
import { companyLinksFor } from "@/server/company-links";

export const dynamic = "force-dynamic";

/**
 * Everything a company decides about scheduling, saved without a developer
 * (Tenancy 2a): online booking on or off, services and their lengths, notice,
 * how far ahead, auto-confirm, how long a request waits, reminders, crews and
 * their hours, and who opens each crew's route.
 *
 * The company's NAME, TIME ZONE and CONTACT are shown here read-only, with a
 * link to company settings: they belong to the company, are typed once in
 * /settings/company, and every feature reads them from there. Changing the
 * zone there keeps every booked visit at its clock time.
 *
 * Anyone who can see the schedule can read this page; only owners and admins
 * (`schedule.resources.manage`) can save — the server decides, and for
 * everyone else every card is read-only (`canManage`) instead of offering a
 * Save the server would refuse. The crew picker lists the company's own members: a
 * new crew member is invited with the Crew role on the Team page first
 * (`inviteHref`).
 *
 * #booking, #crews and #hours open the page on that card (the setup
 * checklist links there).
 */
export default async function CompanyScheduleSettingsPage() {
  return (
    <CompanyGate path="/app/schedule/settings" permission="schedule.view">
      {({ company, can, isStaff, locale }) => (
        <main className={WORK_MAIN}>
          <PageHeader
            title="Schedule settings"
            description="Online booking, customer messages, crews and hours. Changes apply as soon as you save."
          />
          <div className="max-w-4xl">
            <SchedulingSettings
              baseUrl={`/api/app/${company.id}/schedule`}
              bookingPageUrl={companyLinksFor(company.slug).bookVisit()}
              inviteHref="/settings/team"
              canManage={can.includes("schedule.resources.manage")}
              showTechnical={isStaff}
              locale={locale}
            />
          </div>
        </main>
      )}
    </CompanyGate>
  );
}
