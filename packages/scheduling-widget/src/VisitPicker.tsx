import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type Ref } from "react";
import type { SchedulingTransport } from "./client.js";
import {
  buildVisitRequest,
  EMPTY_VISIT_FORM,
  firstInvalidField,
  friendlyError,
  isTimeGone,
  issuesToFieldErrors,
  LIMITS,
  validateVisitForm,
  type FieldErrors,
  type VisitField,
  type VisitFormValues,
} from "./form.js";
import type { ClientError } from "./http.js";
import {
  CheckIcon,
  ClockIcon,
  ContactLinks,
  CopyField,
  describedBy,
  Field,
  Notice,
  Skeleton,
  useStepFocus,
  WidgetRoot,
  type ChromeProps,
} from "./parts.js";
import { SlotPicker } from "./SlotPicker.js";
import { describeVisitWhen, formatDuration } from "./time.js";
import { usePublicTransport, wait } from "./transport.js";
import type { PublicConfig, PublicService, PublicSlot, VisitRequestResponse } from "./types.js";
import { CalendarActions, clientCalendarUrl, VisitFacts } from "./VisitSummary.js";

/**
 * <VisitPicker> — a customer books a visit on the business's own website, in
 * one card (contract 8.3):
 *
 *   service   what they need (skipped when there is one, or the page locks one)
 *   time      a day and a time, on the BUSINESS's clock — the crew comes to them
 *   details   name, email, phone, address, notes
 *   done      what happens next, the calendar links, and the link to change it
 *
 * Focus moves to each step's heading when the customer moves (never on load),
 * so keyboard and screen-reader users land where the content changed.
 *
 * NOTHING IS HELD while they type. The server checks the time when the form
 * is sent; if someone else took it meanwhile, the customer is told plainly,
 * the times are fetched again, and everything they typed is kept.
 *
 * SPAM. A honeypot field a person never sees, and the time between the form
 * appearing and the submit (`fillMs`). A customer whose browser autofills the
 * form and who clicks at once would be faster than the server's floor, so the
 * submit waits out the rest (the button says "Sending…") instead of letting
 * them meet "spam_suspected".
 */

export interface VisitPickerProps extends ChromeProps {
  /** The mounted public handlers, e.g. "/api/schedule". Ignored when `transport` is given. */
  baseUrl?: string;
  transport?: SchedulingTransport;
  /** Preselect this service key. */
  service?: string;
  /** With `service`: don't offer the others. */
  lockService?: boolean;
  /** Sent with the request, so the visit links back to an estimate. */
  estimateId?: string;
  /** The card's heading. Default "Book a visit". */
  title?: string;
  /** Days per window of times. Default 14. */
  days?: number;
  /** Called once per successful request. */
  onRequested?: (result: VisitRequestResponse) => void;
  /**
   * The business's own colour (Tenancy 2a): a `#rrggbb` becomes the accent,
   * with the text on it, its shades and the focus ring derived for contrast.
   * undefined or null: the stylesheet's accent.
   */
  accentColor?: string | null;
}

type Step = "service" | "time" | "details" | "done";

type ConfigState = { status: "loading" } | { status: "ready"; config: PublicConfig } | { status: "error"; error: ClientError };

export function VisitPicker(props: VisitPickerProps) {
  const locale = props.locale ?? "en-US";
  const transport = usePublicTransport(props.transport, props.baseUrl);
  const days = Math.max(1, Math.min(31, Math.round(props.days ?? 14)));
  const ids = useId();
  const fieldId = (field: VisitField | "website") => `${ids}-${field}`;

  const [configState, setConfigState] = useState<ConfigState>({ status: "loading" });
  const [configReload, setConfigReload] = useState(0);
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const headingRef = useStepFocus<HTMLHeadingElement>(focusTick);
  const [picked, setPicked] = useState<PublicSlot | null>(null);
  const [pickNotice, setPickNotice] = useState<string | null>(null);
  const [serviceNotice, setServiceNotice] = useState<string | null>(null);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [form, setForm] = useState<VisitFormValues>(EMPTY_VISIT_FORM);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<VisitRequestResponse | null>(null);
  // The map couldn't find the address: offer to send it as typed (BO-07).
  const [addressUnfound, setAddressUnfound] = useState(false);
  const [slotsClosed, setSlotsClosed] = useState(false);
  const detailsShownAt = useRef<number | null>(null);
  const fired = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    setConfigState({ status: "loading" });
    void transport.config().then((res) => {
      if (!alive) return;
      setConfigState(res.ok ? { status: "ready", config: res.data } : { status: "error", error: res.error });
    });
    return () => {
      alive = false;
    };
  }, [transport, configReload]);

  const config = configState.status === "ready" ? configState.config : null;
  const services = config?.services ?? [];
  const preset = props.service ? services.find((s) => s.key === props.service) : undefined;
  const locked = Boolean(props.lockService && preset);
  const offered: PublicService[] = locked && preset ? [preset] : services;
  const canChooseService = offered.length > 1;
  const service: PublicService | null =
    offered.find((s) => s.key === chosenKey) ?? preset ?? (offered.length === 1 ? offered[0]! : null);

  // The first step, decided once the config is in — without moving focus.
  const firstStep: Step = service ? "time" : "service";
  const currentStep: Step = step ?? firstStep;

  /** Move to a step because the customer did something: focus follows. */
  const go = useCallback((next: Step) => {
    setStep(next);
    setFocusTick((n) => n + 1);
  }, []);

  useEffect(() => {
    if (currentStep === "details" && detailsShownAt.current === null) detailsShownAt.current = Date.now();
  }, [currentStep]);

  const closed = Boolean(config && (!config.publicBookingEnabled || slotsClosed));

  const update = (field: keyof VisitFormValues, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    if (field === "address") setAddressUnfound(false);
    if (field !== "website" && fieldErrors[field]) {
      setFieldErrors((current) => {
        const next = { ...current };
        delete next[field];
        return next;
      });
    }
  };

  const chooseService = (key: string) => {
    setChosenKey(key);
    setPicked(null);
    setPickNotice(null);
    setServiceNotice(null);
    go("time");
  };

  /** The time went away: say so, re-ask for the times, keep the form. */
  const timeGone = (message: string) => {
    setPicked(null);
    setPickNotice(message);
    setRefreshSignal((n) => n + 1);
    go("time");
  };

  const pick = (slot: PublicSlot) => {
    setPicked(slot);
    setPickNotice(null);
    setSubmitError(null);
    go("details");
  };

  const focusField = (field: VisitField | null) => {
    if (!field || typeof document === "undefined") return;
    document.getElementById(fieldId(field))?.focus();
  };

  const submit = async (event: FormEvent | null, options: { addressAsTyped?: boolean } = {}) => {
    event?.preventDefault();
    if (!config || !service || !picked || submitting) return;
    const errors = validateVisitForm(form, { requireAddress: config.requireAddress });
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      setSubmitError(null);
      focusField(firstInvalidField(errors));
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    const shownAt = detailsShownAt.current ?? Date.now();
    const floor = config.minFillMs;
    const elapsed = Date.now() - shownAt;
    // A person who is faster than the floor (autofill, a saved form) waits it
    // out here, instead of being told their request looked like spam.
    if (floor > 0 && elapsed < floor) await wait(floor - elapsed);
    const res = await transport.request(
      buildVisitRequest({
        slotId: picked.slotId,
        service: service.key,
        values: form,
        fillMs: Date.now() - shownAt,
        estimateId: props.estimateId ?? null,
        ...(options.addressAsTyped ? { addressAsTyped: true } : {}),
      }),
    );
    if (!mounted.current) return;
    setSubmitting(false);
    if (res.ok) {
      setResult(res.data);
      go("done");
      // Once per successful request. A `repeated` answer (the server saw the
      // same request twice, say after a first answer that never arrived) is
      // still the first success THIS page sees, so it counts once too.
      if (!fired.current) {
        fired.current = true;
        props.onRequested?.(res.data);
      }
      return;
    }
    const error = res.error;
    if (isTimeGone(error)) {
      timeGone(friendlyError(error, "request"));
      return;
    }
    if (error.code === "address_unresolved") {
      setFieldErrors({ address: friendlyError(error, "request") });
      // A new subdivision or a rural route may not be on the map yet: a
      // customer sure of their address can send it anyway, rather than being
      // turned away at the last step with no way forward.
      setAddressUnfound(form.address.trim() !== "");
      focusField("address");
      return;
    }
    if (error.code === "unknown_service" || error.code === "invalid_duration") {
      setChosenKey(null);
      setPicked(null);
      setServiceNotice(friendlyError(error, "request"));
      setConfigReload((n) => n + 1);
      setStep(null);
      setFocusTick((n) => n + 1);
      return;
    }
    if (error.code === "booking_closed") {
      setConfigReload((n) => n + 1);
      setStep(null);
      return;
    }
    if (error.code === "invalid") {
      const timeIssue = (error.issues ?? []).some((issue) => issue.path[0] === "slotId" || issue.path[0] === "service");
      if (timeIssue) {
        timeGone("That time can't be booked any more. Pick another.");
        return;
      }
      const mapped = issuesToFieldErrors(error.issues);
      setFieldErrors(mapped);
      setSubmitError(friendlyError(error, "request"));
      focusField(firstInvalidField(mapped));
      return;
    }
    setSubmitError(friendlyError(error, "request"));
  };

  const contact = config ? <ContactLinks phone={config.contactPhone} email={config.contactEmail} /> : null;
  const title = props.title ?? "Book a visit";

  let body;
  if (configState.status === "loading") {
    body = <Skeleton label="Loading times…" />;
  } else if (configState.status === "error" && configState.error.code === "booking_closed" && configState.error.message && configState.error.message !== "booking_closed") {
    // Closed BY THE BUSINESS (Tenancy 2a, D7): the server's own sentence
    // ("Green Acres isn't taking requests online right now. Call …"), and no
    // retry: trying again changes nothing until the business is open again.
    body = (
      <section className="aisw-empty" data-aisw-state="closed" aria-labelledby={`${ids}-closed`}>
        <h2 className="aisw-empty-title" id={`${ids}-closed`}>
          {configState.error.message}
        </h2>
      </section>
    );
  } else if (configState.status === "error") {
    body = (
      <Notice tone="error">
        {friendlyError(configState.error, "config")}{" "}
        <button type="button" className="aisw-btn aisw-btn-link" onClick={() => setConfigReload((n) => n + 1)}>
          Try again
        </button>
      </Notice>
    );
  } else if (config && closed && currentStep !== "done") {
    body = (
      <section className="aisw-empty" data-aisw-state="closed" aria-labelledby={`${ids}-closed`}>
        <h2 className="aisw-empty-title" id={`${ids}-closed`}>
          Online booking is closed right now.
        </h2>
        {config.contactPhone || config.contactEmail ? (
          <p>
            To book a visit, <ContactLinks phone={config.contactPhone} email={config.contactEmail} lowercase />
          </p>
        ) : null}
      </section>
    );
  } else if (config && offered.length === 0) {
    body = (
      <div className="aisw-empty" data-aisw-state="empty">
        <span className="aisw-empty-title">There's nothing to book online right now.</span>
        {contact ? <span>{contact}</span> : null}
      </div>
    );
  } else if (config) {
    body = (
      <>
        {currentStep !== "done" ? (
          <header className="aisw-head">
            <h2 className="aisw-title">{title}</h2>
            {config.businessName ? <p className="aisw-sub">{config.businessName}</p> : null}
          </header>
        ) : null}

        {currentStep === "service" ? (
          <section className="aisw-section" aria-labelledby={`${ids}-svc`}>
            <h3 className="aisw-h3" id={`${ids}-svc`} ref={headingRef} tabIndex={-1}>
              What do you need?
            </h3>
            {serviceNotice ? <Notice tone="warn">{serviceNotice}</Notice> : null}
            <div className="aisw-services" role="group" aria-labelledby={`${ids}-svc`}>
              {offered.map((candidate) => (
                <button
                  key={candidate.key}
                  type="button"
                  className="aisw-service"
                  data-service={candidate.key}
                  aria-pressed={candidate.key === service?.key}
                  onClick={() => chooseService(candidate.key)}
                >
                  <span className="aisw-service-name">
                    {candidate.name}
                    <span className="aisw-service-len">{formatDuration(candidate.durationMinutes)}</span>
                  </span>
                  {candidate.description ? <span className="aisw-service-desc">{candidate.description}</span> : null}
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {(currentStep === "time" || currentStep === "details") && service ? (
          <div className="aisw-picked" data-aisw-service={service.key}>
            <div className="aisw-picked-main">
              <span className="aisw-picked-when">{service.name}</span>
              <span className="aisw-picked-meta">
                About {formatDuration(service.durationMinutes)}
                {service.description && currentStep === "time" ? ` · ${service.description}` : ""}
              </span>
            </div>
            {canChooseService ? (
              <button type="button" className="aisw-btn aisw-btn-secondary" onClick={() => go("service")}>
                Change service
              </button>
            ) : null}
          </div>
        ) : null}

        {currentStep === "time" && service ? (
          <SlotPicker
            transport={transport}
            service={service.key}
            days={days}
            timeZone={config.timeZone}
            horizonDays={config.horizonDays}
            locale={locale}
            heading="Pick a day and time"
            headingRef={headingRef}
            selectedSlotId={picked?.slotId ?? null}
            onPick={pick}
            refreshSignal={refreshSignal}
            notice={pickNotice ? <Notice tone="warn">{pickNotice}</Notice> : null}
            contact={contact}
            onClosed={() => setSlotsClosed(true)}
          />
        ) : null}

        {currentStep === "details" && service && picked ? (
          <section className="aisw-section" aria-labelledby={`${ids}-details`}>
            <h3 className="aisw-h3" id={`${ids}-details`} ref={headingRef} tabIndex={-1}>
              Your details
            </h3>
            <div className="aisw-picked" data-aisw-picked="">
              <div className="aisw-picked-main">
                <span className="aisw-picked-when">
                  {describeVisitWhen({ ...picked, timeZone: config.timeZone }, locale)}
                </span>
                <span className="aisw-picked-meta">The crew comes to the address you give below.</span>
              </div>
              <button type="button" className="aisw-btn aisw-btn-secondary" onClick={() => go("time")}>
                Change time
              </button>
            </div>

            <form className="aisw-form" noValidate onSubmit={(event) => void submit(event)} data-aisw-form="">
              <div className="aisw-row2">
                <Field id={fieldId("name")} label="Your name" error={fieldErrors.name}>
                  <input
                    id={fieldId("name")}
                    name="name"
                    className="aisw-input"
                    type="text"
                    autoComplete="name"
                    maxLength={LIMITS.name}
                    required
                    value={form.name}
                    aria-invalid={fieldErrors.name ? true : undefined}
                    aria-describedby={describedBy(fieldId("name"), false, fieldErrors.name)}
                    onChange={(event) => update("name", event.target.value)}
                  />
                </Field>
                <Field
                  id={fieldId("email")}
                  label="Email"
                  hint={config.emailsEnabled ? "We email your confirmation here." : undefined}
                  error={fieldErrors.email}
                >
                  <input
                    id={fieldId("email")}
                    name="email"
                    className="aisw-input"
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    maxLength={LIMITS.email}
                    required
                    value={form.email}
                    aria-invalid={fieldErrors.email ? true : undefined}
                    aria-describedby={describedBy(fieldId("email"), config.emailsEnabled, fieldErrors.email)}
                    onChange={(event) => update("email", event.target.value)}
                  />
                </Field>
              </div>
              <Field
                id={fieldId("address")}
                label="Address for the visit"
                optional={!config.requireAddress}
                hint="Street, city and ZIP code, so the crew can find you."
                error={fieldErrors.address}
              >
                <input
                  id={fieldId("address")}
                  name="address"
                  className="aisw-input"
                  type="text"
                  autoComplete="street-address"
                  maxLength={LIMITS.address}
                  required={config.requireAddress}
                  value={form.address}
                  aria-invalid={fieldErrors.address ? true : undefined}
                  aria-describedby={describedBy(fieldId("address"), true, fieldErrors.address)}
                  onChange={(event) => update("address", event.target.value)}
                />
              </Field>
              {addressUnfound ? (
                <div className="aisw-notice aisw-notice-info" data-aisw-address-anyway="">
                  <span>
                    Sure it&apos;s right? New streets aren&apos;t always on the map yet.
                    {config.contactPhone ? ` Or call ${config.contactPhone}.` : ""}
                  </span>{" "}
                  <button
                    type="button"
                    className="aisw-btn aisw-btn-secondary"
                    disabled={submitting}
                    onClick={() => void submit(null, { addressAsTyped: true })}
                  >
                    Send it anyway
                  </button>
                </div>
              ) : null}
              <Field
                id={fieldId("phone")}
                label="Phone"
                optional
                hint="In case the crew needs to reach you on the day."
                error={fieldErrors.phone}
              >
                <input
                  id={fieldId("phone")}
                  name="phone"
                  className="aisw-input"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  maxLength={LIMITS.phone}
                  value={form.phone}
                  aria-invalid={fieldErrors.phone ? true : undefined}
                  aria-describedby={describedBy(fieldId("phone"), true, fieldErrors.phone)}
                  onChange={(event) => update("phone", event.target.value)}
                />
              </Field>
              <Field
                id={fieldId("notes")}
                label="Anything we should know?"
                optional
                hint="Gate codes, pets, which windows — whatever helps."
                error={fieldErrors.notes}
              >
                <textarea
                  id={fieldId("notes")}
                  name="notes"
                  className="aisw-input"
                  rows={3}
                  maxLength={LIMITS.notes}
                  value={form.notes}
                  aria-invalid={fieldErrors.notes ? true : undefined}
                  aria-describedby={describedBy(fieldId("notes"), true, fieldErrors.notes)}
                  onChange={(event) => update("notes", event.target.value)}
                />
              </Field>
              {/* The honeypot. Off-screen rather than display:none, out of the
                  tab order, hidden from assistive tech, and never autofilled. */}
              <div className="aisw-hp" aria-hidden="true">
                <label htmlFor={fieldId("website")}>Website</label>
                <input
                  id={fieldId("website")}
                  name="website"
                  type="text"
                  tabIndex={-1}
                  autoComplete="off"
                  value={form.website}
                  onChange={(event) => update("website", event.target.value)}
                />
              </div>

              {submitError ? <Notice tone="error">{submitError}</Notice> : null}

              <button
                type="submit"
                className="aisw-btn aisw-btn-primary aisw-btn-block"
                disabled={submitting}
                aria-busy={submitting || undefined}
              >
                {submitting ? "Sending…" : config.autoConfirm ? "Book this visit" : "Request this visit"}
              </button>
              <p className="aisw-hint">
                {config.autoConfirm
                  ? "Your visit is booked as soon as you send this."
                  : `${config.businessName || "The business"} confirms each request.`}
              </p>
            </form>
          </section>
        ) : null}

        {currentStep === "done" && result ? (
          <Confirmation result={result} config={config} transport={transport} locale={locale} headingRef={headingRef} />
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
      accent={props.accentColor ?? null}
      data={{
        "aisw-picker":
          configState.status === "ready"
            ? closed && currentStep !== "done"
              ? "closed"
              : currentStep
            : configState.status === "error" && configState.error.code === "booking_closed"
              ? "closed"
              : configState.status,
      }}
    >
      <div className="aisw-body">{body}</div>
    </WidgetRoot>
  );
}

/** What the customer sees once the request is in. */
function Confirmation({
  result,
  config,
  transport,
  locale,
  headingRef,
}: {
  result: VisitRequestResponse;
  config: PublicConfig;
  transport: SchedulingTransport;
  locale: string;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const titleId = useId();
  const { visit, manageUrl } = result;
  const requested = visit.status === "requested";
  // A repeat carries no key to the visit: the first request's email has the link.
  const repeatWithoutLink = result.repeated && !result.manageToken;
  const business = visit.businessName || config.businessName || "The business";
  const cutoff = config.cancelCutoffHours;
  const changeLine =
    cutoff > 0
      ? `You can change or cancel online up to ${cutoff} hour${cutoff === 1 ? "" : "s"} before the visit.`
      : "You can change or cancel online until the visit starts.";
  return (
    <section className="aisw-done" aria-labelledby={titleId} data-aisw-confirmation={requested ? "requested" : "confirmed"}>
      <div className="aisw-done-head">
        <span className={`aisw-badge${requested ? " aisw-badge-warn" : ""}`}>{requested ? <ClockIcon /> : <CheckIcon />}</span>
        <div>
          <h2 className="aisw-done-title" id={titleId} ref={headingRef} tabIndex={-1}>
            {requested ? "Request received" : "You're booked"}
          </h2>
          <p className="aisw-sub">
            {requested ? `${business} will confirm it soon.` : `${business} will see you at the time below.`}
          </p>
        </div>
      </div>
      <VisitFacts visit={visit} locale={locale} />
      {/* Only a visit that is ON: a request may still be declined or lapse,
          and a calendar entry for a visit that isn't happening is worse than
          none. The confirmation email carries the calendar links (BO-12). */}
      {requested ? null : (
        <CalendarActions
          google={clientCalendarUrl(visit, manageUrl)}
          icsHref={result.manageToken ? transport.icsUrl(result.manageToken) : null}
        />
      )}

      <div className="aisw-next">
        <h3 className="aisw-h3">What happens next</h3>
        <ul className="aisw-list">
          {requested ? (
            <>
              <li>{business} checks the time and confirms it.</li>
              <li>
                {config.emailsEnabled
                  ? "You'll get an email when they do — or, if they can't make it, so you can pick another time."
                  : "Open your link below to see when they do."}
              </li>
            </>
          ) : (
            <li>The crew comes to {visit.address ? visit.address : "your address"} at the time above.</li>
          )}
          <li>{changeLine}</li>
        </ul>
      </div>

      {repeatWithoutLink ? (
        <p className="aisw-sub" data-aisw-manage="repeat">
          We already had this request from you, so nothing new was booked.{" "}
          {config.emailsEnabled
            ? "The email we sent you has the link to change or cancel it."
            : `To change or cancel it, ${(config.contactPhone ? `call ${config.contactPhone}.` : config.contactEmail ? `email ${config.contactEmail}.` : "get in touch with us.")}`}
        </p>
      ) : config.emailsEnabled ? (
        <p className="aisw-sub" data-aisw-manage="email">
          {/* CONTRACT: 8.3 gives one sentence ("We've emailed you a confirmation
              with a link to change it."). A request isn't confirmed yet and the
              server sends it `visit_requested`, not a confirmation, so a pending
              visit says "a copy of your request" instead: promise only what the
              email actually is. */}
          {requested
            ? "We've emailed you a copy of your request with a link to change it."
            : "We've emailed you a confirmation with a link to change it."}{" "}
          {manageUrl ? <a href={manageUrl}>Change or cancel this visit</a> : null}
        </p>
      ) : manageUrl ? (
        <CopyField
          label="Keep this link to change or cancel your visit"
          value={manageUrl}
          buttonLabel="Copy link"
          hint="It's the only way to change or cancel online. Bookmark it, or add the visit to your calendar (the link is inside)."
        />
      ) : null}
    </section>
  );
}
