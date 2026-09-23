"use client";

import { useParams } from "next/navigation";
import { api } from "@/trpc/client";
import {
  Badge,
  Card,
  CardBody,
  EmptyState,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/components/ui";

function usd(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

/**
 * A customer's own invoice, opened by its capability token — no account. The
 * token is the whole authorization; there is nothing here a stranger with a
 * different token could reach.
 */
export default function CustomerInvoicePage() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const detail = api.invoicing.byToken.useQuery({ token }, { enabled: Boolean(token) });

  return (
    <main className="mx-auto max-w-2xl px-6 py-14">
      {detail.isLoading ? (
        <p className="text-sm text-ink-muted">Loading your invoice…</p>
      ) : !detail.data ? (
        <EmptyState title="Invoice not found">
          This link may have expired or been mistyped. Contact us and we&rsquo;ll resend it.
        </EmptyState>
      ) : (
        <InvoiceBody
          invoice={detail.data.invoice}
          items={detail.data.items}
        />
      )}
    </main>
  );
}

function InvoiceBody({
  invoice,
  items,
}: {
  invoice: {
    invoiceNumber: string;
    status: string;
    customerName: string | null;
    total: number;
    amountPaid: number;
    dueDate: Date | string | null;
  };
  items: Array<{ id: string; description: string; quantity: number; unitPrice: number; total: number }>;
}) {
  const balance = Math.max(0, invoice.total - invoice.amountPaid);
  return (
    <>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <p className="font-mono text-[12px] uppercase tracking-[0.16em] text-accent">Invoice</p>
          <h1 className="mt-1 text-3xl tracking-tight text-ink" style={{ fontFamily: "var(--font-display)" }}>
            {invoice.invoiceNumber}
          </h1>
          {invoice.customerName ? <p className="mt-1 text-sm text-ink-muted">{invoice.customerName}</p> : null}
        </div>
        <Badge tone={invoice.status === "paid" ? "accent" : invoice.status === "partial" ? "warn" : "neutral"}>
          {invoice.status}
        </Badge>
      </div>

      <Card>
        <CardBody>
          <div className="overflow-x-auto">
            <Table>
              <THead><TR><TH>Description</TH><TH className="w-16">Qty</TH><TH className="w-24">Unit</TH><TH className="w-24">Total</TH></TR></THead>
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
          <div className="mt-4 ml-auto text-right text-sm">
            <p><span className="text-ink-faint">Total:</span> <span className="font-mono tabular-nums">{usd(invoice.total)}</span></p>
            <p><span className="text-ink-faint">Paid:</span> <span className="font-mono tabular-nums">{usd(invoice.amountPaid)}</span></p>
            <p className="text-lg font-semibold"><span className="text-ink-faint">Balance due:</span> <span className="font-mono tabular-nums">{usd(balance)}</span></p>
          </div>
        </CardBody>
      </Card>

      <p className="mt-4 text-center text-xs text-ink-faint">
        Questions about this invoice? Just reply to the email it came in.
      </p>
    </>
  );
}
