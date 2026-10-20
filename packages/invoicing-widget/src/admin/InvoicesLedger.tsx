import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import type { ClientError } from "../http.js";
import { DEFAULT_FORMAT, formatDate, formatMoney, parseDollars, parsePercent, parseQuantity, STATUS_TONE, STATUS_WORDS } from "../money.js";
import type { CreateInvoiceBody, InvoiceStatusWire, InvoiceSummaryWire, InvoicingStatusWire, MoneyFormatWire } from "../types.js";
import { Field, fieldAria, Loading, Root, SetupCard, type ChromeProps } from "../ui.js";
import type { InvoicingTransport } from "./client.js";
import { InvoiceEditor } from "./InvoiceEditor.js";
import { errorSentence, hrefFor, issueAt, navigate, safely, useAlive, useInvoicingTransport } from "./shared.js";

/**
 * The ledger a business works from (Tenancy 2a, 10.9): every invoice, newest
 * first, filtered in words, with "New invoice". It replaces the page
 * create-app used to copy into every project.
 *
 *   <InvoicesLedger baseUrl={`/api/app/${company.id}/invoices`} invoiceHref="/app/invoices/{id}" />
 *
 * A person types dollars and a percent; the ledger sends cents and basis
 * points and refuses a value that isn't a number before anything is sent.
 * The server's totals are the truth: the preview here is only a guide.
 */

export interface InvoicesLedgerProps extends ChromeProps {
  baseUrl?: string;
  transport?: InvoicingTransport;
  /** Where one invoice opens: a pattern with {id}, or a function. Default "?invoice={id}" on this page. */
  invoiceHref?: string | ((id: string) => string);
  /**
   * Default true; false = read-only (Tenancy 2a: a company's viewer, who may
   * look at invoices but not raise them): no "New invoice". The server refuses
   * the create anyway; this stops offering it. Each invoice's own page already
   * offers only what the server says this person may do (`invoice.can`). Pass
   * `can.includes("invoices.manage")`.
   */
  canManage?: boolean;
  /** The heading. Default "Invoices"; `false` draws none, for a host page whose own header says it (New invoice stays). */
  title?: string | false;
  /** Staff of the SITE: the setup card also shows the technical detail of what only the operator can switch on. */
  showTechnical?: boolean;
}

const FILTERS: readonly { label: string; status: InvoiceStatusWire | null }[] = [
  { label: "All", status: null },
  { label: "Draft", status: "draft" },
  { label: "Sent", status: "sent" },
  { label: "Viewed", status: "viewed" },
  { label: "Partly paid", status: "partial" },
  { label: "Overdue", status: "overdue" },
  { label: "Paid", status: "paid" },
  { label: "Void", status: "void" },
];

/** The invoice the default "?invoice={id}" href opened on this page, if any. */
function openedHere(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return new URLSearchParams(window.location.search).get("invoice");
  } catch {
    return null;
  }
}

export function InvoicesLedger(props: InvoicesLedgerProps) {
  const { baseUrl, transport: given, invoiceHref, locale, canManage: _canManage, title: _title, showTechnical: _showTechnical, ...chrome } = props;
  const transport = useInvoicingTransport(given, baseUrl);
  // With the default href, an invoice opened from this page shows here.
  const [inline] = useState<string | null>(() => (invoiceHref === undefined ? openedHere() : null));
  if (inline) {
    const back = typeof window !== "undefined" ? window.location.pathname : "?";
    return <InvoiceEditor {...chrome} locale={locale} transport={transport} invoiceId={inline} backHref={back} />;
  }
  return <Ledger {...props} transport={transport} />;
}

type ListState = { state: "loading" } | { state: "ready"; rows: InvoiceSummaryWire[]; next: string | null; format: MoneyFormatWire } | { state: "error"; error: ClientError };

function Ledger(props: InvoicesLedgerProps & { transport: InvoicingTransport }) {
  const { transport, invoiceHref = "?invoice={id}", locale, baseUrl: _baseUrl, canManage = true, title, showTechnical = false, ...chrome } = props;
  const alive = useAlive();
  const [status, setStatus] = useState<InvoicingStatusWire | null>(null);
  const [filter, setFilter] = useState<InvoiceStatusWire | null>(null);
  const [list, setList] = useState<ListState>({ state: "loading" });
  const [more, setMore] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void safely(() => transport.status()).then((res) => {
      if (alive.current && res.ok) setStatus(res.data);
    });
  }, [transport, alive]);

  const load = useCallback(async () => {
    setList({ state: "loading" });
    const res = await safely(() => transport.list(filter ? { status: filter } : {}));
    if (!alive.current) return;
    setList(res.ok ? { state: "ready", rows: res.data.invoices, next: res.data.nextCursor, format: res.data.format } : { state: "error", error: res.error });
  }, [transport, filter, alive]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    if (list.state !== "ready" || !list.next) return;
    setMore(true);
    const res = await safely(() => transport.list({ ...(filter ? { status: filter } : {}), cursor: list.next as string }));
    if (!alive.current) return;
    setMore(false);
    if (res.ok) setList({ state: "ready", rows: [...list.rows, ...res.data.invoices], next: res.data.nextCursor, format: res.data.format });
  };

  const format = list.state === "ready" ? list.format : (status?.format ?? DEFAULT_FORMAT);
  const money = (cents: number) => formatMoney(cents, format, locale);
  const open = (id: string) => hrefFor(invoiceHref, id);

  return (
    <Root {...chrome} admin data={{ "aiiw-ledger": "" }}>
      <div className="aiiw-admin-inner">
        <div className="aiiw-spread" data-titled={title === false ? undefined : ""}>
          {title === false ? <span /> : <h2 className="aiiw-title">{title ?? "Invoices"}</h2>}
          {canManage && !creating ? (
            <button type="button" className="aiiw-btn aiiw-btn-primary" onClick={() => setCreating(true)}>
              New invoice
            </button>
          ) : null}
        </div>

        {/* One setup card, never a stack of banners: how customers pay (the
            owner's job, with where to fill it in) and email (the operator's). */}
        {status ? (
          <SetupCard
            showTechnical={showTechnical}
            items={[
              ...(!status.detailsComplete ? [{ code: "details", text: "Add how customers pay you, so every invoice says it.", href: status.detailsHref }] : []),
              ...(!status.emails
                ? [{ code: "email", operator: true, text: "Email isn't switched on for this site yet, so invoices aren't emailed. Send one and copy its link to the customer.", detail: status.emailsOffReason }]
                : []),
            ]}
          />
        ) : null}

        {creating ? (
          <NewInvoice
            transport={transport}
            onCancel={() => setCreating(false)}
            onCreated={(id) => {
              setCreating(false);
              navigate(open(id));
            }}
          />
        ) : null}

        <div className="aiiw-chips" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button key={f.label} type="button" className="aiiw-chip" aria-pressed={filter === f.status} onClick={() => setFilter(f.status)}>
              {f.label}
            </button>
          ))}
        </div>

        <section className="aiiw-card" aria-label="Your invoices">
          {list.state === "loading" ? (
            <Loading text="Loading invoices…" />
          ) : list.state === "error" ? (
            <div className="aiiw-notice aiiw-notice-error aiiw-row">
              <span className="aiiw-grow">{errorSentence(list.error)}</span>
              <button type="button" className="aiiw-btn aiiw-btn-secondary" onClick={() => void load()}>
                Try again
              </button>
            </div>
          ) : list.rows.length === 0 ? (
            filter ? (
              <p className="aiiw-muted">No invoices here.</p>
            ) : (
              <div className="aiiw-empty" data-aiiw-empty="">
                <p className="aiiw-empty-title">No invoices yet</p>
                <p className="aiiw-empty-text">
                  Once you&apos;re invoicing, every bill lives here with what&apos;s owed and what&apos;s overdue. Customers open theirs from a
                  link and pay by card, and the payment lands on the invoice by itself.
                </p>
                {canManage ? (
                  <button type="button" className="aiiw-btn aiiw-btn-primary" onClick={() => setCreating(true)}>
                    Raise your first invoice
                  </button>
                ) : null}
              </div>
            )
          ) : (
            <>
              <table className="aiiw-table aiiw-wide">
                <thead>
                  <tr>
                    <th scope="col">Number</th>
                    <th scope="col">Customer</th>
                    <th scope="col" className="aiiw-right">
                      Total
                    </th>
                    <th scope="col" className="aiiw-right">
                      Paid
                    </th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {list.rows.map((row) => (
                    <tr key={row.id} data-aiiw-invoice={row.id}>
                      <td>
                        <a href={open(row.id)}>{row.number}</a>
                      </td>
                      <td>{row.customerName ?? ""}</td>
                      <td className="aiiw-right aiiw-num">{money(row.total)}</td>
                      <td className="aiiw-right aiiw-num">{money(row.amountPaid)}</td>
                      <td>
                        <span className={`aiiw-tag aiiw-tag-${STATUS_TONE[row.status]}`}>{STATUS_WORDS[row.status]}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <ul className="aiiw-cards">
                {list.rows.map((row) => (
                  <li key={row.id} className="aiiw-item-card">
                    <div className="aiiw-row">
                      <a className="aiiw-grow" href={open(row.id)}>
                        {row.number}
                      </a>
                      <span className={`aiiw-tag aiiw-tag-${STATUS_TONE[row.status]}`}>{STATUS_WORDS[row.status]}</span>
                    </div>
                    <span>{row.customerName ?? ""}</span>
                    <span className="aiiw-small">
                      {money(row.total)} · paid {money(row.amountPaid)}
                      {row.dueDate ? ` · due ${formatDate(row.dueDate, format, locale)}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
              {list.next ? (
                <div className="aiiw-actions">
                  <button type="button" className="aiiw-btn aiiw-btn-secondary" disabled={more} onClick={() => void loadMore()}>
                    {more ? "Loading…" : "Load more"}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>
    </Root>
  );
}

interface LineDraft {
  key: number;
  description: string;
  quantity: string;
  price: string;
}

let lineKeys = 0;
const blankLine = (): LineDraft => ({ key: ++lineKeys, description: "", quantity: "1", price: "" });

function NewInvoice({ transport, onCancel, onCreated }: { transport: InvoicingTransport; onCancel: () => void; onCreated: (id: string) => void }) {
  const id = useId();
  const alive = useAlive();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [lines, setLines] = useState<LineDraft[]>(() => [blankLine()]);
  const [tax, setTax] = useState("");
  const [discount, setDiscount] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<ClientError | null>(null);
  const [saving, setSaving] = useState(false);

  const preview = lines.reduce((sum, line) => {
    const q = parseQuantity(line.quantity);
    const p = parseDollars(line.price);
    return q.ok && p.ok ? sum + q.value * p.value : sum;
  }, 0);

  const err = (path: string) => errors[path] ?? issueAt(serverError?.issues, path);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (name.trim() === "") found.customerName = "Who is this invoice for?";
    const items: CreateInvoiceBody["items"] = [];
    lines.forEach((line, index) => {
      if (line.description.trim() === "") found[`items.${index}.description`] = "Describe the work.";
      const q = parseQuantity(line.quantity);
      if (!q.ok) found[`items.${index}.quantity`] = q.message;
      const p = parseDollars(line.price);
      if (!p.ok) found[`items.${index}.unitPrice`] = p.message;
      if (q.ok && p.ok) items.push({ description: line.description.trim(), quantity: q.value, unitPrice: p.value });
    });
    const taxBp = parsePercent(tax);
    if (!taxBp.ok) found.taxRateBp = taxBp.message;
    const disc = discount.trim() === "" ? ({ ok: true, value: 0 } as const) : parseDollars(discount);
    if (!disc.ok) found.discount = disc.message;
    setErrors(found);
    setServerError(null);
    // A value that isn't a number is refused HERE, before anything is sent.
    if (Object.keys(found).length > 0 || !taxBp.ok || !disc.ok) return;
    setSaving(true);
    const res = await safely(() =>
      transport.create({
        customerName: name.trim(),
        customerEmail: email.trim() === "" ? null : email.trim(),
        taxRateBp: taxBp.value,
        discount: disc.value,
        dueDate: dueDate === "" ? null : dueDate,
        items,
      }),
    );
    if (!alive.current) return;
    setSaving(false);
    if (res.ok) onCreated(res.data.invoice.id);
    else setServerError(res.error);
  };

  const setLine = (key: number, patch: Partial<LineDraft>) => setLines((all) => all.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const fieldless = serverError && !(serverError.issues && serverError.issues.length > 0);

  return (
    <section className="aiiw-card" aria-labelledby={`${id}-title`} data-aiiw-new="">
      <h3 className="aiiw-h2" id={`${id}-title`}>
        New invoice
      </h3>
      <form className="aiiw-form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="aiiw-grid2">
          <Field id={`${id}-name`} label="Customer name" error={err("customerName")}>
            <input className="aiiw-input" value={name} autoComplete="name" onChange={(e) => setName(e.target.value)} {...fieldAria(`${id}-name`, err("customerName"))} />
          </Field>
          <Field id={`${id}-email`} label="Customer email (optional)" error={err("customerEmail")}>
            <input className="aiiw-input" type="email" value={email} autoComplete="email" onChange={(e) => setEmail(e.target.value)} {...fieldAria(`${id}-email`, err("customerEmail"))} />
          </Field>
        </div>
        <fieldset className="aiiw-stack-sm">
          <legend className="aiiw-label">Lines</legend>
          {lines.map((line, index) => (
            <div key={line.key} className="aiiw-line-row" data-aiiw-line={index}>
              <Field id={`${id}-d${line.key}`} label="Description" error={err(`items.${index}.description`)}>
                <input className="aiiw-input" value={line.description} onChange={(e) => setLine(line.key, { description: e.target.value })} {...fieldAria(`${id}-d${line.key}`, err(`items.${index}.description`))} />
              </Field>
              <Field id={`${id}-q${line.key}`} label="Quantity" error={err(`items.${index}.quantity`)}>
                <input className="aiiw-input" inputMode="numeric" value={line.quantity} onChange={(e) => setLine(line.key, { quantity: e.target.value })} {...fieldAria(`${id}-q${line.key}`, err(`items.${index}.quantity`))} />
              </Field>
              <Field id={`${id}-p${line.key}`} label="Price ($)" error={err(`items.${index}.unitPrice`)}>
                <input className="aiiw-input" inputMode="decimal" value={line.price} onChange={(e) => setLine(line.key, { price: e.target.value })} {...fieldAria(`${id}-p${line.key}`, err(`items.${index}.unitPrice`))} />
              </Field>
              <button
                type="button"
                className="aiiw-btn aiiw-btn-secondary"
                aria-label={`Remove line ${index + 1}`}
                disabled={lines.length === 1}
                onClick={() => setLines((all) => all.filter((l) => l.key !== line.key))}
              >
                Remove
              </button>
            </div>
          ))}
          <div className="aiiw-actions">
            <button type="button" className="aiiw-btn aiiw-btn-secondary" onClick={() => setLines((all) => [...all, blankLine()])}>
              + Add line
            </button>
          </div>
        </fieldset>
        <div className="aiiw-grid2">
          <Field id={`${id}-tax`} label="Tax (%)" error={err("taxRateBp")}>
            <input className="aiiw-input" inputMode="decimal" value={tax} placeholder="0" onChange={(e) => setTax(e.target.value)} {...fieldAria(`${id}-tax`, err("taxRateBp"))} />
          </Field>
          <Field id={`${id}-disc`} label="Discount ($)" error={err("discount")}>
            <input className="aiiw-input" inputMode="decimal" value={discount} placeholder="0" onChange={(e) => setDiscount(e.target.value)} {...fieldAria(`${id}-disc`, err("discount"))} />
          </Field>
          {/* CONTRACT: 10.9 words this hint with the business's {dueDays}, but
              InvoicingStatusWire (10.8) doesn't carry it; the hint says the
              same thing without the number rather than change the wire. */}
          <Field id={`${id}-due`} label="Due date" error={err("dueDate")} hint="Leave it empty and it's due after your usual number of days.">
            <input className="aiiw-input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} {...fieldAria(`${id}-due`, err("dueDate"), true)} />
          </Field>
        </div>
        <p className="aiiw-small" data-aiiw-preview="">
          Subtotal before discount and tax: <span className="aiiw-num">{formatMoney(preview)}</span>
        </p>
        {fieldless ? (
          <div className="aiiw-notice aiiw-notice-error" role="alert">
            {errorSentence(serverError)}
          </div>
        ) : Object.keys(errors).length > 0 || serverError ? (
          <div className="aiiw-notice aiiw-notice-error" role="alert">
            Check the highlighted fields.
          </div>
        ) : null}
        <div className="aiiw-actions">
          <button type="submit" className="aiiw-btn aiiw-btn-primary" disabled={saving}>
            {saving ? "Creating…" : "Create invoice"}
          </button>
          <button type="button" className="aiiw-btn aiiw-btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
