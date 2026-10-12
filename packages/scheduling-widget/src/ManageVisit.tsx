import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import type { SchedulingTransport } from "./client.js";
import { cutoffMessage, friendlyError, isTimeGone, LIMITS, toPublicStatusLabel } from "./form.js";
import type { ClientError } from "./http.js";
import { useNow } from "./hooks.js";
import {
  CalendarOffIcon,
  CheckIcon,
  ClockIcon,
  ContactLinks,
  CrossIcon,
  Loading,
  Notice,
  useStepFocus,
  WidgetRoot,
  type ChromeProps,
} from "./parts.js";
import { SlotPicker } from "./SlotPicker.js";
import { describeShortWhen, describeVisitWhen } from "./time.js";
import { usePublicTransport } from "./transport.js";
import type { PublicConfig, PublicSlot, PublicVisit, PublicVisitStatus } from "./types.js";
import { CalendarActions, VisitFacts } from "./VisitSummary.js";

/**
 * <ManageVisit> — the page behind the link in the customer's email (contract
 * 8.4): see the visit, add it to a calendar, move it, or cancel it. No
 * account: the token in the link IS the credential.
 *
 * Every state has its own page: requested, confirmed, under way, done,
 * cancelled, declined, not confirmed in time, missed, and "this link doesn't
 * open a visit". The server answers an unknown, mistyped or other-business
 * token the same way on purpose, so the not-found page never claims to know
 * which it was.
 *
 * THE CUTOFF. Inside the business's cutoff (24 hours by default) the actions
 * are replaced by one sentence and the business's phone number: the crew has
 * planned its day, and a same-morning click would leave a slot nobody can
 * refill. The server enforces the same rule; a `too_late` from it shows the
 * same sentence and reloads the visit.
 *
 * RESCHEDULE uses the booking flow's own day-and-time picker, asked AS the
 * visit (`manage: token`): the server leaves the visit out of busy, so the
 * time right next to it is offered. The same visit moves — same link, same
 * calendar entry with a bumped sequence — so the customer is never stranded
 * on a dead link after moving.
 */

export interface ManageVisitProps extends ChromeProps {
  /** The token from the link. */
  token: string;
  /** The mounted public handlers, e.g. "/api/schedule". Ignored when `transport` is given. */
  baseUrl?: string;
  transport?: SchedulingTransport;
  /** "Book a new time" after a cancelled / declined / expired visit, and on a link that opens nothing. */
  bookHref?: string;
  /** After a successful reschedule or cancel, with the updated visit. */
  onChange?: (visit: PublicVisit) => void;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; visit: PublicVisit }
  | { status: "not_found" }
  | { status: "error"; error: ClientError };

type Mode = "view" | "reschedule" | "confirm-move" | "cancel";

const ACTIVE: ReadonlySet<PublicVisitStatus> = new Set(["requested", "confirmed"]);
const STANDING: ReadonlySet<PublicVisitStatus> = new Set(["requested", "confirmed", "in_progress"]);

function tagTone(status: PublicVisitStatus): string {
  switch (status) {
    case "requested":
      return " aisw-tag-pending";
    case "confirmed":
      return " aisw-tag-ok";
    case "in_progress":
      return " aisw-tag-progress";
    case "completed":
      return " aisw-tag-done";
    case "missed":
      return " aisw-tag-muted";
    default:
      return " aisw-tag-danger";
  }
}

function TagIcon({ status }: { status: PublicVisitStatus }) {
  if (status === "confirmed" || status === "completed") return <CheckIcon />;
  if (status === "requested" || status === "in_progress") return <ClockIcon />;
  return <CrossIcon />;
}

/**
 * Past the point where the visit can be changed online: the server says so
 * (`canCancel` false on an active visit), or the deadline has passed on this
 * browser's clock since the page loaded.
 */
export function isPastChangeDeadline(visit: PublicVisit, nowMs: number): boolean {
  if (!ACTIVE.has(visit.status)) return false;
  if (!visit.canCancel && !visit.canReschedule) return true;
  const deadline = visit.changeDeadline ? Date.parse(visit.changeDeadline) : Number.NaN;
  return Number.isFinite(deadline) && nowMs >= deadline;
}

export function ManageVisit(props: ManageVisitProps) {
  const locale = props.locale ?? "en-US";
  const transport = usePublicTransport(props.transport, props.baseUrl);
  const ids = useId();
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [reloadSignal, setReloadSignal] = useState(0);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [mode, setMode] = useState<Mode>("view");
  const [picked, setPicked] = useState<PublicSlot | null>(null);
  const [pickNotice, setPickNotice] = useState<string | null>(null);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [lateMessage, setLateMessage] = useState<string | null>(null);
  // Focus follows the customer's own actions only, never the first load.
  const [focusTick, setFocusTick] = useState(0);
  const headingRef = useStepFocus<HTMLHeadingElement>(focusTick);
  const now = useNow(true, 30_000);

  const go = useCallback((next: Mode) => {
    setMode(next);
    setFocusTick((n) => n + 1);
  }, []);

  useEffect(() => {
    let alive = true;
    setLoad((current) => (current.status === "ready" ? current : { status: "loading" }));
    void transport.visit(props.token).then((res) => {
      if (!alive) return;
      if (res.ok) setLoad({ status: "ready", visit: res.data.visit });
      else if (res.error.code === "not_found") setLoad({ status: "not_found" });
      else setLoad({ status: "error", error: res.error });
    });
    return () => {
      alive = false;
    };
  }, [transport, props.token, reloadSignal]);

  // The config says whether the business sends email (and so whether "we've
  // emailed you" is true) and how far ahead it books. A page that can't read
  // it claims no email at all.
  useEffect(() => {
    let alive = true;
    void transport.config().then((res) => {
      if (alive && res.ok) setConfig(res.data);
    });
    return () => {
      alive = false;
    };
  }, [transport]);
  const emails = config?.emailsEnabled === true;

  const applyVisit = (visit: PublicVisit, message: string) => {
    setLoad({ status: "ready", visit });
    setSuccess(message);
    setPicked(null);
    setPickNotice(null);
    setActionError(null);
    go("view");
    props.onChange?.(visit);
  };

  const tooLate = (visit: PublicVisit) => {
    setLateMessage(cutoffMessage(visit));
    setPicked(null);
    setReloadSignal((n) => n + 1);
    go("view");
  };

  const move = async (visit: PublicVisit) => {
    if (!picked || busy) return;
    setBusy(true);
    setActionError(null);
    const res = await transport.reschedule(props.token, { slotId: picked.slotId });
    setBusy(false);
    if (res.ok) {
      applyVisit(
        res.data.visit,
        `Moved to ${describeVisitWhen(res.data.visit, locale)}.${emails ? " We've emailed you the new time." : ""}`,
      );
      return;
    }
    const error = res.error;
    if (error.code === "not_found") {
      setLoad({ status: "not_found" });
      setFocusTick((n) => n + 1);
      return;
    }
    if (error.code === "too_late") {
      tooLate(visit);
      return;
    }
    if (isTimeGone(error)) {
      setPicked(null);
      setPickNotice(friendlyError(error, "reschedule"));
      setRefreshSignal((n) => n + 1);
      go("reschedule");
      return;
    }
    if (error.code === "booking_closed") {
      setReloadSignal((n) => n + 1);
      setActionError(`${friendlyError(error, "reschedule")} ${contactLine(visit)}`);
      return;
    }
    setActionError(friendlyError(error, "reschedule"));
  };

  const cancel = async (visit: PublicVisit) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    const trimmed = reason.trim();
    const res = await transport.cancel(props.token, trimmed ? { reason: trimmed.slice(0, LIMITS.reason) } : {});
    setBusy(false);
    if (res.ok) {
      setReason("");
      applyVisit(res.data.visit, `Your visit is cancelled.${emails ? " We've emailed you to confirm." : ""}`);
      return;
    }
    if (res.error.code === "not_found") {
      setLoad({ status: "not_found" });
      setFocusTick((n) => n + 1);
      return;
    }
    if (res.error.code === "too_late") {
      tooLate(visit);
      return;
    }
    setActionError(friendlyError(res.error, "cancel"));
  };

  const bookAgain = props.bookHref ? (
    <div className="aisw-actions">
      <a className="aisw-btn aisw-btn-primary" href={props.bookHref}>
        Book a new time
      </a>
    </div>
  ) : null;

  let body: ReactNode;
  if (load.status === "loading") {
    body = <Loading label="Loading your visit…" />;
  } else if (load.status === "error") {
    body = (
      <Notice tone="error">
        {friendlyError(load.error, "visit")}{" "}
        <button type="button" className="aisw-btn aisw-btn-link" onClick={() => setReloadSignal((n) => n + 1)}>
          Try again
        </button>
      </Notice>
    );
  } else if (load.status === "not_found") {
    body = (
      <section className="aisw-done" aria-labelledby={`${ids}-nf`} data-aisw-state="not_found">
        <div className="aisw-done-head">
          <span className="aisw-badge aisw-badge-muted">
            <CalendarOffIcon />
          </span>
          <h2 className="aisw-done-title" id={`${ids}-nf`} ref={headingRef} tabIndex={-1}>
            This link doesn't open a visit.
          </h2>
        </div>
        <p className="aisw-sub">
          It may be incomplete. If you copied it from an email, try opening it from the email again.
        </p>
        {bookAgain}
      </section>
    );
  } else {
    const visit = load.visit;
    const business = visit.businessName || "The business";
    const active = ACTIVE.has(visit.status);
    const pastCutoff = isPastChangeDeadline(visit, now);
    const canReschedule = active && !pastCutoff && visit.canReschedule;
    const canCancel = active && !pastCutoff && visit.canCancel;
    // A visit that won't happen any more — including one that was missed —
    // offers "Book a new time": the customer's next step, not a dead end.
    const over =
      visit.status === "cancelled" || visit.status === "declined" || visit.status === "expired" || visit.status === "missed";

    body = (
      <>
        {mode === "view" || mode === "cancel" ? (
          <section className="aisw-done" aria-labelledby={`${ids}-h`} data-aisw-state={visit.status}>
            <div className="aisw-head">
              <span className={`aisw-tag${tagTone(visit.status)}`} data-aisw-status={visit.status}>
                <TagIcon status={visit.status} />
                {toPublicStatusLabel(visit.status, business)}
              </span>
              <h2 className="aisw-done-title" id={`${ids}-h`} ref={mode === "view" ? headingRef : undefined} tabIndex={-1}>
                {headingFor(visit)}
              </h2>
            </div>
            {success ? <Notice tone="ok">{success}</Notice> : null}
            {lateMessage && pastCutoff ? null : lateMessage ? <Notice tone="warn">{lateMessage}</Notice> : null}
            {visit.status === "requested" ? (
              <Notice tone="info">
                {business} still has to confirm this time.{" "}
                {emails ? "You'll get an email when they do." : "This page shows it as soon as they do."}
              </Notice>
            ) : null}
            {visit.status === "cancelled" ? (
              <p className="aisw-sub">
                {visit.cancelledBy === "customer" ? "You cancelled this visit." : `${business} cancelled this visit.`}
              </p>
            ) : null}
            {visit.status === "expired" ? (
              <p className="aisw-sub">{business} wasn't able to confirm your request in time, so it was released.</p>
            ) : null}
            {visit.status === "missed" ? (
              <p className="aisw-sub">
                The visit couldn't go ahead. If you&apos;d like another time, book one below, or get in touch with {business}.
              </p>
            ) : null}
            <VisitFacts visit={visit} locale={locale} />
            {STANDING.has(visit.status) ? (
              <CalendarActions google={visit.googleCalendarUrl} icsHref={transport.icsUrl(props.token)} />
            ) : null}

            {active && pastCutoff ? (
              <Notice tone="info">
                <span data-aisw-cutoff="">{cutoffMessage(visit)}</span>
              </Notice>
            ) : null}

            {mode === "view" && (canReschedule || canCancel) ? (
              <>
                <hr className="aisw-divider" />
                <div className="aisw-actions">
                  {canReschedule ? (
                    <button
                      type="button"
                      className="aisw-btn aisw-btn-secondary"
                      onClick={() => {
                        setSuccess(null);
                        setActionError(null);
                        setPickNotice(null);
                        setPicked(null);
                        go("reschedule");
                      }}
                    >
                      Pick another time
                    </button>
                  ) : null}
                  {canCancel ? (
                    <button
                      type="button"
                      className="aisw-btn aisw-btn-danger-outline"
                      onClick={() => {
                        setSuccess(null);
                        setActionError(null);
                        go("cancel");
                      }}
                    >
                      Cancel visit
                    </button>
                  ) : null}
                </div>
                {canCancel && !canReschedule ? (
                  <p className="aisw-hint">To move it to another time, {contactLine(visit).replace(/^C/, "c")}</p>
                ) : null}
                <p className="aisw-hint">
                  {visit.cancelCutoffHours > 0
                    ? `You can change or cancel online up to ${visit.cancelCutoffHours} hour${visit.cancelCutoffHours === 1 ? "" : "s"} before the visit.`
                    : "You can change or cancel online until the visit starts."}
                </p>
              </>
            ) : null}

            {mode === "view" && actionError ? <Notice tone="error">{actionError}</Notice> : null}

            {mode === "cancel" ? (
              <div className="aisw-section" data-aisw-cancel="">
                <hr className="aisw-divider" />
                <h3 className="aisw-h3" id={`${ids}-c`} ref={headingRef} tabIndex={-1}>
                  Cancel this visit?
                </h3>
                <div className="aisw-field">
                  <label className="aisw-label" htmlFor={`${ids}-reason`}>
                    Anything you'd like {business} to know? <span className="aisw-optional">(optional)</span>
                  </label>
                  <textarea
                    id={`${ids}-reason`}
                    className="aisw-input"
                    rows={3}
                    maxLength={LIMITS.reason}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </div>
                {actionError ? <Notice tone="error">{actionError}</Notice> : null}
                <div className="aisw-actions">
                  <button
                    type="button"
                    className="aisw-btn aisw-btn-danger"
                    onClick={() => void cancel(visit)}
                    disabled={busy}
                    aria-busy={busy || undefined}
                  >
                    {busy ? "Cancelling…" : "Yes, cancel it"}
                  </button>
                  <button
                    type="button"
                    className="aisw-btn aisw-btn-secondary"
                    onClick={() => {
                      setActionError(null);
                      go("view");
                    }}
                  >
                    Keep my visit
                  </button>
                </div>
              </div>
            ) : null}

            {!STANDING.has(visit.status) || over ? (
              <p className="aisw-sub">
                <ContactLinks phone={visit.contactPhone} email={visit.contactEmail} />
              </p>
            ) : (
              <p className="aisw-hint">
                Questions? <ContactLinks phone={visit.contactPhone} email={visit.contactEmail} lowercase />
              </p>
            )}
            {over ? bookAgain : null}
          </section>
        ) : null}

        {mode === "reschedule" ? (
          <>
            <div className="aisw-picked">
              <div className="aisw-picked-main">
                <span className="aisw-picked-meta">Currently booked</span>
                <span className="aisw-picked-when">{describeVisitWhen(visit, locale)}</span>
              </div>
              <button type="button" className="aisw-btn aisw-btn-secondary" onClick={() => go("view")}>
                Keep this time
              </button>
            </div>
            <SlotPicker
              transport={transport}
              manageToken={props.token}
              days={14}
              timeZone={visit.timeZone}
              horizonDays={config?.horizonDays ?? null}
              locale={locale}
              heading="Pick a new time"
              headingRef={headingRef}
              selectedSlotId={picked?.slotId ?? null}
              onPick={(slot) => {
                setPicked(slot);
                setActionError(null);
                go("confirm-move");
              }}
              refreshSignal={refreshSignal}
              notice={pickNotice ? <Notice tone="warn">{pickNotice}</Notice> : null}
              hide={{ date: visit.date, startTime: visit.startTime }}
              contact={<ContactLinks phone={visit.contactPhone} email={visit.contactEmail} />}
            />
          </>
        ) : null}

        {mode === "confirm-move" && picked ? (
          <section className="aisw-section" aria-labelledby={`${ids}-m`} data-aisw-confirm-move="">
            <h3 className="aisw-h3" id={`${ids}-m`} ref={headingRef} tabIndex={-1}>
              Move to {describeShortWhen(picked, locale)}?
            </h3>
            <div className="aisw-picked">
              <div className="aisw-picked-main">
                <span className="aisw-picked-meta">From {describeVisitWhen(visit, locale)}</span>
                <span className="aisw-picked-when">To {describeVisitWhen({ ...picked, timeZone: visit.timeZone }, locale)}</span>
              </div>
            </div>
            {actionError ? <Notice tone="error">{actionError}</Notice> : null}
            <div className="aisw-actions">
              <button
                type="button"
                className="aisw-btn aisw-btn-primary"
                onClick={() => void move(visit)}
                disabled={busy}
                aria-busy={busy || undefined}
              >
                {busy ? "Moving…" : "Yes, move it"}
              </button>
              <button type="button" className="aisw-btn aisw-btn-secondary" onClick={() => go("reschedule")}>
                Pick a different time
              </button>
            </div>
            <div>
              <button type="button" className="aisw-btn aisw-btn-link" onClick={() => go("view")}>
                Keep my current time
              </button>
            </div>
          </section>
        ) : null}
      </>
    );
  }

  return (
    <WidgetRoot
      theme={props.theme}
      nonce={props.nonce}
      className={props.className}
      style={props.style}
      data={{ "aisw-manage": load.status === "ready" ? mode : load.status }}
    >
      <div className="aisw-body">{body}</div>
    </WidgetRoot>
  );
}

function headingFor(visit: PublicVisit): string {
  const service = visit.serviceName.toLowerCase();
  switch (visit.status) {
    case "cancelled":
      return `Your ${service} is cancelled`;
    case "declined":
      return `${visit.businessName || "The business"} couldn't make this time`;
    case "expired":
      return `Your ${service} wasn't confirmed in time`;
    case "completed":
      return `Your ${service} is done`;
    case "missed":
      return `Your ${service} didn't go ahead`;
    default:
      return `Your ${service}`;
  }
}

/** "Call (801) 555-0143." — plain text, for a sentence inside a message. */
function contactLine(visit: PublicVisit): string {
  if (visit.contactPhone) return `Call ${visit.contactPhone}.`;
  if (visit.contactEmail) return `Email ${visit.contactEmail}.`;
  return "Please get in touch with the business.";
}
