"use client";

import { useState } from "react";
import { api } from "@/trpc/client";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Input,
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
const selectClass = "rounded-control border border-line-strong bg-surface px-2 py-1 text-sm text-ink";

function statusTone(status: string): BadgeTone {
  if (status === "paid") return "accent";
  if (status === "void" || status === "overdue") return "danger";
  if (status === "partial") return "warn";
  return "neutral";
}

/**
 * The invoices queue, from __SCOPE__/invoicing. Create an invoice, then record
 * payments here — the status follows the money (partial → paid) and the customer
 * opens theirs by a token link, no account. (With --estimator, add a
 * convert-from-estimate action; see the invoicing router.)
 */
export default function InvoicesPage() {
  const invoices = api.invoicing.list.useQuery();
  const create = api.invoicing.create.useMutation();
  const [openId, setOpenId] = useState<string | null>(null);
  const [customer, setCustomer] = useState("");

  const add = async () => {
    if (!customer.trim()) return;
    await create.mutateAsync({
      customerName: customer.trim(),
      items: [{ description: "Services", quantity: 1, unitPrice: 0 }],
    });
    setCustomer("");
    void invoices.refetch();
  };

  return (
    <>
      <PageHeader
        title="Invoices"
        description="Invoices and payments. Raise an invoice, record payments, and share a token link a customer can open without signing in."
      />

      {invoices.isLoading ? (
        <EmptyState title="Loading invoices…">Reading the ledger.</EmptyState>
      ) : (
        <div className="flex flex-col gap-4">
          <Card>
            <CardBody className="flex flex-wrap items-end gap-2">
              <Input placeholder="Customer name" value={customer} onChange={(e) => setCustomer(e.target.value)} className="w-56" />
              <Button variant="primary" disabled={!customer.trim() || create.isPending} onClick={() => void add()}>
                New invoice
              </Button>
              <span className="text-xs text-ink-faint">Add line items and amounts by opening the invoice below.</span>
            </CardBody>
          </Card>

          {(invoices.data ?? []).length === 0 ? (
            <EmptyState title="No invoices yet">Raise the first one above.</EmptyState>
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
                  {(invoices.data ?? []).map((inv) => (
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

          {openId ? <InvoiceDetail id={openId} onChanged={() => void invoices.refetch()} /> : null}
        </div>
      )}
    </>
  );
}

function InvoiceDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const detail = api.invoicing.get.useQuery({ id });
  const pay = api.invoicing.recordPayment.useMutation();
  const setStatus = api.invoicing.setStatus.useMutation();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("card");

  if (detail.isLoading || !detail.data) return <Card><CardBody>Loading…</CardBody></Card>;
  const { invoice, items, payments } = detail.data;
  const balance = Math.max(0, invoice.total - invoice.amountPaid);
  const tokenUrl = typeof window !== "undefined" ? `${window.location.origin}/invoice/${invoice.viewToken}` : `/invoice/${invoice.viewToken}`;

  const record = async () => {
    const cents = Math.round((Number(amount) || 0) * 100);
    if (cents <= 0) return;
    await pay.mutateAsync({ invoiceId: invoice.id, amount: cents, method: method as "card" | "cash" | "check" | "ach" | "other" });
    setAmount("");
    onChanged();
    void detail.refetch();
  };

  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-sm text-ink">{invoice.invoiceNumber}</span>
          <Badge tone={statusTone(invoice.status)}>{invoice.status}</Badge>
          <label className="ml-auto flex items-center gap-2 text-xs text-ink-muted">
            Status
            <select
              value={["draft", "sent", "viewed", "void"].includes(invoice.status) ? invoice.status : "sent"}
              onChange={(e) =>
                void setStatus
                  .mutateAsync({ id: invoice.id, status: e.target.value as "draft" | "sent" | "viewed" | "void" })
                  .then(() => { onChanged(); void detail.refetch(); })
              }
              className={selectClass}
            >
              {["draft", "sent", "viewed", "void"].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        </div>

        <p className="text-sm">
          <span className="text-ink-faint">Customer:</span> {invoice.customerName ?? "—"}
          {invoice.customerEmail ? ` · ${invoice.customerEmail}` : ""}
        </p>

        <div className="overflow-x-auto">
          <Table>
            <THead><TR><TH>Line</TH><TH className="w-16">Qty</TH><TH className="w-24">Unit</TH><TH className="w-24">Total</TH></TR></THead>
            <TBody>
              {items.map((it) => (
                <TR key={it.id}>
                  <TD className="text-sm text-ink">{it.description}</TD>
                  <TD className="text-sm tabular-nums">{it.quantity}</TD>
                  <TD className="font-mono text-sm tabular-nums">{usd(it.unitPrice)}</TD>
                  <TD className="font-mono text-sm tabular-nums">{usd(it.total)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>

        <div className="ml-auto text-right text-sm">
          <p><span className="text-ink-faint">Total:</span> <span className="font-mono tabular-nums">{usd(invoice.total)}</span></p>
          <p><span className="text-ink-faint">Paid:</span> <span className="font-mono tabular-nums">{usd(invoice.amountPaid)}</span></p>
          <p className="text-base font-semibold"><span className="text-ink-faint">Balance:</span> <span className="font-mono tabular-nums">{usd(balance)}</span></p>
        </div>

        {payments.length > 0 ? (
          <div className="text-xs text-ink-muted">
            <p className="font-medium">Payments</p>
            {payments.map((p) => (
              <p key={p.id} className="font-mono tabular-nums">
                {usd(p.amount)} · {p.method} · {new Date(p.paidAt).toLocaleDateString()}
              </p>
            ))}
          </div>
        ) : null}

        <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
          <Input type="number" min="0" step="0.01" placeholder="Payment $" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-28" />
          <select value={method} onChange={(e) => setMethod(e.target.value)} className={selectClass}>
            {["card", "cash", "check", "ach", "other"].map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <Button variant="primary" disabled={pay.isPending} onClick={() => void record()}>Record payment</Button>
        </div>

        <p className="text-xs text-ink-faint">
          Customer link:{" "}
          <a href={tokenUrl} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">
            {tokenUrl}
          </a>
        </p>
      </CardBody>
    </Card>
  );
}
