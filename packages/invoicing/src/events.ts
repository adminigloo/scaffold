import { newId } from "@adminigloo/db";
import { and, eq } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { outstandingBalance } from "./money.js";
import { invoices } from "./schema.js";
import type { StoredInvoiceStatus } from "./status.js";
import type { MoneyFormatWire } from "./wire.js";

/**
 * Invoicing's events (Tenancy 2b-1, 11.1): a customer opened their invoice, an
 * invoice was paid in full — and, since 0.6, staff made an invoice
 * (`invoice.created`, for the customer list: @adminigloo/customers links the
 * invoice to its customer). One envelope, so the alerts glue (`invoicingAlertsFor`
 * → `alerts.notify`) — or a host's own Slack ping or webhook — reacts to one
 * stream instead of wrapping the handlers.
 *
 * THE GUARANTEES, scheduling's word for word (the alerts glue and any host
 * rely on them):
 *
 *   - AFTER COMMIT. The listener runs only once the write has committed, so a
 *     read inside it sees the new state, and a rolled-back write never tells
 *     anybody anything.
 *   - AWAITED. A serverless response must not end before the alert is
 *     written, so the listener is awaited before the handler answers.
 *   - CONTAINED. A throwing or rejecting listener never fails the action: the
 *     payment is recorded whether or not the alert went. The error goes to
 *     `onEventError(error, event)` if one is given.
 *   - NO SECRETS. No view token is ever in an event: `InvoiceEventSnapshot`
 *     has no field for one. Events are safe to log or queue.
 *   - NO EVENT FOR A NO-OP: a second view, a preview (the business's own
 *     link never reports a view), a draft, a part payment, a payment whose
 *     reference was already recorded.
 */

export type InvoicingEventType = "invoice.created" | "invoice.viewed" | "invoice.paid";

/** The invoice AFTER the change, as the event carries it. Money in cents. */
export interface InvoiceEventSnapshot {
  readonly id: string;
  readonly number: string;
  readonly status: StoredInvoiceStatus;
  readonly customerName: string | null;
  readonly customerEmail: string | null;
  /** 0.6: the phone on the invoice, as typed. */
  readonly customerPhone?: string | null;
  /** Cents. */
  readonly total: number;
  /** Cents. */
  readonly amountPaid: number;
  /** Cents: what is still owed (0 on a void invoice). */
  readonly balanceDue: number;
  readonly dueDate: string | null;
  readonly viewedAt: string | null;
  readonly paidAt: string | null;
}

export interface InvoicingEvent {
  /** uuidv7 (`newId()` from @adminigloo/db): unique per event. Use it as an idempotency key. */
  readonly id: string;
  readonly type: InvoicingEventType;
  readonly tenantId: string;
  readonly invoiceId: string;
  /** ISO instant: the action's `now`. */
  readonly occurredAt: string;
  /** "customer" for a view (the link has no account), "staff" for a recorded payment (the person `authorize` named). */
  readonly actor: { readonly type: "customer" | "staff"; readonly id: string | null };
  /**
   * 0.7, past records: staff entered this from the business's records, so
   * `occurredAt` is the day it really happened. It's history, not news: no
   * alert is raised for it, and the customer list files it on that day.
   */
  readonly enteredLater?: true;
  /** `format`: how to show this business's money and dates (its `business` seam, 2a 10.4). */
  readonly data: { readonly invoice: InvoiceEventSnapshot; readonly format: MoneyFormatWire };
}

export type InvoicingEventListener = (event: InvoicingEvent) => void | Promise<void>;

/** The handler factories' event options (both take the same pair). */
export interface InvoicingEventOptions {
  /** Told after commit, awaited before the response, contained (see the guarantees above). */
  readonly onEvent?: InvoicingEventListener;
  /** A throwing listener's error, with the event it was told. */
  readonly onEventError?: (error: unknown, event: InvoicingEvent) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PgDatabase<any, any, any>;

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

/**
 * Build the event from the committed row (tenant-scoped: an invoice of
 * another company is never read) and tell the listener, awaited and
 * contained. Answers once the listener settled.
 *
 * A failed READ of the row is reported through `report` (the handler's own
 * `onError`), never thrown: the action it would announce has already
 * committed, and the customer's answer must not turn into a 500 because an
 * alert couldn't be built. No listener → nothing is read at all.
 */
export async function emitInvoicingEvent(
  db: Db,
  spec: {
    readonly type: InvoicingEventType;
    readonly tenantId: string;
    readonly invoiceId: string;
    readonly actor: InvoicingEvent["actor"];
    readonly format: () => Promise<MoneyFormatWire>;
    readonly now: Date;
    /** 0.7: `now` is a past day staff entered from records. */
    readonly enteredLater?: boolean;
  },
  options: InvoicingEventOptions & { readonly report: (error: unknown) => void },
): Promise<void> {
  const listener = options.onEvent;
  if (!listener) return;
  let event: InvoicingEvent;
  try {
    const [row] = (await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, spec.invoiceId), eq(invoices.tenantId, spec.tenantId)))
      .limit(1)) as Array<typeof invoices.$inferSelect>;
    if (!row) return;
    event = {
      id: newId(),
      type: spec.type,
      tenantId: spec.tenantId,
      invoiceId: row.id,
      occurredAt: spec.now.toISOString(),
      actor: { type: spec.actor.type, id: spec.actor.id ?? null },
      ...(spec.enteredLater ? { enteredLater: true as const } : {}),
      data: {
        invoice: {
          id: row.id,
          number: row.invoiceNumber,
          status: row.status as StoredInvoiceStatus,
          customerName: row.customerName ?? null,
          customerEmail: row.customerEmail ?? null,
          customerPhone: row.customerPhone ?? null,
          total: Number(row.total),
          amountPaid: Number(row.amountPaid),
          balanceDue: outstandingBalance({ status: row.status, total: Number(row.total), amountPaid: Number(row.amountPaid) }),
          dueDate: iso(row.dueDate),
          viewedAt: iso(row.viewedAt),
          paidAt: iso(row.paidAt),
        },
        format: await spec.format(),
      },
    };
  } catch (error) {
    options.report(error);
    return;
  }
  try {
    await listener(event);
  } catch (error) {
    try {
      options.onEventError?.(error, event);
    } catch {
      /* a broken reporter must not fail the action it reports on */
    }
  }
}
