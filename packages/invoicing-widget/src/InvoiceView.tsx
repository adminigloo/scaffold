import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createInvoicePublicClient, type InvoicePublicTransport } from "./client.js";
import type { ClientError, Result } from "./http.js";
import { dollarsInput, formatDate, formatMoney, METHOD_WORDS, parseDollars, percentText, STATUS_TONE } from "./money.js";
import { normalizeHex } from "./styles.js";
import type { MoneyFormatWire, PayOptionWire, PublicInvoiceResponse } from "./types.js";
import { Loading, Root, type ChromeProps } from "./ui.js";

/**
 * The customer's own invoice page (Tenancy 2a, 10.9): opened by its link, no
 * account. Mount it on the company's public page:
 *
 *   <InvoiceView baseUrl={`/api/t/${slug}/invoices`} token={token} preview={searchParams.preview === "1"} accentColor={company.brandColor} />
 *
 * It reports the open ONCE, from the browser, with a POST after the invoice
 * loaded (a ref latch): a mail scanner's or link preview's GET never counts as
 * the customer reading it. `preview` (the business's own "Preview" link)
 * never reports at all, so staff checking a link don't mark it viewed.
 *
 * Prints as a plain invoice: the print sheet keeps everything but the accent
 * chrome. Never throws.
 */

export interface InvoiceViewProps extends ChromeProps {
  baseUrl?: string;
  transport?: InvoicePublicTransport;
  token: string;
  /** The business's preview (?preview=1): never reports a view. */
  preview?: boolean;
  /** The business's colour for the accent (as estimator-widget's accentColor): a `#rrggbb`, null for none; default the business's own. */
  accentColor?: string | null;
  /** 0.2: the customer just came back from paying (?paid=1): say thank you while the payment is recorded. */
  returned?: boolean;
  /** 0.2: where "Pay now" sends the browser. Default: `window.location.assign`. */
  navigate?: (url: string) => void;
}

export const NOT_AVAILABLE = "This invoice isn't available. It may have been replaced; contact the business.";

const MISSING: Result<never> = {
  ok: false,
  error: { code: "bad_response", message: "This page isn't connected to an invoice server yet.", status: 0 },
};

type State = { state: "loading" } | { state: "ready"; data: PublicInvoiceResponse } | { state: "error"; error: ClientError };

/** "Paid", "Overdue since Nov 2, 2026", "Due Nov 2, 2026". */
export function statusLine(invoice: PublicInvoiceResponse["invoice"], format: MoneyFormatWire, locale?: string): string {
  const due = formatDate(invoice.dueDate, format, locale);
  switch (invoice.status) {
    case "paid":
      return "Paid";
    case "void":
      return "Void";
    case "overdue":
      return due ? `Overdue since ${due}` : "Overdue";
    case "partial":
      return due ? `Partly paid · Due ${due}` : "Partly paid";
    default:
      return due ? `Due ${due}` : "Due now";
  }
}

export function InvoiceView(props: InvoiceViewProps) {
  const { baseUrl, transport: given, token, preview = false, accentColor, locale, returned = false, navigate, ...chrome } = props;
  const transport = useMemo<InvoicePublicTransport>(
    () =>
      given ??
      (baseUrl ? createInvoicePublicClient({ baseUrl }) : { invoice: () => Promise.resolve(MISSING), viewed: () => Promise.resolve(MISSING) }),
    [given, baseUrl],
  );
  const [state, setState] = useState<State>({ state: "loading" });
  const reported = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setState({ state: "loading" });
    let res: Result<PublicInvoiceResponse>;
    try {
      res = await transport.invoice(token);
    } catch {
      res = { ok: false, error: { code: "bad_response", message: "Something went wrong. Please try again.", status: 0 } };
    }
    if (!alive.current) return;
    setState(res.ok ? { state: "ready", data: res.data } : { state: "error", error: res.error });
    if (res.ok && !preview && !reported.current) {
      reported.current = true;
      // Fire and forget: the page is the same whether the count lands or not.
      void Promise.resolve()
        .then(() => transport.viewed(token))
        .catch(() => undefined);
    }
  }, [transport, token, preview]);

  useEffect(() => {
    void load();
  }, [load]);

  const business = state.state === "ready" ? state.data.business : null;
  const accent = accentColor === null ? null : normalizeHex(accentColor ?? business?.brandColor ?? null);

  return (
    <Root {...chrome} accent={accent}>
      {state.state === "loading" ? (
        <div className="aiiw-card">
          <Loading text="Loading your invoice…" />
        </div>
      ) : state.state === "error" ? (
        <div className="aiiw-card" data-aiiw-error={state.error.code}>
          <p className="aiiw-h2">
            {state.error.code === "not_found"
              ? NOT_AVAILABLE
              : state.error.code === "unavailable"
                ? state.error.message
                : state.error.message || "Something went wrong. Please try again."}
          </p>
          {state.error.code !== "not_found" && state.error.code !== "unavailable" ? (
            <div className="aiiw-actions aiiw-no-print">
              <button type="button" className="aiiw-btn aiiw-btn-secondary" onClick={() => void load()}>
                Try again
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <InvoiceBody
          data={state.data}
          locale={locale}
          returned={returned}
          pay={
            transport.pay && !preview
              ? async (amount) => {
                  try {
                    return await transport.pay!(token, amount === undefined ? {} : { amount });
                  } catch {
                    return { ok: false, error: { code: "network", message: "Something went wrong. Please try again.", status: 0 } };
                  }
                }
              : null
          }
          navigate={navigate ?? ((url) => window.location.assign(url))}
        />
      )}
    </Root>
  );
}

type PayFn = (amount: number | undefined) => Promise<Result<{ url: string }>>;

/**
 * "Pay now" (0.2): the amount is the SERVER's — the deposit first, then the
 * balance. Only when the business lets customers choose is there a box, and
 * the server checks what it says again.
 */
function PayNow({ option, money, pay, navigate }: { option: PayOptionWire; money: (cents: number) => string; pay: PayFn; navigate: (url: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState(dollarsInput(option.amount));
  const submit = async () => {
    setError(null);
    let amount: number | undefined;
    if (option.allowPartial) {
      const parsed = parseDollars(text, { allowZero: false });
      if (!parsed.ok) return setError(parsed.message);
      if (parsed.value < option.minimum || parsed.value > option.maximum) {
        return setError(`Enter an amount from ${money(option.minimum)} to ${money(option.maximum)}.`);
      }
      amount = parsed.value;
    }
    setBusy(true);
    const res = await pay(amount);
    if (res.ok) {
      navigate(res.data.url);
      return;
    }
    setBusy(false);
    setError(res.error.message || "Something went wrong. Please try again.");
  };
  const deposit = option.stage === "deposit";
  return (
    <section className="aiiw-stack-sm aiiw-no-print" aria-labelledby="aiiw-paynow" data-aiiw-paynow={option.stage}>
      <h2 className="aiiw-h3" id="aiiw-paynow">
        {deposit ? "Pay the deposit" : "Pay by card"}
      </h2>
      {deposit ? (
        <p className="aiiw-small">
          A deposit of {money(option.depositAmount)} is due first. You'll pay the rest later, from this page.
        </p>
      ) : null}
      {option.allowPartial ? (
        <label className="aiiw-field">
          <span>Amount to pay</span>
          <input className="aiiw-input" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} aria-invalid={error ? true : undefined} />
        </label>
      ) : null}
      {error ? (
        <p className="aiiw-notice aiiw-notice-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="aiiw-actions">
        <button type="button" className="aiiw-btn aiiw-btn-primary" disabled={busy} onClick={() => void submit()} data-aiiw-paynow-button="">
          {busy ? "Opening the secure payment page…" : option.allowPartial ? "Pay now" : `Pay ${money(option.amount)} now`}
        </button>
      </div>
      <p className="aiiw-small">You'll pay on Stripe's secure page, then come back here.</p>
    </section>
  );
}

function InvoiceBody({
  data,
  locale,
  returned,
  pay,
  navigate,
}: {
  data: PublicInvoiceResponse;
  locale: string | undefined;
  returned: boolean;
  pay: PayFn | null;
  navigate: (url: string) => void;
}) {
  const { invoice, business, format } = data;
  const money = (cents: number) => formatMoney(cents, format, locale);
  const status = statusLine(invoice, format, locale);
  const issued = formatDate(invoice.issuedAt, format, locale);
  return (
    <article className="aiiw-card" data-aiiw-invoice="">
      <header className="aiiw-business" data-aiiw-business="">
        {business.logoUrl ? <img className="aiiw-logo" src={business.logoUrl} alt="" /> : null}
        <div className="aiiw-grow">
          <div className="aiiw-business-name">{business.name}</div>
          {business.contactEmail || business.contactPhone ? (
            <div className="aiiw-small">
              {business.contactEmail ? <a href={`mailto:${business.contactEmail}`}>{business.contactEmail}</a> : null}
              {business.contactEmail && business.contactPhone ? " · " : null}
              {business.contactPhone ? <a href={`tel:${business.contactPhone.replace(/[^\d+]/g, "")}`}>{business.contactPhone}</a> : null}
            </div>
          ) : null}
        </div>
      </header>

      <div className="aiiw-spread">
        <div className="aiiw-stack-sm">
          <h1 className="aiiw-title">Invoice {invoice.number}</h1>
          {invoice.customerName ? <p className="aiiw-muted">For {invoice.customerName}</p> : null}
          {issued ? <p className="aiiw-small">Issued {issued}</p> : null}
        </div>
        <span className={`aiiw-tag aiiw-tag-${STATUS_TONE[invoice.status]}`} data-aiiw-status="">
          {status}
        </span>
      </div>

      <table className="aiiw-table aiiw-wide">
        <thead>
          <tr>
            <th scope="col">What</th>
            <th scope="col" className="aiiw-right">
              Qty
            </th>
            <th scope="col" className="aiiw-right">
              Price
            </th>
            <th scope="col" className="aiiw-right">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((line, index) => (
            <tr key={index}>
              <td>{line.description}</td>
              <td className="aiiw-right aiiw-num">{line.quantity}</td>
              <td className="aiiw-right aiiw-num">{money(line.unitPrice)}</td>
              <td className="aiiw-right aiiw-num">{money(line.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="aiiw-cards">
        {invoice.lines.map((line, index) => (
          <li key={index} className="aiiw-item-card">
            <strong>{line.description}</strong>
            <span className="aiiw-small">
              {line.quantity} × {money(line.unitPrice)} = <span className="aiiw-num">{money(line.total)}</span>
            </span>
          </li>
        ))}
      </ul>

      <dl className="aiiw-totals" data-aiiw-totals="">
        <dt>Subtotal</dt>
        <dd>{money(invoice.subtotal)}</dd>
        {invoice.discount > 0 ? (
          <>
            <dt>Discount</dt>
            <dd>−{money(invoice.discount)}</dd>
          </>
        ) : null}
        {invoice.taxRateBp > 0 || invoice.taxAmount > 0 ? (
          <>
            <dt>Tax ({percentText(invoice.taxRateBp)})</dt>
            <dd>{money(invoice.taxAmount)}</dd>
          </>
        ) : null}
        <dt className="aiiw-strong">Total</dt>
        <dd className="aiiw-strong">{money(invoice.total)}</dd>
        {invoice.amountPaid !== 0 ? (
          <>
            <dt>Paid</dt>
            <dd>{money(invoice.amountPaid)}</dd>
          </>
        ) : null}
        <dt className="aiiw-strong">Balance due</dt>
        <dd className="aiiw-strong">{money(invoice.balanceDue)}</dd>
      </dl>

      {invoice.payments.length > 0 ? (
        <section className="aiiw-stack-sm" aria-labelledby="aiiw-payments">
          <h2 className="aiiw-h3" id="aiiw-payments">
            Payments
          </h2>
          <ul className="aiiw-stack-sm" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {invoice.payments.map((payment, index) => (
              <li key={index} className="aiiw-small">
                {formatDate(payment.paidAt, format, locale)} · {METHOD_WORDS[payment.method]} ·{" "}
                <span className="aiiw-num">{money(payment.amount)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {returned ? (
        <p className="aiiw-notice aiiw-notice-ok" role="status" data-aiiw-returned="">
          Thank you! Your payment is on its way to {business.name || "the business"}. It shows here once it's recorded, usually within a minute.
        </p>
      ) : null}

      {invoice.pending ? (
        <p className="aiiw-notice aiiw-notice-info" role="status" data-aiiw-pending="">
          A bank payment of {money(invoice.pending.amount)} is on its way
          {formatDate(invoice.pending.startedAt, format, locale) ? ` (started ${formatDate(invoice.pending.startedAt, format, locale)})` : ""}.
        </p>
      ) : null}

      {invoice.pay && pay ? (
        invoice.pay.belowMinimum ? (
          <p className="aiiw-notice aiiw-notice-info" data-aiiw-small="">
            Please contact {business.name || "the business"} to pay this small amount.
          </p>
        ) : (
          <PayNow option={invoice.pay} money={money} pay={pay} navigate={navigate} />
        )
      ) : null}

      {business.paymentInstructions || business.footer ? (
        <section className="aiiw-stack-sm" aria-labelledby="aiiw-pay" data-aiiw-pay="">
          <h2 className="aiiw-h3" id="aiiw-pay">
            {invoice.pay && pay && !invoice.pay.belowMinimum ? "Other ways to pay" : "How to pay"}
          </h2>
          {business.paymentInstructions ? <p className="aiiw-pre">{business.paymentInstructions}</p> : null}
          {business.footer ? <p className="aiiw-small aiiw-pre">{business.footer}</p> : null}
        </section>
      ) : null}
    </article>
  );
}
