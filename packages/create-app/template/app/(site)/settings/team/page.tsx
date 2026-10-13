import { TeamManager } from "__SCOPE__/tenancy-widget";
import { CompanyGate } from "@/components/CompanyGate";
import { PageHeader } from "@/components/ui";
import { AFTER_AUTH_PATH, NOUN, TENANCY_API } from "@/tenancy";

/**
 * Who is in the active __TENANT_LABEL_LOWER__, and who has been invited.
 *
 * In EVERY project, both modes: a single business still invites its staff.
 * The screen is the package's <TeamManager> — invite by email with a role,
 * resend, withdraw, change a role (with a confirmation that says what it
 * changes), remove, leave, and hand over ownership with the name typed. Every
 * row says what THIS person may do to it, worked out on the server, so the
 * page never offers a button the server would refuse.
 *
 * THE GATE IS HERE, on the page, not in a layout. A layout doesn't re-render on
 * client navigation, and "the parent checked" is not something anything
 * enforces — a page can be reached by a route that doesn't sit under the
 * layout you assumed. <CompanyGate> sends a signed-out visitor to sign in, a
 * person with no company to onboarding, shows the suspended screen, and
 * refuses someone without `members.view` in plain words.
 */
export const dynamic = "force-dynamic";

export default async function TeamPage() {
  return (
    <CompanyGate path="/settings/team" permission="members.view">
      {({ company }) => (
        <main className="mx-auto max-w-4xl px-6 py-10">
          <PageHeader
            title="Team"
            description={`Who's in ${company.name}, and who's been invited.`}
          />
          <TeamManager
            baseUrl={TENANCY_API}
            tenantId={company.id}
            noun={NOUN}
            afterLeaveHref={AFTER_AUTH_PATH}
          />
        </main>
      )}
    </CompanyGate>
  );
}
