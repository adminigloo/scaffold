import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type Ref } from "react";
import type { EstimatorPublicTransport } from "./client.js";
import { formatDate, formatMoney, formatPercent, friendlyError, withParam } from "./format.js";
import type { ClientError } from "./http.js";
import {
  CheckIcon,
  ContactLinks,
  Field,
  Honeypot,
  Notice,
  PrintIcon,
  resolveAccent,
  Skeleton,
  telHref,
  useMounted,
  useStepFocus,
  WidgetRoot,
  type ChromeProps,
} from "./parts.js";
import { usePublicTransport } from "./transport.js";
import type { PublicQuote } from "./types.js";

/**
 * <QuoteView> — the page behind the link in the customer's quote email,
 * `/quote/[token]` (contract 9.6). The business's name, the lines, the total
 * with tax, how long it's good for, and Accept / Decline — confirmed on the
 * page itself before anything is sent.
 *
 * The token in the URL is the customer's key to this one quote. The page the
 * host mounts this on is noindex and no-referrer (the server's headers say
 * so too); links out of here carry no referrer.
 *
 * A quote can change under the customer: staff revise it ("updating"), it
 * expires, or another tab already answered. Every refusal of that kind
 * reloads the quote and shows how it stands now, with the server's words
 * ("This quote expired on Nov 14, 2026. Call us at …").
 */

export interface QuoteViewProps extends ChromeProps {
  /** The token from the URL. */
  token: string;
  baseUrl?: string;
  clientKey?: string;
  transport?: EstimatorPublicTransport;
  /** Accepted: "Pick a time for the work" → bookHref + (? or &) + "estimate=" + estimateId. */
  bookHref?: string;
  /** Undefined: the business's colour; null: the stylesheet's; a `#rrggbb`: that. */
  accentColor?: string | null;
  /** Called after the customer accepts or declines. */
  onRespond?: (quote: PublicQuote) => void;
}

type ViewState =
  | { status: "loading" }
  | { status: "not_found" }
  | { status: "error"; error: ClientError }
  | { status: "ready"; quote: PublicQuote };

/**
 * CONTRACT: 9.6 says Accept "opens a confirmation". It is confirmed IN the page
 * (the buttons give way to a short form, focus moves to its heading), not in a
 * modal: it prints, it works without a dialog on any host, and on a phone the
 * customer never loses sight of the quote they are answering.
 */
type Answering = null | "accept" | "decline";

/**
 * Refusals that mean "the quote isn't what you're looking at": read it again
 * and show it as it stands. `quote_changed` is the version check (review
 * ADV-2): staff revised and re-sent the quote while this page was open, so an
 * accept here would bind the customer to a price they never saw. Nothing was
 * answered; the new version is shown and can be accepted on its own.
 */
const RESPONSE_REFUSALS = new Set(["quote_expired", "already_answered", "not_changeable", "quote_changed"]);

export function QuoteView(props: QuoteViewProps) {
  const transport = usePublicTransport(props.transport, props.baseUrl, props.clientKey);
  const mounted = useMounted();
  const [state, setState] = useState<ViewState>({ status: "loading" });
  const [reload, setReload] = useState(0);
  const [answering, setAnswering] = useState<Answering>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const statusRef = useStepFocus<HTMLDivElement>(focusTick);

  const load = useCallback(async () => {
    const res = await transport.quote(props.token);
    if (!mounted.current) return;
    if (res.ok) setState({ status: "ready", quote: res.data.quote });
    else if (res.error.code === "not_found") setState({ status: "not_found" });
    else setState({ status: "error", error: res.error });
  }, [transport, props.token, mounted]);

  useEffect(() => {
    setState({ status: "loading" });
    void load();
  }, [load, reload]);

  const quote = state.status === "ready" ? state.quote : null;
  const locale = props.locale ?? quote?.locale ?? "en-US";
  const accent = resolveAccent(props.accentColor, quote?.brandColor);

  const answered = (next: PublicQuote, text: string) => {
    setState({ status: "ready", quote: next });
    setAnswering(null);
    setNotice({ tone: "ok", text });
    setFocusTick((n) => n + 1);
    props.onRespond?.(next);
  };

  /** A refusal that means "the quote changed": show it as it is now, in the server's words. */
  const refused = async (error: ClientError) => {
    setAnswering(null);
    if (RESPONSE_REFUSALS.has(error.code) || error.code === "not_found") {
      setNotice({ tone: "warn", text: friendlyError(error, "respond") });
      await load();
    } else {
      setNotice({ tone: "error", text: friendlyError(error, "respond") });
    }
    setFocusTick((n) => n + 1);
  };

  // The version on screen: an answer names it, so it only ever binds the
  // customer to the quote they were looking at.
  const version = quote?.version ?? 0;

  const accept = async (body: { name: string; note: string; website: string }) => {
    const res = await transport.acceptQuote(props.token, {
      version,
      ...(body.name.trim() ? { name: body.name.trim() } : {}),
      ...(body.note.trim() ? { note: body.note.trim() } : {}),
      ...(body.website ? { website: body.website } : {}),
    });
    if (!mounted.current) return;
    if (res.ok) answered(res.data.quote, `Thank you. Your answer is saved, and ${res.data.quote.businessName || "the business"} can see it.`);
    else await refused(res.error);
  };

  const decline = async (body: { note: string; website: string }) => {
    const res = await transport.declineQuote(props.token, {
      version,
      ...(body.note.trim() ? { note: body.note.trim() } : {}),
      ...(body.website ? { website: body.website } : {}),
    });
    if (!mounted.current) return;
    if (res.ok) answered(res.data.quote, `Thanks for letting us know. Your answer is saved, and ${res.data.quote.businessName || "the business"} can see it.`);
    else await refused(res.error);
  };

  let body;
  if (state.status === "loading") body = <Skeleton label="Loading your quote…" />;
  else if (state.status === "not_found") {
    body = (
      <section className="aiew-empty" data-aiew-state="not-found">
        <p className="aiew-empty-title">This quote link doesn&apos;t work.</p>
        <p>It may have been replaced by a newer one; check your latest email from the business.</p>
      </section>
    );
  } else if (state.status === "error") {
    body = (
      <Notice tone="error" data="quote-error">
        {friendlyError(state.error, "quote")}{" "}
        <button type="button" className="aiew-btn aiew-btn-link" onClick={() => setReload((n) => n + 1)}>
          Retry
        </button>
      </Notice>
    );
  } else {
    body = (
      <QuoteBody
        quote={state.quote}
        locale={locale}
        bookHref={props.bookHref}
        answering={answering}
        setAnswering={(next) => {
          setNotice(null);
          setAnswering(next);
        }}
        onAccept={accept}
        onDecline={decline}
        notice={notice}
        statusRef={statusRef}
      />
    );
  }

  return (
    <WidgetRoot
      theme={props.theme}
      nonce={props.nonce}
      className={`aiew-card${props.className ? ` ${props.className}` : ""}`}
      style={props.style}
      accent={accent}
      data={{ "aiew-quote": state.status === "ready" ? state.quote.status : state.status }}
    >
      <div className="aiew-body">{body}</div>
    </WidgetRoot>
  );
}

function QuoteBody({
  quote,
  locale,
  bookHref,
  answering,
  setAnswering,
  onAccept,
  onDecline,
  notice,
  statusRef,
}: {
  quote: PublicQuote;
  locale: string;
  bookHref?: string;
  answering: Answering;
  setAnswering: (next: Answering) => void;
  onAccept: (body: { name: string; note: string; website: string }) => Promise<void>;
  onDecline: (body: { note: string; website: string }) => Promise<void>;
  notice: { tone: "ok" | "warn" | "error"; text: string } | null;
  statusRef: Ref<HTMLDivElement>;
}) {
  const ids = useId();
  const money = (cents: number) => formatMoney(cents, quote.currency, locale);
  const date = (instant: string | null) => formatDate(instant, locale, quote.timeZone);
  const business = quote.businessName || "The business";
  const total = money(quote.total);

  return (
    <article className="aiew-quote" aria-labelledby={`${ids}-business`}>
      <div className="aiew-quote-brand" aria-hidden="true" />
      <header className="aiew-quote-head">
        <h2 className="aiew-quote-business" id={`${ids}-business`}>
          {business}
        </h2>
        <div className="aiew-quote-meta">
          <p>
            <strong>Quote {quote.number}</strong>
          </p>
          {quote.customerName ? <p>For {quote.customerName}</p> : null}
          {quote.jobAddress ? <p>{quote.jobAddress}</p> : null}
          {quote.sentAt ? <p>Sent {date(quote.sentAt)}</p> : null}
        </div>
      </header>

      <div ref={statusRef} tabIndex={-1} className="aiew-stack-sm" aria-live="polite">
        {notice ? (
          <Notice tone={notice.tone === "ok" ? "ok" : notice.tone} data="respond">
            {notice.text}
          </Notice>
        ) : null}
        <StatusBanner quote={quote} locale={locale} bookHref={bookHref} />
      </div>

      {quote.message ? <p className="aiew-message">{quote.message}</p> : null}

      <table className="aiew-lines" data-aiew-lines="">
        <caption className="aiew-sr">What&apos;s included</caption>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col" className="aiew-num">
              Qty
            </th>
            <th scope="col" className="aiew-num">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {quote.lines.map((line, i) => (
            <tr key={`${i}:${line.description}`}>
              <td>
                <span>{line.description}</span>
                {line.details.length > 0 ? (
                  <ul className="aiew-line-details">
                    {line.details.map((detail, d) => (
                      <li key={`${d}:${detail}`}>{detail}</li>
                    ))}
                  </ul>
                ) : null}
              </td>
              <td className="aiew-num">{line.quantity}</td>
              <td className="aiew-num">{money(line.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="aiew-totals" data-aiew-totals="">
        <div>
          <span>Subtotal</span>
          <span>{money(quote.subtotal)}</span>
        </div>
        {quote.discount > 0 ? (
          <div>
            <span>Discount</span>
            <span>−{money(quote.discount)}</span>
          </div>
        ) : null}
        <div>
          <span>Sales tax ({formatPercent(quote.taxRateBp)})</span>
          <span>{money(quote.taxAmount)}</span>
        </div>
        <div className="aiew-total">
          <span>Total</span>
          <span>{total}</span>
        </div>
      </div>

      {quote.canRespond && quote.status === "open" ? (
        answering === "accept" ? (
          <AcceptForm total={total} defaultName={quote.customerName ?? ""} onCancel={() => setAnswering(null)} onConfirm={onAccept} />
        ) : answering === "decline" ? (
          <DeclineForm onCancel={() => setAnswering(null)} onConfirm={onDecline} />
        ) : (
          <div className="aiew-actions aiew-no-print" data-aiew-respond="">
            <button type="button" className="aiew-btn aiew-btn-primary" onClick={() => setAnswering("accept")}>
              Accept this quote
            </button>
            <button type="button" className="aiew-btn aiew-btn-secondary" onClick={() => setAnswering("decline")}>
              Decline
            </button>
          </div>
        )
      ) : null}

      {quote.footer ? <p className="aiew-footer">{quote.footer}</p> : null}

      <div className="aiew-row aiew-no-print">
        <button type="button" className="aiew-btn aiew-btn-secondary aiew-btn-sm" onClick={() => typeof window !== "undefined" && window.print()}>
          <PrintIcon />
          Print or save as PDF
        </button>
        {quote.contactPhone || quote.contactEmail ? (
          <span className="aiew-desc">
            Questions? <ContactLinks phone={quote.contactPhone} email={quote.contactEmail} />
          </span>
        ) : null}
      </div>
    </article>
  );
}

/** How the quote stands, in one plain sentence (contract 9.6). */
export function StatusBanner({ quote, locale, bookHref }: { quote: PublicQuote; locale: string; bookHref?: string }) {
  const date = (instant: string | null) => formatDate(instant, locale, quote.timeZone);
  const phone = quote.contactPhone;
  const email = quote.contactEmail;
  switch (quote.status) {
    case "open":
      return (
        <div className="aiew-banner" data-aiew-banner="open">
          {quote.validUntil ? `Good until ${date(quote.validUntil)}.` : "This quote is open."}
        </div>
      );
    case "accepted":
      return (
        <div className="aiew-banner aiew-banner-ok" data-aiew-banner="accepted">
          <p className="aiew-row">
            <CheckIcon className="aiew-chip-check" />
            You accepted this quote{quote.respondedAt ? ` on ${date(quote.respondedAt)}` : ""}. Thank you!
          </p>
          {bookHref && quote.estimateId ? (
            <p className="aiew-no-print">
              <a className="aiew-btn aiew-btn-primary" href={withParam(bookHref, "estimate", quote.estimateId)} referrerPolicy="no-referrer" data-aiew-book="">
                Pick a time for the work
              </a>
            </p>
          ) : null}
        </div>
      );
    case "declined":
      return (
        <div className="aiew-banner" data-aiew-banner="declined">
          You declined this quote{quote.respondedAt ? ` on ${date(quote.respondedAt)}` : ""}.{" "}
          {phone ? (
            <>
              Changed your mind? Call <a href={telHref(phone)}>{phone}</a>.
            </>
          ) : email ? (
            <>
              Changed your mind? Email <a href={`mailto:${email}`}>{email}</a>.
            </>
          ) : (
            "Changed your mind? Get in touch with us."
          )}
        </div>
      );
    case "expired":
      return (
        <div className="aiew-banner aiew-banner-warn" data-aiew-banner="expired">
          This quote expired{quote.validUntil ? ` on ${date(quote.validUntil)}` : ""}.{" "}
          {phone ? (
            <>
              Call <a href={telHref(phone)}>{phone}</a>
            </>
          ) : null}
          {phone && email ? " or email " : email ? "Email " : null}
          {email ? <a href={`mailto:${email}`}>{email}</a> : null}
          {phone || email ? " for an updated one." : "Get in touch for an updated one."}
        </div>
      );
    case "updating":
      return (
        <div className="aiew-banner aiew-banner-warn" data-aiew-banner="updating">
          We&apos;re updating this quote. You&apos;ll get the new version by email.
        </div>
      );
  }
}

function AcceptForm({
  total,
  defaultName,
  onCancel,
  onConfirm,
}: {
  total: string;
  defaultName: string;
  onCancel: () => void;
  onConfirm: (body: { name: string; note: string; website: string }) => Promise<void>;
}) {
  const ids = useId();
  const [name, setName] = useState(defaultName);
  const [note, setNote] = useState("");
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState(false);
  // Opened by the customer's own click, so focus follows them into it.
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    await onConfirm({ name, note, website });
    setBusy(false);
  };
  return (
    <form className="aiew-confirm aiew-no-print" onSubmit={(event) => void submit(event)} noValidate data-aiew-confirm="accept">
      <h3 className="aiew-h3" ref={headingRef} tabIndex={-1}>
        Accept this quote for {total}?
      </h3>
      <Field id={`${ids}-name`} label="Your name" optional hint="So the business knows who said yes.">
        <input id={`${ids}-name`} className="aiew-input" type="text" autoComplete="name" maxLength={120} value={name} aria-describedby={`${ids}-name-hint`} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field id={`${ids}-note`} label="A note for the business" optional hint="Best days for the work, gate codes, anything that helps.">
        <textarea id={`${ids}-note`} className="aiew-input" rows={3} maxLength={1000} value={note} aria-describedby={`${ids}-note-hint`} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <Honeypot id={`${ids}-website`} value={website} onChange={setWebsite} />
      <div className="aiew-actions">
        <button type="submit" className="aiew-btn aiew-btn-primary" disabled={busy} aria-busy={busy || undefined}>
          {busy ? "Sending…" : "Yes, accept the quote"}
        </button>
        <button type="button" className="aiew-btn aiew-btn-secondary" onClick={onCancel} disabled={busy}>
          Not yet
        </button>
      </div>
    </form>
  );
}

function DeclineForm({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: (body: { note: string; website: string }) => Promise<void> }) {
  const ids = useId();
  const [note, setNote] = useState("");
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState(false);
  // Opened by the customer's own click, so focus follows them into it.
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    await onConfirm({ note, website });
    setBusy(false);
  };
  return (
    <form className="aiew-confirm aiew-no-print" onSubmit={(event) => void submit(event)} noValidate data-aiew-confirm="decline">
      <h3 className="aiew-h3" ref={headingRef} tabIndex={-1}>
        Decline this quote?
      </h3>
      <Field id={`${ids}-note`} label="Tell the business why" optional hint="It helps them, and you can still change your mind by calling.">
        <textarea id={`${ids}-note`} className="aiew-input" rows={3} maxLength={1000} value={note} aria-describedby={`${ids}-note-hint`} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <Honeypot id={`${ids}-website`} value={website} onChange={setWebsite} />
      <div className="aiew-actions">
        <button type="submit" className="aiew-btn aiew-btn-danger" disabled={busy} aria-busy={busy || undefined}>
          {busy ? "Sending…" : "Yes, decline"}
        </button>
        <button type="button" className="aiew-btn aiew-btn-secondary" onClick={onCancel} disabled={busy}>
          Go back
        </button>
      </div>
    </form>
  );
}
