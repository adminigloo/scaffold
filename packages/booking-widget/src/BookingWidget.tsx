import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import { BookingClient } from "./client.js";
import { Confirmation } from "./Confirmation.js";
import { useHold, useNow, useStepFocus } from "./hooks.js";
import {
  defaultRealBookingLabel,
  defaultSandboxNotice,
  describeWhen,
  HoldCountdown,
  Loading,
  Notice,
  SandboxBanner,
} from "./parts.js";
import { Picker } from "./Picker.js";
import {
  alreadyBookedMessage,
  buildBookRequest,
  EMPTY_FORM,
  firstInvalidField,
  friendlyError,
  isSlotGone,
  issuesToFieldErrors,
  LIMITS,
  MEDIUM_COPY,
  normalizeCallingCode,
  normalizePhone,
  orderedMedia,
  PHONE_EXAMPLE,
  sourceFromSearch,
  validateBookForm,
  type BookField,
  type BookFormValues,
  type BookingError,
  type EmailFacts,
  type FieldErrors,
} from "./requests.js";
import { injectStyles } from "./styles.js";
import { browserTimeZone, formatDuration, resolveInitialZone, sameInstant, type LocalSlot } from "./time.js";
import type { BookingConfig, BookResponse, Medium, Slot } from "./types.js";

/**
 * <BookingWidget> — the public booking flow, three steps in one card:
 *
 *   pick     type (when there is more than one), day, time — in the viewer's zone
 *   details  the held time with its countdown, then name / email / how we meet
 *   done     the confirmation (or, in sandbox mode, a labelled preview of it)
 *
 * Steps rather than one long page because the widget embeds into a column of
 * someone else's page and must work at 390px; focus moves to each step's
 * heading as it opens, so keyboard and screen-reader users land where the
 * content changed.
 *
 * HOLDS. Picking a time holds it for ten minutes (a countdown shows it);
 * picking another hands the first back in the same request; switching type,
 * leaving the page or unmounting releases it best-effort. A hold that runs out
 * is not fatal — booking re-checks the time and still succeeds while it is
 * free — so the countdown offers "hold it again" rather than ending the flow.
 *
 * When the time goes anyway (`slot_taken` / `hold_expired`), the visitor is
 * told plainly, the times are refetched, and everything typed is kept. When
 * the same form arrives twice (`already_booked` — a double click, or a retry
 * after an answer that was lost), they are told the first one worked and
 * where its confirmation is, instead of being sent back to pick a time.
 */

export interface BookingWidgetProps {
  /** The mounted handlers' base URL, e.g. "/api/booking". */
  baseUrl: string;
  /** For keyed cross-origin embeds; sent as `x-adminigloo-key`. */
  clientKey?: string;
  /** Force sandbox mode. The server's `config.sandbox` turns it on too. */
  sandbox?: boolean;
  /** Override the sandbox banner's copy. */
  sandboxNotice?: string;
  /** Where the sandbox's "book a real call" button goes. */
  realBookingHref?: string;
  /** Default: "Book a real call with {host} →". */
  realBookingLabel?: string;
  /** Override the sandbox confirmation's "What happens on a real booking" list. */
  realBookingSteps?: readonly string[];
  /**
   * The line under "You're booked". Leave unset for the default ("A
   * confirmation is on its way to …"); pass a string when the host app knows
   * better — e.g. it has no email provider yet — or null to drop the line.
   */
  confirmationNote?: string | null;
  /** IANA zone to open in. Default: the viewer's browser zone. */
  defaultTimezone?: string;
  /** Attribution. Default: `?src=` or the UTM tags on the page URL. */
  source?: string;
  /** Called once a booking is made (sandbox bookings included). */
  onBooked?: (result: BookResponse) => void;
  /** Preselect this booking type. */
  typeKey?: string;
  /** Override the card's heading. */
  title?: string;
  /**
   * Leave the type's description out of the header. For a page that already
   * pitches the call right above the widget, so the same sentence is not
   * read twice before the first time on offer.
   */
  hideDescription?: boolean;
  /** Formatting locale for dates and times. Default "en-US" (the copy is English). */
  locale?: string;
  /** Pin a theme; "auto" (default) follows prefers-color-scheme. */
  theme?: "auto" | "light" | "dark";
  className?: string;
  style?: CSSProperties;
  /**
   * The country calling code ("1") a phone number typed without "+" is read
   * in, e.g. "801 555 0143" → +18015550143. Default: whatever the server's
   * config advertises (its `defaultCallingCode` option); with neither, the
   * "+" and country code are required.
   */
  defaultCallingCode?: string;
}

type Step = "pick" | "details" | "done";

type ConfigState =
  | { status: "loading" }
  | { status: "ready"; config: BookingConfig }
  | { status: "error"; error: BookingError };

export function BookingWidget(props: BookingWidgetProps) {
  const locale = props.locale ?? "en-US";
  const client = useMemo(
    () => new BookingClient({ baseUrl: props.baseUrl, clientKey: props.clientKey }),
    [props.baseUrl, props.clientKey],
  );

  const [configState, setConfigState] = useState<ConfigState>({ status: "loading" });
  const [configReload, setConfigReload] = useState(0);
  const [chosenType, setChosenType] = useState<string | null>(null);
  const [zoneChoice, setZoneChoice] = useState<string | null>(null);
  const [browserZone] = useState(() => browserTimeZone());
  const [step, setStep] = useState<Step>("pick");
  const [picked, setPicked] = useState<Slot | null>(null);
  const [pickNotice, setPickNotice] = useState<string | null>(null);
  const [holdNote, setHoldNote] = useState<string | null>(null);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [form, setForm] = useState<BookFormValues>(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<BookResponse | null>(null);
  const headingRef = useStepFocus<HTMLHeadingElement>(step);
  const ids = useId();
  const fieldId = (field: BookField) => `${ids}-${field}`;

  /** The time went away: say so, refetch, keep the form, back to the picker. */
  const timeGone = useCallback((message: string) => {
    setPicked(null);
    setPickNotice(message);
    setHoldNote(null);
    setRefreshSignal((n) => n + 1);
    setStep("pick");
  }, []);

  const hold = useHold(
    client,
    useCallback((error: BookingError) => timeGone(friendlyError(error, "hold")), [timeGone]),
  );

  useEffect(() => {
    injectStyles();
  }, []);

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
  const types = config?.types ?? [];
  const type =
    types.find((t) => t.key === chosenType) ?? types.find((t) => t.key === props.typeKey) ?? types[0] ?? null;
  const media = type ? orderedMedia(type.media) : [];
  const medium: Medium | null = form.medium && media.includes(form.medium) ? form.medium : (media[0] ?? null);
  const sandbox = Boolean(props.sandbox || config?.sandbox);
  const host = config?.hostDisplayName ?? "";
  const callingCode = normalizeCallingCode(props.defaultCallingCode) ?? config?.defaultCallingCode ?? null;
  const zone = zoneChoice ?? resolveInitialZone(props.defaultTimezone, browserZone, config?.hostTimezone);
  const suggestedZones = useMemo(
    () => [browserZone, ...(config?.hostTimezone ? [config.hostTimezone] : [])],
    [browserZone, config?.hostTimezone],
  );
  const realBookingLabel = props.realBookingLabel ?? defaultRealBookingLabel(host);
  const emails = useMemo<EmailFacts | null>(
    () => (config ? { emailsEnabled: config.emailsEnabled, contactEmail: config.contactEmail } : null),
    [config],
  );

  const heldHere = hold.hold && picked && sameInstant(hold.hold.start, picked.start) ? hold.hold : null;
  const now = useNow(step === "details" && heldHere !== null);
  const remaining = heldHere ? heldHere.deadline - now : null;
  const expired = remaining !== null && remaining <= 0;

  const update = <K extends keyof BookFormValues>(field: K, value: BookFormValues[K]) => {
    setForm((current) => ({ ...current, [field]: value }) as BookFormValues);
    if (fieldErrors[field as BookField]) {
      setFieldErrors((current) => {
        const next = { ...current };
        delete next[field as BookField];
        return next;
      });
    }
  };

  const chooseType = (key: string) => {
    if (key === type?.key) return;
    hold.release();
    setChosenType(key);
    setPicked(null);
    setPickNotice(null);
    setHoldNote(null);
    setStep("pick");
  };

  const takeHold = async (start: string, end: string) => {
    if (!type) return;
    setPickNotice(null);
    setHoldNote(null);
    setSubmitError(null);
    setPicked({ start, end });
    const res = await hold.take(type.key, start);
    if (res === null) return; // a later pick superseded this one
    if (res.ok) {
      setPicked({ start: res.data.start, end: res.data.end });
      setStep("details");
      return;
    }
    const error = res.error;
    if (isSlotGone(error) || error.code === "invalid") {
      timeGone(friendlyError(error, "hold"));
      return;
    }
    if (error.code === "not_found") {
      // The type itself is gone: reload the config so the picker shows what is offered now.
      setPicked(null);
      setPickNotice(friendlyError(error, "hold"));
      setChosenType(null);
      setConfigReload((n) => n + 1);
      return;
    }
    if (error.code === "unlicensed") {
      setPicked(null);
      setPickNotice(friendlyError(error, "hold"));
      return;
    }
    // Network trouble or a rate limit: go on without a hold. Booking re-checks
    // the time, so the worst case is the same slot_taken recovery as above.
    setHoldNote("We couldn't hold this time for you, but you can still book it — we'll check it's free when you confirm.");
    setStep("details");
  };

  const pickSlot = (slot: LocalSlot) => void takeHold(slot.start, slot.end);

  const focusField = (field: BookField | null) => {
    if (!field || typeof document === "undefined") return;
    const id = field === "medium" ? `${fieldId("medium")}-0` : fieldId(field);
    document.getElementById(id)?.focus();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!type || !picked || submitting) return;
    const values = { ...form, medium };
    const errors = validateBookForm(values, media, { defaultCallingCode: callingCode });
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0 || !medium) {
      setSubmitError(null);
      focusField(firstInvalidField(errors));
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    const source =
      props.source ?? (typeof window !== "undefined" ? sourceFromSearch(window.location.search) : undefined);
    const res = await client.book(
      buildBookRequest({
        type: type.key,
        start: picked.start,
        holdToken: heldHere?.token,
        values,
        medium,
        timezone: zone,
        source,
        defaultCallingCode: callingCode,
      }),
    );
    setSubmitting(false);
    if (res.ok) {
      hold.consume();
      setResult(res.data);
      setStep("done");
      props.onBooked?.(res.data);
      return;
    }
    const error = res.error;
    if (error.code === "already_booked") {
      // The same form went twice and the FIRST one booked (its answer was
      // lost, or a double click). The hold is now that booking — forget it
      // without releasing — and say where the confirmation is. No refetch,
      // no "pick another time": nothing is wrong with the time.
      hold.consume();
      setSubmitError(alreadyBookedMessage(emails, { sandbox, hostDisplayName: host }));
      return;
    }
    const timeIssue = error.issues.some((issue) => ["start", "type", "holdToken"].includes(issue.path[0] ?? ""));
    if (isSlotGone(error) || (error.code === "invalid" && timeIssue)) {
      hold.release();
      timeGone(friendlyError(error, isSlotGone(error) ? "book" : "hold"));
      return;
    }
    if (error.code === "invalid") {
      const mapped = issuesToFieldErrors(error.issues);
      setFieldErrors(mapped);
      setSubmitError(friendlyError(error, "book"));
      focusField(firstInvalidField(mapped));
      return;
    }
    setSubmitError(friendlyError(error, "book", emails));
  };

  const reset = () => {
    hold.release();
    setResult(null);
    setPicked(null);
    setPickNotice(null);
    setHoldNote(null);
    setSubmitError(null);
    setFieldErrors({});
    setRefreshSignal((n) => n + 1);
    setStep("pick");
  };

  const rootClass = `aibk-root${props.className ? ` ${props.className}` : ""}`;
  const theme = props.theme && props.theme !== "auto" ? props.theme : undefined;

  return (
    <div className={rootClass} style={props.style} data-theme={theme} data-aibk-step={step}>
      {sandbox ? (
        <SandboxBanner
          notice={props.sandboxNotice ?? defaultSandboxNotice(host)}
          realBookingHref={props.realBookingHref}
          realBookingLabel={realBookingLabel}
        />
      ) : null}
      <div className="aibk-body">
        {configState.status === "loading" ? <Loading label="Loading…" /> : null}

        {configState.status === "error" ? (
          <Notice tone="error">
            {friendlyError(configState.error, "config")}{" "}
            {configState.error.code !== "unlicensed" ? (
              <button type="button" className="aibk-btn aibk-btn-link" onClick={() => setConfigReload((n) => n + 1)}>
                Try again
              </button>
            ) : null}
          </Notice>
        ) : null}

        {config && !type ? (
          <div className="aibk-empty">
            <span className="aibk-empty-title">Nothing to book right now</span>
            <span>Please check back soon.</span>
          </div>
        ) : null}

        {config && type && step === "done" && result ? (
          <Confirmation
            result={result}
            zone={zone}
            locale={locale}
            client={client}
            sandbox={sandbox || result.booking.sandbox}
            inviteeEmail={form.email.trim()}
            // The number as the server stored it, not as typed: a number read
            // in the wrong country is caught by the visitor right here.
            inviteePhone={
              form.phone.trim()
                ? (normalizePhone(form.phone, { defaultCallingCode: callingCode }) ?? form.phone.trim())
                : undefined
            }
            confirmationNote={props.confirmationNote}
            emails={emails}
            realBookingHref={props.realBookingHref}
            realBookingLabel={realBookingLabel}
            realBookingSteps={props.realBookingSteps}
            headingRef={headingRef}
            onReset={sandbox || result.booking.sandbox ? reset : undefined}
          />
        ) : null}

        {config && type && step !== "done" ? (
          <>
            <header className="aibk-head">
              <h2 className="aibk-title">{props.title ?? (types.length > 1 ? `Book time${host ? ` with ${host}` : ""}` : type.name)}</h2>
              <p className="aibk-sub">
                {formatDuration(type.durationMinutes)}
                {types.length > 1 ? ` · ${type.name}` : host ? ` · with ${host}` : ""}
              </p>
              {type.description && types.length === 1 && !props.hideDescription ? (
                <p className="aibk-sub">{type.description}</p>
              ) : null}
            </header>

            {types.length > 1 && step === "pick" ? (
              <div className="aibk-types" role="group" aria-label="What would you like to book?">
                {types.map((candidate) => (
                  <button
                    key={candidate.key}
                    type="button"
                    className="aibk-type"
                    aria-pressed={candidate.key === type.key}
                    onClick={() => chooseType(candidate.key)}
                  >
                    <span className="aibk-type-name">
                      {candidate.name}
                      <span className="aibk-type-len">{formatDuration(candidate.durationMinutes)}</span>
                    </span>
                    {candidate.description ? <span className="aibk-type-desc">{candidate.description}</span> : null}
                  </button>
                ))}
              </div>
            ) : null}

            {step === "pick" ? (
              <Picker
                client={client}
                typeKey={type.key}
                zone={zone}
                onZoneChange={setZoneChoice}
                suggestedZones={suggestedZones}
                locale={locale}
                selectedStart={picked?.start ?? null}
                pendingStart={hold.pendingStart}
                onPick={pickSlot}
                sandbox={sandbox}
                refreshSignal={refreshSignal}
                heading="Choose a time"
                headingRef={headingRef}
                notice={pickNotice ? <Notice tone="warn">{pickNotice}</Notice> : null}
                horizonDays={type.horizonDays}
                hostTimezone={config.hostTimezone}
              />
            ) : null}

            {step === "details" && picked ? (
              <section className="aibk-section" aria-labelledby={`${ids}-details`}>
                <h3 className="aibk-h3" id={`${ids}-details`} ref={headingRef} tabIndex={-1}>
                  Your details
                </h3>
                <div className="aibk-picked">
                  <div className="aibk-picked-main">
                    <span className="aibk-picked-when">{describeWhen(picked.start, zone, locale)}</span>
                    <span className="aibk-picked-meta">
                      {type.name} · {formatDuration(type.durationMinutes)}
                      {sandbox ? " · sandbox time" : ""}
                    </span>
                    {heldHere && !expired ? <HoldCountdown deadline={heldHere.deadline} now={now} /> : null}
                  </div>
                  <button type="button" className="aibk-btn aibk-btn-secondary" onClick={() => setStep("pick")}>
                    Change time
                  </button>
                </div>

                {expired ? (
                  <Notice tone="warn">
                    Your hold ran out, so this time isn't reserved any more — you can still book it if it's free.{" "}
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

                <form className="aibk-form" noValidate onSubmit={(event) => void submit(event)}>
                  <div className="aibk-row2">
                    <Field
                      id={fieldId("name")}
                      label="Name"
                      error={fieldErrors.name}
                    >
                      <input
                        id={fieldId("name")}
                        className="aibk-input"
                        type="text"
                        autoComplete="name"
                        maxLength={LIMITS.name}
                        required
                        value={form.name}
                        aria-invalid={fieldErrors.name ? true : undefined}
                        aria-describedby={fieldErrors.name ? `${fieldId("name")}-error` : undefined}
                        onChange={(event) => update("name", event.target.value)}
                      />
                    </Field>
                    <Field id={fieldId("email")} label="Email" error={fieldErrors.email}>
                      <input
                        id={fieldId("email")}
                        className="aibk-input"
                        type="email"
                        inputMode="email"
                        autoComplete="email"
                        maxLength={LIMITS.email}
                        required
                        value={form.email}
                        aria-invalid={fieldErrors.email ? true : undefined}
                        aria-describedby={fieldErrors.email ? `${fieldId("email")}-error` : undefined}
                        onChange={(event) => update("email", event.target.value)}
                      />
                    </Field>
                  </div>

                  <fieldset
                    className="aibk-media"
                    aria-describedby={fieldErrors.medium ? `${fieldId("medium")}-error` : undefined}
                  >
                    <legend className="aibk-label">How should we meet?</legend>
                    {media.map((option, index) => (
                      <label key={option} className={`aibk-medium${medium === option ? " aibk-on" : ""}`}>
                        <input
                          id={`${fieldId("medium")}-${index}`}
                          type="radio"
                          name={`${ids}-medium`}
                          value={option}
                          checked={medium === option}
                          onChange={() => update("medium", option)}
                        />
                        <span className="aibk-medium-text">
                          <span className="aibk-medium-title">{MEDIUM_COPY[option].title}</span>
                          <span className="aibk-medium-blurb">{MEDIUM_COPY[option].blurb}</span>
                        </span>
                      </label>
                    ))}
                    {fieldErrors.medium ? (
                      <span className="aibk-field-error" id={`${fieldId("medium")}-error`}>
                        {fieldErrors.medium}
                      </span>
                    ) : null}
                  </fieldset>

                  <div className="aibk-row2">
                    <Field
                      id={fieldId("phone")}
                      label={medium === "phone" ? "Phone number" : "Phone"}
                      optional={medium !== "phone"}
                      hint={
                        (medium === "phone"
                          ? "We call this number at the time you picked. "
                          : "Only used about this booking. ") +
                        (callingCode
                          ? `Outside +${callingCode}? Start with + and the country code.`
                          : "Include the country code.")
                      }
                      error={fieldErrors.phone}
                    >
                      <input
                        id={fieldId("phone")}
                        className="aibk-input"
                        type="tel"
                        inputMode="tel"
                        autoComplete="tel"
                        maxLength={32}
                        placeholder={PHONE_EXAMPLE}
                        required={medium === "phone"}
                        value={form.phone}
                        aria-invalid={fieldErrors.phone ? true : undefined}
                        aria-describedby={`${fieldId("phone")}-hint${fieldErrors.phone ? ` ${fieldId("phone")}-error` : ""}`}
                        onChange={(event) => update("phone", event.target.value)}
                      />
                    </Field>
                    <Field id={fieldId("company")} label="Company" optional error={fieldErrors.company}>
                      <input
                        id={fieldId("company")}
                        className="aibk-input"
                        type="text"
                        autoComplete="organization"
                        maxLength={LIMITS.company}
                        value={form.company}
                        aria-invalid={fieldErrors.company ? true : undefined}
                        aria-describedby={fieldErrors.company ? `${fieldId("company")}-error` : undefined}
                        onChange={(event) => update("company", event.target.value)}
                      />
                    </Field>
                  </div>

                  <Field
                    id={fieldId("notes")}
                    label="Anything we should know?"
                    optional
                    hint={`${form.notes.length} / ${LIMITS.notes}`}
                    error={fieldErrors.notes}
                  >
                    <textarea
                      id={fieldId("notes")}
                      className="aibk-input"
                      rows={3}
                      maxLength={LIMITS.notes}
                      value={form.notes}
                      aria-invalid={fieldErrors.notes ? true : undefined}
                      aria-describedby={`${fieldId("notes")}-hint${fieldErrors.notes ? ` ${fieldId("notes")}-error` : ""}`}
                      onChange={(event) => update("notes", event.target.value)}
                    />
                  </Field>

                  {submitError ? <Notice tone="error">{submitError}</Notice> : null}

                  <button
                    type="submit"
                    className="aibk-btn aibk-btn-primary aibk-btn-block"
                    disabled={submitting}
                    aria-busy={submitting || undefined}
                  >
                    {submitting ? "Booking…" : sandbox ? "Confirm booking (sandbox)" : "Confirm booking"}
                  </button>
                </form>
              </section>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

/** A labelled form field with its hint and error wired for screen readers. */
function Field({
  id,
  label,
  optional,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  optional?: boolean;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="aibk-field">
      <label className="aibk-label" htmlFor={id}>
        {label} {optional ? <span className="aibk-optional">(optional)</span> : null}
      </label>
      {children}
      {hint ? (
        <span className="aibk-hint" id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="aibk-field-error" id={`${id}-error`}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
