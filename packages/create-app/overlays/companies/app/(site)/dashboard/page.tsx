import Link from "next/link";
import { SetupChecklist } from "__SCOPE__/tenancy-widget";
import { CompanyGate } from "@/components/CompanyGate";
import { PageHeader } from "@/components/ui";
import { APP_LINKS } from "@/nav";
import { NOUN, TENANCY_API } from "@/tenancy";

/**
 * The active __TENANT_LABEL_LOWER__'s home (Tenancy 1): its name, the setup
 * checklist, and where to go next.
 *
 * <CompanyGate> does the deciding — signed out → sign in; no
 * __TENANT_LABEL_LOWER__ yet → onboarding; suspended → the suspended screen —
 * so a new owner who signs up lands here and is walked on to "What's your
 * __TENANT_LABEL_LOWER__ called?".
 *
 * The checklist is the package's <SetupChecklist>: items know when they are
 * done, "Not needed" can be undone, and items other packages add appear here
 * by themselves (src/server/setup-checklist.ts).
 */
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  return (
    <CompanyGate path="/dashboard" permission="tenant.view">
      {({ company, can }) => (
        <main className="mx-auto max-w-4xl px-6 py-10">
          <PageHeader title={company.name} description={`Your ${NOUN.singular} at a glance.`} />
          {/* Someone who joined the team (not the owner) would otherwise land on a
              page with nothing to do and nothing saying why (review R2 T1BO-11). */}
          {can.includes("tenant.edit") ? null : (
            <p className="mb-6 max-w-[62ch] text-sm text-ink-muted" data-member-note="">
              {`You're part of ${company.name}. For now this page shows your team and the ${NOUN.singular}'s details; the tools you'll use day to day will appear here as they're switched on for ${NOUN.plural}.`}
            </p>
          )}
          <SetupChecklist baseUrl={TENANCY_API} tenantId={company.id} noun={NOUN} />
          <nav aria-label="Go to" className="mt-8 grid gap-3 sm:grid-cols-2">
            {APP_LINKS.filter((link) => link.audience === undefined && link.href !== "/dashboard").map(
              (link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="flex min-h-11 items-center rounded-[6px] border border-line bg-surface px-4 py-3 text-sm font-medium text-ink no-underline hover:bg-canvas"
                >
                  {link.label}
                </Link>
              ),
            )}
          </nav>
        </main>
      )}
    </CompanyGate>
  );
}
