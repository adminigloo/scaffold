import Link from "next/link";
import { SetupChecklist } from "__SCOPE__/tenancy-widget";
import { CompanyGate } from "@/components/CompanyGate";
import { PageHeader } from "@/components/ui";
import { APP_LINKS } from "@/nav";
import { NOUN, TENANCY_API } from "@/tenancy";

/**
 * The active __TENANT_LABEL_LOWER__'s home: its name, the setup checklist, and
 * a card for every part of the __TENANT_LABEL_LOWER__ the person may open.
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
 * member), and the cards are the header's own links, filtered the same way
 * (a crew member sees one card: Today's route).
 *
 * The checklist is the package's <SetupChecklist>: items know when they are
 * done, "Not needed" can be undone, and the items the installed features add
 * (prices, crews and hours, invoice details, the website embed) appear here
 * by themselves (src/server/setup-checklist.ts).
 */
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  return (
    <CompanyGate path="/dashboard">
      {({ company, can }) => (
        <main className="mx-auto max-w-4xl px-6 py-10">
          <PageHeader title={company.name} description={`Your ${NOUN.singular} at a glance.`} />
          {/* Someone who joined the team (not the owner) is told why they see
              what they see, rather than meeting a short page with no word
              about it (review R2 T1BO-11). */}
          {can.includes("tenant.edit") ? null : (
            <p className="mb-6 max-w-[62ch] text-sm text-ink-muted" data-member-note="">
              {`You're part of ${company.name}. Your role decides what you can open here; ask the owner if something you need is missing.`}
            </p>
          )}
          <SetupChecklist baseUrl={TENANCY_API} tenantId={company.id} noun={NOUN} />
          <nav aria-label="Go to" className="mt-8 grid gap-3 sm:grid-cols-2">
            {/* A RUNTIME PERMISSION FILTER OVER A GENERATED LIST, not a
                feature `if`: which links exist was settled when src/nav.ts
                was generated; which of them this person may open is settled
                here, from their role in this company. Staff-only links (the
                platform's /admin) belong to the header, never to a card. */}
            {APP_LINKS.filter(
              (link) =>
                link.audience === undefined &&
                link.href !== "/dashboard" &&
                (link.permission === undefined || can.includes(link.permission)),
            ).map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="flex min-h-11 items-center rounded-[6px] border border-line bg-surface px-4 py-3 text-sm font-medium text-ink no-underline hover:bg-canvas"
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </main>
      )}
    </CompanyGate>
  );
}
