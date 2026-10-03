import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { BookingClient, resolveBookingTypeKey } from "./client.js";
import { useIcsClick } from "./Confirmation.js";
import { useHold, useNow, useStepFocus } from "./hooks.js";
import {
  BookingFacts,
  CalendarActions,
  CalendarOffIcon,
  defaultRealBookingLabel,
  defaultSandboxNotice,
  describeWhen,
  HoldCountdown,
  isPast,
  Loading,
  Notice,
  ReachHostText,
  SandboxBanner,
  StatusTag,
} from "./parts.js";
import { Picker } from "./Picker.js";
import { friendlyError, isSlotGone, LIMITS, reachHost, type BookingError, type EmailFacts } from "./requests.js";
import { injectStyles } from "./styles.js";
import { browserTimeZone, resolveInitialZone, sameInstant, type LocalSlot } from "./time.js";
import type { BookingConfig, PublicBooking, Slot } from "./types.js";

/**
 * <ManageBooking> — the invitee's self-service page behind the manage link:
 * see the booking, add it to a calendar, move it, or cancel it. No account; the
 * token in the link IS the credential, which is what makes "reschedule in one
 * click from the email" possible.
 *
 * Every state has a page of its own — active, requested, cancelled, past, and
 * not found. Unknown, expired and cancelled tokens may all come back from the
 * server as the same not-found answer (deliberately: no oracle for which tokens
 * exist), so "not found" never claims to know which it was.
 *
 * RESCHEDULE reuses the booking flow's picker and holds. The booking row is
 * moved in place server-side — same manage link, same calendar UID with a
 * bumped SEQUENCE — so the visitor is never stranded on a dead link after
 * moving (the defect the source system shipped). The picker's slots and
 * holds carry the manage token, so the server leaves this booking out of
 * busy and "half an hour later" is offered rather than blocked by the call
 * being moved; the type comes from the booking's `typeKey` (name matching
 * only for servers too old to send it).
 */

export interface ManageBookingProps {
  baseUrl: string;
  /** The manage token from the link. */
  token: string;
  clientKey?: string;
  /** "Book a new time" after a cancellation; the real-booking CTA on a sandbox booking. */
  realBookingHref?: string;
  realBookingLabel?: string;
  sandboxNotice?: string;
  /**
   * This page serves SANDBOX manage links. The booking's own `sandbox` flag
   * says so too — but only once it loads, and a sandbox link opened in
   * another browser, or after the sandbox expired, loads nothing. Without
   * this prop that visitor got the real not-found page and a "Book a new
   * time" button into the REAL calendar.
   */
  sandbox?: boolean;
  /** In sandbox mode, the secondary "Try the demo again" link (e.g. the demo page). */
  sandboxHref?: string;
  /** Default: the zone the booking was made in. */
  defaultTimezone?: string;
  locale?: string;
  theme?: "auto" | "light" | "dark";
  className?: string;
  style?: CSSProperties;
  /** Called after a successful reschedule or cancel with the updated booking. */
  onChange?: (booking: PublicBooking) => void;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; booking: PublicBooking }
  | { status: "not_found" }
  | { status: "error"; error: BookingError };

type Mode = "view" | "reschedule" | "confirm-move" | "cancel";

type ConfigState =
  | { status: "loading" }
  | { status: "ready"; config: BookingConfig }
  | { status: "error"; error: BookingError };

export function ManageBooking(props: ManageBookingProps) {
  const locale = props.locale ?? "en-US";
  const client = useMemo(
    () => new BookingClient({ baseUrl: props.baseUrl, clientKey: props.clientKey }),
    [props.baseUrl, props.clientKey],
  );
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [reloadSignal, setReloadSignal] = useState(0);
  const [mode, setMode] = useState<Mode>("view");
  const [browserZone] = useState(() => browserTimeZone());
  const [zoneChoice, setZoneChoice] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [configState, setConfigState] = useState<ConfigState>({ status: "loading" });
  const [configReload, setConfigReload] = useState(0);
  const [picked, setPicked] = useState<Slot | null>(null);
  const [pickNotice, setPickNotice] = useState<string | null>(null);
  const [holdNote, setHoldNote] = useState<string | null>(null);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const ids = useId();

  const booking = load.status === "ready" ? load.booking : null;
  // Focus follows the visitor's OWN actions only. Keyed on an explicit tick
  // rather than on the load state, so the first load (loading → ready) does
  // not pull focus and scroll the page before anyone has touched it.
  const [focusTick, setFocusTick] = useState(0);
  const headingRef = useStepFocus<HTMLHeadingElement>(focusTick);
  const go = useCallback((next: Mode) => {
    setMode(next);
    setFocusTick((n) => n + 1);
  }, []);

  const timeGone = useCallback(
    (message: string) => {
      setPicked(null);
      setPickNotice(message);
      setHoldNote(null);
      setRefreshSignal((n) => n + 1);
      go("reschedule");
    },
    [go],
  );

  const hold = useHold(
    client,
    useCallback((error: BookingError) => timeGone(friendlyError(error, "hold")), [timeGone]),
  );

  useEffect(() => {
    injectStyles();
  }, []);

  useEffect(() => {
    let alive = true;
    setLoad({ status: "loading" });
    void client.getBooking(props.token).then((res) => {
      if (!alive) return;
      if (res.ok) setLoad({ status: "ready", booking: res.data.booking });
      else if (res.error.code === "not_found") setLoad({ status: "not_found" });
      else setLoad({ status: "error", error: res.error });
    });
    return () => {
      alive = false;
    };
  }, [client, props.token, reloadSignal]);

  // The config is fetched alongside the booking, not only on a reschedule:
  // it says whether the server sends email, and every "reply to your
  // confirmation email" on this page depends on that. A failed config is
  // settled too — the page then claims no email at all (see `emails`).
  useEffect(() => {
    let alive = true;
    setConfigState({ status: "loading" });
    void client.config().then((res) => {
      if (!alive) return;
      setConfigState(res.ok ? { status: "ready", config: res.data } : { status: "error", error: res.error });
    });
    return () => {
      alive = false;
    };
  }, [client, configReload]);
  const config = configState.status === "ready" ? configState.config : null;
  const configError = configState.status === "error" ? configState.error : null;

  // A visitor who asked to move before the config arrived: the picker's
  // heading exists only now, so focus moves onto it.
  const configReady = config !== null;
  const wasReady = useRef(configReady);
  useEffect(() => {
    if (configReady && !wasReady.current && mode === "reschedule") setFocusTick((n) => n + 1);
    wasReady.current = configReady;
  }, [configReady, mode]);

  const zone =
    zoneChoice ??
    resolveInitialZone(props.defaultTimezone ?? booking?.inviteeTimezone, browserZone, booking?.hostTimezone);
  const suggestedZones = useMemo(
    () => [browserZone, ...(booking ? [booking.inviteeTimezone, booking.hostTimezone] : [])],
    [browserZone, booking],
  );

  const heldHere = hold.hold && picked && sameInstant(hold.hold.start, picked.start) ? hold.hold : null;
  const now = useNow(true, mode === "confirm-move" ? 1000 : 60_000);
  const remaining = heldHere ? heldHere.deadline - now : null;
  const expired = remaining !== null && remaining <= 0;

  const sandbox = Boolean(props.sandbox || booking?.sandbox);
  const host = booking?.hostDisplayName || config?.hostDisplayName || "";
  const realBookingLabel = props.realBookingLabel ?? defaultRealBookingLabel(host);
  // Unknown (config failed) reads as "no email": a page that cannot tell
  // must not send anyone to an inbox that may never have been written to.
  const emails: EmailFacts = config
    ? { emailsEnabled: config.emailsEnabled, contactEmail: config.contactEmail }
    : { emailsEnabled: false };
  const reach = reachHost(emails, host);
  const onIcsClick = useIcsClick(client, props.token);
  const typeKey = booking && config ? resolveBookingTypeKey(booking, config.types) : null;
  const bookedType = typeKey ? config?.types.find((type) => type.key === typeKey) : undefined;

  const applyBooking = (next: PublicBooking, message: string) => {
    setLoad({ status: "ready", booking: next });
    setSuccess(message);
    go("view");
    setPicked(null);
    props.onChange?.(next);
  };

  const startReschedule = () => {
    setSuccess(null);
    setActionError(null);
    setPickNotice(null);
    setHoldNote(null);
    setPicked(null);
    go("reschedule");
  };

  const leaveReschedule = () => {
    hold.release();
    setPicked(null);
    setPickNotice(null);
    setHoldNote(null);
    setActionError(null);
    go("view");
  };

  const takeHold = async (start: string, end: string) => {
    if (!typeKey) return;
    setPickNotice(null);
    setHoldNote(null);
    setActionError(null);
    setPicked({ start, end });
    // The manage token tells the server this hold is FOR moving this booking,
    // so the booking itself does not block a time next to it.
    const res = await hold.take(typeKey, start, { manageToken: props.token });
    if (res === null) return;
    if (res.ok) {
      setPicked({ start: res.data.start, end: res.data.end });
      go("confirm-move");
      return;
    }
    if (res.error.code === "not_found") {
      // A hold made FOR this booking is not_found when the booking can no
      // longer move — cancelled or started since the page loaded, or its type
      // retired. Re-read it and show where it stands instead of offering
      // more times that would all answer the same.
      hold.release();
      setPicked(null);
      setReloadSignal((n) => n + 1);
      go("view");
      return;
    }
    if (isSlotGone(res.error) || res.error.code === "invalid") {
      timeGone(friendlyError(res.error, "hold"));
      return;
    }
    if (res.error.code === "unlicensed") {
      setPicked(null);
      setPickNotice(friendlyError(res.error, "hold"));
      return;
    }
    setHoldNote("We couldn't hold this time for you, but you can still move to it — we'll check it's free when you confirm.");
    go("confirm-move");
  };

  const pickSlot = (slot: LocalSlot) => void takeHold(slot.start, slot.end);

  const move = async () => {
    if (!picked || busy) return;
    setBusy(true);
    setActionError(null);
    const holdToken = heldHere?.token;
    let res = await client.reschedule(props.token, { start: picked.start, ...(holdToken ? { holdToken } : {}) });
    // The reference server excludes both the booking being moved and this
    // visitor's hold on the new time. A server that counted that hold as busy
    // would answer slot_taken to every held reschedule — so on slot_taken
    // WITH a hold, hand the hold back and try once more without it. A
    // genuinely taken time fails again.
    if (!res.ok && res.error.code === "slot_taken" && holdToken) {
      // Awaited, not the fire-and-forget release: the retry must not reach
      // the server before the hold is gone.
      await client.releaseHold(holdToken);
      hold.consume();
      res = await client.reschedule(props.token, { start: picked.start });
    }
    setBusy(false);
    if (res.ok) {
      hold.consume();
      applyBooking(
        res.data.booking,
        `Moved to ${describeWhen(res.data.booking.start, zone, locale)}.${
          res.data.booking.sandbox
            ? " (Sandbox — nothing was sent.)"
            : " Your manage link stays the same. If you added this call to a calendar yourself, add it again so the new time shows."
        }`,
      );
      return;
    }
    const error = res.error;
    if (error.code === "not_found") {
      hold.release();
      setLoad({ status: "not_found" });
      setFocusTick((n) => n + 1);
      return;
    }
    const timeIssue = error.issues.some((issue) => ["start", "holdToken"].includes(issue.path[0] ?? ""));
    if (isSlotGone(error) || (error.code === "invalid" && timeIssue)) {
      hold.release();
      timeGone(friendlyError(error, "reschedule"));
      return;
    }
    setActionError(friendlyError(error, "reschedule"));
  };

  const cancel = async () => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    const trimmed = reason.trim();
    const res = await client.cancel(props.token, trimmed ? { reason: trimmed.slice(0, LIMITS.reason) } : {});
    setBusy(false);
    if (res.ok) {
      setReason("");
      applyBooking(res.data.booking, "Your booking is cancelled.");
      return;
    }
    if (res.error.code === "not_found") {
      setLoad({ status: "not_found" });
      setFocusTick((n) => n + 1);
      return;
    }
    setActionError(friendlyError(res.error, "cancel"));
  };

  const rootClass = `aibk-root${props.className ? ` ${props.className}` : ""}`;
  const theme = props.theme && props.theme !== "auto" ? props.theme : undefined;

  // In a sandbox the primary button is the REAL booking, labelled as such —
  // "Book a new time" there read as "rebook the demo" and led into the real
  // calendar. The demo itself is the secondary link.
  const bookAgain = props.realBookingHref ? (
    <a className="aibk-btn aibk-btn-primary" href={props.realBookingHref} data-aibk-real-cta={sandbox ? "" : undefined}>
      {sandbox ? realBookingLabel : "Book a new time"}
    </a>
  ) : null;
  const tryDemoAgain =
    sandbox && props.sandboxHref ? (
      <div>
        <a className="aibk-btn aibk-btn-link" href={props.sandboxHref} data-aibk-demo-again="">
          Try the demo again
        </a>
      </div>
    ) : null;

  let body: ReactNode;
  if (load.status === "loading" || configState.status === "loading") {
    // Both, so the copy below is chosen once: whether a confirmation email
    // exists decides several sentences, and they must not flip after paint.
    body = <Loading label="Loading your booking…" />;
  } else if (load.status === "error") {
    body = (
      <Notice tone="error">
        {friendlyError(load.error, "manage")}{" "}
        <button type="button" className="aibk-btn aibk-btn-link" onClick={() => setReloadSignal((n) => n + 1)}>
          Try again
        </button>
      </Notice>
    );
  } else if (load.status === "not_found") {
    body = (
      <section className="aibk-done" aria-labelledby={`${ids}-nf`} data-aibk-state="not_found">
        <div className="aibk-done-head">
          <span className="aibk-badge aibk-badge-muted">
            <CalendarOffIcon />
          </span>
          <h2 className="aibk-done-title" id={`${ids}-nf`} ref={headingRef} tabIndex={-1}>
            This link is no longer valid
          </h2>
        </div>
        {sandbox ? (
          // Sandbox tenants live in one browser's cookie for a day: a link
          // opened anywhere else (the phone the calendar event synced to) or
          // later finds nothing, and that is expected, not an error.
          <p className="aibk-sub">
            Sandbox calls only open in the browser that booked them, for 24 hours. Nothing real was booked.
          </p>
        ) : reach.kind === "reply" ? (
          <p className="aibk-sub">
            The booking may have been cancelled, or the link is incomplete. If you copied it from an email, try opening
            it from the email again.
          </p>
        ) : (
          <p className="aibk-sub">
            The booking may have been cancelled, or the link is incomplete. Check you copied all of it.
            {reach.kind === "email" ? (
              <>
                {" "}
                If you need a hand, <ReachHostText reach={reach} />.
              </>
            ) : null}
          </p>
        )}
        {bookAgain ? <div className="aibk-actions">{bookAgain}</div> : null}
        {tryDemoAgain}
      </section>
    );
  } else {
    const current = load.booking;
    const past = isPast(current, now);
    const cancelled = current.status === "cancelled";
    const active = !cancelled && !past;
    const state = cancelled ? "cancelled" : past ? "past" : current.status;

    body = (
      <>
        {mode === "view" || mode === "cancel" ? (
          <section className="aibk-done" aria-labelledby={`${ids}-h`} data-aibk-state={state}>
            <div className="aibk-head">
              <StatusTag status={current.status} past={past} />
              <h2
                className="aibk-done-title"
                id={`${ids}-h`}
                ref={mode === "view" ? headingRef : undefined}
                tabIndex={-1}
              >
                {cancelled
                  ? `Your ${current.typeName.toLowerCase()} is cancelled`
                  : past
                    ? `Your ${current.typeName.toLowerCase()} has already happened`
                    : `Your ${current.typeName.toLowerCase()}`}
              </h2>
            </div>
            {success ? <Notice tone="ok">{success}</Notice> : null}
            {current.status === "requested" && active ? (
              <Notice tone="info">
                {current.hostDisplayName || "The host"} still has to confirm this time.{" "}
                {reach.kind === "reply" ? "You'll get an email when they do." : "This page shows it as soon as they do."}
              </Notice>
            ) : null}
            <BookingFacts booking={current} zone={zone} locale={locale} />
            {active ? (
              <CalendarActions
                booking={current}
                icsHref={client.icsUrl(props.token)}
                onIcsClick={onIcsClick}
                sandbox={sandbox}
              />
            ) : null}

            {mode === "view" && active && (current.canReschedule || current.canCancel) ? (
              <>
                <hr className="aibk-divider" />
                <div className="aibk-actions">
                  {current.canReschedule ? (
                    <button type="button" className="aibk-btn aibk-btn-secondary" onClick={startReschedule}>
                      Pick another time
                    </button>
                  ) : null}
                  {current.canCancel ? (
                    <button
                      type="button"
                      className="aibk-btn aibk-btn-secondary"
                      onClick={() => {
                        setSuccess(null);
                        setActionError(null);
                        go("cancel");
                      }}
                    >
                      Cancel booking
                    </button>
                  ) : null}
                </div>
              </>
            ) : null}

            {mode === "view" && active && !current.canReschedule && !current.canCancel ? (
              <p className="aibk-hint">
                This booking can't be changed online any more. To change it, <ReachHostText reach={reach} />.
              </p>
            ) : null}

            {mode === "cancel" ? (
              <div className="aibk-section">
                <hr className="aibk-divider" />
                <h3 className="aibk-h3" id={`${ids}-c`} ref={headingRef} tabIndex={-1}>
                  Cancel this booking?
                </h3>
                <div className="aibk-field">
                  <label className="aibk-label" htmlFor={`${ids}-reason`}>
                    Anything we should know? <span className="aibk-optional">(optional)</span>
                  </label>
                  <textarea
                    id={`${ids}-reason`}
                    className="aibk-input"
                    rows={3}
                    maxLength={LIMITS.reason}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </div>
                {actionError ? <Notice tone="error">{actionError}</Notice> : null}
                <div className="aibk-actions">
                  <button
                    type="button"
                    className="aibk-btn aibk-btn-danger"
                    onClick={() => void cancel()}
                    disabled={busy}
                    aria-busy={busy || undefined}
                  >
                    {busy ? "Cancelling…" : "Yes, cancel it"}
                  </button>
                  <button
                    type="button"
                    className="aibk-btn aibk-btn-secondary"
                    onClick={() => {
                      setActionError(null);
                      go("view");
                    }}
                  >
                    Keep my booking
                  </button>
                </div>
              </div>
            ) : null}

            {!active && bookAgain ? <div className="aibk-actions">{bookAgain}</div> : null}
            {active && sandbox && props.realBookingHref ? (
              <a className="aibk-btn aibk-btn-primary aibk-btn-cta" href={props.realBookingHref} data-aibk-real-cta="">
                {realBookingLabel}
              </a>
            ) : null}
            {!active ? tryDemoAgain : null}
          </section>
        ) : null}

        {mode === "reschedule" ? (
          <>
            <div className="aibk-picked">
              <div className="aibk-picked-main">
                <span className="aibk-picked-meta">Currently booked</span>
                <span className="aibk-picked-when">{describeWhen(current.start, zone, locale)}</span>
              </div>
              <button type="button" className="aibk-btn aibk-btn-secondary" onClick={leaveReschedule}>
                Keep this time
              </button>
            </div>
            {configError ? (
              <Notice tone="error">
                {friendlyError(configError, "config")}{" "}
                <button type="button" className="aibk-btn aibk-btn-link" onClick={() => setConfigReload((n) => n + 1)}>
                  Try again
                </button>
              </Notice>
            ) : null}
            {!config && !configError ? <Loading label="Loading open times…" /> : null}
            {config && !typeKey ? (
              <Notice tone="warn">
                This booking can't be moved online. To change it, <ReachHostText reach={reach} />.
              </Notice>
            ) : null}
            {config && typeKey ? (
              <Picker
                client={client}
                typeKey={typeKey}
                zone={zone}
                onZoneChange={setZoneChoice}
                suggestedZones={suggestedZones}
                locale={locale}
                selectedStart={picked?.start ?? null}
                pendingStart={hold.pendingStart}
                onPick={pickSlot}
                sandbox={sandbox}
                refreshSignal={refreshSignal}
                hideStarts={[current.start]}
                heading="Pick a new time"
                headingRef={headingRef}
                notice={pickNotice ? <Notice tone="warn">{pickNotice}</Notice> : null}
                manageToken={props.token}
                horizonDays={bookedType?.horizonDays}
                hostTimezone={config.hostTimezone}
              />
            ) : null}
          </>
        ) : null}

        {mode === "confirm-move" && picked ? (
          <section className="aibk-section" aria-labelledby={`${ids}-m`}>
            <h3 className="aibk-h3" id={`${ids}-m`} ref={headingRef} tabIndex={-1}>
              Move your booking?
            </h3>
            <div className="aibk-picked">
              <div className="aibk-picked-main">
                <span className="aibk-picked-meta">From {describeWhen(current.start, zone, locale)}</span>
                <span className="aibk-picked-when">To {describeWhen(picked.start, zone, locale)}</span>
                {heldHere && !expired ? <HoldCountdown deadline={heldHere.deadline} now={now} /> : null}
              </div>
            </div>
            {expired ? (
              <Notice tone="warn">
                Your hold ran out, so this time isn't reserved any more — you can still move to it if it's free.{" "}
                <button
                  type="button"
                  className="aibk-btn aibk-btn-link"
                  onClick={() => void takeHold(picked.start, picked.end)}
                >
                  Hold it again
                </button>
              </Notice>
            ) : null}
            {holdNote ? <Notice tone="info">{holdNote}</Notice> : null}
            {actionError ? <Notice tone="error">{actionError}</Notice> : null}
            <div className="aibk-actions">
              <button
                type="button"
                className="aibk-btn aibk-btn-primary"
                onClick={() => void move()}
                disabled={busy}
                aria-busy={busy || undefined}
              >
                {busy ? "Moving…" : "Move my booking"}
              </button>
              <button type="button" className="aibk-btn aibk-btn-secondary" onClick={() => go("reschedule")}>
                Pick a different time
              </button>
            </div>
            <div>
              <button type="button" className="aibk-btn aibk-btn-link" onClick={leaveReschedule}>
                Keep my current time
              </button>
            </div>
          </section>
        ) : null}
      </>
    );
  }

  return (
    <div className={rootClass} style={props.style} data-theme={theme} data-aibk-manage={mode}>
      {sandbox ? (
        <SandboxBanner
          notice={props.sandboxNotice ?? defaultSandboxNotice(host)}
          realBookingHref={props.realBookingHref}
          realBookingLabel={realBookingLabel}
        />
      ) : null}
      <div className="aibk-body">{body}</div>
    </div>
  );
}
