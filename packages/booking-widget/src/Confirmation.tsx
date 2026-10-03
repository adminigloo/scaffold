import { useCallback, type MouseEvent, type Ref } from "react";
import type { BookingClient } from "./client.js";
import {
  BookingFacts,
  CalendarActions,
  CheckIcon,
  ClockIcon,
  CopyField,
  REAL_BOOKING_STEPS,
  ReachHostText,
} from "./parts.js";
import { emailsOn, reachHost, type EmailFacts } from "./requests.js";
import type { TimeZoneChoice } from "./time.js";
import type { BookResponse, PublicBooking } from "./types.js";

/**
 * What a visitor sees after booking — and, in sandbox mode, the same thing
 * framed as a preview of what THEIR customer would see, followed by what a real
 * booking sets in motion and one prominent way to book a real call.
 *
 * Medium-aware and literal: it only promises what the contract can deliver
 * (the host's link, the number calls come from, the mailbox to invite), so a
 * phone booking never claims a video link is on its way.
 *
 * Email-aware too. When the server says it sends no email
 * (`config.emailsEnabled === false`), this screen is the ONLY place the
 * visitor ever sees their private manage link — so it stops promising a
 * confirmation and hands them the link as a copyable field instead, with a
 * plain sentence about why it matters.
 */

/**
 * A plain link cannot carry the client key, so a keyed embed downloads the
 * .ics through fetch instead; without a key (same-origin, or a keyless
 * server) the plain link with its `download` attribute does the job.
 */
export function useIcsClick(client: BookingClient, token: string) {
  return useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (!client.clientKey) return;
      event.preventDefault();
      const href = event.currentTarget.href;
      void client.downloadIcs(token).then((ok) => {
        if (!ok && typeof window !== "undefined") window.location.assign(href);
      });
    },
    [client, token],
  );
}

/** The line under "You're booked" when the host app did not supply one. */
export function defaultConfirmationNote(input: {
  booking: PublicBooking;
  inviteeEmail: string;
  emails: EmailFacts | null | undefined;
  hasManageLink: boolean;
}): string | null {
  const { booking, inviteeEmail } = input;
  const host = booking.hostDisplayName || "The host";
  const requested = booking.status === "requested";
  if (!emailsOn(input.emails)) {
    // Nothing is on its way, so say nothing about an inbox. A request still
    // needs a word: where to see whether it was accepted.
    if (!requested) return null;
    return input.hasManageLink
      ? `${host} still has to confirm this time. Your private link below shows when they do.`
      : `${host} still has to confirm this time.`;
  }
  if (requested) return `${host} will confirm by email${inviteeEmail ? ` at ${inviteeEmail}` : ""}.`;
  return inviteeEmail ? `A confirmation is on its way to ${inviteeEmail}.` : "A confirmation is on its way to your inbox.";
}

function CustomerConfirmation({
  booking,
  manageToken,
  manageUrl,
  zone,
  locale,
  client,
  inviteeEmail,
  inviteePhone,
  confirmationNote,
  emails,
  sandbox,
  headingLevel,
  headingRef,
  timeZones,
}: {
  booking: PublicBooking;
  manageToken: string;
  manageUrl: string;
  zone: string;
  locale: string;
  client: BookingClient;
  inviteeEmail: string;
  inviteePhone?: string;
  confirmationNote?: string | null;
  emails?: EmailFacts | null;
  sandbox: boolean;
  headingLevel: "h2" | "h3";
  headingRef?: Ref<HTMLHeadingElement>;
  timeZones?: readonly TimeZoneChoice[];
}) {
  const onIcsClick = useIcsClick(client, manageToken);
  const requested = booking.status === "requested";
  const Heading = headingLevel;
  const withEmail = emailsOn(emails);
  // confirmationNote: the host knows whether it actually sends email. A
  // string replaces the default; null drops the line.
  const note =
    confirmationNote !== undefined
      ? confirmationNote
      : defaultConfirmationNote({ booking, inviteeEmail, emails, hasManageLink: Boolean(manageUrl) });
  return (
    <>
      <div className="aibk-done-head">
        <span className={`aibk-badge${requested ? " aibk-badge-warn" : ""}`}>
          {requested ? <ClockIcon /> : <CheckIcon />}
        </span>
        <div>
          <Heading className="aibk-done-title" ref={headingRef} tabIndex={-1}>
            {requested ? "Request sent" : "You're booked"}
          </Heading>
          {note === null ? null : <p className="aibk-sub">{note}</p>}
        </div>
      </div>
      <BookingFacts booking={booking} zone={zone} locale={locale} inviteePhone={inviteePhone} zoneChoices={timeZones} />
      <CalendarActions booking={booking} icsHref={client.icsUrl(manageToken)} onIcsClick={onIcsClick} sandbox={sandbox} />
      {manageUrl && !withEmail ? (
        <CopyField
          label="Your private link"
          value={manageUrl}
          buttonLabel="Copy your private link"
          hint="This is the only way to move or cancel. Bookmark it, or add the call to your calendar (the link is inside)."
        />
      ) : null}
      {manageUrl ? (
        <p className="aibk-sub">
          Need to change something?{" "}
          <a className="aibk-manage-link" href={manageUrl}>
            Reschedule or cancel
          </a>
        </p>
      ) : !withEmail ? (
        // A server with no manage page configured and no email: the visitor
        // can only change the call through a person — say which.
        <p className="aibk-sub">
          To move or cancel, <ReachHostText reach={reachHost(emails, booking.hostDisplayName)} />.
        </p>
      ) : null}
    </>
  );
}

export interface ConfirmationProps {
  result: BookResponse;
  zone: string;
  locale: string;
  client: BookingClient;
  sandbox: boolean;
  inviteeEmail: string;
  /** Shown as given — pass the NORMALISED number (what the server stored), so a misread number is caught here. */
  inviteePhone?: string;
  confirmationNote?: string | null;
  /** What the server's config says about email. Absent: email is assumed on (the old behaviour). */
  emails?: EmailFacts | null;
  /** The widget's `timeZones`: the zone reads by the label the selector used. */
  timeZones?: readonly TimeZoneChoice[];
  realBookingHref?: string;
  realBookingLabel: string;
  realBookingSteps?: readonly string[];
  headingRef?: Ref<HTMLHeadingElement>;
  onReset?: () => void;
}

export function Confirmation(props: ConfirmationProps) {
  const { result, sandbox } = props;
  const shared = {
    booking: result.booking,
    manageToken: result.manageToken,
    manageUrl: result.manageUrl,
    zone: props.zone,
    locale: props.locale,
    client: props.client,
    inviteeEmail: props.inviteeEmail,
    inviteePhone: props.inviteePhone,
    emails: props.emails,
    sandbox,
    timeZones: props.timeZones,
  };

  if (!sandbox) {
    return (
      <section className="aibk-done" aria-label="Booking confirmed" data-aibk-confirmation="">
        <CustomerConfirmation {...shared} confirmationNote={props.confirmationNote} headingLevel="h2" headingRef={props.headingRef} />
      </section>
    );
  }

  // Inside the preview frame the customer's card must not claim that
  // something went to an inbox — "nobody was emailed" sits right above it.
  const email = props.inviteeEmail.trim();
  const sandboxNote =
    props.confirmationNote !== undefined
      ? props.confirmationNote
      : email
        ? `In a real booking, a confirmation goes to ${email}.`
        : "In a real booking, a confirmation goes to your customer's inbox.";
  const steps = props.realBookingSteps ?? REAL_BOOKING_STEPS;
  return (
    <section className="aibk-done" aria-label="Sandbox confirmation" data-aibk-confirmation="sandbox">
      <div className="aibk-head">
        <h2 className="aibk-done-title" ref={props.headingRef} tabIndex={-1}>
          This is what your customer would see
        </h2>
        <p className="aibk-sub">Nothing was booked and nobody was emailed — the confirmation below is a preview.</p>
      </div>
      <div className="aibk-preview" role="group" aria-label="Preview of the customer's confirmation">
        <span className="aibk-preview-label">Preview · your customer's confirmation</span>
        <CustomerConfirmation {...shared} confirmationNote={sandboxNote} headingLevel="h3" />
      </div>
      <div className="aibk-real">
        <h3 className="aibk-h3">What happens on a real booking</h3>
        <ul className="aibk-list">
          {steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ul>
      </div>
      {props.realBookingHref ? (
        <a className="aibk-btn aibk-btn-primary aibk-btn-cta" href={props.realBookingHref} data-aibk-real-cta="">
          {props.realBookingLabel}
        </a>
      ) : null}
      {props.onReset ? (
        <div>
          <button type="button" className="aibk-btn aibk-btn-link" onClick={props.onReset}>
            Try another time in the sandbox
          </button>
        </div>
      ) : null}
    </section>
  );
}
