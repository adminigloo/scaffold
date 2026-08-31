import Link from "next/link";
import type { ReactNode } from "react";
import { AcceptInvitation } from "@/components/invitations/AcceptInvitation";
import { Card, CardBody, Notice, PageHeader, buttonClass } from "@/components/ui";
import { invitePath } from "@/invitations";
import { currentPrincipal } from "@/server/auth";

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
 * because they are holding it, and every real answer comes from a mutation
 * somebody deliberately triggers.
 *
 * The consequence is that an unknown token is indistinguishable from a real one
 * until it is redeemed, which is exactly the property wanted: this page never
 * confirms or denies that a token ever existed.
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
  // hands the accept mutation "[object Promise]", which reports every real
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
          title="You have been invited"
          description="Create an account or sign in, and this page will pick up where it left off."
        />
        <Card>
          <CardBody className="flex flex-col gap-4">
            <p className="max-w-[62ch] text-sm text-ink-muted">
              We will not say who invited you or what to until you are signed in.
              A link in an inbox is read by more than the person it was sent to,
              and there is nothing here worth telling a mail scanner.
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
        <Notice tone="info" title="Keep this tab open">
          The link is the invitation. If you lose it, whoever invited you has to
          send a new one &mdash; we store a hash of it and cannot recover the
          original.
        </Notice>
      </Main>
    );
  }

  return (
    <Main>
      <PageHeader
        title="Accept your invitation"
        description="Nothing happens until you press the button."
      />
      <AcceptInvitation token={token} signedInAs={principal.email} />
    </Main>
  );
}

function Main({ children }: { readonly children: ReactNode }) {
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 px-6 py-12">{children}</main>
  );
}
