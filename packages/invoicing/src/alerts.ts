import { and, asc, eq, gt, gte, inArray, lt } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { z } from "zod";
import { endOfDayInZone, todayInZone } from "./business.js";
import type { InvoicingEvent } from "./events.js";
import { invoices } from "./schema.js";
import type { MoneyFormatWire } from "./wire.js";

/**
 * Alerts about invoices (Tenancy 2b-1, 11.2–11.3): a customer opened one, one
 * was paid in full, one went past its due date. Invoicing's fragment for the
 * project's alert registry, the mappers from its events (and from the overdue
 * sweep) to alert drafts, and the sweep itself.
 *
 * STRUCTURAL (2a D4, 2b-1 D3): nothing here imports @adminigloo/notifications.
 * The shapes are declared again in every package that produces alerts,
 * identical field for field (2b-1 section 3.2, 3.3), prefixed `Invoicing…` so
 * a generated file importing two packages never sees two `AlertDraft`s.
 * Invoicing writes the words because it knows the facts: a wording fix
 * reaches every project by npm, and the glue only connects.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PgDatabase<any, any, any>;

/** How a person hears about a kind of alert (2b-1 D5). */
export type InvoicingAlertChannel = "in_app" | "email";

/** One kind of alert (2b-1 section 3.2), structurally identical to notifications' `AlertKindSpec`. */
export interface InvoicingAlertKind {
  /** Permanent. /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$/, at most 64 characters. */
  readonly key: string;
  /** What a person sees in Alert settings, a plain phrase. */
  readonly label: string;
  readonly description?: string;
  /** The heading it is listed under. */
  readonly category: string;
  readonly audience: {
    /** Only active members holding this may receive it (D4). */
    readonly permission: string;
    /** The routing group whose chosen people get it (default: the owner). Absent: everyone holding `permission`. */
    readonly routing?: string;
    /** People assigned to the record who hold this also get it (crew). */
    readonly assigned?: { readonly permission: string };
  };
  /** For someone who never chose. */
  readonly defaultChannel: InvoicingAlertChannel;
  /** false: never emailed, and the choice isn't offered. Default true. */
  readonly email?: boolean;
  /** "producer": the package sends its own office email for it (D6). Default "notifications". */
  readonly emailBy?: "notifications" | "producer";
  /** Order inside its category. Default 100. */
  readonly order?: number;
}

/** A routing group (2b-1 section 3.2). */
export interface InvoicingAlertRouting {
  /** /^[a-z][a-z0-9-]{1,31}$/. Permanent (stored). */
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  /** Who may be chosen for it: members holding this. */
  readonly permission: string;
  readonly order?: number;
}

/** Invoicing's fragment for the project's alert registry. */
export interface InvoicingAlertKinds {
  readonly kinds: readonly InvoicingAlertKind[];
  readonly routings: readonly InvoicingAlertRouting[];
}

/** What a mapper returns and `alerts.notify` takes (2b-1 section 3.3). */
export interface InvoicingAlertDraft {
  readonly tenantId: string;
  /** A registered kind key. */
  readonly kind: string;
  /** One line, 1–200 characters, plain text: no CR, LF, U+2028 or U+2029 (it becomes an email Subject; D18). */
  readonly title: string;
  /** At most 2000 characters, plain text; null = none. */
  readonly body: string | null;
  /** A same-site path matching /^\/(?![\/\\])[^\\\s\u0000-\u001f]{0,499}$/; null = nothing to open. */
  readonly href: string | null;
  /** Where it opens for someone reached ONLY through `assigned`. Default `href`. */
  readonly assignedHref?: string | null;
  /** D7: from the durable fact; 1–200 characters. */
  readonly dedupeKey: string;
  /** What it is about. */
  readonly subject: { readonly type: string; readonly id: string } | null;
  /** Who caused it; never alerted about it. null for a customer or the system. */
  readonly actorUserId: string | null;
  /** For kinds with `audience.assigned`: who is on the record. */
  readonly assignedUserIds?: readonly string[];
  /** Where a reply to the email copy goes. */
  readonly replyTo?: string | null;
}

// --- The kinds ------------------------------------------------------------------

export const INVOICING_INVOICE_VIEWED_KIND = "invoicing.invoice.viewed";
export const INVOICING_INVOICE_PAID_KIND = "invoicing.invoice.paid";
export const INVOICING_INVOICE_OVERDUE_KIND = "invoicing.invoice.overdue";
/** The routing group's permanent key: "Invoices opened, paid or overdue". */
export const INVOICING_ROUTING = "invoices";
/**
 * invoicing 0.5: money Stripe took that didn't land cleanly on an invoice (a
 * mismatch, an unknown checkout, a cancelled invoice, an overpayment), a
 * refund, a dispute opened or lost, a bank payment that failed. To the people
 * who answer for the books (`invoices.payments.reverse`: owners and admins),
 * in the app AND by email, never routed elsewhere.
 */
export const INVOICING_CARD_PAYMENT_KIND = "invoicing.card-payment";

const audience = Object.freeze({ permission: "invoices.view", routing: INVOICING_ROUTING });

/**
 * Invoicing's alert fragment (11.3).
 *
 * All three are ROUTED through the "invoices" group (D4): with nothing saved
 * they go to the owner alone (at the business email for the email copy,
 * review BO-01), not to everyone who can see invoices — a crew lead with
 * `invoices.view` doesn't need a ping each time a customer opens a bill
 * (founder question 4: the owner by default). The owner adds people in Alert
 * settings.
 *
 * Opened and paid default to the app; overdue defaults to email: it is the one
 * that costs money if nobody acts on it, and it comes at most once per invoice
 * per due date.
 */
export const invoicingAlertKinds: InvoicingAlertKinds = Object.freeze({
  kinds: Object.freeze([
    Object.freeze({
      key: INVOICING_INVOICE_VIEWED_KIND,
      label: "A customer opens an invoice",
      description: "The first time a customer opens an invoice you sent them.",
      category: "Invoices",
      audience,
      defaultChannel: "in_app",
      order: 10,
    }) as InvoicingAlertKind,
    Object.freeze({
      key: INVOICING_INVOICE_PAID_KIND,
      label: "An invoice is paid in full",
      description: "When a payment you record pays off what was owed.",
      category: "Invoices",
      audience,
      defaultChannel: "in_app",
      order: 20,
    }) as InvoicingAlertKind,
    Object.freeze({
      key: INVOICING_INVOICE_OVERDUE_KIND,
      label: "An invoice goes overdue",
      description: "The day after an unpaid invoice's due date.",
      category: "Invoices",
      audience,
      defaultChannel: "email",
      order: 30,
    }) as InvoicingAlertKind,
    Object.freeze({
      key: INVOICING_CARD_PAYMENT_KIND,
      label: "A card payment needs you",
      description: "Money Stripe took that couldn't be recorded as it was, an overpayment, a refund, a dispute, or a bank payment that failed — with a link to it in Stripe.",
      category: "Invoices",
      audience: Object.freeze({ permission: "invoices.payments.reverse" }),
      defaultChannel: "email",
      order: 40,
    }) as InvoicingAlertKind,
  ]),
  routings: Object.freeze([
    Object.freeze({
      key: INVOICING_ROUTING,
      label: "Invoices opened, paid or overdue",
      description: "A customer opening an invoice, an invoice paid in full, and one going past its due date.",
      permission: "invoices.view",
      order: 30,
    }) as InvoicingAlertRouting,
  ]),
}) as InvoicingAlertKinds;

// --- Words ----------------------------------------------------------------------

/** 3.3's href rule (D18): a same-site path; no "//", no "/\", no backslash, whitespace or control character. */
const HREF_PATTERN = /^\/(?![\/\\])[^\\\s\u0000-\u001f]{0,499}$/;

/**
 * One line of plain text: CR, LF, U+2028, U+2029 and every other control
 * character become a space (a title becomes an email Subject, D18), runs of
 * space collapse, and it is cut to `max` characters with an ellipsis, by code
 * point. A customer typed their name; it is text, never a header.
 */
function oneLine(value: string, max: number): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
    out += control ? " " : char;
  }
  const cleaned = out.replace(/\s+/g, " ").trim();
  const chars = Array.from(cleaned);
  return chars.length <= max ? cleaned : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/** The customer's name as one short line, or null when there is none worth showing. */
function customerOf(name: string | null | undefined): string | null {
  const cleaned = typeof name === "string" ? oneLine(name, 80) : "";
  return cleaned === "" ? null : cleaned;
}

/** Cents in the business's currency and locale; a format the runtime can't use falls back to plain digits. */
export function formatAlertMoney(cents: number, format: Pick<MoneyFormatWire, "currency" | "locale">): string {
  try {
    return new Intl.NumberFormat(format.locale, { style: "currency", currency: format.currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${format.currency}`;
  }
}

/** A due date as the business reads it, in its zone: "Nov 2, 2026". */
function formatAlertDate(instant: Date, format: MoneyFormatWire): string {
  try {
    return new Intl.DateTimeFormat(format.locale, { timeZone: format.timeZone, dateStyle: "medium" }).format(instant);
  } catch {
    return instant.toISOString().slice(0, 10);
  }
}

/** The pattern with `{id}` URL-encoded; null unless it is a same-site path (D18). */
function hrefFor(pattern: string, id: string): string | null {
  const href = pattern.replace(/\{id\}/g, encodeURIComponent(id));
  return HREF_PATTERN.test(href) ? href : null;
}

/** The calendar date of `instant` in `timeZone`, "YYYY-MM-DD" (UTC for a zone the runtime can't use). */
function dateInZone(instant: Date, timeZone: string): string {
  try {
    return todayInZone(instant, timeZone);
  } catch {
    return instant.toISOString().slice(0, 10);
  }
}

// --- The mappers ----------------------------------------------------------------

/**
 * An invoicing event → its alert drafts (11.3's table).
 *
 *   invoice.viewed → "{Customer} opened invoice {number}", "{balance} due {date}"
 *   invoice.paid   → "Invoice {number} is paid: {total} from {customer}"
 *
 * DEDUPE KEYS (2b-1 D7) from the durable fact, never the delivery: a view
 * happens once per invoice (`viewed_at` is stamped once), so the key is the
 * invoice; a payment that settles it is keyed by WHEN it settled (`paid_at`),
 * so a reversal and a new full payment is a new alert, and the same event
 * handed over twice is one.
 *
 * `actorUserId`: nobody for a view (a customer did it); the staff member who
 * recorded the payment for `paid` — never alerted about their own entry.
 */
export function invoicingAlertsFor(
  event: InvoicingEvent,
  options: { readonly hrefs: { readonly invoice: string } },
): readonly InvoicingAlertDraft[] {
  const invoice = event.data.invoice;
  const format = event.data.format;
  const number = oneLine(invoice.number, 40) || "without a number";
  const customer = customerOf(invoice.customerName);
  const href = hrefFor(options.hrefs.invoice, event.invoiceId);
  const subject = { type: "invoicing.invoice", id: event.invoiceId } as const;
  switch (event.type) {
    case "invoice.viewed": {
      const balance = formatAlertMoney(invoice.balanceDue, format);
      const due = invoice.dueDate ? new Date(invoice.dueDate) : null;
      // CONTRACT: 11.3 writes "{Customer} opened invoice {number}"; with no
      // customer name on the invoice it reads "A customer opened …" rather
      // than starting with a blank.
      return [
        {
          tenantId: event.tenantId,
          kind: INVOICING_INVOICE_VIEWED_KIND,
          title: oneLine(`${customer ?? "A customer"} opened invoice ${number}`, 200),
          body: due && !Number.isNaN(due.getTime()) ? `${balance} due ${formatAlertDate(due, format)}` : `${balance} due`,
          href,
          dedupeKey: `${INVOICING_INVOICE_VIEWED_KIND}:${event.invoiceId}`,
          subject,
          actorUserId: event.actor.type === "staff" ? event.actor.id : null,
        },
      ];
    }
    case "invoice.paid": {
      const total = formatAlertMoney(invoice.total, format);
      // CONTRACT: "… from {customer}" is left off when the invoice names no
      // customer, rather than "from null" or "from a customer".
      return [
        {
          tenantId: event.tenantId,
          kind: INVOICING_INVOICE_PAID_KIND,
          title: oneLine(`Invoice ${number} is paid: ${total}${customer ? ` from ${customer}` : ""}`, 200),
          body: null,
          href,
          dedupeKey: `${INVOICING_INVOICE_PAID_KIND}:${event.invoiceId}:${invoice.paidAt ?? event.occurredAt}`,
          subject,
          actorUserId: event.actor.type === "staff" ? event.actor.id : null,
        },
      ];
    }
    default:
      return [];
  }
}

/**
 * An invoice the sweep found newly overdue → its alert (11.3).
 *
 *   "Invoice {number} to {customer} is overdue" · "{balance} was due {date}."
 *
 * Keyed by the invoice AND its due date in the business's zone (D7): the cron
 * that runs again, or runs twice a day, alerts once; an invoice whose due date
 * staff later move, and that lapses again, is a new fact and a new alert.
 * Nobody caused it (`actorUserId` null): it's the clock.
 */
export function invoicingOverdueAlert(
  tenantId: string,
  invoice: OverdueInvoice,
  options: { readonly hrefs: { readonly invoice: string }; readonly format: MoneyFormatWire },
): InvoicingAlertDraft {
  const number = oneLine(invoice.number, 40) || "without a number";
  const customer = customerOf(invoice.customerName);
  // CONTRACT: "to {customer}" is left off for an invoice with no customer name.
  return {
    tenantId,
    kind: INVOICING_INVOICE_OVERDUE_KIND,
    title: oneLine(`Invoice ${number}${customer ? ` to ${customer}` : ""} is overdue`, 200),
    body: `${formatAlertMoney(invoice.balanceDue, options.format)} was due ${formatAlertDate(invoice.dueDate, options.format)}.`,
    href: hrefFor(options.hrefs.invoice, invoice.id),
    dedupeKey: `${INVOICING_INVOICE_OVERDUE_KIND}:${invoice.id}:${dateInZone(invoice.dueDate, options.format.timeZone)}`,
    subject: { type: "invoicing.invoice", id: invoice.id },
    actorUserId: null,
  };
}

// --- The overdue sweep ------------------------------------------------------------

export interface OverdueInvoice {
  readonly id: string;
  readonly number: string;
  readonly customerName: string | null;
  /** Cents still owed. */
  readonly balanceDue: number;
  readonly dueDate: Date;
}

/** How many days back "newly" overdue reaches when the caller doesn't say (review BO-15). */
export const OVERDUE_SINCE_DAYS = 7;
const DEFAULT_OVERDUE_LIMIT = 200;
const MAX_OVERDUE_LIMIT = 1000;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `date` plus `days` calendar days, "YYYY-MM-DD". */
function addDays(date: string, days: number): string {
  const m = DATE_RE.exec(date);
  if (!m) throw new RangeError(`not a date: ${date}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days)).toISOString().slice(0, 10);
}

/** A zone the runtime can use, else UTC (a typo in a profile must not throw out of the cron). */
function usableZone(zone: string | undefined): string {
  if (typeof zone !== "string" || zone.trim() === "") return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(0);
    return zone;
  } catch {
    return "UTC";
  }
}

const overdueOptionsSchema = z.object({
  now: z.date().optional(),
  dueSince: z
    .string()
    .regex(DATE_RE, "Use a date like 2026-11-02.")
    .refine((v) => {
      const d = new Date(`${v}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
    }, "Use a real calendar date.")
    .optional(),
  timeZone: z.string().max(100).optional(),
  limit: z.number().int().min(1).max(MAX_OVERDUE_LIMIT).optional(),
});

/** The statuses an invoice can be overdue in: issued and not settled (a draft isn't out; paid and void are closed). */
const OPEN_STATUSES = ["sent", "viewed", "partial"] as const;

/**
 * sent / viewed / partial invoices whose due date has passed, and is on or
 * after `dueSince` (YYYY-MM-DD; default today − 7 days in the business's
 * zone, `timeZone`): "goes overdue" is an event, and older ones are the
 * invoice list's job, so the first cron after deploy doesn't email the owner
 * once per old invoice (review BO-15). Oldest due first. Default limit 200.
 * One query on invoices_tenant_idx.
 *
 * THE WINDOW, in the business's zone. A due date is stored as the last moment
 * of its day there (`endOfDayInZone`), so an invoice due on Nov 2 is overdue
 * from the first moment of Nov 3, and `dueSince` counts from the first moment
 * of its own day: due seven days ago is in, eight days ago is out. The cron
 * runs daily (or every 15 minutes) and the alert's key is the invoice and its
 * due date, so each invoice alerts once in its first week overdue whichever
 * run finds it.
 */
export async function listOverdueInvoices(
  db: Db,
  tenantId: string,
  options: { readonly now?: Date; readonly dueSince?: string; readonly timeZone?: string; readonly limit?: number } = {},
): Promise<readonly OverdueInvoice[]> {
  if (typeof tenantId !== "string" || tenantId.length === 0 || tenantId.length > 200) return [];
  const parsed = overdueOptionsSchema.parse(options);
  const now = parsed.now ?? new Date();
  const zone = usableZone(parsed.timeZone);
  const since = parsed.dueSince ?? addDays(todayInZone(now, zone), -OVERDUE_SINCE_DAYS);
  // The first moment of `since` in the zone: one millisecond after the end
  // of the day before.
  const from = new Date(endOfDayInZone(addDays(since, -1), zone).getTime() + 1);
  const rows = (await db
    .select({
      id: invoices.id,
      number: invoices.invoiceNumber,
      customerName: invoices.customerName,
      total: invoices.total,
      amountPaid: invoices.amountPaid,
      dueDate: invoices.dueDate,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.tenantId, tenantId),
        inArray(invoices.status, [...OPEN_STATUSES]),
        lt(invoices.dueDate, now),
        gte(invoices.dueDate, from),
        // CONTRACT: 11.2 names the statuses; an invoice in one of them with
        // nothing left to pay (a $0 bill, an overpaid legacy row) owes no
        // money, so it isn't "overdue" to anyone.
        gt(invoices.total, invoices.amountPaid),
      ),
    )
    .orderBy(asc(invoices.dueDate), asc(invoices.id))
    .limit(parsed.limit ?? DEFAULT_OVERDUE_LIMIT)) as Array<{
    id: string;
    number: string;
    customerName: string | null;
    total: number;
    amountPaid: number;
    dueDate: Date | null;
  }>;
  return rows
    .filter((r): r is typeof r & { dueDate: Date } => r.dueDate instanceof Date)
    .map((r) => ({
      id: r.id,
      number: r.number,
      customerName: r.customerName ?? null,
      balanceDue: Math.max(0, Number(r.total) - Number(r.amountPaid)),
      dueDate: r.dueDate,
    }));
}

// --- Card payments (0.5) ------------------------------------------------------------

/** The title each card-payment alert leads with, in plain words. */
const CARD_TITLES: Readonly<Record<string, (amount: string, invoice: string) => string>> = {
  unknown_checkout: (a) => `Stripe took ${a} that isn't on any invoice`,
  metadata_mismatch: (a, i) => `A card payment of ${a}${i} couldn't be recorded`,
  amount_mismatch: (a, i) => `A card payment of ${a}${i} didn't match what was asked`,
  currency_mismatch: (a, i) => `A card payment of ${a}${i} came in the wrong currency`,
  paid_on_void: (a, i) => `A customer paid ${a} on a cancelled invoice${i}`,
  overpaid: (a, i) => `An invoice${i} is overpaid by ${a}`,
  refunded: (a, i) => `${a} was refunded${i}`,
  dispute_opened: (a, i) => `A card payment of ${a}${i} is disputed`,
  dispute_lost: (a, i) => `A dispute was lost: ${a} came off${i ? i.replace(" on ", " ") : " an invoice"}`,
  bank_payment_failed: (a, i) => `A bank payment of ${a}${i} failed`,
};

/**
 * One card-payment problem (`CardAlert` from the webhook) as an alert for the
 * company's owners: what happened, the amount, and — in the body, since an
 * alert's link stays on this site — the payment in the company's Stripe
 * dashboard, to refund it or answer a dispute.
 */
export function invoicingCardAlert(
  alert: {
    readonly tenantId: string;
    readonly kind: string;
    readonly message: string;
    readonly amount: number | null;
    readonly currency: string | null;
    readonly invoiceId: string | null;
    readonly invoiceNumber: string | null;
    readonly stripeUrl: string | null;
    readonly dedupeKey: string;
  },
  options: { readonly hrefs: { readonly invoice: string }; readonly locale?: string },
): InvoicingAlertDraft {
  const amount = alert.amount === null ? "an amount" : formatAlertMoney(alert.amount, { currency: (alert.currency ?? "usd").toUpperCase(), locale: options.locale ?? "en-US" });
  const number = alert.invoiceNumber ? oneLine(alert.invoiceNumber, 40) : null;
  const title = (CARD_TITLES[alert.kind] ?? ((a: string) => `A card payment of ${a} needs you`))(amount, number ? ` on invoice ${number}` : "");
  const body = oneLine(`${alert.message}${alert.stripeUrl ? ` Open it in Stripe: ${alert.stripeUrl}` : ""}`, 1000);
  return {
    tenantId: alert.tenantId,
    kind: INVOICING_CARD_PAYMENT_KIND,
    title: oneLine(title, 200),
    body,
    href: alert.invoiceId ? hrefFor(options.hrefs.invoice, alert.invoiceId) : null,
    dedupeKey: `${INVOICING_CARD_PAYMENT_KIND}:${alert.dedupeKey}`,
    subject: alert.invoiceId ? { type: "invoicing.invoice", id: alert.invoiceId } : null,
    actorUserId: null,
  };
}
