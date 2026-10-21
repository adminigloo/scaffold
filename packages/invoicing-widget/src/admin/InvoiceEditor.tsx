import { useCallback, useEffect, useId, useState, type FormEvent, type ReactElement } from "react";
import type { ClientError, Result } from "../http.js";
import { dollarsInput, formatDate, formatMoney, METHOD_WORDS, MOVE_WORDS, parseDollars, paymentWords, parsePercent, parseQuantity, percentText, STATUS_TONE, STATUS_WORDS } from "../money.js";
import type {
  DepositBody,
  InvoiceDetailWire,
  InvoiceLineWire,
  InvoiceLinkWire,
  InvoicePaymentWire,
  InvoiceResponse,
  MoneyFormatWire,
  PaymentMethodWire,
  SettableInvoiceStatusWire,
} from "../types.js";
import { Dialog, Field, fieldAria, Loading, Root, type ChromeProps } from "../ui.js";
import type { InvoicingTransport } from "./client.js";
import { errorSentence, issueAt, safely, useAlive, useInvoicingTransport } from "./shared.js";

/**
 * One invoice, worked on (Tenancy 2a, 10.9): its lines while they can still
 * change, Send (or "Mark as sent"), the customer's link to copy and preview,
 * the moves its status allows, and payments, recorded and reversed.
 *
 *   <InvoiceEditor baseUrl={`/api/app/${company.id}/invoices`} invoiceId={id} backHref="/app/invoices" />
 *
 * Every write disables only its own control, is announced in ONE
 * `role="status"` region, shows the server's own sentence when refused, and
 * re-renders from the server's answer: the totals on screen are always the
 * server's. Never throws.
 */

export interface InvoiceEditorProps extends ChromeProps {
  baseUrl?: string;
  transport?: InvoicingTransport;
  invoiceId: string;
  /** "Back to invoices". Default: no back link. */
  backHref?: string;
}

type State = { state: "loading" } | { state: "ready"; invoice: InvoiceDetailWire; format: MoneyFormatWire } | { state: "error"; error: ClientError };

const METHODS: readonly PaymentMethodWire[] = ["cash", "check", "card", "ach", "other"];

export function InvoiceEditor(props: InvoiceEditorProps) {
  const { baseUrl, transport: given, invoiceId, backHref, locale, ...chrome } = props;
  const transport = useInvoicingTransport(given, baseUrl);
  const alive = useAlive();
  const [state, setState] = useState<State>({ state: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [refusal, setRefusal] = useState<{ where: string; text: string } | null>(null);
  const [link, setLink] = useState<(InvoiceLinkWire & { copied: boolean }) | null>(null);
  const [confirmVoid, setConfirmVoid] = useState(false);
  const [reversing, setReversing] = useState<InvoicePaymentWire | null>(null);

  const load = useCallback(async () => {
    setState({ state: "loading" });
    const res = await safely(() => transport.get(invoiceId));
    if (!alive.current) return;
    setState(res.ok ? { state: "ready", invoice: res.data.invoice, format: res.data.format } : { state: "error", error: res.error });
  }, [transport, invoiceId, alive]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Run one write: only `key`'s control waits; the answer re-renders the invoice. */
  const write = async <T extends InvoiceResponse>(key: string, call: () => Promise<Result<T>>, done: (data: T) => string): Promise<Result<T>> => {
    setBusy(key);
    setRefusal(null);
    const res = await safely(call);
    if (!alive.current) return res;
    setBusy(null);
    if (res.ok) {
      setState({ state: "ready", invoice: res.data.invoice, format: res.data.format });
      setAnnounce(done(res.data));
    } else {
      setRefusal({ where: key, text: errorSentence(res.error) });
      setAnnounce(errorSentence(res.error));
    }
    return res;
  };

  if (state.state === "loading") {
    return (
      <Root {...chrome} admin>
        <div className="aiiw-admin-inner">
          <Loading text="Loading the invoice…" />
        </div>
      </Root>
    );
  }
  if (state.state === "error") {
    return (
      <Root {...chrome} admin>
        <div className="aiiw-admin-inner">
          {backHref ? <a href={backHref}>Back to invoices</a> : null}
          <div className="aiiw-notice aiiw-notice-error aiiw-row">
            <span className="aiiw-grow">{state.error.code === "not_found" ? "That invoice isn't here." : errorSentence(state.error)}</span>
            {state.error.code !== "not_found" ? (
              <button type="button" className="aiiw-btn aiiw-btn-secondary" onClick={() => void load()}>
                Try again
              </button>
            ) : null}
          </div>
        </div>
      </Root>
    );
  }

  const { invoice, format } = state;
  const money = (cents: number) => formatMoney(cents, format, locale);
  const canSend = invoice.can.manage && invoice.storedStatus !== "paid" && invoice.storedStatus !== "void";
  const canPay = invoice.can.record && (invoice.storedStatus === "sent" || invoice.storedStatus === "viewed" || invoice.storedStatus === "partial");
  const refused = (where: string) =>
    refusal && refusal.where === where ? (
      <div className="aiiw-notice aiiw-notice-error" role="alert" data-aiiw-refusal={where}>
        {refusal.text}
      </div>
    ) : null;

  const send = () =>
    write("send", () => transport.send(invoice.id), (data) => {
      setLink(null);
      return data.message;
    });

  const copyLink = async () => {
    setBusy("link");
    setRefusal(null);
    const res = await safely(() => transport.link(invoice.id));
    if (!alive.current) return;
    setBusy(null);
    if (!res.ok) {
      setRefusal({ where: "link", text: errorSentence(res.error) });
      return;
    }
    let copied = false;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(res.data.url);
        copied = true;
      }
    } catch {
      copied = false;
    }
    setLink({ ...res.data, copied });
    setAnnounce(copied ? "Link copied." : "Here's the link to copy.");
  };

  const move = (status: SettableInvoiceStatusWire) =>
    write(`move-${status}`, () => transport.setStatus(invoice.id, { status }), (data) => `Invoice ${data.invoice.number} is ${STATUS_WORDS[data.invoice.status].toLowerCase()}.`);

  return (
    <Root {...chrome} admin data={{ "aiiw-editor": invoice.id }}>
      <div className="aiiw-admin-inner">
        <div className="aiiw-sr" role="status" aria-live="polite" data-aiiw-announce="">
          {announce}
        </div>
        {backHref ? (
          <a href={backHref} className="aiiw-small">
            Back to invoices
          </a>
        ) : null}
        <div className="aiiw-spread">
          <div className="aiiw-stack-sm">
            <h2 className="aiiw-title">Invoice {invoice.number}</h2>
            <p className="aiiw-small">
              {invoice.customerName ?? "No customer name"}
              {invoice.customerEmail ? ` · ${invoice.customerEmail}` : ""}
              {invoice.dueDate ? ` · due ${formatDate(invoice.dueDate, format, locale)}` : ""}
            </p>
          </div>
          <span className={`aiiw-tag aiiw-tag-${STATUS_TONE[invoice.status]}`} data-aiiw-status="">
            {STATUS_WORDS[invoice.status]}
          </span>
        </div>

        {canSend || invoice.can.manage ? (
          <section className="aiiw-card" aria-label="Send and share">
            <div className="aiiw-actions">
              {canSend ? (
                <button type="button" className="aiiw-btn aiiw-btn-primary" disabled={busy === "send"} onClick={() => void send()}>
                  {busy === "send" ? "Sending…" : invoice.customerEmail ? `Send to ${invoice.customerEmail}` : "Mark as sent"}
                </button>
              ) : null}
              {invoice.can.manage ? (
                <button type="button" className="aiiw-btn aiiw-btn-secondary" disabled={busy === "link"} onClick={() => void copyLink()}>
                  Copy link
                </button>
              ) : null}
              {link ? (
                <a className="aiiw-btn aiiw-btn-secondary" href={link.previewUrl} target="_blank" rel="noopener noreferrer">
                  Preview
                </a>
              ) : null}
            </div>
            {refused("send")}
            {refused("link")}
            {link ? (
              <div className="aiiw-stack-sm" data-aiiw-link="">
                <p className="aiiw-small">{link.copied ? "Copied. Paste it into a text or an email to your customer." : "Copy this link and send it to your customer."}</p>
                <input className="aiiw-input" readOnly value={link.url} aria-label="The customer's link" onFocus={(e) => e.currentTarget.select()} />
              </div>
            ) : null}
            <SendOutcome announce={announce} />
          </section>
        ) : null}

        <Lines invoice={invoice} money={money} busy={busy} refused={refused} transport={transport} write={write} />

        <dl className="aiiw-totals" data-aiiw-totals="">
          <dt>Subtotal</dt>
          <dd>{money(invoice.subtotal)}</dd>
          {invoice.discount > 0 ? (
            <>
              <dt>Discount</dt>
              <dd>−{money(invoice.discount)}</dd>
            </>
          ) : null}
          {invoice.taxRateBp > 0 ? (
            <>
              <dt>Tax ({percentText(invoice.taxRateBp)})</dt>
              <dd>{money(invoice.taxAmount)}</dd>
            </>
          ) : null}
          <dt className="aiiw-strong">Total</dt>
          <dd className="aiiw-strong">{money(invoice.total)}</dd>
          <dt>Paid</dt>
          <dd>{money(invoice.amountPaid)}</dd>
          <dt className="aiiw-strong">Balance due</dt>
          <dd className="aiiw-strong">{money(invoice.balanceDue)}</dd>
        </dl>
        {invoice.overpaid > 0 ? (
          <p className="aiiw-overpaid" data-aiiw-overpaid="">
            {money(invoice.overpaid)} overpaid: refund or credit it.
          </p>
        ) : null}

        {invoice.can.manage && invoice.nextStatuses.length > 0 ? (
          <section className="aiiw-card" aria-labelledby="aiiw-move">
            <h3 className="aiiw-h3" id="aiiw-move">
              Move to
            </h3>
            <div className="aiiw-actions">
              {invoice.nextStatuses.map((status) => (
                <button
                  key={status}
                  type="button"
                  className="aiiw-btn aiiw-btn-secondary"
                  disabled={busy === `move-${status}`}
                  onClick={() => (status === "void" ? setConfirmVoid(true) : void move(status))}
                >
                  {MOVE_WORDS[status]}
                </button>
              ))}
            </div>
            {invoice.nextStatuses.map((status) => refused(`move-${status}`))}
          </section>
        ) : null}

        {invoice.can.manage && transport.setDeposit && (invoice.deposit.editable || invoice.deposit.amount > 0) ? (
          <Deposit
            invoice={invoice}
            money={(cents) => formatMoney(cents, format, locale)}
            busy={busy === "deposit"}
            refused={refused}
            onSave={(body) => write("deposit", () => transport.setDeposit!(invoice.id, body), () => "Deposit saved.")}
          />
        ) : null}

        <Payments
          invoice={invoice}
          format={format}
          locale={locale}
          canPay={canPay}
          busy={busy}
          refused={refused}
          onRecord={(body) => write("pay", () => transport.recordPayment(invoice.id, body), () => "Payment recorded.")}
          onReverse={setReversing}
        />
      </div>

      {confirmVoid ? (
        <Dialog title="Void this invoice?" onClose={() => setConfirmVoid(false)}>
          <p>{`Void invoice ${invoice.number}? It stays in your records and can't be changed after.`}</p>
          <div className="aiiw-actions">
            <button
              type="button"
              className="aiiw-btn aiiw-btn-danger"
              data-autofocus=""
              onClick={() => {
                setConfirmVoid(false);
                void move("void");
              }}
            >
              Void invoice
            </button>
            <button type="button" className="aiiw-btn aiiw-btn-secondary" onClick={() => setConfirmVoid(false)}>
              Keep it
            </button>
          </div>
        </Dialog>
      ) : null}

      {reversing ? (
        <ReverseDialog
          payment={reversing}
          money={money}
          onClose={() => setReversing(null)}
          onReverse={async (reason) => {
            const res = await write("reverse", () => transport.reversePayment(reversing.id, { reason }), () => "Payment reversed.");
            if (res.ok) setReversing(null);
            return res.ok ? null : res.error;
          }}
        />
      ) : null}
    </Root>
  );
}

/** The last outcome sentence, shown under the Send buttons (the status region announces it). */
function SendOutcome({ announce }: { announce: string }) {
  if (!/^(Emailed|This invoice has no customer email|This site doesn't send email|The email didn't go)/.test(announce)) return null;
  return (
    <p className="aiiw-small" data-aiiw-send-outcome="">
      {announce}
    </p>
  );
}

type Write = <T extends InvoiceResponse>(key: string, call: () => Promise<Result<T>>, done: (data: T) => string) => Promise<Result<T>>;

function Lines({
  invoice,
  money,
  busy,
  refused,
  transport,
  write,
}: {
  invoice: InvoiceDetailWire;
  money: (cents: number) => string;
  busy: string | null;
  refused: (where: string) => ReactElement | null;
  transport: InvoicingTransport;
  write: Write;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const canEdit = invoice.editable && invoice.can.manage;
  return (
    <section className="aiiw-card" aria-labelledby="aiiw-lines">
      <h3 className="aiiw-h3" id="aiiw-lines">
        Lines
      </h3>
      {canEdit && invoice.storedStatus !== "draft" ? (
        <p className="aiiw-small" data-aiiw-replace-note="">
          On a sent invoice, a change replaces the line; the customer's page shows the new one.
        </p>
      ) : null}
      {invoice.lines.length === 0 ? <p className="aiiw-muted">No lines yet.</p> : null}
      <ul className="aiiw-stack-sm" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {invoice.lines.map((line) =>
          editing === line.id ? (
            <li key={line.id}>
              <LineForm
                initial={line}
                busy={busy === `line-${line.id}`}
                submitLabel="Save line"
                onCancel={() => setEditing(null)}
                onSubmit={async (body) => {
                  const res = await write(`line-${line.id}`, () => transport.updateItem(line.id, body), () => "Line saved.");
                  if (res.ok) setEditing(null);
                  return res.ok ? null : res.error;
                }}
              />
            </li>
          ) : (
            <li key={line.id} className="aiiw-item-card" data-aiiw-line={line.id}>
              <div className="aiiw-row">
                <strong className="aiiw-grow">{line.description}</strong>
                <span className="aiiw-num">{money(line.total)}</span>
              </div>
              <span className="aiiw-small">
                {line.quantity} × {money(line.unitPrice)}
              </span>
              {canEdit ? (
                <div className="aiiw-actions">
                  <button type="button" className="aiiw-btn aiiw-btn-secondary" aria-label={`Change ${line.description}`} onClick={() => setEditing(line.id)}>
                    Change
                  </button>
                  <button
                    type="button"
                    className="aiiw-btn aiiw-btn-secondary"
                    aria-label={`Remove ${line.description}`}
                    disabled={busy === `remove-${line.id}`}
                    onClick={() => void write(`remove-${line.id}`, () => transport.removeItem(line.id), () => "Line removed.")}
                  >
                    Remove
                  </button>
                </div>
              ) : null}
              {refused(`remove-${line.id}`)}
            </li>
          ),
        )}
      </ul>
      {canEdit ? (
        adding ? (
          <LineForm
            busy={busy === "add-line"}
            submitLabel="Add line"
            onCancel={() => setAdding(false)}
            onSubmit={async (body) => {
              const res = await write("add-line", () => transport.addItem(invoice.id, body as { description: string; quantity: number; unitPrice: number }), () => "Line added.");
              if (res.ok) setAdding(false);
              return res.ok ? null : res.error;
            }}
          />
        ) : (
          <div className="aiiw-actions">
            <button type="button" className="aiiw-btn aiiw-btn-secondary" onClick={() => setAdding(true)}>
              + Add line
            </button>
          </div>
        )
      ) : null}
    </section>
  );
}

function LineForm({
  initial,
  busy,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  initial?: InvoiceLineWire;
  busy: boolean;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (body: { description: string; quantity: number; unitPrice: number }) => Promise<ClientError | null>;
}) {
  const id = useId();
  const [description, setDescription] = useState(initial?.description ?? "");
  const [quantity, setQuantity] = useState(String(initial?.quantity ?? 1));
  const [price, setPrice] = useState(initial ? dollarsInput(initial.unitPrice) : "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [server, setServer] = useState<ClientError | null>(null);
  const err = (key: string) => errors[key] ?? issueAt(server?.issues, key);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (description.trim() === "") found.description = "Describe the work.";
    const q = parseQuantity(quantity);
    if (!q.ok) found.quantity = q.message;
    const p = parseDollars(price);
    if (!p.ok) found.unitPrice = p.message;
    setErrors(found);
    setServer(null);
    if (!q.ok || !p.ok || Object.keys(found).length > 0) return;
    const error = await onSubmit({ description: description.trim(), quantity: q.value, unitPrice: p.value });
    setServer(error);
  };

  return (
    <form className="aiiw-form aiiw-item-card" onSubmit={(event) => void submit(event)} noValidate data-aiiw-line-form="">
      <div className="aiiw-line-row">
        <Field id={`${id}-d`} label="Description" error={err("description")}>
          <input className="aiiw-input" value={description} onChange={(e) => setDescription(e.target.value)} {...fieldAria(`${id}-d`, err("description"))} />
        </Field>
        <Field id={`${id}-q`} label="Quantity" error={err("quantity")}>
          <input className="aiiw-input" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} {...fieldAria(`${id}-q`, err("quantity"))} />
        </Field>
        <Field id={`${id}-p`} label="Price ($)" error={err("unitPrice")}>
          <input className="aiiw-input" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} {...fieldAria(`${id}-p`, err("unitPrice"))} />
        </Field>
      </div>
      {server && !(server.issues && server.issues.length > 0) ? (
        <div className="aiiw-notice aiiw-notice-error" role="alert">
          {errorSentence(server)}
        </div>
      ) : null}
      <div className="aiiw-actions">
        <button type="submit" className="aiiw-btn aiiw-btn-primary" disabled={busy}>
          {busy ? "Saving…" : submitLabel}
        </button>
        <button type="button" className="aiiw-btn aiiw-btn-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * The deposit (0.2): what the customer pays online first. The company's
 * default, none, a percent or a fixed amount; the server works out what it
 * comes to, and refuses a change once money is against the invoice.
 */
function Deposit({
  invoice,
  money,
  busy,
  refused,
  onSave,
}: {
  invoice: InvoiceDetailWire;
  money: (cents: number) => string;
  busy: boolean;
  refused: (where: string) => ReactElement | null;
  onSave: (body: DepositBody) => Promise<Result<InvoiceResponse>>;
}) {
  const id = useId();
  const d = invoice.deposit;
  const [rule, setRule] = useState<DepositBody["rule"]>(d.rule);
  const [percent, setPercent] = useState(d.percentBp !== null ? String(d.percentBp / 100) : "");
  const [amount, setAmount] = useState(d.fixedAmount !== null ? dollarsInput(d.fixedAmount) : "");
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    let body: DepositBody;
    if (rule === "percent") {
      const parsed = parsePercent(percent);
      if (!parsed.ok || parsed.value < 1 || parsed.value > 10_000) return setError("Enter a percent from 1 to 100.");
      body = { rule, percentBp: parsed.value };
    } else if (rule === "amount") {
      const parsed = parseDollars(amount, { allowZero: false });
      if (!parsed.ok) return setError(parsed.message);
      body = { rule, amount: parsed.value };
    } else body = { rule };
    const res = await onSave(body);
    if (!res.ok) setError(res.error.message);
  };
  return (
    <section className="aiiw-card" aria-labelledby={`${id}-title`} data-aiiw-deposit="">
      <h3 className="aiiw-h3" id={`${id}-title`}>
        Deposit
      </h3>
      <p className="aiiw-muted">
        {d.amount > 0 ? `Customers paying online pay ${money(d.amount)} first, then the rest.` : "No deposit: customers paying online pay the whole balance."}
      </p>
      {d.editable ? (
        <form className="aiiw-form" onSubmit={(event) => void submit(event)} noValidate>
          <label className="aiiw-field">
            <span>Deposit on this invoice</span>
            <select className="aiiw-input" value={rule} onChange={(e) => setRule(e.target.value as DepositBody["rule"])}>
              <option value="default">{d.defaultPercent > 0 ? `Your usual (${d.defaultPercent}%)` : "Your usual (none)"}</option>
              <option value="none">No deposit</option>
              <option value="percent">A percent of the invoice</option>
              <option value="amount">A fixed amount</option>
            </select>
          </label>
          {rule === "percent" ? (
            <label className="aiiw-field">
              <span>Percent</span>
              <input className="aiiw-input" inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} />
            </label>
          ) : rule === "amount" ? (
            <label className="aiiw-field">
              <span>Amount ($)</span>
              <input className="aiiw-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
          ) : null}
          {error ? (
            <p className="aiiw-field-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="aiiw-actions">
            <button type="submit" className="aiiw-btn aiiw-btn-secondary" disabled={busy}>
              Save deposit
            </button>
          </div>
          {refused("deposit")}
        </form>
      ) : null}
    </section>
  );
}

function Payments({
  invoice,
  format,
  locale,
  canPay,
  busy,
  refused,
  onRecord,
  onReverse,
}: {
  invoice: InvoiceDetailWire;
  format: MoneyFormatWire;
  locale: string | undefined;
  canPay: boolean;
  busy: string | null;
  refused: (where: string) => ReactElement | null;
  onRecord: (body: { amount: number; method: PaymentMethodWire; reference: string | null }) => Promise<Result<InvoiceResponse>>;
  onReverse: (payment: InvoicePaymentWire) => void;
}) {
  const id = useId();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PaymentMethodWire>("check");
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const money = (cents: number) => formatMoney(cents, format, locale);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseDollars(amount, { allowZero: false });
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setError(null);
    const res = await onRecord({ amount: parsed.value, method, reference: reference.trim() === "" ? null : reference.trim() });
    if (res.ok) {
      setAmount("");
      setReference("");
    } else setError(issueAt(res.error.issues, "amount"));
  };

  return (
    <section className="aiiw-card" aria-labelledby="aiiw-payments-title">
      <h3 className="aiiw-h3" id="aiiw-payments-title">
        Payments
      </h3>
      {invoice.payments.length === 0 ? <p className="aiiw-muted">No payments yet.</p> : null}
      <ul className="aiiw-stack-sm" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {invoice.payments.map((payment) => (
          <li key={payment.id} className="aiiw-item-card" data-aiiw-payment={payment.id}>
            <div className="aiiw-row">
              <span className={`aiiw-grow aiiw-num${payment.reversed ? " aiiw-reversed" : ""}`}>
                {money(payment.amount)} · {paymentWords(payment.method, payment.reference)}
              </span>
              <span className="aiiw-small">{formatDate(payment.paidAt, format, locale)}</span>
            </div>
            {payment.reversesPaymentId ? <span className="aiiw-small">Reversal{payment.reason ? `: ${payment.reason}` : ""}</span> : null}
            {payment.reversed ? (
              <span className="aiiw-small">Reversed</span>
            ) : payment.reversedAmount > 0 ? (
              <span className="aiiw-small" data-aiiw-partly-refunded="">
                Partly refunded {money(payment.reversedAmount)}
              </span>
            ) : null}
            {payment.flag === "disputed" ? (
              <span className="aiiw-small" data-aiiw-flag="disputed">
                Disputed: the customer's bank opened a chargeback. Answer it in your Stripe dashboard.
              </span>
            ) : payment.flag === "dispute_lost" ? (
              <span className="aiiw-small" data-aiiw-flag="dispute_lost">
                The dispute was lost: the bank took this payment back (see the reversal).
              </span>
            ) : null}
            {invoice.can.reverse && !payment.reversed && payment.reversedAmount === 0 && !payment.reversesPaymentId ? (
              <div className="aiiw-actions">
                <button type="button" className="aiiw-btn aiiw-btn-secondary" onClick={() => onReverse(payment)}>
                  Reverse
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {canPay ? (
        <form className="aiiw-form" onSubmit={(event) => void submit(event)} noValidate data-aiiw-pay-form="">
          <div className="aiiw-grid2">
            <Field id={`${id}-amount`} label="Amount ($)" error={error}>
              <input className="aiiw-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} {...fieldAria(`${id}-amount`, error)} />
            </Field>
            <Field id={`${id}-method`} label="How they paid">
              <select id={`${id}-method`} className="aiiw-input" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethodWire)}>
                {METHODS.map((m) => (
                  <option key={m} value={m}>
                    {METHOD_WORDS[m]}
                  </option>
                ))}
              </select>
            </Field>
            <Field id={`${id}-ref`} label="Check number or note (optional)">
              <input id={`${id}-ref`} className="aiiw-input" value={reference} maxLength={200} onChange={(e) => setReference(e.target.value)} />
            </Field>
          </div>
          {refused("pay")}
          <div className="aiiw-actions">
            <button type="submit" className="aiiw-btn aiiw-btn-primary" disabled={busy === "pay"}>
              {busy === "pay" ? "Recording…" : "Record payment"}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

function ReverseDialog({
  payment,
  money,
  onClose,
  onReverse,
}: {
  payment: InvoicePaymentWire;
  money: (cents: number) => string;
  onClose: () => void;
  onReverse: (reason: string) => Promise<ClientError | null>;
}) {
  const id = useId();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (reason.trim() === "") {
      setError("Say why this payment is being reversed.");
      return;
    }
    setSaving(true);
    const failed = await onReverse(reason.trim());
    setSaving(false);
    if (failed) setError(issueAt(failed.issues, "reason") ?? errorSentence(failed));
  };
  return (
    <Dialog title="Reverse this payment?" onClose={onClose}>
      <form className="aiiw-form" onSubmit={(event) => void submit(event)} noValidate>
        <p>{`${money(payment.amount)} by ${METHOD_WORDS[payment.method].toLowerCase()} will be undone with a reversal. The record of both stays.`}</p>
        <Field id={`${id}-reason`} label="Why" error={error}>
          <textarea className="aiiw-input" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} {...fieldAria(`${id}-reason`, error)} />
        </Field>
        <div className="aiiw-actions">
          <button type="submit" className="aiiw-btn aiiw-btn-danger" disabled={saving}>
            {saving ? "Reversing…" : "Reverse payment"}
          </button>
          <button type="button" className="aiiw-btn aiiw-btn-secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}
