import Link from "next/link";
import { SetupChecklist } from "__SCOPE__/tenancy-widget";
import { CompanyGate } from "@/components/CompanyGate";
import { PageHeader, StatCard, WORK_MAIN, buttonClass } from "@/components/ui";
import { CREW_HOME, dashboardNumbers } from "@/server/dashboard";
import { tenancy } from "@/server/tenancy";
import { NOUN, TENANCY_API } from "@/tenancy";

/**
 * The active __TENANT_LABEL_LOWER__'s home (create-app 0.36, the showroom):
 * the business at a glance, not a second copy of the sidebar.
 *
 *   - UNTIL SETUP IS DONE: the setup checklist, compact — what's left in
 *     full, what's done folded into one line. Items know when they are done,
 *     "Not needed" can be undone, and the installed features add their own
 *     (prices, crews and hours, invoice details, the website embed;
 *     src/server/setup-checklist.ts).
 *   - ONCE IT'S DONE (or the owner hid the list): the numbers — Today, New
 *     leads, Money owed, Paid this week — real figures from the
 *     __TENANT_LABEL_LOWER__'s own rows (src/server/dashboard.ts), each only
 *     when this project has the feature and this person may open it.
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
        // Server-rendered, so the list never flashes in: and whether it is
        // done decides which half of the page shows.
        const checklist = owner
          ? await tenancy.getChecklist({ actorUserId: principal.userId, tenantId: company.id }).catch(() => null)
          : null;
        const settingUp = checklist !== null && checklist.items.length > 0 && !checklist.complete && !checklist.hidden;
        const numbers = settingUp ? [] : await dashboardNumbers(company.id, can, locale).catch(() => []);
        // A crew member's whole job is their route: one button to it (generated:
        // null in a project without scheduling).
        const crewHome = numbers.length === 0 && can.includes("schedule.route") && !can.includes("schedule.view") ? CREW_HOME : null;
        return (
          <main className={WORK_MAIN}>
            <PageHeader
              title={company.name}
              description={
                settingUp ? `A few things to finish, and ${company.name} is ready for customers.` : `How ${company.name} is doing today.`
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
            {settingUp && checklist ? (
              <div className="max-w-3xl">
                <SetupChecklist baseUrl={TENANCY_API} tenantId={company.id} noun={NOUN} initial={checklist} compact />
              </div>
            ) : null}
            {numbers.length > 0 ? (
              <section aria-label="At a glance" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-dashboard-numbers="">
                {numbers.map((number) => (
                  <StatCard key={number.key} label={number.label} value={number.value} detail={number.detail} href={number.href} />
                ))}
              </section>
            ) : null}
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
