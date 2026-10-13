import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { TenancyTransport } from "./client.js";
import {
  CheckCircleIcon,
  describedBy,
  Field,
  Loading,
  navigate,
  Notice,
  WidgetRoot,
  type ChromeProps,
  type NounProps,
} from "./parts.js";
import { companyNameProblem, companyNameProblemMessage, normaliseCompanyName, suggestSlug } from "./slug.js";
import { isUnconnected, useDebounced, useLoaded, useTenancyTransport } from "./transport.js";
import type { AcceptWire, CreateCompanyWire, SessionWire, SlugCheckWire } from "./types.js";
import { acceptOutcomeText, errorText, nounOf, NOT_CONNECTED_MESSAGE, ONBOARDING, W } from "./words.js";

/**
 * <Onboarding> (contract 8.3): the one question a new owner is asked, "What's
 * your company called?", with the web address suggested from the name, and
 * any invitation waiting for one of their verified addresses offered first.
 *
 * ONE COMPANY PER SUBMIT, WHATEVER HAPPENS. The form mints a request key once
 * per mount and sends the SAME key with every attempt: a double click, a
 * retry after a network error, a second press while the first is still in
 * flight. The server replays a key it has seen (`replayed`), so an owner who
 * clicks twice gets one company, never two. A new key per attempt would be
 * the bug the e2e negative control plants on purpose.
 *
 * NOTHING JOINS BY ITSELF. An invitation is joined only by pressing "Join"
 * (decision D19): an account must never join a company as a side effect of
 * opening a page.
 */

export interface OnboardingProps extends ChromeProps, NounProps {
  baseUrl?: string;
  transport?: TenancyTransport;
  /** "onboarding" (default) for a first company; "additional" is "Create another company". */
  purpose?: "onboarding" | "additional";
  /** Where to go once created or joined. Default "/dashboard". */
  afterHref?: string;
  /** Shown before the address, e.g. "https://app.example.com/t/". Default "/t/". */
  publicUrlPrefix?: string;
  /** Server-resolved, so there is no loading flash. Without it the component asks for the session. */
  initialSession?: SessionWire;
  /** Called instead of navigating, with what happened and where. */
  onDone?: (result: {
    status: CreateCompanyWire["status"] | AcceptWire["status"];
    company: { id: string; name: string };
  }) => void;
  /**
   * For platform staff (the person who runs the site), the admin console's
   * address: onboarding then says they don't need a company of their own and
   * links there, instead of nudging them into making a fake one that shows up
   * in their own console as a customer (review T1-09). Leave it unset for
   * everyone else.
   */
  staffConsoleHref?: string | null;
}

/** A one-time key for this form: a UUID where the browser has one, else 32 random hex characters. */
export function mintRequestKey(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* an insecure context: fall through */
  }
  const bytes = new Uint8Array(16);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The last answer, for the query it answered; `data: null` when the check itself failed (say nothing). */
type Check = { key: string; data: SlugCheckWire | null } | null;

export function Onboarding(props: OnboardingProps) {
  const {
    purpose = "onboarding",
    afterHref = "/dashboard",
    publicUrlPrefix = "/t/",
    initialSession,
    onDone,
    staffConsoleHref = null,
    theme,
    nonce,
    className,
    style,
  } = props;
  const noun = nounOf(props.noun);
  const transport = useTenancyTransport(props.transport, props.baseUrl);
  const unconnected = isUnconnected(props.transport, props.baseUrl);
  const session = useLoaded(() => transport.session(), initialSession, unconnected ? null : "session");

  const nameId = useId();
  const slugId = useId();
  const statusId = useId();
  const slugRef = useRef<HTMLInputElement | null>(null);

  const [name, setName] = useState("");
  const [edited, setEdited] = useState(false);
  const [slugInput, setSlugInput] = useState("");
  const [check, setCheck] = useState<Check>(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const requestKey = useRef<string | null>(null);
  /** What the key was first sent with: a different name or address is a different company (review T1-17). */
  const keyFor = useRef<string | null>(null);
  /** A replayed or already-made company whose name isn't what was just typed: say so instead of moving on. */
  const [landed, setLanded] = useState<{
    status: CreateCompanyWire["status"];
    company: { id: string; name: string };
    /** The create's answer was lost, but the company exists (review R2 T1BO-01). */
    lostAnswer?: boolean;
  } | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [slugError, setSlugError] = useState<{ message: string; suggestion: string | null } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [joins, setJoins] = useState<Record<string, { busy: boolean; message: string | null }>>({});

  /** The companies this person already had when the page opened: a lost answer is told apart by a NEW one. */
  const knownIds = useRef<Set<string>>(new Set());
  const knownFrom = useRef<SessionWire | null>(null);
  if (session.data && knownFrom.current !== session.data) {
    knownFrom.current = session.data;
    knownIds.current = new Set(session.data.companies.map((c) => c.id));
  }

  const normalisedName = normaliseCompanyName(name);
  const derived = normalisedName ? suggestSlug(normalisedName) : "";
  const slug = edited ? slugInput.trim().toLowerCase() : derived;

  // What to ask the server about: the name (it suggests and checks, and adds
  // -2 when the suggestion is taken) until the owner edits the address; then
  // the address exactly as typed.
  const queryKey = edited ? (slug ? `slug:${slug}` : "") : derived ? `name:${normalisedName}` : "";
  const settledKey = useDebounced(queryKey, 350);

  useEffect(() => {
    if (!settledKey || unconnected) return;
    let alive = true;
    const [mode, ...rest] = settledKey.split(":");
    const value = rest.join(":");
    void transport.checkSlug(mode === "slug" ? { slug: value } : { name: value }).then((res) => {
      if (alive) setCheck({ key: settledKey, data: res.ok ? res.data : null });
    });
    return () => {
      alive = false;
    };
  }, [settledKey, transport, unconnected]);

  const answered = check !== null && check.key === queryKey;
  const current = answered ? check.data : null;
  const checking = queryKey !== "" && !answered;
  // Until edited, show the address the server will really use (review R2
  // T1BO-03). For a NAME the server answers the first FREE address it derives
  // — "green-acres-lawn-care-2" when another company has the plain one — as
  // `slug`, marked available; showing the local guess there told the second
  // "Green Acres Lawn Care" that its address was "/t/green-acres-lawn-care",
  // and the company was saved at "-2". (An older server answered unavailable
  // with a suggestion; that's still honoured.)
  const shownSlug =
    !edited && current ? (current.available ? current.slug || slug : current.suggestion || slug) : slug;
  const problem = edited && current && !current.available ? current : null;

  const done = (status: CreateCompanyWire["status"] | AcceptWire["status"], company: { id: string; name: string }) => {
    if (onDone) onDone({ status, company });
    else navigate(afterHref);
  };

  const startEdit = () => {
    setSlugInput(shownSlug);
    setEdited(true);
    setSlugError(null);
    setTimeout(() => slugRef.current?.focus(), 0);
  };

  const takeSuggestion = (suggestion: string) => {
    setEdited(true);
    setSlugInput(suggestion);
    setSlugError(null);
    setTimeout(() => slugRef.current?.focus(), 0);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // A second press while the first is in flight sends nothing at all; a
    // retry after a failure sends the same key (see the header).
    if (sendingRef.current) return;
    setFormError(null);
    const nameProblem = companyNameProblem(name);
    if (nameProblem) {
      setNameError(companyNameProblemMessage(nameProblem, noun.singular));
      return;
    }
    setNameError(null);
    setSlugError(null);
    sendingRef.current = true;
    setSending(true);
    // The SAME key for the same company (a double click, a retry after a lost
    // answer): one company, never two. A DIFFERENT name or address after a
    // failed attempt is a different request, so it gets a new key — otherwise
    // the server would replay the first attempt and the corrected name would
    // be silently dropped (review T1-17).
    const sentFor = `${normalisedName}\u0000${edited ? slug : ""}`;
    if (requestKey.current === null || keyFor.current !== sentFor) {
      requestKey.current = mintRequestKey();
      keyFor.current = sentFor;
    }
    const res = await transport.createCompany({
      name: normalisedName,
      requestKey: requestKey.current,
      purpose,
      ...(edited ? { slug } : {}),
    });
    if (res.ok) {
      const made = { id: res.data.company.id, name: res.data.company.name };
      if (res.data.status !== "created" && normaliseCompanyName(made.name).toLowerCase() !== normalisedName.toLowerCase()) {
        // An earlier attempt already made a company under another name (a lost
        // answer, another tab). Don't move on as if this one worked.
        sendingRef.current = false;
        setSending(false);
        setLanded({ status: res.data.status, company: made });
        return;
      }
      // Stay "sending" while the page navigates away: no third press.
      done(res.data.status, made);
      return;
    }
    const error = res.error;
    // A LOST ANSWER (review R2 T1BO-01): the request may well have made the
    // company — the connection dropped on the way back. Before anyone presses
    // Create again (or takes the "-2" address the check now offers, because
    // the plain one is theirs), ask the session whether it exists; if it
    // does, say so and offer to open it. Retrying is how twins were made.
    if (error.code === "network" || error.code === "internal" || error.code === "bad_response") {
      const now = await transport.session();
      const twin = now.ok
        ? now.data.companies.find((c) => normaliseCompanyName(c.name).toLowerCase() === normalisedName.toLowerCase() && !knownIds.current.has(c.id))
        : undefined;
      if (twin) {
        sendingRef.current = false;
        setSending(false);
        setLanded({ status: "replayed", company: { id: twin.id, name: twin.name }, lostAnswer: true });
        return;
      }
    }
    sendingRef.current = false;
    setSending(false);
    if (error.code === "name_invalid") {
      setNameError(errorText(error, noun));
    } else if (error.code === "slug_invalid" || error.code === "slug_reserved" || error.code === "slug_taken") {
      if (!edited) {
        setSlugInput(shownSlug);
        setEdited(true);
      }
      setSlugError({ message: errorText(error, noun), suggestion: error.suggestion ?? null });
    } else if (error.code === "invalid" && error.issues?.length) {
      let placed = false;
      for (const issue of error.issues) {
        if (issue.path[0] === "name") {
          setNameError(issue.message);
          placed = true;
        } else if (issue.path[0] === "slug") {
          setSlugError({ message: issue.message, suggestion: null });
          placed = true;
        }
      }
      if (!placed) setFormError(errorText(error, noun));
    } else {
      setFormError(errorText(error, noun));
    }
  };

  const join = async (id: string) => {
    if (joins[id]?.busy) return;
    setJoins((all) => ({ ...all, [id]: { busy: true, message: null } }));
    const res = await transport.joinInvitation(id);
    if (res.ok && (res.data.status === "accepted" || res.data.status === "already-a-member") && res.data.company) {
      done(res.data.status, res.data.company);
      return;
    }
    const message = res.ok ? acceptOutcomeText(res.data, noun) : errorText(res.error, noun);
    setJoins((all) => ({ ...all, [id]: { busy: false, message } }));
  };

  const chrome = { theme, nonce, className, style };
  if (unconnected) {
    return (
      <WidgetRoot {...chrome}>
        <div className="aitw-panel aitw-onboard">
          <Notice tone="error">{NOT_CONNECTED_MESSAGE}</Notice>
        </div>
      </WidgetRoot>
    );
  }
  if (!session.data && session.loading) {
    return (
      <WidgetRoot {...chrome}>
        <div className="aitw-panel aitw-onboard">
          <Loading label={W.loading} />
        </div>
      </WidgetRoot>
    );
  }
  if (session.error?.code === "signed_out") {
    return (
      <WidgetRoot {...chrome}>
        <div className="aitw-panel aitw-onboard">
          <Notice tone="error">{errorText(session.error, noun)}</Notice>
        </div>
      </WidgetRoot>
    );
  }
  if (session.data?.mode === "personal") {
    return (
      <WidgetRoot {...chrome} data={{ "aitw-onboarding": "personal" }}>
        <div className="aitw-panel aitw-onboard">
          <Notice tone="info">{ONBOARDING.personalMode(noun)}</Notice>
        </div>
      </WidgetRoot>
    );
  }

  const invitations = purpose === "onboarding" ? (session.data?.invitations ?? []) : [];
  const heading = purpose === "additional" ? ONBOARDING.headingAdditional(noun) : ONBOARDING.heading(noun);
  const slugMessage = slugError?.message ?? (problem ? (problem.message ?? "") : null);
  const slugSuggestion = slugError ? slugError.suggestion : problem ? problem.suggestion || null : null;

  const former = purpose === "onboarding" ? (session.data?.formerCompany ?? null) : null;

  if (landed) {
    return (
      <WidgetRoot {...chrome} data={{ "aitw-onboarding": "landed" }}>
        <div className="aitw-panel aitw-onboard aitw-stack">
          {landed.lostAnswer ? (
            <Notice tone="ok">{ONBOARDING.wasCreated(landed.company.name)}</Notice>
          ) : (
            <Notice tone="warn">{ONBOARDING.alreadyMade(landed.company.name, noun)}</Notice>
          )}
          <div className="aitw-actions">
            <button type="button" className="aitw-btn aitw-btn-primary" onClick={() => done(landed.status, landed.company)}>
              {ONBOARDING.continueTo(landed.company.name)}
            </button>
          </div>
        </div>
      </WidgetRoot>
    );
  }

  return (
    <WidgetRoot {...chrome} data={{ "aitw-onboarding": purpose }}>
      <div className="aitw-panel aitw-onboard">
        {staffConsoleHref ? (
          <div className="aitw-stack" data-aitw-staff="">
            <Notice tone="info">{ONBOARDING.staffNote(noun)}</Notice>
            <div className="aitw-actions">
              <a className="aitw-btn aitw-btn-secondary" href={staffConsoleHref}>
                {ONBOARDING.staffConsole}
              </a>
            </div>
          </div>
        ) : null}
        {former ? (
          <div data-aitw-former="">
            <Notice tone="info">{ONBOARDING.formerCompany(former, noun)}</Notice>
          </div>
        ) : null}
        {invitations.length > 0 ? (
          <section className="aitw-stack" aria-labelledby={`${nameId}-inv`}>
            <h2 className="aitw-title" id={`${nameId}-inv`}>
              {ONBOARDING.invitationsHeading}
            </h2>
            <ul className="aitw-invites">
              {invitations.map((invitation) => {
                const state = joins[invitation.id];
                return (
                  <li key={invitation.id} className="aitw-invite-card" data-invitation={invitation.id}>
                    <p>{ONBOARDING.invitedYou(invitation.companyName, invitation.roleName)}</p>
                    {invitation.invitedBy ? <p className="aitw-hint">{ONBOARDING.invitedBy(invitation.invitedBy)}</p> : null}
                    <div className="aitw-actions">
                      <button
                        type="button"
                        className="aitw-btn aitw-btn-primary"
                        disabled={state?.busy}
                        aria-busy={state?.busy || undefined}
                        onClick={() => void join(invitation.id)}
                      >
                        {state?.busy ? ONBOARDING.joining : ONBOARDING.join(invitation.companyName)}
                      </button>
                    </div>
                    {state?.message ? <Notice tone="warn">{state.message}</Notice> : null}
                  </li>
                );
              })}
            </ul>
            <p className="aitw-or">{ONBOARDING.orCreate(noun)}</p>
          </section>
        ) : null}

        <form className="aitw-form" onSubmit={(event) => void submit(event)} noValidate>
          <h2 className="aitw-title">
            <label htmlFor={nameId}>{heading}</label>
          </h2>
          <div className="aitw-field">
            <input
              id={nameId}
              className="aitw-input"
              type="text"
              name="organization"
              autoComplete="organization"
              maxLength={80}
              // CONTRACT: autofocused unless invitations are listed above it,
              // so a screen reader starts at "you've been invited", not past it.
              autoFocus={invitations.length === 0}
              value={name}
              aria-invalid={nameError ? true : undefined}
              aria-describedby={describedBy(nameId, false, nameError)}
              onChange={(event) => {
                setName(event.target.value);
                if (nameError) setNameError(null);
              }}
            />
            {nameError ? (
              <span className="aitw-field-error" id={`${nameId}-error`}>
                {nameError}
              </span>
            ) : null}
          </div>

          {edited ? (
            <Field id={slugId} label={ONBOARDING.addressLabel} error={slugMessage}>
              <div className="aitw-slug-row">
                <span className="aitw-slug-prefix" aria-hidden="true" title={publicUrlPrefix}>
                  {publicUrlPrefix}
                </span>
                <input
                  id={slugId}
                  ref={slugRef}
                  className="aitw-input"
                  type="text"
                  inputMode="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={60}
                  value={slugInput}
                  aria-invalid={slugMessage ? true : undefined}
                  aria-describedby={[slugMessage ? `${slugId}-error` : null, statusId].filter(Boolean).join(" ")}
                  onChange={(event) => {
                    setSlugInput(event.target.value.toLowerCase());
                    setSlugError(null);
                  }}
                />
              </div>
              {/* The whole address as text, so a narrow prefix box that cuts
                  "https://igloo-back-of…" never hides where it points (T1-15). */}
              <span className="aitw-hint aitw-break" data-aitw-full-address="">
                {publicUrlPrefix}
                {slugInput.trim().toLowerCase()}
              </span>
            </Field>
          ) : (
            <div className="aitw-field">
              <span className="aitw-label">{ONBOARDING.addressLabel}</span>
              <div className="aitw-address">
                <span className="aitw-address-text" data-aitw-address="">
                  <span className="aitw-address-prefix">{publicUrlPrefix}</span>
                  <strong>{shownSlug}</strong>
                </span>
                <button type="button" className="aitw-btn aitw-btn-link" onClick={startEdit}>
                  {ONBOARDING.change}
                  <span className="aitw-sr"> {ONBOARDING.addressLabel.toLowerCase()}</span>
                </button>
              </div>
              {slugMessage ? <span className="aitw-field-error">{slugMessage}</span> : null}
            </div>
          )}
          {/* What the address is for, so "Available" beside a URL doesn't read
              like buying a domain (review T1-15). */}
          <p className="aitw-hint" data-aitw-address-hint="">
            {ONBOARDING.addressHint}
          </p>

          <div className="aitw-availability" id={statusId} role="status" aria-live="polite" data-aitw-availability="">
            {slugSuggestion ? (
              <button type="button" className="aitw-btn aitw-btn-secondary aitw-btn-sm" onClick={() => takeSuggestion(slugSuggestion)}>
                {ONBOARDING.use(slugSuggestion)}
              </button>
            ) : checking ? (
              <span className="aitw-muted">{W.checking}</span>
            ) : current && (current.available || !edited) ? (
              <span className="aitw-ok-text aitw-row">
                <CheckCircleIcon />
                {W.available}
              </span>
            ) : null}
          </div>

          <div className="aitw-actions">
            <button type="submit" className="aitw-btn aitw-btn-primary" disabled={sending} aria-busy={sending || undefined}>
              {sending ? ONBOARDING.creating(noun) : ONBOARDING.create(noun)}
            </button>
          </div>
          <p className="aitw-status aitw-danger-text" role="alert" data-aitw-alert="">
            {formError ?? ""}
          </p>
        </form>
      </div>
    </WidgetRoot>
  );
}
