"use client";

import { useClerk } from "@clerk/nextjs";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button, Card, CardBody, Notice, buttonClass } from "@/components/ui";
import { invitePath } from "@/invitations";
import { api } from "@/trpc/client";

/**
 * The button that redeems an invitation, and a screen for every way that ends.
 *
 * SIX OUTCOMES, SIX SCREENS. The procedure returns a discriminated union rather
 * than throwing, because a thrown error collapses "your link expired", "you
 * were already in", "somebody withdrew this" and "we have never seen this
 * token" into one red box that offers the same non-advice to all four. They are
 * different facts about the world and the next step differs for each: one is
 * "ask for a new link", one is "you are done, here is the door", one is "you
 * are signed in as the wrong person". A screen that cannot tell them apart
 * sends every one of those people to support.
 *
 * REDEEMING IS A MUTATION, TRIGGERED BY A PERSON. The page it sits on renders
 * on GET, and a GET with a bearer token in the URL is fetched by prefetchers,
 * mail scanners and preview bots. Accepting during render would let a scanner
 * join the __TENANT_LABEL_LOWER__ on the invitee's behalf — the invitation is
 * spent, the audit log names the invitee, and the invitee themselves never saw
 * the page.
 *
 * `useClerk` is safe here even though the root layout mounts no ClerkProvider
 * on a deployment with no Clerk keys: this component renders only inside the
 * signed-in branch of the invite page, and there is no signed-in branch without
 * Clerk. Signing out and returning to THIS url is the only real next step for a
 * wrong-address invitation — sending somebody to /sign-in with a live session
 * would redirect them straight back here as the same person.
 */
export interface AcceptInvitationProps {
  readonly token: string;
  /** Whatever address this session belongs to. Null until Clerk mirrors one. */
  readonly signedInAs: string | null;
}

export function AcceptInvitation({ token, signedInAs }: AcceptInvitationProps) {
  const clerk = useClerk();
  const accept = api.invitations.accept.useMutation();
  const result = accept.data;

  if (accept.error) {
    return (
      <Outcome
        tone="danger"
        title="We could not check that link"
        action={
          <Button variant="primary" onClick={() => accept.mutate({ token })}>
            Try again
          </Button>
        }
      >
        {accept.error.message}
      </Outcome>
    );
  }

  if (result === undefined) {
    return (
      <Card>
        <CardBody className="flex flex-col gap-4">
          <p className="max-w-[62ch] text-sm text-ink-muted">
            You are signed in as{" "}
            <span className="font-medium text-ink">{signedInAs ?? "this account"}</span>.
            Accepting adds this account to whichever __TENANT_LABEL_LOWER__ the
            invitation is for, with the role it carries.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={accept.isPending}
              onClick={() => accept.mutate({ token })}
            >
              {accept.isPending ? "Accepting…" : "Accept invitation"}
            </Button>
            <button
              type="button"
              className={buttonClass("secondary")}
              onClick={() => void clerk.signOut({ redirectUrl: invitePath(token) })}
            >
              Use a different account
            </button>
          </div>
        </CardBody>
      </Card>
    );
  }

  switch (result.status) {
    case "accepted":
      return (
        <Outcome
          tone="info"
          title={`You are now a member of ${result.tenantName}`}
          action={
            <Link href="/members" className={buttonClass("primary")}>
              See the members
            </Link>
          }
        >
          The invitation has been spent &mdash; the link you followed will not
          work a second time, for you or for anybody it was forwarded to.
        </Outcome>
      );

    case "already-a-member":
      return (
        <Outcome
          tone="info"
          title={`You were already in ${result.tenantName}`}
          action={
            <Link href="/members" className={buttonClass("primary")}>
              See the members
            </Link>
          }
        >
          Nothing changed, and nothing needed to. Your existing role is
          untouched: an invitation never quietly overwrites the access somebody
          already has.
        </Outcome>
      );

    case "expired":
      return (
        <Outcome tone="warn" title="This invitation has expired">
          Ask whoever invited you to send another. Resending mints a fresh link
          rather than posting this one again, because only a hash of it was ever
          stored &mdash; so the new mail will carry a different URL.
        </Outcome>
      );

    case "revoked":
      return (
        <Outcome tone="warn" title="This invitation was withdrawn">
          Somebody with access to the __TENANT_LABEL_LOWER__ cancelled it before
          it was used. If that looks like a mistake, ask them to invite you
          again.
        </Outcome>
      );

    case "wrong-email":
      return (
        <Outcome
          tone="warn"
          title="This invitation is for a different address"
          action={
            <button
              type="button"
              className={buttonClass("primary")}
              onClick={() => void clerk.signOut({ redirectUrl: invitePath(token) })}
            >
              Sign in as somebody else
            </button>
          }
        >
          {/* The invited address is deliberately not printed. Whoever holds the
              link received the mail and already knows it; anybody else holding
              it would be handed a colleague's address by a page that has just
              refused them. */}
          You are signed in as{" "}
          <span className="font-medium text-ink">{signedInAs ?? "this account"}</span>,
          and the invitation was sent to somebody else. Signing out brings you
          back here.
        </Outcome>
      );

    case "unknown":
      return (
        <Outcome
          tone="danger"
          title="This link cannot be used"
          action={
            <Link href="/" className={buttonClass("secondary")}>
              Go to the home page
            </Link>
          }
        >
          {/* Says nothing about whether the token ever existed. An invitation
              that was accepted last week and one that was never issued produce
              the same sentence on purpose — the alternative turns this page
              into an oracle for anybody holding a list of guesses. */}
          Check that you copied the whole link, including anything after the
          last slash. If it still does not work, ask whoever invited you to send
          a new one.
        </Outcome>
      );
  }
}

function Outcome({
  tone,
  title,
  action,
  children,
}: {
  readonly tone: "info" | "warn" | "danger";
  readonly title: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <Notice tone={tone} role="status" title={title}>
          {children}
        </Notice>
        {action && <div className="flex flex-wrap gap-2">{action}</div>}
      </CardBody>
    </Card>
  );
}
