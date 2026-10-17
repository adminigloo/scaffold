import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import type { ResolvedInvoicingBusiness } from "./business.js";
import { CardPaymentUnavailableError, InvoiceNotEditableError, PaymentRefusedError, PaymentReversalError } from "./errors.js";
import { emitInvoicingEvent, type InvoicingEventOptions } from "./events.js";
import { formatCents, outstandingBalance } from "./money.js";
import { invoiceCardAlerts, invoiceCheckouts, invoicePayments, invoices } from "./schema.js";
import type { MoneyFormatWire } from "./wire.js";
import type { InvoicingDb, InvoiceRow } from "./index.js";
import { recordPayment, reversePayment } from "./index.js";

/**
 * PAY NOW (invoicing 0.5, getting paid part 1): a customer pays an invoice by
 * card (or bank) from its link, and the webhook records the money.
 *
 * THE RULE: every cent Stripe takes is either recorded on the right invoice
 * or reported to that company's owner with a link to the payment in Stripe.
 * Money is never silently dropped and never silently over-recorded.
 *
 *   - The amount is always the SERVER's: the deposit (or what is left of it)
 *     first, then the balance — less any bank payment already on its way. A
 *     customer chooses another amount only when the company allows part
 *     payments. Nothing below the card minimum for the currency is charged.
 *   - Every "Pay now" writes an `invoice_checkouts` row (amount, currency,
 *     Stripe's page, when it closes) under the INVOICE ROW LOCK: a second tab
 *     or a double click for the same stage and amount gets the same page.
 *   - Any staff edit of the invoice (lines, deposit, void) closes its open
 *     Sessions (`expireOpenCheckouts`), and every Session closes after an hour.
 *   - The webhook acts for the company the caller resolved from the Stripe
 *     account. It records a payment only for a checkout of that company, for
 *     that checkout's invoice, in exactly its amount and currency, keyed on
 *     the PaymentIntent (replays are recorded once).
 *   - Money that arrives on a stale checkout is recorded; if it overpays, the
 *     invoice shows the overpayment and the owner is told to refund it. Money
 *     on a VOID invoice is never recorded: the owner is told to refund it.
 *   - A refund (all or part) and a lost dispute are reversals; an opened
 *     dispute is a flag, a won one clears it. A failed bank payment releases
 *     its amount so the customer can pay again.
 *
 * Stripe-free: the Stripe calls are a seam (`InvoiceCardPayments`), and the
 * events are read structurally.
 */

// --- The seam ---------------------------------------------------------------

export type CardPaymentsReady = { readonly ready: true; readonly accountId: string | null } | { readonly ready: false };

export interface CardSessionInput {
  readonly tenantId: string;
  /** The company's connected account; null for a single business on its own Stripe keys. */
  readonly accountId: string | null;
  /** The `invoice_checkouts` row: the idempotency key and the metadata. */
  readonly checkoutId: string;
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  /** Minor units, decided here. */
  readonly amount: number;
  /** Lower-case ISO 4217. */
  readonly currency: string;
  /** "Deposit on invoice INV-2026-0042 from Green Acres". */
  readonly description: string;
  readonly customerEmail: string | null;
  readonly successUrl: string;
  readonly cancelUrl: string;
  /** Seconds since the epoch: Stripe closes the Session then (an hour from now). */
  readonly expiresAt: number;
}

export interface InvoiceCardPayments {
  /** Can this company take a card payment right now (Stripe connected, charges on)? */
  ready(tenantId: string): Promise<CardPaymentsReady>;
  /** Open a Checkout Session for exactly `amount`, with `checkoutId`, `invoiceId` and the company in its metadata. */
  createSession(input: CardSessionInput): Promise<{ readonly id: string; readonly url: string }>;
  /** Close an open Session (a newer one replaced it, the invoice changed, or the company disconnected). */
  expireSession(input: { readonly tenantId: string; readonly accountId: string | null; readonly sessionId: string }): Promise<void>;
}

/** The metadata keys a Session and its PaymentIntent carry. */
export const CARD_METADATA = { checkout: "checkoutId", invoice: "invoiceId", tenant: "tenantId" } as const;

/** How long a Session stays open: an hour (Stripe's minimum is 30 minutes). */
export const CHECKOUT_LIFETIME_MS = 60 * 60 * 1000;
/** A Session closer than this to closing is not handed to a second tab. */
const REUSE_MARGIN_MS = 5 * 60 * 1000;

/**
 * The smallest amount Stripe charges, per currency, in minor units (Stripe's
 * published minimums; ¥50 is 50 because yen has no minor unit). Anything not
 * listed uses 50.
 */
export const CARD_MINIMUMS: Readonly<Record<string, number>> = Object.freeze({
  usd: 50, eur: 50, gbp: 30, cad: 50, aud: 50, nzd: 50, chf: 50, sgd: 50, jpy: 50,
  hkd: 400, mxn: 1000, sek: 300, nok: 300, dkk: 250, pln: 200, brl: 50, inr: 50, czk: 1500, huf: 17500,
});

export function cardMinimum(currency: string): number {
  return CARD_MINIMUMS[currency.toLowerCase()] ?? 50;
}

/** The Stripe dashboard's page for a payment (works for a Standard account's own dashboard). */
export function stripePaymentUrl(paymentIntentId: string | null): string | null {
  return paymentIntentId ? `https://dashboard.stripe.com/payments/${encodeURIComponent(paymentIntentId)}` : null;
}

// --- The deposit --------------------------------------------------------------

export type DepositRule =
  | { readonly rule: "default" }
  | { readonly rule: "none" }
  | { readonly rule: "percent"; readonly percentBp: number }
  | { readonly rule: "amount"; readonly amount: number };

/** The invoice's own deposit choice, from its two columns. */
export function depositRuleOf(invoice: Pick<InvoiceRow, "depositBp" | "depositAmount">): DepositRule {
  if (invoice.depositAmount !== null && invoice.depositAmount !== undefined && invoice.depositAmount > 0) {
    return { rule: "amount", amount: invoice.depositAmount };
  }
  if (invoice.depositBp === 0) return { rule: "none" };
  if (invoice.depositBp !== null && invoice.depositBp !== undefined && invoice.depositBp > 0) return { rule: "percent", percentBp: invoice.depositBp };
  return { rule: "default" };
}

/**
 * What the deposit comes to, in minor units. A percent is of the invoice's
 * TOTAL, rounded to the NEAREST cent (a half cent rounds up), in integer
 * arithmetic: 30% of $1,234.57 is $370.37. A fixed deposit is capped at the
 * total. With `minimum` (the currency's card minimum), the deposit is never
 * below it and never leaves less than it to pay after — it then grows to the
 * whole total. The rest is always total − deposit, so deposit then balance
 * comes to the total exactly.
 */
export function depositDue(total: number, rule: DepositRule, defaultPercent: number, minimum = 0): number {
  if (!Number.isSafeInteger(total) || total <= 0) return 0;
  let deposit: number;
  if (rule.rule === "amount") deposit = Math.min(rule.amount, total);
  else {
    const bp = rule.rule === "percent" ? rule.percentBp : rule.rule === "default" ? Math.round(defaultPercent) * 100 : 0;
    deposit = bp <= 0 ? 0 : Math.min(total, Math.floor((total * Math.min(bp, 10_000) + 5_000) / 10_000));
  }
  if (deposit <= 0) return 0;
  if (deposit < minimum) deposit = Math.min(minimum, total);
  if (total - deposit > 0 && total - deposit < minimum) deposit = total;
  return deposit;
}

/**
 * The deposit this invoice asks NOW. The company's default applies only
 * before any money is on the invoice: once something is paid the stage has
 * passed, so raising the default later never reopens it (an online deposit
 * pins the deposit onto the invoice when it is recorded).
 */
export function invoiceDeposit(
  invoice: Pick<InvoiceRow, "total" | "amountPaid" | "depositBp" | "depositAmount">,
  business: Pick<ResolvedInvoicingBusiness, "depositPercent" | "currency">,
): number {
  const rule = depositRuleOf(invoice);
  if (rule.rule === "default" && invoice.amountPaid > 0) return 0;
  return depositDue(invoice.total, rule, business.depositPercent, cardMinimum(business.currency));
}

export interface PayOption {
  readonly stage: "deposit" | "balance";
  readonly amount: number;
  readonly depositAmount: number;
  readonly allowPartial: boolean;
  readonly minimum: number;
  readonly maximum: number;
  /** What is due is below the card minimum: the customer is asked to contact the business. */
  readonly belowMinimum: boolean;
}

/**
 * What "Pay now" would charge on this invoice, or null when nothing can be
 * paid online (a draft, a void or paid invoice, nothing owed beyond what is
 * already on its way). Pure: the page shows it and the checkout charges it.
 */
export function onlinePaymentOption(
  invoice: Pick<InvoiceRow, "status" | "total" | "amountPaid" | "depositBp" | "depositAmount">,
  business: Pick<ResolvedInvoicingBusiness, "depositPercent" | "allowPartialPayments" | "currency">,
  pending = 0,
): PayOption | null {
  if (invoice.status === "draft" || invoice.status === "void" || invoice.status === "paid") return null;
  const balance = outstandingBalance(invoice) - Math.max(0, pending);
  if (balance <= 0) return null;
  const minimum = cardMinimum(business.currency);
  const deposit = invoiceDeposit(invoice, business);
  const depositLeft = Math.max(0, deposit - invoice.amountPaid - Math.max(0, pending));
  const stage = depositLeft > 0 ? "deposit" : "balance";
  const amount = stage === "deposit" ? Math.min(depositLeft, balance) : balance;
  return {
    stage,
    amount,
    depositAmount: deposit,
    allowPartial: business.allowPartialPayments && balance >= minimum,
    minimum,
    maximum: balance,
    belowMinimum: amount < minimum,
  };
}

/** Bank payments on their way for an invoice: their sum and when the first started. */
export async function pendingCardPayments(db: InvoicingDb, tenantId: string, invoiceId: string): Promise<{ amount: number; startedAt: Date } | null> {
  const rows = (await db
    .select({ amount: invoiceCheckouts.amount, at: invoiceCheckouts.processingAt })
    .from(invoiceCheckouts)
    .where(and(eq(invoiceCheckouts.tenantId, tenantId), eq(invoiceCheckouts.invoiceId, invoiceId), eq(invoiceCheckouts.status, "processing")))
    .orderBy(asc(invoiceCheckouts.processingAt))) as Array<{ amount: number; at: Date | null }>;
  if (rows.length === 0) return null;
  let amount = 0;
  for (const r of rows) amount += Number(r.amount);
  return { amount, startedAt: rows[0]!.at ?? new Date() };
}

/** Change an invoice's deposit while nothing has been paid on it. Null: not this company's invoice. */
export async function setInvoiceDeposit(db: InvoicingDb, tenantId: string, invoiceId: string, rule: DepositRule): Promise<boolean | null> {
  return db.transaction(async (tx) => {
    const [inv] = (await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId)))
      .limit(1)
      .for("update")) as InvoiceRow[];
    if (!inv) return null;
    if (inv.status === "void" || inv.status === "paid" || inv.amountPaid > 0) throw new InvoiceNotEditableError(inv.status);
    const columns =
      rule.rule === "default"
        ? { depositBp: null, depositAmount: null }
        : rule.rule === "none"
          ? { depositBp: 0, depositAmount: null }
          : rule.rule === "percent"
            ? { depositBp: rule.percentBp, depositAmount: null }
            : { depositBp: null, depositAmount: rule.amount };
    await tx.update(invoices).set({ ...columns, updatedAt: new Date() }).where(eq(invoices.id, inv.id));
    return true;
  });
}

// --- Starting a payment -----------------------------------------------------------

export interface StartInvoiceCheckoutInput {
  /** The company whose web address the customer is on. */
  readonly tenantId: string;
  readonly token: string;
  /** An amount the customer chose; read only when the business allows part payments. */
  readonly requestedAmount?: number;
  readonly business: ResolvedInvoicingBusiness;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly report?: (error: unknown) => void;
  readonly now?: Date;
}

/**
 * The customer pressed "Pay now". Null when the token isn't an invoice of
 * this company (or is a draft): the caller answers "not available". Throws
 * CardPaymentUnavailableError when nothing can be paid online right now.
 */
export async function startInvoiceCheckout(
  db: InvoicingDb,
  payments: InvoiceCardPayments,
  input: StartInvoiceCheckoutInput,
): Promise<{ url: string; checkoutId: string; reused: boolean } | null> {
  const now = input.now ?? new Date();
  const name = input.business.name || "this business";
  const started = await db.transaction(async (tx) => {
    // THE INVOICE ROW LOCK: two tabs (or a double click) serialize here, and
    // the second finds the first's open Session below.
    const [inv] = (await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.viewToken, input.token), eq(invoices.tenantId, input.tenantId)))
      .limit(1)
      .for("update")) as InvoiceRow[];
    if (!inv || inv.status === "draft") return null;
    const pending = await pendingCardPayments(tx, input.tenantId, inv.id);
    const option = onlinePaymentOption(inv, input.business, pending?.amount ?? 0);
    if (!option) {
      throw new CardPaymentUnavailableError(
        inv.status === "void"
          ? "This invoice was cancelled, so it can't be paid."
          : pending
            ? "A bank payment for what's left is already on its way."
            : "There's nothing left to pay on this invoice.",
      );
    }
    if (option.belowMinimum) throw new CardPaymentUnavailableError(`Please contact ${name} to pay this small amount.`);
    const ready = await payments.ready(input.tenantId);
    if (!ready.ready) throw new CardPaymentUnavailableError(`${input.business.name || "This business"} isn't taking card payments online right now. See "How to pay" below.`);
    let amount = option.amount;
    let purpose: "deposit" | "balance" | "part" = option.stage;
    if (option.allowPartial && input.requestedAmount !== undefined && input.requestedAmount !== option.amount) {
      const requested = input.requestedAmount;
      const left = option.maximum - requested;
      if (!Number.isSafeInteger(requested) || requested < option.minimum || requested > option.maximum || (left > 0 && left < option.minimum)) {
        const fmt = (cents: number) => formatCents(cents, input.business.currency, input.business.locale);
        throw new CardPaymentUnavailableError(
          `Choose an amount from ${fmt(option.minimum)} to ${fmt(option.maximum)}, leaving nothing or at least ${fmt(option.minimum)} to pay later.`,
        );
      }
      purpose = "part";
      amount = requested;
    }
    const currency = input.business.currency.toLowerCase();
    // The same stage and amount, still open for a while: the SAME page.
    const [open] = (await tx
      .select({ id: invoiceCheckouts.id, url: invoiceCheckouts.sessionUrl })
      .from(invoiceCheckouts)
      .where(
        and(
          eq(invoiceCheckouts.tenantId, input.tenantId),
          eq(invoiceCheckouts.invoiceId, inv.id),
          eq(invoiceCheckouts.status, "open"),
          eq(invoiceCheckouts.purpose, purpose),
          eq(invoiceCheckouts.amount, amount),
          eq(invoiceCheckouts.currency, currency),
          gt(invoiceCheckouts.expiresAt, new Date(now.getTime() + REUSE_MARGIN_MS)),
        ),
      )
      .limit(1)) as Array<{ id: string; url: string | null }>;
    if (open?.url) return { url: open.url, checkoutId: open.id, reused: true, invoiceId: inv.id };

    const expiresAt = new Date(now.getTime() + CHECKOUT_LIFETIME_MS);
    const [row] = (await tx
      .insert(invoiceCheckouts)
      .values({ tenantId: input.tenantId, invoiceId: inv.id, accountId: ready.accountId, purpose, amount, currency, status: "creating", expiresAt })
      .returning({ id: invoiceCheckouts.id })) as Array<{ id: string }>;
    const checkoutId = row!.id;
    const label = purpose === "deposit" ? "Deposit on invoice" : purpose === "part" ? "Payment on invoice" : "Invoice";
    // A throw here rolls the row back with the lock: nothing half-made stays.
    const session = await payments.createSession({
      tenantId: input.tenantId,
      accountId: ready.accountId,
      checkoutId,
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      amount,
      currency,
      description: `${label} ${inv.invoiceNumber}${input.business.name ? ` from ${input.business.name}` : ""}`,
      customerEmail: inv.customerEmail ?? null,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      expiresAt: Math.floor(expiresAt.getTime() / 1000),
    });
    await tx
      .update(invoiceCheckouts)
      .set({ sessionId: session.id, sessionUrl: session.url, status: "open", updatedAt: now })
      .where(eq(invoiceCheckouts.id, checkoutId));
    return { url: session.url, checkoutId, reused: false, invoiceId: inv.id };
  });
  if (!started) return null;
  // One open Session per invoice: an older one (another stage or amount) is
  // closed after commit, so it can't be paid on top of this one.
  if (!started.reused) await expireOpenCheckouts(db, payments, input.tenantId, started.invoiceId, { except: started.checkoutId, report: input.report });
  return { url: started.url, checkoutId: started.checkoutId, reused: started.reused };
}

/**
 * Close the open Sessions on an invoice — THE one helper every edit path
 * calls (a line added, changed or removed, the deposit changed, the invoice
 * voided) and that a newer Session uses to replace an older one. Failures
 * are reported, never thrown: the edit stands.
 */
export async function expireOpenCheckouts(
  db: InvoicingDb,
  payments: InvoiceCardPayments,
  tenantId: string,
  invoiceId: string | null,
  options: { readonly except?: string; readonly report?: (error: unknown) => void } = {},
): Promise<number> {
  const open = (await db
    .select({ id: invoiceCheckouts.id, sessionId: invoiceCheckouts.sessionId, accountId: invoiceCheckouts.accountId })
    .from(invoiceCheckouts)
    .where(
      and(
        eq(invoiceCheckouts.tenantId, tenantId),
        invoiceId === null ? undefined : eq(invoiceCheckouts.invoiceId, invoiceId),
        inArray(invoiceCheckouts.status, ["open", "creating"]),
        options.except ? ne(invoiceCheckouts.id, options.except) : undefined,
      ),
    )) as Array<{ id: string; sessionId: string | null; accountId: string | null }>;
  let closed = 0;
  for (const row of open) {
    try {
      if (row.sessionId) await payments.expireSession({ tenantId, accountId: row.accountId, sessionId: row.sessionId });
      await db.update(invoiceCheckouts).set({ status: "expired", updatedAt: new Date() }).where(eq(invoiceCheckouts.id, row.id));
      closed += 1;
    } catch (error) {
      options.report?.(error);
    }
  }
  return closed;
}

/** Every open Session of a company (it disconnected Stripe). */
export function expireCompanyCheckouts(db: InvoicingDb, payments: InvoiceCardPayments, tenantId: string, report?: (error: unknown) => void): Promise<number> {
  return expireOpenCheckouts(db, payments, tenantId, null, { report });
}

// --- The webhook ------------------------------------------------------------------

/** The account events this records, for the Stripe endpoint's event list. */
export const INVOICE_CARD_EVENT_TYPES = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "payment_intent.succeeded",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
] as const;

/** Every case where money moved and didn't land cleanly on an invoice — each one goes to the company's owners. */
export type CardAlertKind =
  | "unknown_checkout"
  | "metadata_mismatch"
  | "amount_mismatch"
  | "currency_mismatch"
  | "paid_on_void"
  | "overpaid"
  | "refunded"
  | "dispute_opened"
  | "dispute_lost"
  | "bank_payment_failed";

export interface CardAlert {
  readonly tenantId: string;
  readonly kind: CardAlertKind;
  /** Plain words for the owner: what happened, the amount, and what to do. */
  readonly message: string;
  /** Minor units and the currency they're in, when known. */
  readonly amount: number | null;
  readonly currency: string | null;
  readonly invoiceId: string | null;
  readonly invoiceNumber: string | null;
  readonly paymentIntentId: string | null;
  /** The payment in the company's Stripe dashboard (refund it, answer a dispute). */
  readonly stripeUrl: string | null;
  /** One alert per thing that happened, however often Stripe repeats it. */
  readonly dedupeKey: string;
}

export type CardEventOutcome =
  | { readonly outcome: "recorded"; readonly invoiceId: string; readonly paymentId: string; readonly status: string; readonly overpayment: number }
  | { readonly outcome: "duplicate"; readonly invoiceId: string }
  | { readonly outcome: "reversed"; readonly invoiceId: string; readonly paymentId: string; readonly amount: number }
  | { readonly outcome: "flagged"; readonly invoiceId: string; readonly paymentId: string; readonly flag: "disputed" | null }
  | { readonly outcome: "expired" }
  | { readonly outcome: "pending" }
  | { readonly outcome: "released" }
  | { readonly outcome: "ignored"; readonly why: string }
  | { readonly outcome: "refused"; readonly reason: CardAlertKind; readonly message: string };

export interface CardEventOptions extends InvoicingEventOptions {
  /** Money that needs the owner: the bell and email (the app's alerts), and the error log. */
  readonly onAlert?: (alert: CardAlert) => void | Promise<void>;
  /** How to show the company's money, for the `invoice.paid` event. */
  readonly format?: (tenantId: string) => Promise<MoneyFormatWire>;
  readonly report?: (error: unknown) => void;
  readonly now?: Date;
}

/** A Stripe event as this module reads it: structural, so invoicing never imports Stripe. */
export interface CardEventLike {
  readonly id?: string;
  readonly type: string;
  readonly data: { readonly object: unknown };
}

type Meta = Readonly<Record<string, string | undefined>>;
const idOf = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string" ? (value as { id: string }).id : null;
const metaOf = (object: Record<string, unknown>): Meta =>
  object.metadata && typeof object.metadata === "object" ? (object.metadata as Meta) : {};
const num = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) ? value : null);
const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

function money(cents: number | null, currency: string | null): string {
  if (cents === null) return "an unknown amount";
  try {
    return formatCents(cents, (currency ?? "usd").toUpperCase());
  } catch {
    return `${cents} (${currency ?? "?"})`;
  }
}

/**
 * One event, for the company `tenantId` — WHICH THE CALLER RESOLVED FROM THE
 * STRIPE ACCOUNT the event was signed for (stripe's `companyForConnectEvent`),
 * never from the event's metadata. Throws only for a failure worth a retry
 * (the database); a refusal is an outcome, alerted, and answered 200.
 */
export async function handleInvoiceCardEvent(db: InvoicingDb, tenantId: string, event: CardEventLike, options: CardEventOptions = {}): Promise<CardEventOutcome> {
  const object = (event.data.object ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return recordCardPayment(
        db,
        tenantId,
        {
          sessionId: idOf(object.id),
          paymentIntentId: idOf(object.payment_intent),
          amount: num(object.amount_total),
          currency: text(object.currency),
          paid: object.payment_status === "paid",
          metadata: metaOf(object),
        },
        options,
      );
    case "checkout.session.async_payment_failed":
      return bankPaymentFailed(db, tenantId, object, options);
    case "payment_intent.succeeded":
      return recordCardPayment(
        db,
        tenantId,
        {
          sessionId: null,
          paymentIntentId: idOf(object.id),
          amount: num(object.amount_received) ?? num(object.amount),
          currency: text(object.currency),
          paid: true,
          metadata: metaOf(object),
        },
        options,
      );
    case "checkout.session.expired": {
      const sessionId = idOf(object.id);
      if (!sessionId) return { outcome: "ignored", why: "no session id" };
      await db
        .update(invoiceCheckouts)
        .set({ status: "expired", updatedAt: new Date() })
        .where(and(eq(invoiceCheckouts.tenantId, tenantId), eq(invoiceCheckouts.sessionId, sessionId), inArray(invoiceCheckouts.status, ["open", "creating"])));
      return { outcome: "expired" };
    }
    case "charge.refunded":
      return recordCardRefund(db, tenantId, { paymentIntentId: idOf(object.payment_intent), amountRefunded: num(object.amount_refunded) ?? 0, currency: text(object.currency) }, options);
    case "charge.dispute.created":
      return disputeOpened(db, tenantId, { paymentIntentId: idOf(object.payment_intent), amount: num(object.amount), currency: text(object.currency) }, options);
    case "charge.dispute.closed":
      return disputeClosed(
        db,
        tenantId,
        { paymentIntentId: idOf(object.payment_intent), amount: num(object.amount), currency: text(object.currency), status: text(object.status) },
        options,
      );
    default:
      return { outcome: "ignored", why: `not an invoice event (${event.type})` };
  }
}

export interface CardPaymentReport {
  readonly sessionId: string | null;
  readonly paymentIntentId: string | null;
  readonly amount: number | null;
  readonly currency: string | null;
  /** The money has cleared (a card), as opposed to a bank payment still on its way. */
  readonly paid: boolean;
  readonly metadata: Meta;
}

/**
 * Every card problem is STORED for the company (`invoice_card_alerts`, its
 * owner's "Needs your attention" list) — with or without the app's alerts —
 * and only a NEW one is handed to `onAlert` (the bell and the email), so a
 * repeated event never alerts twice.
 */
async function alert(db: InvoicingDb, options: CardEventOptions, value: Omit<CardAlert, "stripeUrl">): Promise<void> {
  const inserted = (await db
    .insert(invoiceCardAlerts)
    .values({
      tenantId: value.tenantId,
      kind: value.kind,
      message: value.message,
      amount: value.amount,
      currency: value.currency,
      invoiceId: value.invoiceId,
      paymentIntentId: value.paymentIntentId,
      dedupeKey: value.dedupeKey,
    })
    .onConflictDoNothing()
    .returning({ id: invoiceCardAlerts.id })) as Array<{ id: string }>;
  if (inserted.length === 0) return;
  try {
    await options.onAlert?.({ ...value, stripeUrl: stripePaymentUrl(value.paymentIntentId) });
  } catch (error) {
    options.report?.(error);
  }
}

export type CardAlertRow = typeof invoiceCardAlerts.$inferSelect;

/** The company's card problems: the open ones first (newest first), then up to `handled` handled ones. */
export async function listCardAlerts(db: InvoicingDb, tenantId: string, options: { readonly handled?: number } = {}): Promise<{ open: CardAlertRow[]; handled: CardAlertRow[] }> {
  const open = (await db
    .select()
    .from(invoiceCardAlerts)
    .where(and(eq(invoiceCardAlerts.tenantId, tenantId), isNull(invoiceCardAlerts.resolvedAt)))
    .orderBy(desc(invoiceCardAlerts.createdAt))
    .limit(200)) as CardAlertRow[];
  const handled = (await db
    .select()
    .from(invoiceCardAlerts)
    .where(and(eq(invoiceCardAlerts.tenantId, tenantId), isNotNull(invoiceCardAlerts.resolvedAt)))
    .orderBy(desc(invoiceCardAlerts.resolvedAt))
    .limit(options.handled ?? 10)) as CardAlertRow[];
  return { open, handled };
}

/** How many card problems the company hasn't handled yet (the nav's badge). */
export async function openCardAlertCount(db: InvoicingDb, tenantId: string): Promise<number> {
  const [row] = (await db
    .select({ n: count() })
    .from(invoiceCardAlerts)
    .where(and(eq(invoiceCardAlerts.tenantId, tenantId), isNull(invoiceCardAlerts.resolvedAt)))) as Array<{ n: number }>;
  return Number(row?.n ?? 0);
}

/** "Mark as handled": null when it isn't this company's. Marking one already handled is a no-op. */
export async function resolveCardAlert(db: InvoicingDb, tenantId: string, id: string, userId: string | null, now: Date = new Date()): Promise<CardAlertRow | null> {
  await db
    .update(invoiceCardAlerts)
    .set({ resolvedAt: now, resolvedBy: userId })
    .where(and(eq(invoiceCardAlerts.id, id), eq(invoiceCardAlerts.tenantId, tenantId), isNull(invoiceCardAlerts.resolvedAt)));
  const [row] = (await db
    .select()
    .from(invoiceCardAlerts)
    .where(and(eq(invoiceCardAlerts.id, id), eq(invoiceCardAlerts.tenantId, tenantId)))
    .limit(1)) as CardAlertRow[];
  return row ?? null;
}

async function invoiceNumberOf(db: InvoicingDb, tenantId: string, invoiceId: string | null): Promise<string | null> {
  if (!invoiceId) return null;
  const [row] = (await db
    .select({ n: invoices.invoiceNumber })
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId)))
    .limit(1)) as Array<{ n: string }>;
  return row?.n ?? null;
}

/** Record a payment the webhook reported, if — and only if — every check below holds. */
export async function recordCardPayment(db: InvoicingDb, tenantId: string, report: CardPaymentReport, options: CardEventOptions = {}): Promise<CardEventOutcome> {
  const checkoutId = report.metadata[CARD_METADATA.checkout];
  const claimedInvoice = report.metadata[CARD_METADATA.invoice];
  // Not an invoice payment at all (no checkout of ours named): somebody
  // else's use of the account. Nothing to record, nothing to alarm about.
  if (!checkoutId && !claimedInvoice) return { outcome: "ignored", why: "not an invoice payment" };
  const pi = report.paymentIntentId;
  const refuse = async (reason: CardAlertKind, message: string, invoiceId: string | null): Promise<CardEventOutcome> => {
    await alert(db, options, {
      tenantId,
      kind: reason,
      message,
      amount: report.amount,
      currency: report.currency,
      invoiceId,
      invoiceNumber: await invoiceNumberOf(db, tenantId, invoiceId),
      paymentIntentId: pi,
      dedupeKey: `${reason}:${pi ?? report.sessionId ?? checkoutId ?? "unknown"}`,
    });
    return { outcome: "refused", reason, message };
  };
  const taken = money(report.amount, report.currency);

  // 1. The checkout row, IN THIS COMPANY. A Session another company opened —
  //    or metadata naming another company's invoice — finds nothing here.
  const [row] = checkoutId
    ? ((await db
        .select()
        .from(invoiceCheckouts)
        .where(and(eq(invoiceCheckouts.id, checkoutId), eq(invoiceCheckouts.tenantId, tenantId)))
        .limit(1)) as Array<typeof invoiceCheckouts.$inferSelect>)
    : [];
  if (!row) return refuse("unknown_checkout", `Stripe took ${taken} for a payment no invoice of yours started. It was not recorded: check it in Stripe and refund it if it isn't yours.`, null);

  // 2. Everything the event says must agree with the row.
  const claimedTenant = report.metadata[CARD_METADATA.tenant];
  if (
    claimedInvoice !== row.invoiceId ||
    (claimedTenant !== undefined && claimedTenant !== tenantId) ||
    (report.sessionId !== null && row.sessionId !== null && report.sessionId !== row.sessionId)
  ) {
    return refuse("metadata_mismatch", `Stripe took ${taken} with details that don't match the invoice it names. It was not recorded: check it in Stripe.`, row.invoiceId);
  }
  if (report.amount === null || report.amount !== row.amount) {
    return refuse("amount_mismatch", `Stripe took ${taken} where ${money(row.amount, row.currency)} was asked. It was not recorded: check it in Stripe and refund it or record it yourself.`, row.invoiceId);
  }
  if (!report.currency || report.currency.toLowerCase() !== row.currency.toLowerCase()) {
    return refuse("currency_mismatch", `Stripe took ${taken} where ${money(row.amount, row.currency)} was asked. It was not recorded: check it in Stripe.`, row.invoiceId);
  }
  // 3. A bank payment on its way: hold its amount (the page offers only the
  //    rest) until it clears or fails.
  if (!report.paid) {
    if (row.status === "open" || row.status === "creating" || row.status === "expired") {
      await db
        .update(invoiceCheckouts)
        .set({ status: "processing", processingAt: options.now ?? new Date(), paymentIntentId: pi, updatedAt: new Date() })
        .where(eq(invoiceCheckouts.id, row.id));
    }
    return { outcome: "pending" };
  }
  if (!pi) return refuse("metadata_mismatch", `Stripe took ${taken} with no payment reference. It was not recorded: check it in Stripe.`, row.invoiceId);

  // 4. Record it, keyed on the PaymentIntent: once, however often it arrives.
  //    Even on an invoice settled meanwhile (a stale page): the money moved.
  let recorded;
  try {
    recorded = await recordPayment(
      db,
      {
        tenantId,
        invoiceId: row.invoiceId,
        amount: report.amount,
        method: "card",
        reference: row.purpose === "deposit" ? "Deposit, paid online" : "Paid online",
        externalRef: pi,
      },
      undefined,
      { allowOverpayment: true },
    );
  } catch (error) {
    if (error instanceof PaymentRefusedError && error.reason === "void") {
      await db.update(invoiceCheckouts).set({ status: "failed", paymentIntentId: pi, updatedAt: new Date() }).where(eq(invoiceCheckouts.id, row.id));
      return refuse("paid_on_void", `A customer paid ${taken} on an invoice you cancelled. It was not recorded: refund it in Stripe.`, row.invoiceId);
    }
    throw error;
  }
  if (!recorded) return refuse("unknown_checkout", `Stripe took ${taken} for an invoice you don't have. It was not recorded: refund it in Stripe.`, row.invoiceId);
  await db.update(invoiceCheckouts).set({ status: "paid", paymentIntentId: pi, updatedAt: new Date() }).where(eq(invoiceCheckouts.id, row.id));
  if (recorded.duplicate) return { outcome: "duplicate", invoiceId: row.invoiceId };

  // The company's default deposit is pinned on the invoice by its first
  // online payment, so changing the default later never reopens the stage.
  await pinDefaultDeposit(db, tenantId, row.invoiceId, row.purpose === "deposit" ? report.amount : null);

  if (recorded.overpayment > 0) {
    await alert(db, options, {
      tenantId,
      kind: "overpaid",
      message: `A customer paid ${taken} by card, which overpays the invoice by ${money(recorded.overpayment, row.currency)} (it changed after they opened the payment page). Refund ${money(recorded.overpayment, row.currency)} in Stripe.`,
      amount: recorded.overpayment,
      currency: row.currency,
      invoiceId: row.invoiceId,
      invoiceNumber: await invoiceNumberOf(db, tenantId, row.invoiceId),
      paymentIntentId: pi,
      dedupeKey: `overpaid:${pi}`,
    });
  }
  if (recorded.status === "paid") {
    await emitInvoicingEvent(
      db,
      {
        type: "invoice.paid",
        tenantId,
        invoiceId: row.invoiceId,
        actor: { type: "customer", id: null },
        format: () => (options.format ? options.format(tenantId) : Promise.resolve({ currency: row.currency.toUpperCase(), locale: "en-US", timeZone: "UTC" })),
        now: options.now ?? new Date(),
      },
      { onEvent: options.onEvent, onEventError: options.onEventError, report: (error) => options.report?.(error) },
    );
  }
  return { outcome: "recorded", invoiceId: row.invoiceId, paymentId: recorded.paymentId, status: recorded.status, overpayment: recorded.overpayment };
}

/** An invoice on the company's default deposit gets it written on (as paid, or none) at its first online payment. */
async function pinDefaultDeposit(db: InvoicingDb, tenantId: string, invoiceId: string, depositPaid: number | null): Promise<void> {
  await db
    .update(invoices)
    .set(depositPaid !== null && depositPaid > 0 ? { depositAmount: depositPaid } : { depositBp: 0 })
    .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId), isNull(invoices.depositBp), isNull(invoices.depositAmount)));
}

/** A bank payment that failed: its amount is released (the customer can pay again) and the owner told. */
async function bankPaymentFailed(db: InvoicingDb, tenantId: string, object: Record<string, unknown>, options: CardEventOptions): Promise<CardEventOutcome> {
  const checkoutId = metaOf(object)[CARD_METADATA.checkout];
  if (!checkoutId) return { outcome: "ignored", why: "not an invoice payment" };
  const released = (await db
    .update(invoiceCheckouts)
    .set({ status: "failed", updatedAt: new Date() })
    .where(and(eq(invoiceCheckouts.id, checkoutId), eq(invoiceCheckouts.tenantId, tenantId), ne(invoiceCheckouts.status, "failed")))
    .returning({ invoiceId: invoiceCheckouts.invoiceId, amount: invoiceCheckouts.amount, currency: invoiceCheckouts.currency })) as Array<{ invoiceId: string; amount: number; currency: string }>;
  const row = released[0];
  if (!row) return { outcome: "ignored", why: "already released, or not this company's" };
  const pi = idOf(object.payment_intent);
  await alert(db, options, {
    tenantId,
    kind: "bank_payment_failed",
    message: `A bank payment of ${money(row.amount, row.currency)} failed. Nothing was recorded, and the customer can pay again from their invoice link.`,
    amount: row.amount,
    currency: row.currency,
    invoiceId: row.invoiceId,
    invoiceNumber: await invoiceNumberOf(db, tenantId, row.invoiceId),
    paymentIntentId: pi,
    dedupeKey: `bank_payment_failed:${checkoutId}`,
  });
  return { outcome: "released" };
}

/** The card payment a PaymentIntent recorded, in this company, with what has been reversed of it. */
async function cardPaymentOf(db: InvoicingDb, tenantId: string, paymentIntentId: string) {
  const [found] = (await db
    .select({ id: invoicePayments.id, invoiceId: invoicePayments.invoiceId, amount: invoicePayments.amount, flag: invoicePayments.flag })
    .from(invoicePayments)
    .innerJoin(invoices, eq(invoices.id, invoicePayments.invoiceId))
    .where(and(eq(invoicePayments.externalRef, paymentIntentId), eq(invoices.tenantId, tenantId), isNull(invoicePayments.reversesPaymentId)))
    .limit(1)) as Array<{ id: string; invoiceId: string; amount: number; flag: string | null }>;
  if (!found) return null;
  const reversals = (await db
    .select({ amount: invoicePayments.amount })
    .from(invoicePayments)
    .where(eq(invoicePayments.reversesPaymentId, found.id))) as Array<{ amount: number }>;
  let reversed = 0;
  for (const r of reversals) reversed -= Number(r.amount);
  return { ...found, reversed };
}

/**
 * A refund in Stripe (`amount_refunded` is the running total): the part not
 * yet on the ledger becomes a reversal, so amountPaid and the status follow.
 */
export async function recordCardRefund(
  db: InvoicingDb,
  tenantId: string,
  refund: { readonly paymentIntentId: string | null; readonly amountRefunded: number; readonly currency?: string | null },
  options: CardEventOptions = {},
): Promise<CardEventOutcome> {
  if (!refund.paymentIntentId) return { outcome: "ignored", why: "no payment reference" };
  const payment = await cardPaymentOf(db, tenantId, refund.paymentIntentId);
  if (!payment) return { outcome: "ignored", why: "not a payment recorded on an invoice here" };
  const delta = Math.min(refund.amountRefunded, payment.amount) - payment.reversed;
  if (delta <= 0) return { outcome: "duplicate", invoiceId: payment.invoiceId };
  const whole = refund.amountRefunded >= payment.amount;
  try {
    await reversePayment(db, tenantId, payment.id, whole ? "Refunded in Stripe" : "Part refunded in Stripe", undefined, { amount: delta });
  } catch (error) {
    if (error instanceof PaymentReversalError) return { outcome: "duplicate", invoiceId: payment.invoiceId };
    throw error;
  }
  await alert(db, options, {
    tenantId,
    kind: "refunded",
    message: `${money(delta, refund.currency ?? null)} of a card payment was refunded in Stripe. The invoice now shows it as not paid.`,
    amount: delta,
    currency: refund.currency ?? null,
    invoiceId: payment.invoiceId,
    invoiceNumber: await invoiceNumberOf(db, tenantId, payment.invoiceId),
    paymentIntentId: refund.paymentIntentId,
    dedupeKey: `refunded:${refund.paymentIntentId}:${refund.amountRefunded}`,
  });
  return { outcome: "reversed", invoiceId: payment.invoiceId, paymentId: payment.id, amount: delta };
}

type DisputeReport = { readonly paymentIntentId: string | null; readonly amount: number | null; readonly currency: string | null };

async function disputeOpened(db: InvoicingDb, tenantId: string, dispute: DisputeReport, options: CardEventOptions): Promise<CardEventOutcome> {
  if (!dispute.paymentIntentId) return { outcome: "ignored", why: "no payment reference" };
  const payment = await cardPaymentOf(db, tenantId, dispute.paymentIntentId);
  if (!payment) return { outcome: "ignored", why: "not a payment recorded on an invoice here" };
  if (payment.flag === "disputed" || payment.flag === "dispute_lost") return { outcome: "duplicate", invoiceId: payment.invoiceId };
  await db.update(invoicePayments).set({ flag: "disputed", flaggedAt: options.now ?? new Date() }).where(eq(invoicePayments.id, payment.id));
  await alert(db, options, {
    tenantId,
    kind: "dispute_opened",
    message: `A customer's bank disputed a card payment of ${money(dispute.amount, dispute.currency)}. Answer it in your Stripe dashboard before its deadline; if you lose, it comes off the invoice.`,
    amount: dispute.amount,
    currency: dispute.currency,
    invoiceId: payment.invoiceId,
    invoiceNumber: await invoiceNumberOf(db, tenantId, payment.invoiceId),
    paymentIntentId: dispute.paymentIntentId,
    dedupeKey: `dispute_opened:${dispute.paymentIntentId}`,
  });
  return { outcome: "flagged", invoiceId: payment.invoiceId, paymentId: payment.id, flag: "disputed" };
}

/** A dispute closed: lost → the disputed amount comes off the invoice (a reversal); won → the flag is cleared. */
async function disputeClosed(db: InvoicingDb, tenantId: string, dispute: DisputeReport & { readonly status: string | null }, options: CardEventOptions): Promise<CardEventOutcome> {
  if (!dispute.paymentIntentId) return { outcome: "ignored", why: "no payment reference" };
  const payment = await cardPaymentOf(db, tenantId, dispute.paymentIntentId);
  if (!payment) return { outcome: "ignored", why: "not a payment recorded on an invoice here" };
  if (dispute.status !== "lost") {
    if (payment.flag !== "disputed") return { outcome: "duplicate", invoiceId: payment.invoiceId };
    await db.update(invoicePayments).set({ flag: null, flaggedAt: null }).where(eq(invoicePayments.id, payment.id));
    return { outcome: "flagged", invoiceId: payment.invoiceId, paymentId: payment.id, flag: null };
  }
  if (payment.flag === "dispute_lost") return { outcome: "duplicate", invoiceId: payment.invoiceId };
  const take = Math.min(dispute.amount ?? payment.amount, payment.amount - payment.reversed);
  if (take > 0) {
    try {
      await reversePayment(db, tenantId, payment.id, "Dispute lost in Stripe", undefined, { amount: take });
    } catch (error) {
      if (!(error instanceof PaymentReversalError)) throw error;
    }
  }
  await db.update(invoicePayments).set({ flag: "dispute_lost", flaggedAt: options.now ?? new Date() }).where(eq(invoicePayments.id, payment.id));
  await alert(db, options, {
    tenantId,
    kind: "dispute_lost",
    message: `You lost a dispute over a card payment: ${money(take, dispute.currency)} was taken back and comes off the invoice, which is open again.`,
    amount: take,
    currency: dispute.currency,
    invoiceId: payment.invoiceId,
    invoiceNumber: await invoiceNumberOf(db, tenantId, payment.invoiceId),
    paymentIntentId: dispute.paymentIntentId,
    dedupeKey: `dispute_lost:${dispute.paymentIntentId}`,
  });
  return { outcome: "reversed", invoiceId: payment.invoiceId, paymentId: payment.id, amount: take };
}

// --- The accepted quote's button (create-app's quote page) ----------------------

export type QuotePayment = { readonly label: string } | { readonly note: string } | null;

/**
 * What an accepted quote's page offers, by the stage the money is at:
 *
 *   no invoice yet           the quote becomes its invoice on the click: "Pay the
 *                            deposit" when the company asks one, else "Pay now"
 *   staff's DRAFT invoice    nothing to pay yet — "Your invoice is on its way."
 *                            (a customer's click never publishes or charges a
 *                            draft someone is still working on)
 *   the deposit is due       "Pay the deposit"
 *   the deposit is paid      "Pay the balance"
 *   no deposit               "Pay now"
 *   nothing due              nothing (null)
 *
 * `invoice` null means none yet; pass the quote's total as `quoteTotal`.
 */
export function quotePaymentAction(
  invoice: Pick<InvoiceRow, "status" | "total" | "amountPaid" | "depositBp" | "depositAmount"> | null,
  business: Pick<ResolvedInvoicingBusiness, "depositPercent" | "allowPartialPayments" | "currency" | "name">,
  options: { readonly quoteTotal?: number; readonly pending?: number } = {},
): QuotePayment {
  if (invoice?.status === "draft") return { note: "Your invoice is on its way." };
  const subject = invoice ?? { status: "sent", total: options.quoteTotal ?? 0, amountPaid: 0, depositBp: null, depositAmount: null };
  const option = onlinePaymentOption(subject, business, options.pending ?? 0);
  if (!option) return null;
  if (option.belowMinimum) return { note: `Please contact ${business.name || "us"} to pay this small amount.` };
  if (option.stage === "deposit") return { label: "Pay the deposit" };
  return { label: option.depositAmount > 0 ? "Pay the balance" : "Pay now" };
}
