import Link from "next/link";
import type { ReactNode } from "react";
import { AcceptInvitation } from "__SCOPE__/tenancy-widget";
import { Card, CardBody, PageHeader, buttonClass } from "@/components/ui";
import { invitePath } from "@/invitations";
import { currentPrincipal } from "@/server/auth";
import { AFTER_AUTH_PATH, NOUN, TENANCY_API } from "@/tenancy";

/**
 * Where an invitation link lands.
 *
 * This page is reached by somebody who may have no account, may have the wrong
 * one open, and has certainly not seen this application before. That makes it
 * the one route in the scaffold whose signed-out path is the MAIN path rather
 * than an edge case, and getting it wrong costs the invitee entirely: they sign
 * up, Clerk drops them on the landing page, the tab with the invitation in it
 * is gone, and the only copy of the token went with it.
 *
 * NOTHING IS LOOKED UP BEFORE SIGN-IN, and that is the security decision on
 * this page rather than an omission. A GET with a token in the URL is fetched
 * by link prefetchers, mail scanners and previewers; resolving the token here
 * would let any of them learn that an invitation exists, which
 * __TENANT_LABEL_LOWER__ it is for, and who sent it — and if the page ACCEPTED
 * on render, a corporate mail scanner would join the __TENANT_LABEL_LOWER__ on
 * the invitee's behalf before they ever clicked. So the signed-out screen says
 * only that an invitation exists at this URL, which the visitor already knew
 * because they are holding it.
 *
 * IN PLAIN WORDS (review R2 T1BO-06). This is the first screen every office
 * manager and crew lead sees, so it says what to do — sign up or sign in, with
 * the address the invitation went to — and nothing about scanners or hashes.
 * It also doesn't say "keep this tab open": the link is still in their email
 * and works again after they sign up.
 *
 * SIGNED IN, the package's <AcceptInvitation> takes over (Tenancy 1). It first
 * asks the server what the link is for — "{company} invited you to join as
 * {role}" — through a POST that only a signed-in person can make (a scanner
 * can't), then accepts only when the person presses the button. When the
 * account's address doesn't match the invitation it offers a way to sign out
 * and back in with the right one (`signOutHref`), instead of just saying so.
 * The screen ships in @__SCOPE_NAME__/tenancy-widget so a fix to it reaches
 * this project by `npm update`.
 *
 * The redirect back here is `forceRedirectUrl` on the Clerk components rather
 * than a hand-rolled `?next=` on the sign-up route, so it survives the whole
 * multi-step flow — email verification, a second factor, an account that turned
 * out to already exist — every one of which is a separate navigation that would
 * otherwise lose it.
 */
export const dynamic = "force-dynamic";

export default async function InvitePage({
  params,
}: {
  // A Promise since Next 15. Destructuring it synchronously compiles and then
  // hands the accept call "[object Promise]", which reports every real
  // invitation as unknown.
  readonly params: Promise<{ readonly token: string }>;
}) {
  const { token } = await params;
  const principal = await currentPrincipal();
  const here = invitePath(token);

  if (!principal) {
    return (
      <Main>
        <PageHeader
          title="You've been invited"
          description="Create an account or sign in to see your invitation."
        />
        <Card>
          <CardBody className="flex flex-col gap-4">
            <p className="max-w-[62ch] text-sm text-ink-muted">
              Use the email address the invitation was sent to. You can come
              back to this link from your email at any time.
            </p>
            <div className="flex flex-wrap gap-2">
              {/* Both destinations carry the same return path. Somebody who
                  already has an account clicks the second one, and dropping the
                  redirect there would strand exactly the people for whom this
                  flow is one click long. */}
              <Link
                href={`/sign-up?redirect_url=${encodeURIComponent(here)}`}
                className={buttonClass("primary")}
              >
                Create an account
              </Link>
              <Link
                href={`/sign-in?redirect_url=${encodeURIComponent(here)}`}
                className={buttonClass("secondary")}
              >
                I already have one
              </Link>
            </div>
          </CardBody>
        </Card>
      </Main>
    );
  }

  return (
    <Main>
      <AcceptInvitation
        baseUrl={TENANCY_API}
        token={token}
        signedInAs={principal.email}
        afterHref={AFTER_AUTH_PATH}
        noun={NOUN}
        // Out, then straight back to sign-in with THIS page as the return
        // path, so signing in with the address the invitation was sent to
        // lands on it again.
        signOutHref={`/sign-out?redirect_url=${encodeURIComponent(
          `/sign-in?redirect_url=${encodeURIComponent(here)}`,
        )}`}
      />
    </Main>
  );
}

function Main({ children }: { readonly children: ReactNode }) {
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 px-6 py-12">{children}</main>
  );
}
