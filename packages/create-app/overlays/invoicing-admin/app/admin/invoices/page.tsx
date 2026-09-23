"use client";

import { useState } from "react";
import { invoiceLinkPath, invoicePreviewPath } from "@/invoice-link";
import { api } from "@/trpc/client";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Input,
  Notice,
  PageHeader,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/components/ui";
import type { BadgeTone } from "@/components/ui/Badge";

function usd(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

/**
 * Dollars a person typed → integer cents. Math.round absorbs float noise
 * (0.29 × 100 = 28.999…); NaN for anything that isn't a number, so the form
 * can refuse it instead of sending a guess.
 */
function toCents(dollars: string): number {
  const n = Number(dollars.trim() === "" ? "0" : dollars);
  return Number.isFinite(n) ? Math.round(n * 100) : Number.NaN;
}

const selectClass = "rounded-control border border-line-strong bg-surface px-2 py-1 text-sm text-ink";
const FILTERS = ["all", "draft", "sent", "viewed", "partial", "overdue", "paid", "void"] as const;
const METHODS = ["card", "cash", "check", "ach", "other"] as const;
type Method = (typeof METHODS)[number];

interface LineDraft {
  description: string;
  quantity: string;
  unit: string;
}
const blankLine = (): LineDraft => ({ description: "", quantity: "1", unit: "" });

/** The lines a person filled in, priced in cents; null if any price isn't a number. */
function priceLines(lines: LineDraft[]): Array<{ description: string; quantity: number; unitPrice: number }> | null {
  const priced = lines
    .filter((l) => l.description.trim() !== "")
    .map((l) => ({
      description: l.description.trim(),
      quantity: Math.max(1, Math.trunc(Number(l.quantity) || 1)),
      unitPrice: toCents(l.unit),
    }));
  return priced.some((p) => !Number.isFinite(p.unitPrice) || p.unitPrice < 0) ? null : priced;
}

function statusTone(status: string): BadgeTone {
  if (status === "paid") return "accent";
  if (status === "void" || status === "overdue") return "danger";
  if (status === "partial") return "warn";
  return "neutral";
}

/**
 * The invoices ledger, from __SCOPE__/invoicing. Raise an invoice with its
 * lines, adjust the lines until money is against it, move it draft → sent, and
 * record payments — the status follows the money (partial → paid), and a
 * mistaken payment is reversed, never edited. The customer opens theirs by a
 * token link, no account. (With --estimator, add a convert-from-estimate
 * action; see the invoicing router.)
 */
export default function InvoicesPage() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const invoices = api.invoicing.list.useInfiniteQuery(
    { status: filter === "all" ? null : filter },
    { getNextPageParam: (last) => last.nextCursor ?? undefined },
  );
  const rows = invoices.data?.pages.flatMap((page) => page.invoices) ?? [];
  const [openId, setOpenId] = useState<string | null>(null);
  const refresh = () => void invoices.refetch();

  return (
    <>
      <PageHeader
        title="Invoices"
        description="Invoices and payments. Raise an invoice with its lines, record payments, and share a token link a customer can open without signing in."
      />

      <div className="flex flex-col gap-4">
        <NewInvoice
          onCreated={(id) => {
            setOpenId(id);
            refresh();
          }}
        />

        <label className="flex items-center gap-2 text-xs text-ink-muted">
          Show
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as (typeof FILTERS)[number])}
            className={selectClass}
          >
            {FILTERS.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>

        {invoices.isLoading ? (
          <EmptyState title="Loading invoices…">Reading the ledger.</EmptyState>
        ) : rows.length === 0 ? (
          <EmptyState title={filter === "all" ? "No invoices yet" : `No ${filter} invoices`}>
            {filter === "all" ? "Raise the first one above." : "Pick another filter to see the rest of the ledger."}
          </EmptyState>
        ) : (
          <Card>
            <Table>
              <THead>
                <TR>
                  <TH className="w-32">Number</TH>
                  <TH>Customer</TH>
                  <TH className="w-24">Total</TH>
                  <TH className="w-24">Paid</TH>
                  <TH className="w-24">Status</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((inv) => (
                  <TR key={inv.id}>
                    <TD className="align-top">
                      <button
                        type="button"
                        onClick={() => setOpenId(openId === inv.id ? null : inv.id)}
                        className="font-mono text-xs text-accent underline underline-offset-2"
                      >
                        {inv.invoiceNumber}
                      </button>
                    </TD>
                    <TD className="align-top text-sm">{inv.customerName ?? "—"}</TD>
                    <TD className="align-top font-mono text-sm tabular-nums">{usd(inv.total)}</TD>
                    <TD className="align-top font-mono text-sm tabular-nums">{usd(inv.amountPaid)}</TD>
                    <TD className="align-top"><Badge tone={statusTone(inv.status)}>{inv.status}</Badge></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Card>
        )}

        {invoices.hasNextPage ? (
          <Button disabled={invoices.isFetchingNextPage} onClick={() => void invoices.fetchNextPage()}>
            {invoices.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        ) : null}

        {openId ? <InvoiceDetail key={openId} id={openId} onChanged={refresh} /> : null}
      </div>
    </>
  );
}

function LineInputs({ line, onChange }: { line: LineDraft; onChange: (next: LineDraft) => void }) {
  return (
    <>
      <Input
        placeholder="Description"
        value={line.description}
        onChange={(e) => onChange({ ...line, description: e.target.value })}
        className="min-w-48 flex-1"
      />
      <Input
        type="number"
        min="1"
        step="1"
        aria-label="Quantity"
        value={line.quantity}
        onChange={(e) => onChange({ ...line, quantity: e.target.value })}
        className="w-20"
      />
      <Input
        type="number"
        min="0"
        step="0.01"
        placeholder="Unit $"
        value={line.unit}
        onChange={(e) => onChange({ ...line, unit: e.target.value })}
        className="w-28"
      />
    </>
  );
}

function NewInvoice({ onCreated }: { onCreated: (id: string) => void }) {
  const create = api.invoicing.create.useMutation();
  const [customer, setCustomer] = useState("");
  const [email, setEmail] = useState("");
  const [taxPercent, setTaxPercent] = useState("");
  const [discount, setDiscount] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([blankLine()]);

  const priced = priceLines(lines);
  const taxRateBp = Math.round(Number(taxPercent || "0") * 100);
  const discountCents = toCents(discount);
  const ready =
    customer.trim() !== "" &&
    priced !== null &&
    priced.length > 0 &&
    Number.isFinite(taxRateBp) &&
    taxRateBp >= 0 &&
    Number.isFinite(discountCents) &&
    discountCents >= 0;
  // A preview only — the server computes the real totals from the lines.
  const subtotal = (priced ?? []).reduce((sum, p) => sum + p.unitPrice * p.quantity, 0);

  const submit = () => {
    if (!ready || priced === null) return;
    create.mutate(
      {
        customerName: customer.trim(),
        customerEmail: email.trim() || null,
        taxRateBp,
        discount: discountCents,
        items: priced,
      },
      {
        onSuccess: (created) => {
          setCustomer("");
          setEmail("");
          setTaxPercent("");
          setDiscount("");
          setLines([blankLine()]);
          onCreated(created.id);
        },
      },
    );
  };

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <p className="text-sm font-medium text-ink">New invoice</p>
        <div className="flex flex-wrap gap-2">
          <Input placeholder="Customer name" value={customer} onChange={(e) => setCustomer(e.target.value)} className="w-56" />
          <Input type="email" placeholder="Customer email (optional)" value={email} onChange={(e) => setEmail(e.target.value)} className="w-64" />
        </div>

        {lines.map((line, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <LineInputs line={line} onChange={(next) => setLines(lines.map((l, i) => (i === index ? next : l)))} />
            {lines.length > 1 ? (
              <Button aria-label="Remove line" onClick={() => setLines(lines.filter((_, i) => i !== index))}>
                ×
              </Button>
            ) : null}
          </div>
        ))}

        <div className="flex flex-wrap items-end gap-2">
          <Button onClick={() => setLines([...lines, blankLine()])}>+ Add line</Button>
          <Input type="number" min="0" step="0.01" placeholder="Tax %" value={taxPercent} onChange={(e) => setTaxPercent(e.target.value)} className="w-24" />
          <Input type="number" min="0" step="0.01" placeholder="Discount $" value={discount} onChange={(e) => setDiscount(e.target.value)} className="w-28" />
          <span className="text-xs text-ink-faint">Subtotal {usd(subtotal)} before discount and tax</span>
          <Button variant="primary" className="ml-auto" disabled={!ready || create.isPending} onClick={submit}>
            Create invoice
          </Button>
        </div>

        {create.error ? <Notice tone="danger" role="alert">{create.error.message}</Notice> : null}
      </CardBody>
    </Card>
  );
}

function InvoiceDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const detail = api.invoicing.get.useQuery({ id });
  const pay = api.invoicing.recordPayment.useMutation();
  const reverse = api.invoicing.reversePayment.useMutation();
  const setStatus = api.invoicing.setStatus.useMutation();
  const addItem = api.invoicing.addItem.useMutation();
  const removeItem = api.invoicing.removeItem.useMutation();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<Method>("card");
  const [reference, setReference] = useState("");
  const [line, setLine] = useState<LineDraft>(blankLine());
  const [reversing, setReversing] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Every action ends the same way: show the server's refusal if there was
  // one (it says what to do instead), otherwise refresh the ledger and this card.
  const settle = {
    onSuccess: () => {
      setError(null);
      onChanged();
      void detail.refetch();
    },
    onError: (e: { message: string }) => setError(e.message),
  };

  if (detail.isLoading) return <Card><CardBody>Loading…</CardBody></Card>;
  if (!detail.data) return <Card><CardBody>Invoice not found.</CardBody></Card>;
  // balanceDue comes from the server (0 on a void invoice — a cancelled bill
  // is not owed); overpaid is still shown there, as money to refund.
  const { invoice, items, payments, editable, nextStatuses, balanceDue } = detail.data;
  const overpaid = Math.max(0, invoice.amountPaid - invoice.total);
  const reversed = new Set(payments.map((p) => p.reversesPaymentId).filter(Boolean));
  const takesPayments = invoice.status !== "paid" && invoice.status !== "void" && invoice.status !== "draft";
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  // The link to SEND is shown as text to copy; the one to CLICK is the
  // preview, which the customer page never reports as viewed. Linking the
  // customer URL itself meant staff checking it marked the invoice "viewed".
  const customerUrl = `${origin}${invoiceLinkPath(invoice.viewToken)}`;
  const previewUrl = `${origin}${invoicePreviewPath(invoice.viewToken)}`;

  const record = () => {
    const cents = toCents(amount);
    if (!Number.isFinite(cents) || cents <= 0) return;
    pay.mutate(
      { invoiceId: invoice.id, amount: cents, method, reference: reference.trim() || null },
      {
        ...settle,
        onSuccess: () => {
          setAmount("");
          setReference("");
          settle.onSuccess();
        },
      },
    );
  };

  const addLine = () => {
    const [priced] = priceLines([line]) ?? [];
    if (!priced) return;
    addItem.mutate(
      { invoiceId: invoice.id, ...priced },
      {
        ...settle,
        onSuccess: () => {
          setLine(blankLine());
          settle.onSuccess();
        },
      },
    );
  };

  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-sm text-ink">{invoice.invoiceNumber}</span>
          <Badge tone={statusTone(invoice.status)}>{invoice.status}</Badge>
          {nextStatuses.length > 0 ? (
            <label className="ml-auto flex items-center gap-2 text-xs text-ink-muted">
              Move to
              <select
                value=""
                onChange={(e) => {
                  const next = nextStatuses.find((s) => s === e.target.value);
                  if (next) setStatus.mutate({ id: invoice.id, status: next }, settle);
                }}
                className={selectClass}
              >
                <option value="" disabled>choose…</option>
                {nextStatuses.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
          ) : (
            <span className="ml-auto text-xs text-ink-faint">
              {invoice.status === "void" ? "Void is final." : "Status follows the payments."}
            </span>
          )}
        </div>

        <p className="text-sm">
          <span className="text-ink-faint">Customer:</span> {invoice.customerName ?? "—"}
          {invoice.customerEmail ? ` · ${invoice.customerEmail}` : ""}
        </p>

        <div className="overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>Line</TH>
                <TH className="w-16">Qty</TH>
                <TH className="w-24">Unit</TH>
                <TH className="w-24">Total</TH>
                {editable ? <TH className="w-10"><span className="sr-only">Remove</span></TH> : null}
              </TR>
            </THead>
            <TBody>
              {items.map((it) => (
                <TR key={it.id}>
                  <TD className="text-sm text-ink">{it.description}</TD>
                  <TD className="text-sm tabular-nums">{it.quantity}</TD>
                  <TD className="font-mono text-sm tabular-nums">{usd(it.unitPrice)}</TD>
                  <TD className="font-mono text-sm tabular-nums">{usd(it.total)}</TD>
                  {editable ? (
                    <TD>
                      <Button
                        aria-label={`Remove ${it.description}`}
                        disabled={removeItem.isPending}
                        onClick={() => removeItem.mutate({ itemId: it.id }, settle)}
                      >
                        ×
                      </Button>
                    </TD>
                  ) : null}
                </TR>
              ))}
            </TBody>
          </Table>
        </div>

        {editable ? (
          <div className="flex flex-wrap items-center gap-2">
            <LineInputs line={line} onChange={setLine} />
            <Button disabled={!line.description.trim() || addItem.isPending} onClick={addLine}>
              Add line
            </Button>
          </div>
        ) : (
          <p className="text-xs text-ink-faint">
            Lines are frozen once money is against an invoice. Reverse its payments, or void it and raise a new one.
          </p>
        )}

        <div className="ml-auto text-right text-sm">
          <p><span className="text-ink-faint">Subtotal:</span> <span className="font-mono tabular-nums">{usd(invoice.subtotal)}</span></p>
          {invoice.discount > 0 ? (
            <p><span className="text-ink-faint">Discount:</span> <span className="font-mono tabular-nums">−{usd(invoice.discount)}</span></p>
          ) : null}
          <p><span className="text-ink-faint">Tax ({invoice.taxRateBp / 100}%):</span> <span className="font-mono tabular-nums">{usd(invoice.taxAmount)}</span></p>
          <p><span className="text-ink-faint">Total:</span> <span className="font-mono tabular-nums">{usd(invoice.total)}</span></p>
          <p><span className="text-ink-faint">Paid:</span> <span className="font-mono tabular-nums">{usd(invoice.amountPaid)}</span></p>
          <p className="text-base font-semibold"><span className="text-ink-faint">Balance:</span> <span className="font-mono tabular-nums">{usd(balanceDue)}</span></p>
          {overpaid > 0 ? <p className="text-warn">Overpaid by {usd(overpaid)} — refund or credit it.</p> : null}
        </div>

        {payments.length > 0 ? (
          <div className="flex flex-col gap-1 text-xs text-ink-muted">
            <p className="font-medium">Payments</p>
            {payments.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center gap-2 font-mono tabular-nums">
                <span>
                  {usd(p.amount)} · {p.method} · {new Date(p.paidAt).toLocaleDateString()}
                  {p.reference ? ` · ${p.reference}` : ""}
                  {p.reversesPaymentId ? ` · reversal: ${p.reason ?? ""}` : ""}
                  {reversed.has(p.id) ? " · reversed" : ""}
                </span>
                {!p.reversesPaymentId && !reversed.has(p.id) ? (
                  reversing === p.id ? (
                    <>
                      <Input placeholder="Why (bounced check, chargeback…)" value={reason} onChange={(e) => setReason(e.target.value)} className="w-64" />
                      <Button
                        variant="danger"
                        disabled={!reason.trim() || reverse.isPending}
                        onClick={() =>
                          reverse.mutate(
                            { paymentId: p.id, reason: reason.trim() },
                            {
                              ...settle,
                              onSuccess: () => {
                                setReversing(null);
                                setReason("");
                                settle.onSuccess();
                              },
                            },
                          )
                        }
                      >
                        Reverse
                      </Button>
                      <Button onClick={() => setReversing(null)}>Cancel</Button>
                    </>
                  ) : (
                    <button type="button" className="text-accent underline underline-offset-2" onClick={() => setReversing(p.id)}>
                      reverse
                    </button>
                  )
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {takesPayments ? (
          <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
            <Input type="number" min="0" step="0.01" placeholder="Payment $" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-28" />
            <select value={method} onChange={(e) => setMethod(e.target.value as Method)} className={selectClass}>
              {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <Input placeholder="Reference (check #)" value={reference} onChange={(e) => setReference(e.target.value)} className="w-40" />
            <Button variant="primary" disabled={pay.isPending} onClick={record}>Record payment</Button>
          </div>
        ) : invoice.status === "draft" ? (
          <p className="border-t border-line pt-3 text-xs text-ink-faint">Send the invoice before recording payments against it.</p>
        ) : null}

        {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}

        {invoice.status !== "draft" ? (
          <p className="text-xs text-ink-faint">
            Customer link (copy to send):{" "}
            <span className="select-all break-all font-mono text-ink-muted">{customerUrl}</span>
            {" · "}
            <a href={previewUrl} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">
              preview
            </a>{" "}
            (doesn&rsquo;t mark it viewed)
          </p>
        ) : (
          <p className="text-xs text-ink-faint">The customer link opens once the invoice is sent.</p>
        )}
      </CardBody>
    </Card>
  );
}
