import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cardMinimum,
  createInvoice,
  createInvoiceSchema,
  createInvoicingAdminHandlers,
  createInvoicingHandlers,
  depositDue,
  handleInvoiceCardEvent,
  invoiceCheckouts,
  invoicePayments,
  invoices,
  invoicingCardAlert,
  onlinePaymentOption,
  quotePaymentAction,
  recordPayment,
  resolveInvoicingBusiness,
  setInvoiceDeposit,
  setInvoiceStatus,
  startInvoiceCheckout,
  type CardAlert,
  type CardSessionInput,
  type InvoiceCardPayments,
  type InvoicingBusiness,
} from "../index.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * PAY NOW's money rules (invoicing 0.5), on a real Postgres: every dollar
 * Stripe takes is recorded on the right invoice or reported to that company's
 * owner with a link to it in Stripe. Stripe is a fake that records what it was
 * asked; the webhook events are the shapes Stripe sends, built here.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => t.close());

function fakePayments(ready = true) {
  const sessions: CardSessionInput[] = [];
  const expired: string[] = [];
  const payments: InvoiceCardPayments = {
    ready: async () => (ready ? { ready: true, accountId: "acct_co" } : { ready: false }),
    createSession: async (input) => {
      sessions.push(input);
      return { id: `cs_${sessions.length}_${input.checkoutId.slice(-6)}`, url: `https://checkout.stripe.test/${sessions.length}` };
    },
    expireSession: async ({ sessionId }) => void expired.push(sessionId),
  };
  return { payments, sessions, expired };
}

const BUSINESS: InvoicingBusiness = {
  name: "Green Acres",
  timeZone: "America/Denver",
  contactEmail: null,
  contactPhone: null,
  logoUrl: null,
  brandColor: null,
  paymentInstructions: null,
  dueDays: 14,
  footer: null,
};
const RESOLVED = resolveInvoicingBusiness(BUSINESS);
const POST = { "sec-fetch-site": "same-origin", "content-type": "application/json" };

async function sentInvoice(tenantId: string, cents: number, extra: Partial<typeof createInvoiceSchema._input> = {}) {
  const created = await createInvoice(t.db, { tenantId, customerName: "Cass Customer", items: [{ description: "Work", quantity: 1, unitPrice: cents }], ...extra });
  await setInvoiceStatus(t.db, { tenantId, id: created.id, status: "sent" });
  return created;
}

async function start(tenantId: string, token: string, payments: InvoiceCardPayments, over: Partial<InvoicingBusiness> = {}, requestedAmount?: number) {
  return startInvoiceCheckout(t.db, payments, {
    tenantId,
    token,
    business: resolveInvoicingBusiness({ ...BUSINESS, ...over }),
    successUrl: "https://app.test/t/green/invoice/tok?paid=1",
    cancelUrl: "https://app.test/t/green/invoice/tok",
    ...(requestedAmount !== undefined ? { requestedAmount } : {}),
  });
}

/** What Stripe sends for a Checkout Session, built from what the app asked Stripe for. */
function completed(session: CardSessionInput, sessionId: string, over: Record<string, unknown> = {}, type = "checkout.session.completed") {
  return {
    type,
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        payment_status: "paid",
        amount_total: session.amount,
        currency: session.currency,
        payment_intent: `pi_${session.checkoutId}`,
        metadata: { checkoutId: session.checkoutId, invoiceId: session.invoiceId, tenantId: session.tenantId },
        ...over,
      },
    },
  };
}

async function sessionIdOf(checkoutId: string): Promise<string> {
  const [row] = await t.db.select({ id: invoiceCheckouts.sessionId }).from(invoiceCheckouts).where(eq(invoiceCheckouts.id, checkoutId));
  return row!.id!;
}
async function checkout(checkoutId: string) {
  const [row] = await t.db.select().from(invoiceCheckouts).where(eq(invoiceCheckouts.id, checkoutId));
  return row!;
}
async function invoiceRow(id: string) {
  const [row] = await t.db.select().from(invoices).where(eq(invoices.id, id));
  return row!;
}
async function paymentsOf(id: string) {
  return t.db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId, id));
}
const collect = () => {
  const alerts: CardAlert[] = [];
  return { alerts, onAlert: (a: CardAlert) => void alerts.push(a) };
};

describe("the deposit", () => {
  it("is a percent of the total to the nearest cent, or a fixed amount, and never leaves less than the card minimum", () => {
    expect(depositDue(123_457, { rule: "percent", percentBp: 3_000 }, 0)).toBe(37_037); // 37,037.1¢
    expect(depositDue(1_005, { rule: "percent", percentBp: 5_000 }, 0)).toBe(503); // 502.5¢ → 503¢
    expect(depositDue(10_000, { rule: "default" }, 25)).toBe(2_500);
    expect(depositDue(10_000, { rule: "none" }, 25)).toBe(0);
    expect(depositDue(10_000, { rule: "amount", amount: 50_000 }, 0)).toBe(10_000);
    // M4: a deposit under the minimum rises to it; one leaving under the minimum takes the whole total.
    expect(depositDue(1_000, { rule: "percent", percentBp: 100 }, 0, 50)).toBe(50);
    expect(depositDue(1_000, { rule: "amount", amount: 980 }, 0, 50)).toBe(1_000);
    expect([cardMinimum("USD"), cardMinimum("gbp"), cardMinimum("mxn"), cardMinimum("xyz")]).toEqual([50, 30, 1000, 50]);
  });

  it("then the balance closes the invoice EXACTLY", async () => {
    const co = tenant("dep");
    const inv = await sentInvoice(co, 123_457);
    await setInvoiceDeposit(t.db, co, inv.id, { rule: "percent", percentBp: 3_000 });
    const { payments, sessions } = fakePayments();
    const first = await start(co, inv.viewToken, payments);
    expect(sessions[0]).toMatchObject({ amount: 37_037, currency: "usd", accountId: "acct_co" });
    expect(await handleInvoiceCardEvent(t.db, co, completed(sessions[0]!, await sessionIdOf(first!.checkoutId)))).toMatchObject({ outcome: "recorded", status: "partial" });
    const second = await start(co, inv.viewToken, payments);
    expect(sessions[1]!.amount).toBe(123_457 - 37_037);
    expect(await handleInvoiceCardEvent(t.db, co, completed(sessions[1]!, await sessionIdOf(second!.checkoutId)))).toMatchObject({ outcome: "recorded", status: "paid", overpayment: 0 });
    const row = await invoiceRow(inv.id);
    expect([row.amountPaid, row.status]).toEqual([row.total, "paid"]);
    await expect(start(co, inv.viewToken, payments)).rejects.toMatchObject({ code: "payment_unavailable" });
  });

  it("L1: the company's default applies before any money, and changing it never reopens the stage", async () => {
    const co = tenant("def");
    const inv = await sentInvoice(co, 20_000);
    const at40 = resolveInvoicingBusiness({ ...BUSINESS, depositPercent: 40 });
    expect(onlinePaymentOption(await invoiceRow(inv.id), at40)).toMatchObject({ stage: "deposit", amount: 8_000 });
    const { payments, sessions } = fakePayments();
    const started = await start(co, inv.viewToken, payments, { depositPercent: 40 });
    await handleInvoiceCardEvent(t.db, co, completed(sessions[0]!, await sessionIdOf(started!.checkoutId)));
    expect((await invoiceRow(inv.id)).depositAmount).toBe(8_000);
    expect(onlinePaymentOption(await invoiceRow(inv.id), resolveInvoicingBusiness({ ...BUSINESS, depositPercent: 90 }))).toMatchObject({ stage: "balance", amount: 12_000 });
    await expect(setInvoiceDeposit(t.db, co, inv.id, { rule: "default" })).rejects.toMatchObject({ code: "invoice_not_editable" });
  });

  it("M4: below the card minimum, nothing is charged and the customer is asked to get in touch", async () => {
    const co = tenant("min");
    const inv = await sentInvoice(co, 10_000);
    await recordPayment(t.db, { tenantId: co, invoiceId: inv.id, amount: 9_970, method: "cash" });
    expect(onlinePaymentOption(await invoiceRow(inv.id), RESOLVED)).toMatchObject({ amount: 30, belowMinimum: true });
    await expect(start(co, inv.viewToken, fakePayments().payments)).rejects.toThrow("Please contact Green Acres to pay this small amount.");
  });
});

describe("the webhook records a payment once, and only when it is exactly what was asked", () => {
  it("records an event replayed twice — and the PaymentIntent event for the same payment — ONCE", async () => {
    const co = tenant("once");
    const inv = await sentInvoice(co, 10_000);
    const { payments, sessions } = fakePayments();
    const started = await start(co, inv.viewToken, payments);
    const event = completed(sessions[0]!, await sessionIdOf(started!.checkoutId));
    expect((await handleInvoiceCardEvent(t.db, co, event)).outcome).toBe("recorded");
    expect((await handleInvoiceCardEvent(t.db, co, event)).outcome).toBe("duplicate");
    const intent = {
      type: "payment_intent.succeeded",
      data: { object: { id: `pi_${started!.checkoutId}`, amount_received: 10_000, currency: "usd", metadata: event.data.object.metadata } },
    };
    expect((await handleInvoiceCardEvent(t.db, co, intent)).outcome).toBe("duplicate");
    expect(await paymentsOf(inv.id)).toHaveLength(1);
  });

  it("does NOT record an amount or currency that differs from what was asked, and tells the owner with the Stripe link", async () => {
    const co = tenant("mismatch");
    const inv = await sentInvoice(co, 10_000);
    const { payments, sessions } = fakePayments();
    const started = await start(co, inv.viewToken, payments);
    const sid = await sessionIdOf(started!.checkoutId);
    const { alerts, onAlert } = collect();
    expect(await handleInvoiceCardEvent(t.db, co, completed(sessions[0]!, sid, { amount_total: 9_999 }), { onAlert })).toMatchObject({ outcome: "refused", reason: "amount_mismatch" });
    expect(await handleInvoiceCardEvent(t.db, co, completed(sessions[0]!, sid, { currency: "eur" }), { onAlert })).toMatchObject({ outcome: "refused", reason: "currency_mismatch" });
    expect(await paymentsOf(inv.id)).toHaveLength(0);
    expect(alerts.map((a) => a.kind)).toEqual(["amount_mismatch", "currency_mismatch"]);
    expect(alerts[0]).toMatchObject({ tenantId: co, amount: 9_999, invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, stripeUrl: `https://dashboard.stripe.com/payments/pi_${started!.checkoutId}` });
    expect(alerts[0]!.message).toContain("$99.99");
  });

  it("refuses FORGED METADATA naming another company's invoice, even when it claims to be this company", async () => {
    const a = tenant("alpha");
    const b = tenant("bravo");
    const bInv = await sentInvoice(b, 10_000);
    const { payments, sessions } = fakePayments();
    const bStarted = await start(b, bInv.viewToken, payments);
    const bEvent = completed(sessions[0]!, await sessionIdOf(bStarted!.checkoutId));
    const { alerts, onAlert } = collect();
    expect(await handleInvoiceCardEvent(t.db, a, bEvent, { onAlert })).toMatchObject({ outcome: "refused", reason: "unknown_checkout" });
    const lying = { ...bEvent, data: { object: { ...bEvent.data.object, metadata: { ...bEvent.data.object.metadata, tenantId: a } } } };
    expect(await handleInvoiceCardEvent(t.db, a, lying)).toMatchObject({ outcome: "refused", reason: "unknown_checkout" });
    expect(await paymentsOf(bInv.id)).toHaveLength(0);
    expect(alerts[0]).toMatchObject({ tenantId: a, kind: "unknown_checkout" });
    const swapped = { ...bEvent, data: { object: { ...bEvent.data.object, metadata: { ...bEvent.data.object.metadata, invoiceId: "inv_someone_else" } } } };
    expect(await handleInvoiceCardEvent(t.db, b, swapped)).toMatchObject({ outcome: "refused", reason: "metadata_mismatch" });
    expect(await paymentsOf(bInv.id)).toHaveLength(0);
  });

  it("never records money on a VOID invoice: the owner is told to refund it", async () => {
    const co = tenant("voided");
    const inv = await sentInvoice(co, 10_000);
    const { payments, sessions } = fakePayments();
    const started = await start(co, inv.viewToken, payments);
    await setInvoiceStatus(t.db, { tenantId: co, id: inv.id, status: "void" });
    const { alerts, onAlert } = collect();
    expect(await handleInvoiceCardEvent(t.db, co, completed(sessions[0]!, await sessionIdOf(started!.checkoutId)), { onAlert })).toMatchObject({ outcome: "refused", reason: "paid_on_void" });
    expect(await paymentsOf(inv.id)).toHaveLength(0);
    expect(alerts[0]!.message).toContain("refund it in Stripe");
  });
});

describe("H1: staff change an invoice after Pay now", () => {
  const admin = (tenantId: string, payments?: InvoiceCardPayments) =>
    createInvoicingAdminHandlers({ db: t.db, tenantId, authorize: () => true, invoiceUrl: () => "https://x", ...(payments ? { payments } : {}) });
  const addLine = (tenantId: string, invoiceId: string, handlers: ReturnType<typeof admin>) =>
    handlers.handle(
      new Request(`https://app.test/api/app/${tenantId}/invoices/v1/admin/invoices/${invoiceId}/items`, {
        method: "POST",
        headers: POST,
        body: JSON.stringify({ description: "More work", quantity: 1, unitPrice: 5_000 }),
      }),
    );

  it("every Session closes in an hour, and an edit closes the open ones (control: without the seam it stays open)", async () => {
    const co = tenant("edit");
    const inv = await sentInvoice(co, 10_000);
    const { payments, sessions, expired } = fakePayments();
    const before = Math.floor(Date.now() / 1000);
    const started = await start(co, inv.viewToken, payments);
    expect(sessions[0]!.expiresAt - before).toBeGreaterThanOrEqual(3_599);
    expect(sessions[0]!.expiresAt - before).toBeLessThanOrEqual(3_601);
    expect((await addLine(co, inv.id, admin(co, payments))).status).toBe(200);
    expect(expired).toEqual([await sessionIdOf(started!.checkoutId)]);
    expect((await checkout(started!.checkoutId)).status).toBe("expired");
    const other = await start(co, inv.viewToken, payments);
    expect((await addLine(co, inv.id, admin(co))).status).toBe(200);
    expect((await checkout(other!.checkoutId)).status).toBe("open");
  });

  it("money still arriving on a stale page is recorded; if it overpays, the invoice says so and the owner is told to refund", async () => {
    const co = tenant("stale");
    const inv = await sentInvoice(co, 10_000);
    const { payments, sessions } = fakePayments();
    const started = await start(co, inv.viewToken, payments);
    await recordPayment(t.db, { tenantId: co, invoiceId: inv.id, amount: 4_000, method: "cash" });
    const { alerts, onAlert } = collect();
    expect(await handleInvoiceCardEvent(t.db, co, completed(sessions[0]!, await sessionIdOf(started!.checkoutId)), { onAlert })).toMatchObject({
      outcome: "recorded",
      status: "paid",
      overpayment: 4_000,
    });
    expect((await invoiceRow(inv.id)).amountPaid).toBe(14_000);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "overpaid", amount: 4_000 });
    expect(alerts[0]!.message).toContain("Refund $40.00 in Stripe");
  });

  it("even on an invoice settled meanwhile: recorded as an overpayment, never dropped", async () => {
    const co = tenant("settled");
    const inv = await sentInvoice(co, 10_000);
    const { payments, sessions } = fakePayments();
    const started = await start(co, inv.viewToken, payments);
    await recordPayment(t.db, { tenantId: co, invoiceId: inv.id, amount: 10_000, method: "check" });
    const { alerts, onAlert } = collect();
    expect(await handleInvoiceCardEvent(t.db, co, completed(sessions[0]!, await sessionIdOf(started!.checkoutId)), { onAlert })).toMatchObject({ outcome: "recorded", overpayment: 10_000 });
    expect(alerts.map((a) => a.kind)).toEqual(["overpaid"]);
  });
});

describe("H2: the owner's alert says what happened, how much, and where it is in Stripe", () => {
  it("maps every card problem to the card-payment alert with the amount and the Stripe link (control: no link without a payment)", () => {
    const base = { tenantId: "co", message: "Stripe took $12.00 where $10.00 was asked.", amount: 1_200, currency: "usd", invoiceId: "inv_1", invoiceNumber: "INV-2026-0001", dedupeKey: "k" };
    for (const kind of ["amount_mismatch", "currency_mismatch", "unknown_checkout", "paid_on_void", "overpaid", "refunded", "dispute_opened", "dispute_lost", "bank_payment_failed"]) {
      const draft = invoicingCardAlert({ ...base, kind, stripeUrl: "https://dashboard.stripe.com/payments/pi_1" }, { hrefs: { invoice: "/app/invoices/{id}" } });
      expect(draft.kind, kind).toBe("invoicing.card-payment");
      expect(draft.title, kind).toContain("$12.00");
      expect(draft.body, kind).toContain("Open it in Stripe: https://dashboard.stripe.com/payments/pi_1");
      expect(draft.href, kind).toBe("/app/invoices/inv_1");
      expect(draft.dedupeKey, kind).toBe("invoicing.card-payment:k");
    }
    expect(invoicingCardAlert({ ...base, kind: "refunded", stripeUrl: null }, { hrefs: { invoice: "/app/invoices/{id}" } }).body).not.toContain("Stripe:");
  });
});

describe("H3: bank payments on their way, and two tabs", () => {
  it("a pending bank payment holds its amount; the page offers only the rest; a failure releases it and tells the owner", async () => {
    const co = tenant("bank");
    const inv = await sentInvoice(co, 10_000);
    const { payments, sessions } = fakePayments();
    const started = await start(co, inv.viewToken, payments, { allowPartialPayments: true }, 6_000);
    const sid = await sessionIdOf(started!.checkoutId);
    expect(await handleInvoiceCardEvent(t.db, co, completed(sessions[0]!, sid, { payment_status: "unpaid" }))).toEqual({ outcome: "pending" });
    expect((await checkout(started!.checkoutId)).status).toBe("processing");
    expect(await paymentsOf(inv.id)).toHaveLength(0);

    const page = createInvoicingHandlers({ db: t.db, tenantId: co, business: () => BUSINESS, payments, invoicePageUrl: () => "https://app.test/i" });
    const read = async () =>
      (await (await page.handle(new Request(`https://app.test/api/t/g/invoices/v1/invoice/${inv.viewToken}`))).json()) as {
        invoice: { pay: { amount: number } | null; pending: { amount: number; startedAt: string } | null };
      };
    const shown = await read();
    expect(shown.invoice.pending?.amount).toBe(6_000);
    expect(shown.invoice.pay?.amount).toBe(4_000);

    const { alerts, onAlert } = collect();
    expect(await handleInvoiceCardEvent(t.db, co, completed(sessions[0]!, sid, { payment_status: "unpaid" }, "checkout.session.async_payment_failed"), { onAlert })).toEqual({ outcome: "released" });
    expect(alerts[0]).toMatchObject({ kind: "bank_payment_failed", amount: 6_000 });
    const again = await read();
    expect([again.invoice.pay?.amount, again.invoice.pending]).toEqual([10_000, null]);
  });

  it("a bank payment that clears is recorded like a card", async () => {
    const co = tenant("bank-ok");
    const inv = await sentInvoice(co, 10_000);
    const { payments, sessions } = fakePayments();
    const started = await start(co, inv.viewToken, payments);
    const sid = await sessionIdOf(started!.checkoutId);
    await handleInvoiceCardEvent(t.db, co, completed(sessions[0]!, sid, { payment_status: "unpaid" }));
    expect(await handleInvoiceCardEvent(t.db, co, completed(sessions[0]!, sid, {}, "checkout.session.async_payment_succeeded"))).toMatchObject({ outcome: "recorded", status: "paid" });
  });

  it("two tabs (or a double click) for the same stage and amount get THE SAME page; another amount gets a new one (the control)", async () => {
    const co = tenant("tabs");
    const inv = await sentInvoice(co, 10_000);
    const { payments, sessions, expired } = fakePayments();
    const [one, two] = await Promise.all([start(co, inv.viewToken, payments), start(co, inv.viewToken, payments)]);
    expect(two!.url).toBe(one!.url);
    expect(sessions).toHaveLength(1);
    expect(expired).toEqual([]);
    const part = await start(co, inv.viewToken, payments, { allowPartialPayments: true }, 2_500);
    expect(part!.url).not.toBe(one!.url);
    expect(expired).toEqual([await sessionIdOf(one!.checkoutId)]);
  });
});

describe("refunds and disputes are on the ledger", () => {
  it("M7: a part refund is a part reversal, the rest of it the rest; replays change nothing", async () => {
    const co = tenant("refund");
    const inv = await sentInvoice(co, 10_000);
    const { payments, sessions } = fakePayments();
    const started = await start(co, inv.viewToken, payments);
    await handleInvoiceCardEvent(t.db, co, completed(sessions[0]!, await sessionIdOf(started!.checkoutId)));
    const pi = `pi_${started!.checkoutId}`;
    const { alerts, onAlert } = collect();
    const refunded = (n: number) => ({ type: "charge.refunded", data: { object: { payment_intent: pi, amount: 10_000, amount_refunded: n, currency: "usd" } } });
    expect(await handleInvoiceCardEvent(t.db, co, refunded(3_000), { onAlert })).toMatchObject({ outcome: "reversed", amount: 3_000 });
    expect(await handleInvoiceCardEvent(t.db, co, refunded(3_000), { onAlert })).toMatchObject({ outcome: "duplicate" });
    let row = await invoiceRow(inv.id);
    expect([row.amountPaid, row.status]).toEqual([7_000, "partial"]);
    expect(await handleInvoiceCardEvent(t.db, co, refunded(10_000), { onAlert })).toMatchObject({ outcome: "reversed", amount: 7_000 });
    row = await invoiceRow(inv.id);
    expect([row.amountPaid, row.status]).toEqual([0, "sent"]);
    expect(alerts.map((a) => [a.kind, a.amount])).toEqual([
      ["refunded", 3_000],
      ["refunded", 7_000],
    ]);
    expect(await handleInvoiceCardEvent(t.db, tenant("x"), refunded(10_000))).toMatchObject({ outcome: "ignored" });
  });

  it("a dispute is a flag; lost, it is a reversal; won, the flag clears", async () => {
    const co = tenant("dispute");
    const inv = await sentInvoice(co, 10_000);
    const { payments, sessions } = fakePayments();
    const started = await start(co, inv.viewToken, payments);
    await handleInvoiceCardEvent(t.db, co, completed(sessions[0]!, await sessionIdOf(started!.checkoutId)));
    const pi = `pi_${started!.checkoutId}`;
    const { alerts, onAlert } = collect();
    const dispute = (type: string, status?: string) => ({ type, data: { object: { payment_intent: pi, amount: 10_000, currency: "usd", ...(status ? { status } : {}) } } });
    expect(await handleInvoiceCardEvent(t.db, co, dispute("charge.dispute.created"), { onAlert })).toMatchObject({ outcome: "flagged", flag: "disputed" });
    expect(await handleInvoiceCardEvent(t.db, co, dispute("charge.dispute.closed", "won"))).toMatchObject({ outcome: "flagged", flag: null });
    expect((await paymentsOf(inv.id))[0]!.flag).toBeNull();
    await handleInvoiceCardEvent(t.db, co, dispute("charge.dispute.created"), { onAlert });
    expect(await handleInvoiceCardEvent(t.db, co, dispute("charge.dispute.closed", "lost"), { onAlert })).toMatchObject({ outcome: "reversed", amount: 10_000 });
    expect(await handleInvoiceCardEvent(t.db, co, dispute("charge.dispute.closed", "lost"), { onAlert })).toMatchObject({ outcome: "duplicate" });
    const row = await invoiceRow(inv.id);
    expect([row.amountPaid, row.status]).toEqual([0, "sent"]);
    // The second "dispute opened" is the same thing happening again: stored and alerted once.
    expect(alerts.map((a) => a.kind)).toEqual(["dispute_opened", "dispute_lost"]);
  });
});

describe("starting a payment", () => {
  it("charges the server's amount: a sent amount is ignored unless part payments are on, then kept in range", async () => {
    const co = tenant("part");
    const inv = await sentInvoice(co, 10_000);
    const { payments, sessions } = fakePayments();
    await start(co, inv.viewToken, payments, {}, 1);
    expect(sessions[0]!.amount).toBe(10_000);
    await start(co, inv.viewToken, payments, { allowPartialPayments: true }, 2_500);
    expect(sessions[1]!.amount).toBe(2_500);
    await expect(start(co, inv.viewToken, payments, { allowPartialPayments: true }, 10_001)).rejects.toMatchObject({ code: "payment_unavailable" });
    await expect(start(co, inv.viewToken, payments, { allowPartialPayments: true }, 49)).rejects.toMatchObject({ code: "payment_unavailable" });
    // Leaving 20¢ to pay later would be a balance nobody can pay by card.
    await expect(start(co, inv.viewToken, payments, { allowPartialPayments: true }, 9_980)).rejects.toMatchObject({ code: "payment_unavailable" });
  });

  it("refuses when the business can't take cards, and a token that isn't its", async () => {
    const co = tenant("ready");
    const inv = await sentInvoice(co, 10_000);
    await expect(start(co, inv.viewToken, fakePayments(false).payments)).rejects.toMatchObject({ code: "payment_unavailable" });
    expect(await start(tenant("stranger"), inv.viewToken, fakePayments().payments)).toBeNull();
  });
});

describe("M1 and M2: what an accepted quote's page offers", () => {
  const at = (depositPercent: number) => resolveInvoicingBusiness({ ...BUSINESS, depositPercent });
  const inv = (over: Partial<{ status: string; total: number; amountPaid: number; depositBp: number | null; depositAmount: number | null }> = {}) => ({
    status: "sent",
    total: 10_000,
    amountPaid: 0,
    depositBp: null as number | null,
    depositAmount: null as number | null,
    ...over,
  });

  it("follows the stage: the deposit, then the balance; Pay now with no deposit; nothing when nothing is due", () => {
    expect(quotePaymentAction(null, at(30), { quoteTotal: 10_000 })).toEqual({ label: "Pay the deposit" });
    expect(quotePaymentAction(null, at(0), { quoteTotal: 10_000 })).toEqual({ label: "Pay now" });
    expect(quotePaymentAction(inv(), at(30))).toEqual({ label: "Pay the deposit" });
    expect(quotePaymentAction(inv({ amountPaid: 3_000, status: "partial", depositAmount: 3_000 }), at(30))).toEqual({ label: "Pay the balance" });
    expect(quotePaymentAction(inv({ status: "paid", amountPaid: 10_000 }), at(30))).toBeNull();
    expect(quotePaymentAction(inv(), at(30), { pending: 10_000 })).toBeNull();
    // The control: the same invoice before its deposit is paid is NOT "Pay the balance".
    expect(quotePaymentAction(inv({ depositAmount: 3_000 }), at(30))).toEqual({ label: "Pay the deposit" });
  });

  it("never offers to publish or charge a draft staff are still working on", () => {
    expect(quotePaymentAction(inv({ status: "draft" }), at(30))).toEqual({ note: "Your invoice is on its way." });
    // The control: the same invoice once sent is payable.
    expect(quotePaymentAction(inv({ status: "sent" }), at(30))).toEqual({ label: "Pay the deposit" });
  });
});

describe("through the handlers", () => {
  it("shows Pay now only when the business takes cards, starts it by POST, and expires it when the invoice is voided", async () => {
    const co = tenant("http");
    const inv = await sentInvoice(co, 10_000);
    const { payments, expired, sessions } = fakePayments();
    const base = `https://app.test/api/t/green/invoices/v1/invoice/${inv.viewToken}`;
    const open = createInvoicingHandlers({ db: t.db, tenantId: co, business: () => BUSINESS, payments, invoicePageUrl: () => "https://app.test/t/green/invoice/x" });
    const got = (await (await open.handle(new Request(base))).json()) as { invoice: { pay: unknown; pending: unknown } };
    expect(got.invoice.pay).toEqual({ stage: "balance", amount: 10_000, depositAmount: 0, allowPartial: false, minimum: 50, maximum: 10_000, belowMinimum: false });
    expect(got.invoice.pending).toBeNull();
    const without = createInvoicingHandlers({ db: t.db, tenantId: co, business: () => BUSINESS });
    expect(((await (await without.handle(new Request(base))).json()) as { invoice: { pay: unknown } }).invoice.pay).toBeNull();

    const res = await open.handle(new Request(`${base}/pay`, { method: "POST", headers: POST, body: JSON.stringify({ amount: 1 }) }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { url: string }).url).toContain("checkout.stripe.test");
    expect(sessions[0]).toMatchObject({ amount: 10_000, successUrl: "https://app.test/t/green/invoice/x?paid=1" });

    const admin = createInvoicingAdminHandlers({ db: t.db, tenantId: co, authorize: () => true, invoiceUrl: () => "https://x", payments });
    const voided = await admin.handle(
      new Request(`https://app.test/api/app/${co}/invoices/v1/admin/invoices/${inv.id}/status`, { method: "POST", headers: POST, body: JSON.stringify({ status: "void" }) }),
    );
    expect(voided.status).toBe(200);
    expect(expired).toHaveLength(1);
    const after = await open.handle(new Request(`${base}/pay`, { method: "POST", headers: POST, body: "{}" }));
    expect([after.status, ((await after.json()) as { error: { code: string } }).error.code]).toEqual([409, "payment_unavailable"]);
  });

  it("sets a deposit from the ledger, shows it, and closes an open deposit page", async () => {
    const co = tenant("depo-http");
    const inv = await sentInvoice(co, 10_000);
    const { payments, expired } = fakePayments();
    await start(co, inv.viewToken, payments, { depositPercent: 10 });
    const admin = createInvoicingAdminHandlers({ db: t.db, tenantId: co, authorize: () => true, invoiceUrl: () => "https://x", business: () => ({ ...BUSINESS, depositPercent: 10 }), payments });
    const res = await admin.handle(
      new Request(`https://app.test/api/app/${co}/invoices/v1/admin/invoices/${inv.id}/deposit`, { method: "POST", headers: POST, body: JSON.stringify({ rule: "amount", amount: 2_000 }) }),
    );
    const body = (await res.json()) as { invoice: { deposit: unknown } };
    expect(body.invoice.deposit).toEqual({ rule: "amount", percentBp: null, fixedAmount: 2_000, amount: 2_000, defaultPercent: 10, editable: true });
    expect(expired).toHaveLength(1);
  });
});

describe("Needs your attention: every card problem is kept for the company, alerts or not", () => {
  const admin = (tenantId: string) => createInvoicingAdminHandlers({ db: t.db, tenantId, authorize: () => ({ userId: "u_owner" }), invoiceUrl: () => "https://x" });
  const get = async (tenantId: string) =>
    (await (await admin(tenantId).handle(new Request(`https://app.test/api/app/${tenantId}/invoices/v1/admin/attention`))).json()) as {
      open: Array<{ id: string; kind: string; message: string; amount: number; stripeUrl: string; resolvedAt: string | null }>;
      handled: Array<{ id: string }>;
    };
  const resolve = (tenantId: string, id: string) =>
    admin(tenantId).handle(new Request(`https://app.test/api/app/${tenantId}/invoices/v1/admin/attention/${id}/resolve`, { method: "POST", headers: POST, body: "{}" }));

  it("stores a problem with NO onAlert at all, once however often Stripe repeats it, for that company only; Mark as handled closes it", async () => {
    const co = tenant("attn");
    const other = tenant("attn-other");
    const inv = await sentInvoice(co, 10_000);
    const { payments, sessions } = fakePayments();
    const started = await start(co, inv.viewToken, payments);
    const wrong = completed(sessions[0]!, await sessionIdOf(started!.checkoutId), { amount_total: 9_999 });
    await handleInvoiceCardEvent(t.db, co, wrong);
    await handleInvoiceCardEvent(t.db, co, wrong);
    const list = await get(co);
    expect(list.open).toHaveLength(1);
    expect(list.open[0]).toMatchObject({ kind: "amount_mismatch", amount: 9_999, stripeUrl: `https://dashboard.stripe.com/payments/pi_${started!.checkoutId}`, resolvedAt: null });
    expect(list.open[0]!.message).toContain("$99.99");
    // Another company sees none of it, and can't mark it handled.
    expect((await get(other)).open).toEqual([]);
    expect((await resolve(other, list.open[0]!.id)).status).toBe(404);
    expect((await get(co)).open).toHaveLength(1);
    // The owner marks it handled.
    expect((await resolve(co, list.open[0]!.id)).status).toBe(200);
    const after = await get(co);
    expect([after.open.length, after.handled.map((h) => h.id)]).toEqual([0, [list.open[0]!.id]]);
  });

  it("a part refund reads 'Partly refunded', not 'Reversed'; all of it reads 'Reversed'", async () => {
    const co = tenant("partly");
    const inv = await sentInvoice(co, 10_000);
    const { payments, sessions } = fakePayments();
    const started = await start(co, inv.viewToken, payments);
    await handleInvoiceCardEvent(t.db, co, completed(sessions[0]!, await sessionIdOf(started!.checkoutId)));
    const refunded = (n: number) => ({ type: "charge.refunded", data: { object: { payment_intent: `pi_${started!.checkoutId}`, amount: 10_000, amount_refunded: n, currency: "usd" } } });
    const card = async () => {
      const res = await admin(co).handle(new Request(`https://app.test/api/app/${co}/invoices/v1/admin/invoices/${inv.id}`));
      const body = (await res.json()) as { invoice: { payments: Array<{ amount: number; reversed: boolean; reversedAmount: number }> } };
      return body.invoice.payments.find((p) => p.amount > 0)!;
    };
    await handleInvoiceCardEvent(t.db, co, refunded(3_000));
    expect(await card()).toMatchObject({ reversed: false, reversedAmount: 3_000 });
    await handleInvoiceCardEvent(t.db, co, refunded(10_000));
    expect(await card()).toMatchObject({ reversed: true, reversedAmount: 10_000 });
  });
});
