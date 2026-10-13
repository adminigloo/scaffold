import { useEffect, useId, useRef, useState } from "react";
import type { TenancyTransport } from "./client.js";
import { CheckCircleIcon, LiveRegion, navigate, Notice, WidgetRoot, type ChromeProps, type NounProps } from "./parts.js";
import { isUnconnected, useLoaded, useTenancyTransport } from "./transport.js";
import type { AcceptWire, InvitationPreviewWire } from "./types.js";
import { ACCEPT, acceptOutcomeText, errorText, nounOf, NOT_CONNECTED_MESSAGE, ONBOARDING } from "./words.js";

/**
 * <AcceptInvitation> (contract 8.8): the page behind the link in an
 * invitation email.
 *
 * NOTHING HAPPENS UNTIL THE BUTTON IS PRESSED (the 0.3 page's decision, kept).
 * Link scanners and mail previews open every link in an email; if opening the
 * page accepted, a scanner would join the company before the person ever saw
 * it, and the wrong account (a shared computer) would join without a word.
 * The page says who you're signed in as, so the wrong-account case explains
 * itself before anyone presses anything.
 *
 * THE WRONG ADDRESS IS SAID BEFORE ACCEPT (review R2 T1BO-07). When the
 * server's preview says the invitation is for another address, the page shows
 * where it was sent (masked: "c•••@greenblade.test"), which address you're
 * signed in with, and both ways out — sign out and use that address, or ask
 * the person who invited you to invite this one — instead of an Accept button
 * that could only be refused.
 */

export interface AcceptInvitationProps extends ChromeProps, NounProps {
  baseUrl?: string;
  transport?: TenancyTransport;
  token: string;
  /** The signed-in email, shown so a wrong-account case explains itself. */
  signedInAs: string | null;
  /** Where to go once in. Default "/dashboard". */
  afterHref?: string;
  /**
   * Which company, role and inviter the link is for, server-rendered
   * (`tenancy.previewInvitation`). Without it the page asks the transport.
   * Shown above the button so nobody accepts blind (review T1-07).
   */
  preview?: InvitationPreviewWire | null;
  /** Where "Sign out" goes when the invitation was for another address (review T1-07). */
  signOutHref?: string | null;
}

/** How long "You're in" stays before the page moves on by itself. */
export const ACCEPT_REDIRECT_MS = 1500;

export function AcceptInvitation(props: AcceptInvitationProps) {
  const { token, signedInAs, afterHref = "/dashboard", signOutHref = null, theme, nonce, className, style } = props;
  const noun = nounOf(props.noun);
  const transport = useTenancyTransport(props.transport, props.baseUrl);
  const unconnected = isUnconnected(props.transport, props.baseUrl);
  // A read, never an accept: it only says what the link is for.
  const preview = useLoaded(
    () => transport.previewInvitation(token),
    props.preview ?? undefined,
    unconnected || props.preview !== undefined ? null : `preview:${token}`,
  );
  const about = preview.data?.found ? preview.data : null;
  const mismatch = about?.addressMatches === false ? about : null;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [outcome, setOutcome] = useState<AcceptWire | null>(null);
  const [problem, setProblem] = useState("");
  const headingId = useId();
  const resultRef = useRef<HTMLParagraphElement | null>(null);

  const joined = outcome?.status === "accepted" || outcome?.status === "already-a-member";

  useEffect(() => {
    if (!joined) return;
    resultRef.current?.focus();
    const timer = setTimeout(() => navigate(afterHref), ACCEPT_REDIRECT_MS);
    return () => clearTimeout(timer);
  }, [joined, afterHref]);

  const accept = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setProblem("");
    const res = await transport.acceptInvitation(token);
    busyRef.current = false;
    setBusy(false);
    if (res.ok) setOutcome(res.data);
    else setProblem(errorText(res.error, noun));
  };

  const chrome = { theme, nonce, className, style };
  if (unconnected) {
    return (
      <WidgetRoot {...chrome}>
        <div className="aitw-panel aitw-centre">
          <Notice tone="error">{NOT_CONNECTED_MESSAGE}</Notice>
        </div>
      </WidgetRoot>
    );
  }

  return (
    <WidgetRoot {...chrome} data={{ "aitw-accept": outcome?.status ?? "waiting" }}>
      <section className="aitw-panel aitw-centre" aria-labelledby={headingId}>
        <h2 className="aitw-title" id={headingId}>
          {ACCEPT.heading}
        </h2>
        {outcome ? (
          joined ? (
            <div className="aitw-stack-sm">
              <div className="aitw-row">
                <span className="aitw-badge-icon" data-tone="ok">
                  <CheckCircleIcon />
                </span>
                <p className="aitw-h3 aitw-grow" ref={resultRef} tabIndex={-1} data-aitw-outcome="">
                  {acceptOutcomeText(outcome, noun)}
                </p>
              </div>
              <div className="aitw-actions">
                <a className="aitw-btn aitw-btn-primary" href={afterHref}>
                  {ACCEPT.goTo(outcome.company?.name ?? noun.singular)}
                </a>
              </div>
            </div>
          ) : (
            <div className="aitw-stack-sm">
              <Notice tone="warn">
                <span data-aitw-outcome="">{acceptOutcomeText(outcome, noun)}</span>
              </Notice>
              {outcome.status === "wrong-email" && signOutHref ? (
                <div className="aitw-actions">
                  <a className="aitw-btn aitw-btn-secondary" href={signOutHref} data-aitw-sign-out="">
                    {ACCEPT.signOut}
                  </a>
                </div>
              ) : null}
            </div>
          )
        ) : (
          <div className="aitw-stack-sm">
            {about?.companyName ? (
              <div className="aitw-stack-sm" data-aitw-preview="">
                <p className="aitw-h3">
                  {about.roleName ? ACCEPT.invitedAs(about.companyName, about.roleName) : ACCEPT.invitedTo(about.companyName)}
                </p>
                {about.invitedBy ? <p className="aitw-sub">{ONBOARDING.invitedBy(about.invitedBy)}</p> : null}
              </div>
            ) : null}
            {mismatch ? (
              <div className="aitw-stack-sm" data-aitw-mismatch="">
                <Notice tone="warn">
                  {mismatch.sentTo ? ACCEPT.sentTo(mismatch.sentTo) : null}{" "}
                  {ACCEPT.youAre(mismatch.signedInAs ?? signedInAs ?? "")}
                </Notice>
                {signOutHref ? (
                  <div className="aitw-actions">
                    <a className="aitw-btn aitw-btn-primary" href={signOutHref} data-aitw-sign-out="">
                      {ACCEPT.signOutToUse}
                    </a>
                  </div>
                ) : null}
                <p className="aitw-sub">{ACCEPT.askInstead(mismatch.invitedBy, mismatch.signedInAs ?? signedInAs ?? "")}</p>
              </div>
            ) : (
              <>
                <div className="aitw-actions">
                  <button type="button" className="aitw-btn aitw-btn-primary" disabled={busy} aria-busy={busy || undefined} onClick={() => void accept()}>
                    {busy ? ACCEPT.accepting : ACCEPT.accept}
                  </button>
                </div>
                {signedInAs ? <p className="aitw-sub">{ACCEPT.signedInAs(signedInAs)}</p> : null}
              </>
            )}
            {problem ? <Notice tone="error">{problem}</Notice> : null}
          </div>
        )}
        {/* The outcome is on screen already; this only announces it. The failure is the alert above. */}
        <LiveRegion status={outcome ? acceptOutcomeText(outcome, noun) : ""} alert="" srOnly />
      </section>
    </WidgetRoot>
  );
}
