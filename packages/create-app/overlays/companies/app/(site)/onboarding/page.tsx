import { redirect } from "next/navigation";
import { Onboarding } from "__SCOPE__/tenancy-widget";
import { sessionToWire } from "__SCOPE__/tenancy/server";
import { env } from "@/env";
import { currentPrincipal, verifiedEmails } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";
import { tenancy } from "@/server/tenancy";
import {
  AFTER_AUTH_PATH,
  NOUN,
  PUBLIC_COMPANY_PREFIX,
  STAFF_CONSOLE_HREF,
  TENANCY_API,
} from "@/tenancy";

/**
 * "What's your __TENANT_LABEL_LOWER__ called?" — where a new owner lands after
 * signing up (Tenancy 1).
 *
 * The screen is the package's <Onboarding>: the name, the web address
 * suggested from it (editable, reserved words refused in a sentence), and one
 * button that creates the __TENANT_LABEL_LOWER__ with them as its owner. A
 * refresh or a double-click can't make two: the form's key replays. Someone
 * with an invitation waiting for their VERIFIED address is offered it here
 * instead of being made to start a new one; someone removed from their only
 * __TENANT_LABEL_LOWER__ is told which one; and the platform's own staff get a
 * "Go to the admin console" link rather than a nudge to create a fake customer.
 *
 * `?another` is "create another" from the header switcher: the same form, for
 * someone who already has one.
 */
export const dynamic = "force-dynamic";

export default async function OnboardingPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly another?: string | string[] }>;
}) {
  const principal = await currentPrincipal();
  if (!principal) redirect(`/sign-up?redirect_url=${encodeURIComponent("/onboarding")}`);

  const another = (await searchParams).another !== undefined;
  const session = await tenancy.resolveSession({
    userId: principal.userId,
    verifiedEmails: await verifiedEmails(),
  });
  // Already in one (or suspended in one, which the dashboard explains):
  // nothing to name unless they asked to create another.
  if (session.state !== "needs-onboarding" && !another) redirect(AFTER_AUTH_PATH);

  const isStaff = (await loadStaffPermissions({ principal })) !== null;

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <Onboarding
        initialSession={sessionToWire(session)}
        purpose={another ? "additional" : "onboarding"}
        baseUrl={TENANCY_API}
        publicUrlPrefix={new URL(PUBLIC_COMPANY_PREFIX, env.NEXT_PUBLIC_APP_URL).toString()}
        afterHref={AFTER_AUTH_PATH}
        noun={NOUN}
        staffConsoleHref={isStaff ? STAFF_CONSOLE_HREF : null}
      />
    </main>
  );
}
