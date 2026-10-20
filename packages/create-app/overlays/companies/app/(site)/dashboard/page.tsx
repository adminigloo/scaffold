import Link from "next/link";
import { SetupChecklist } from "__SCOPE__/tenancy-widget";
import { CompanyGate } from "@/components/CompanyGate";
import { DashboardBody } from "@/components/Dashboard";
import { PageHeader, WORK_MAIN, buttonClass } from "@/components/ui";
import { CREW_HOME, dashboardOverview, type DashboardOverview } from "@/server/dashboard";
import { tenancy } from "@/server/tenancy";
import { NOUN, TENANCY_API } from "@/tenancy";

/** What the page shows when the numbers can't be read at all: nothing invented. */
const NOTHING_READ: DashboardOverview = { numbers: [], lists: [], fresh: false, hint: null };

/**
 * The active __TENANT_LABEL_LOWER__'s home (create-app 0.36, the showroom;
 * 0.36.1): the business at a glance, not a second copy of the sidebar.
 *
 *   - THE NUMBERS, ALWAYS — Today, New leads, Money owed, Paid this week —
 *     real figures from the __TENANT_LABEL_LOWER__'s own rows
 *     (src/server/dashboard.ts), each only when this project has the feature
 *     and this person may open it. An unfinished setup never hides them: a
 *     __TENANT_LABEL_LOWER__ can be busy before its last setting is saved.
 *   - THE SETUP CHECKLIST, while the owner has something left: one compact
 *     card above the numbers ("2 things left to set up") that opens into the
 *     list, and is gone once everything is done or skipped, or the list is
 *     hidden. A brand-new __TENANT_LABEL_LOWER__ (nothing to count yet) gets
 *     it open, and its zeros come with one plain sentence on what fills them.
 *   - UP TO THREE SHORT LISTS under the numbers — today's visits, the newest
 *     leads, the overdue invoices — by the same rules, each line opening its
 *     record and each list its page ("See all").
 *
 * <CompanyGate> does the deciding — signed out → sign in; no
 * __TENANT_LABEL_LOWER__ yet → onboarding; suspended → the suspended screen —
 * so a new owner who signs up lands here and is walked on to "What's your
 * __TENANT_LABEL_LOWER__ called?".
 *
 * ANY MEMBER MAY OPEN IT (Tenancy 2a, D9). A crew member's role holds only
 * their own route — not even `tenant.view` — so the gate asks for membership
 * and nothing more, and what the page SHOWS is filtered by permission: the
 * checklist lists only the items the person can act on (none for a crew
 * member), and a crew member gets one shortcut: Today's route.
 */
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  return (
    <CompanyGate path="/dashboard">
      {async ({ principal, company, can, locale }) => {
        const owner = can.includes("tenant.edit");
        // Both read on the server, side by side, so nothing flashes in.
        const [checklist, overview] = await Promise.all([
          owner ? tenancy.getChecklist({ actorUserId: principal.userId, tenantId: company.id }).catch(() => null) : null,
          dashboardOverview(company.id, can, locale).catch(() => NOTHING_READ),
        ]);
        const settingUp = checklist !== null && checklist.items.length > 0 && !checklist.complete && !checklist.hidden;
        // A crew member's whole job is their route: one button to it (generated:
        // null in a project without scheduling).
        const crewHome = overview.numbers.length === 0 && can.includes("schedule.route") && !can.includes("schedule.view") ? CREW_HOME : null;
        return (
          <main className={WORK_MAIN}>
            <PageHeader
              title={company.name}
              description={
                settingUp && overview.fresh
                  ? `A few things to finish, and ${company.name} is ready for customers.`
                  : `How ${company.name} is doing today.`
              }
              actions={
                <Link href={company.publicPath} className={buttonClass("secondary")} target="_blank" rel="noreferrer">
                  See your page
                </Link>
              }
            />
            {/* Someone who joined the team (not the owner) is told why they see
                what they see (review R2 T1BO-11). */}
            {owner ? null : (
              <p className="mb-6 max-w-[62ch] text-sm text-ink-muted" data-member-note="">
                {`You're part of ${company.name}. Your role decides what you can open here; ask the owner if something you need is missing.`}
              </p>
            )}
            <DashboardBody
              overview={overview}
              setup={
                settingUp && checklist ? (
                  <SetupChecklist
                    baseUrl={TENANCY_API}
                    tenantId={company.id}
                    noun={NOUN}
                    initial={checklist}
                    collapsible
                    defaultOpen={overview.fresh}
                  />
                ) : null
              }
            />
            {crewHome ? (
              <Link href={crewHome} className={buttonClass("primary")}>
                Open today&apos;s route
              </Link>
            ) : null}
          </main>
        );
      }}
    </CompanyGate>
  );
}
