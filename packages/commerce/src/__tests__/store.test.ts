import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { productVariants } from "@adminigloo/catalog/schema";
import { companyForConnectEvent, connectLedgerKey, runLedgeredEvent, verifyStripeSignature, STRIPE_API_VERSION } from "@adminigloo/stripe";
import { stripeConnectedAccounts, stripeEvents } from "@adminigloo/stripe/schema";
import { and, eq } from "drizzle-orm";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { orders, orderItems, storeAlerts, storeCheckouts, storeSettings } from "../schema.js";
import {
  createStoreProduct,
  getStoreSettings,
  handleStoreEvent,
  releaseHeldStock,
  saveStoreSettings,
  storeVisitorKey,
  listPublicStoreProducts,
  listStoreAlerts,
  listStoreOrders,
  releaseLapsedStoreCheckouts,
  removeStoreProduct,
  startStoreCheckout,
  storeCheckoutStatus,
  StoreRefusal,
  updateStoreProduct,
  STORE_CARD_EVENT_TYPES,
  type StoreCardPayments,
  type StoreEmailsOwed,
  type StoreEventOptions,
  type StoreOrderPlaced,
  type StoreSessionInput,
} from "../store.js";
import { storeOrderEmails } from "../store-emails.js";
import { createTestDb, schemaDdl, STORE_TABLES, tenant, type TestDb } from "./pglite.js";

/**
 * A STORE OF ITS OWN (commerce 0.2): the money rules, on a real Postgres.
 *
 * The webhook path here is the one the app emits: Stripe's signature
 * (payloads signed with the SDK's own generateTestHeaderString), the company
 * from `event.account` (stripe's companyForConnectEvent), the ledger keyed
 * account:event (runLedgeredEvent), then commerce's rules. No live Stripe:
 * the Checkout seam is a fake that records what it was asked.
 */

let t: TestDb;
const sdk = new Stripe("sk_test_00000000000000000000000000", { apiVersion: STRIPE_API_VERSION });
const SECRET = "whsec_store_test_secret";

beforeAll(async () => {
  t = await createTestDb();
  for (const statement of schemaDdl([stripeConnectedAccounts, stripeEvents])) await t.client.exec(statement);
});
afterAll(async () => {
  await t?.close();
});

function fakePayments(options: { ready?: boolean; accountId?: string } = {}) {
  const sessions: StoreSessionInput[] = [];
  const expired: string[] = [];
  let n = 0;
  const payments: StoreCardPayments = {
    async ready() {
      return options.ready === false ? { ready: false } : { ready: true, accountId: options.accountId ?? "acct_test" };
    },
    async createSession(input) {
      sessions.push(input);
      n += 1;
      const id = `cs_test_${input.checkoutId}_${n}`;
      return { id, url: `https://checkout.stripe.test/${id}` };
    },
    async expireSession(input) {
      expired.push(input.sessionId);
    },
  };
  return { payments, sessions, expired };
}

/** A company with its own connected Stripe account (as stripe 0.4's onboarding leaves it). */
async function company(prefix = "co") {
  const tenantId = tenant(prefix);
  const accountId = `acct_${tenantId.replace(/[^a-z0-9]/gi, "")}`;
  await t.db.insert(stripeConnectedAccounts).values({ tenantId, accountId, chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true });
  return { tenantId, accountId, ...fakePayments({ accountId }) };
}

async function product(tenantId: string, input: { name?: string; priceMinor?: number; stock?: number | null; currency?: string } = {}) {
  return createStoreProduct(t.db, tenantId, { name: input.name ?? "Pine soap", priceMinor: input.priceMinor ?? 1_250, currency: input.currency ?? "usd", stock: input.stock ?? null });
}

const cartId = () => `cart${Math.random().toString(36).slice(2, 14)}`;

async function checkout(
  co: { tenantId: string; payments: StoreCardPayments },
  lines: Array<{ productId: string; quantity: number }>,
  cart = cartId(),
  now?: Date,
  visitorKey: string | null = `203.0.113.${Math.floor(Math.random() * 250)}-${Math.random()}`,
) {
  return startStoreCheckout(t.db, co.payments, {
    tenantId: co.tenantId,
    cartId: cart,
    lines,
    visitorKey,
    businessName: "Green Acres",
    successUrl: (id) => `https://app.test/t/green/store/thanks/${id}`,
    cancelUrl: "https://app.test/t/green/store",
    ...(now ? { now } : {}),
  });
}

/** What a customer can buy now: on the shelf, less what open checkouts hold. */
async function stockOf(productId: string): Promise<number | null> {
  const [row] = await t.db.select({ n: productVariants.inventory, held: productVariants.held }).from(productVariants).where(eq(productVariants.productId, productId));
  return row?.n === null || row?.n === undefined ? null : Math.max(0, row.n - row.held);
}

/** The two numbers: on the shelf (the owner counts), and held by open checkouts. */
async function shelfOf(productId: string): Promise<{ shelf: number | null; held: number }> {
  const [row] = await t.db.select({ shelf: productVariants.inventory, held: productVariants.held }).from(productVariants).where(eq(productVariants.productId, productId));
  return { shelf: row!.shelf, held: row!.held };
}

async function checkoutRow(id: string) {
  const [row] = await t.db.select().from(storeCheckouts).where(eq(storeCheckouts.id, id));
  return row!;
}

/** A Checkout Session event, as Stripe sends it for the connected account. */
function sessionEvent(
  type: string,
  account: string,
  row: { id: string; sessionId: string | null; amount: number; currency: string },
  overrides: { amount?: number; currency?: string; paid?: boolean; metadata?: Record<string, string>; id?: string; pi?: string } = {},
) {
  return {
    id: overrides.id ?? `evt_${Math.random().toString(36).slice(2, 12)}`,
    object: "event",
    account,
    type,
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: row.sessionId,
        object: "checkout.session",
        amount_total: overrides.amount ?? row.amount,
        currency: overrides.currency ?? row.currency,
        payment_status: overrides.paid === false ? "unpaid" : "paid",
        payment_intent: overrides.pi ?? `pi_${row.id}`,
        customer_details: { email: "buyer@example.test" },
        metadata: overrides.metadata ?? { storeCheckoutId: row.id },
      },
    },
  };
}

function chargeEvent(type: string, account: string, object: Record<string, unknown>, id?: string) {
  return { id: id ?? `evt_${Math.random().toString(36).slice(2, 12)}`, object: "event", account, type, livemode: false, created: 1, data: { object } };
}

/**
 * THE APP'S WEBHOOK, as emitted (src/server/payments-webhook.ts): signature,
 * company from the account, the ledger, then the store's rules.
 */
async function webhook(event: object, options: StoreEventOptions = {}) {
  const body = JSON.stringify(event);
  const signature = sdk.webhooks.generateTestHeaderString({ payload: body, secret: SECRET });
  const verified = verifyStripeSignature(body, signature, SECRET, sdk);
  const owner = await companyForConnectEvent(t.db, verified);
  if (owner.kind === "ignored") return { ledger: "ignored" as const, outcome: null };
  let outcome: Awaited<ReturnType<typeof handleStoreEvent>> | null = null;
  const result = await runLedgeredEvent(t.db, { key: connectLedgerKey(verified), type: verified.type, tenantId: owner.tenantId, payload: verified }, async () => {
    outcome = await handleStoreEvent(t.db, owner.tenantId, verified as unknown as Parameters<typeof handleStoreEvent>[2], options);
  });
  return { ledger: result.outcome, outcome: outcome as Awaited<ReturnType<typeof handleStoreEvent>> | null };
}

async function ordersOf(tenantId: string) {
  return t.db.select().from(orders).where(eq(orders.tenantId, tenantId));
}

async function alertsOf(tenantId: string) {
  return t.db.select().from(storeAlerts).where(eq(storeAlerts.tenantId, tenantId));
}

describe("products", () => {
  it("keeps each company's products its own, apart from the site's (\"*\")", async () => {
    const a = await company();
    const b = await company();
    const soap = await product(a.tenantId, { name: "A soap" });
    await product(b.tenantId, { name: "B candle" });
    expect((await listPublicStoreProducts(t.db, a.tenantId)).map((p) => p.name)).toEqual(["A soap"]);
    expect((await listPublicStoreProducts(t.db, "*")).length).toBe(0);
    // B can't change or remove A's product: not found.
    expect(await updateStoreProduct(t.db, b.tenantId, soap.id, { priceMinor: 1 })).toBeNull();
    expect(await removeStoreProduct(t.db, b.tenantId, soap.id)).toBeNull();
    expect((await listPublicStoreProducts(t.db, a.tenantId))[0]!.priceMinor).toBe(1_250);
  });

  it("refuses the 21st product on a plan of 20, and plain-word bad input", async () => {
    const a = await company();
    for (let i = 0; i < 3; i += 1) await createStoreProduct(t.db, a.tenantId, { name: `P${i}`, priceMinor: 100, currency: "usd" }, { limit: 3 });
    await expect(createStoreProduct(t.db, a.tenantId, { name: "P4", priceMinor: 100, currency: "usd" }, { limit: 3 })).rejects.toThrow(/Your plan includes 3 products/);
    await expect(createStoreProduct(t.db, a.tenantId, { name: "", priceMinor: 100, currency: "usd" })).rejects.toThrow(/name/);
    await expect(createStoreProduct(t.db, a.tenantId, { name: "X", priceMinor: 12.5, currency: "usd" })).rejects.toThrow(/whole number/);
    await expect(createStoreProduct(t.db, a.tenantId, { name: "X", priceMinor: 100, currency: "zzz" })).rejects.toThrow(/currency/);
  });
});

describe("checking out: the server's prices, the company's own products", () => {
  it("prices every line from the product rows; the cart only names products and quantities", async () => {
    const a = await company();
    const soap = await product(a.tenantId, { priceMinor: 1_250 });
    const candle = await product(a.tenantId, { name: "Candle", priceMinor: 900 });
    const started = await startStoreCheckout(t.db, a.payments, {
      tenantId: a.tenantId,
      cartId: cartId(),
      // A forged price in the cart is simply not read.
      lines: [
        { productId: soap.id, quantity: 2, priceMinor: 1 },
        { productId: candle.id, quantity: 1, unitPriceMinor: 1 },
      ],
      businessName: "Green Acres",
      successUrl: (id) => `https://app.test/thanks/${id}`,
      cancelUrl: "https://app.test/store",
    });
    const session = a.sessions.at(-1)!;
    expect(session.amount).toBe(2 * 1_250 + 900);
    expect(session.lines).toEqual([
      { name: "Pine soap", unitAmountMinor: 1_250, quantity: 2 },
      { name: "Candle", unitAmountMinor: 900, quantity: 1 },
    ]);
    expect(session.accountId).toBe(a.accountId);
    expect(session.successUrl).toBe(`https://app.test/thanks/${started.checkoutId}`);
    // Stripe closes the page half an hour from now (its shortest), with a few seconds for the clock.
    expect(session.expiresAt - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(1800);
    expect(session.expiresAt - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(1831);
    const row = await checkoutRow(started.checkoutId);
    expect(row.amount).toBe(3_400);
    expect(row.status).toBe("open");
  });

  it("refuses a cart naming another company's product (the price lookup's company check)", async () => {
    const a = await company();
    const b = await company();
    const aSoap = await product(a.tenantId, { priceMinor: 5_000 });
    const error = await checkout(b, [{ productId: aSoap.id, quantity: 1 }]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreRefusal);
    expect((error as StoreRefusal).code).toBe("not_found");
    expect(b.sessions.length).toBe(0);
  });

  it("refuses a hidden or removed product, and one company's cart mixing currencies", async () => {
    const a = await company();
    const hidden = await product(a.tenantId);
    await updateStoreProduct(t.db, a.tenantId, hidden.id, { status: "inactive" });
    await expect(checkout(a, [{ productId: hidden.id, quantity: 1 }])).rejects.toThrow(/isn't for sale/);
    const usd = await product(a.tenantId);
    const cad = await product(a.tenantId, { currency: "cad" });
    await expect(checkout(a, [{ productId: usd.id, quantity: 1 }, { productId: cad.id, quantity: 1 }])).rejects.toThrow(/different currencies/);
  });

  it("gives the same page to the same cart pressed twice, and replaces it when the cart changes", async () => {
    const a = await company();
    const soap = await product(a.tenantId, { stock: 10 });
    const cart = cartId();
    const first = await checkout(a, [{ productId: soap.id, quantity: 1 }], cart);
    const again = await checkout(a, [{ productId: soap.id, quantity: 1 }], cart);
    expect(again.checkoutId).toBe(first.checkoutId);
    expect(again.reused).toBe(true);
    expect(a.sessions.length).toBe(1);
    expect(await stockOf(soap.id)).toBe(9);
    const changed = await checkout(a, [{ productId: soap.id, quantity: 3 }], cart);
    expect(changed.checkoutId).not.toBe(first.checkoutId);
    // The older page is closed at Stripe, and its one soap is back.
    expect(a.expired).toContain((await checkoutRow(first.checkoutId)).sessionId);
    expect((await checkoutRow(first.checkoutId)).status).toBe("expired");
    expect(await stockOf(soap.id)).toBe(7);
  });

  it("refuses a card payment below the currency's minimum, and a business not taking payments", async () => {
    const a = await company();
    const gum = await product(a.tenantId, { priceMinor: 20 });
    await expect(checkout(a, [{ productId: gum.id, quantity: 1 }])).rejects.toThrow(/smallest order/);
    const off = { tenantId: a.tenantId, payments: fakePayments({ ready: false }).payments };
    await expect(checkout(off, [{ productId: gum.id, quantity: 5 }])).rejects.toThrow(/isn't taking orders online/);
  });
});

describe("stock: held at checkout, given back once, never oversold", () => {
  it("sells exactly the stock to many customers at once (3 left, 8 try)", async () => {
    const a = await company();
    const soap = await product(a.tenantId, { stock: 3 });
    const tries = await Promise.allSettled(Array.from({ length: 8 }, () => checkout(a, [{ productId: soap.id, quantity: 1 }])));
    const won = tries.filter((r) => r.status === "fulfilled");
    const lost = tries.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(won.length).toBe(3);
    expect(lost.length).toBe(5);
    for (const r of lost) expect((r.reason as StoreRefusal).code).toBe("sold_out");
    expect(await stockOf(soap.id)).toBe(0);
    expect((await listPublicStoreProducts(t.db, a.tenantId))[0]!.soldOut).toBe(true);
  });

  it("never lets two customers both take more than is left (2 left, two want 2)", async () => {
    const a = await company();
    const soap = await product(a.tenantId, { stock: 2 });
    const tries = await Promise.allSettled([checkout(a, [{ productId: soap.id, quantity: 2 }]), checkout(a, [{ productId: soap.id, quantity: 2 }])]);
    expect(tries.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect(await stockOf(soap.id)).toBe(0);
  });

  it("gives stock back when Stripe closes the page — once, however often it says so", async () => {
    const a = await company();
    const soap = await product(a.tenantId, { stock: 5 });
    const started = await checkout(a, [{ productId: soap.id, quantity: 2 }]);
    expect(await stockOf(soap.id)).toBe(3);
    const row = await checkoutRow(started.checkoutId);
    const expired = sessionEvent("checkout.session.expired", a.accountId, row);
    expect((await webhook(expired)).outcome?.outcome).toBe("expired");
    expect(await stockOf(soap.id)).toBe(5);
    // A replay of the same event, and a second (new-id) expiry: nothing more comes back.
    expect((await webhook(expired)).ledger).toBe("duplicate");
    await webhook(sessionEvent("checkout.session.expired", a.accountId, row));
    expect(await stockOf(soap.id)).toBe(5);
  });

  it("gives back stock held by a page past its hour that Stripe never reported", async () => {
    const a = await company();
    const soap = await product(a.tenantId, { stock: 1 });
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await checkout(a, [{ productId: soap.id, quantity: 1 }], cartId(), longAgo);
    expect(await stockOf(soap.id)).toBe(0);
    expect(await releaseLapsedStoreCheckouts(t.db, a.tenantId)).toBe(1);
    expect(await stockOf(soap.id)).toBe(1);
    // …so the next customer can buy it.
    await checkout(a, [{ productId: soap.id, quantity: 1 }]);
  });
});

describe("a price changed after checkout: the edit rule and the hour", () => {
  it("closes every open page with the product in when its price changes, and gives their stock back", async () => {
    const a = await company();
    const soap = await product(a.tenantId, { priceMinor: 1_000, stock: 4 });
    const other = await product(a.tenantId, { name: "Other", priceMinor: 700 });
    const withSoap = await checkout(a, [{ productId: soap.id, quantity: 1 }]);
    const without = await checkout(a, [{ productId: other.id, quantity: 1 }]);
    await updateStoreProduct(t.db, a.tenantId, soap.id, { priceMinor: 1_500 }, { payments: a.payments });
    expect((await checkoutRow(withSoap.checkoutId)).status).toBe("expired");
    expect((await checkoutRow(without.checkoutId)).status).toBe("open");
    expect(await stockOf(soap.id)).toBe(4);
    // A new checkout charges the new price.
    await checkout(a, [{ productId: soap.id, quantity: 1 }]);
    expect(a.sessions.at(-1)!.amount).toBe(1_500);
  });

  it("records a payment that raced the edit at the price the customer was shown, and takes the stock again", async () => {
    const a = await company();
    const soap = await product(a.tenantId, { priceMinor: 1_000, stock: 4 });
    const started = await checkout(a, [{ productId: soap.id, quantity: 1 }]);
    const row = await checkoutRow(started.checkoutId);
    await updateStoreProduct(t.db, a.tenantId, soap.id, { priceMinor: 1_500 }, { payments: a.payments });
    expect(await stockOf(soap.id)).toBe(4);
    const paid = await webhook(sessionEvent("checkout.session.completed", a.accountId, row));
    expect(paid.outcome?.outcome).toBe("recorded");
    const [order] = await ordersOf(a.tenantId);
    expect(Number(order!.totalMinor)).toBe(1_000);
    expect(await stockOf(soap.id)).toBe(3);
  });

  it("flags an order paid after its stock ran out — the money moved, the count stays at zero", async () => {
    const a = await company();
    const soap = await product(a.tenantId, { stock: 1 });
    const first = await checkout(a, [{ productId: soap.id, quantity: 1 }]);
    const row = await checkoutRow(first.checkoutId);
    await updateStoreProduct(t.db, a.tenantId, soap.id, { priceMinor: 2_000 }, { payments: a.payments });
    await checkout(a, [{ productId: soap.id, quantity: 1 }]);
    expect(await stockOf(soap.id)).toBe(0);
    const late = await webhook(sessionEvent("checkout.session.completed", a.accountId, row));
    expect(late.outcome?.outcome).toBe("recorded");
    expect(await stockOf(soap.id)).toBe(0);
    const [order] = await ordersOf(a.tenantId);
    expect(order!.oversoldAt).not.toBeNull();
    expect(order!.flag).toBeNull();
    expect((await alertsOf(a.tenantId)).map((x) => x.kind)).toContain("oversold");
  });
});

describe("the webhook: an order only for this company's checkout, in exactly its amount, once", () => {
  it("writes the order, numbered per company, from the checkout's priced lines — and emails once", async () => {
    const a = await company();
    const b = await company();
    const soap = await product(a.tenantId, { priceMinor: 1_250, stock: 5 });
    const started = await checkout(a, [{ productId: soap.id, quantity: 2 }]);
    const row = await checkoutRow(started.checkoutId);
    const placed: StoreOrderPlaced[] = [];
    const event = sessionEvent("checkout.session.completed", a.accountId, row);
    const result = await webhook(event, { onOrder: (order) => void placed.push(order) });
    expect(result.outcome?.outcome).toBe("recorded");
    const [order] = await ordersOf(a.tenantId);
    expect(order!.orderNumber).toMatch(/^ORD-\d{8}-000001-\d{2}$/);
    expect(order!.email).toBe("buyer@example.test");
    expect(Number(order!.totalMinor)).toBe(2_500);
    expect(order!.stripePaymentIntentId).toBe(`pi_${row.id}`);
    const items = await t.db.select().from(orderItems).where(eq(orderItems.orderId, order!.id));
    expect(items.map((i) => [i.name, i.quantity, Number(i.unitPriceMinor)])).toEqual([["Pine soap", 2, 1_250]]);
    expect(placed.length).toBe(1);
    expect((await storeCheckoutStatus(t.db, a.tenantId, row.id))?.orderNumber).toBe(order!.orderNumber);
    // Another company's first order is its own number 1.
    const bSoap = await product(b.tenantId);
    const bRow = await checkoutRow((await checkout(b, [{ productId: bSoap.id, quantity: 1 }])).checkoutId);
    await webhook(sessionEvent("checkout.session.completed", b.accountId, bRow));
    expect((await ordersOf(b.tenantId))[0]!.orderNumber).toMatch(/-000001-/);
    // Stock was taken at checkout, not again at payment.
    expect(await stockOf(soap.id)).toBe(3);
  });

  it("records a replay once: the same event (the ledger), and the same payment by another event (the order's key)", async () => {
    const a = await company();
    const soap = await product(a.tenantId);
    const row = await checkoutRow((await checkout(a, [{ productId: soap.id, quantity: 1 }])).checkoutId);
    const placed: StoreOrderPlaced[] = [];
    const event = sessionEvent("checkout.session.completed", a.accountId, row);
    await webhook(event, { onOrder: (o) => void placed.push(o) });
    expect((await webhook(event, { onOrder: (o) => void placed.push(o) })).ledger).toBe("duplicate");
    const other = await webhook(sessionEvent("checkout.session.async_payment_succeeded", a.accountId, row), { onOrder: (o) => void placed.push(o) });
    expect(other.outcome?.outcome).toBe("duplicate");
    expect((await ordersOf(a.tenantId)).length).toBe(1);
    expect(placed.length).toBe(1);
  });

  it("refuses forged metadata naming another company's checkout: no order anywhere, the owner told", async () => {
    const a = await company();
    const b = await company();
    const aSoap = await product(a.tenantId, { priceMinor: 4_000 });
    const aRow = await checkoutRow((await checkout(a, [{ productId: aSoap.id, quantity: 1 }])).checkoutId);
    // Money taken on B's own account, with metadata naming A's checkout.
    const forged = sessionEvent("checkout.session.completed", b.accountId, aRow, { metadata: { storeCheckoutId: aRow.id, tenantId: a.tenantId } });
    const result = await webhook(forged);
    expect(result.outcome).toMatchObject({ outcome: "refused", reason: "unknown_checkout" });
    expect((await ordersOf(a.tenantId)).length).toBe(0);
    expect((await ordersOf(b.tenantId)).length).toBe(0);
    expect((await checkoutRow(aRow.id)).status).toBe("open");
    expect((await alertsOf(b.tenantId)).map((x) => x.kind)).toEqual(["unknown_checkout"]);
    expect((await alertsOf(a.tenantId)).length).toBe(0);
  });

  it("ignores an event from an account no company connected", async () => {
    const a = await company();
    const soap = await product(a.tenantId);
    const row = await checkoutRow((await checkout(a, [{ productId: soap.id, quantity: 1 }])).checkoutId);
    expect((await webhook(sessionEvent("checkout.session.completed", "acct_nobody", row))).ledger).toBe("ignored");
    expect((await ordersOf(a.tenantId)).length).toBe(0);
  });

  it("refuses an amount (or currency) that isn't exactly the checkout's, and lists it under Needs your attention", async () => {
    const a = await company();
    const soap = await product(a.tenantId, { priceMinor: 1_000 });
    const row = await checkoutRow((await checkout(a, [{ productId: soap.id, quantity: 1 }])).checkoutId);
    const short = await webhook(sessionEvent("checkout.session.completed", a.accountId, row, { amount: 999 }));
    expect(short.outcome).toMatchObject({ outcome: "refused", reason: "amount_mismatch" });
    const euros = await webhook(sessionEvent("checkout.session.completed", a.accountId, row, { currency: "eur" }));
    expect(euros.outcome).toMatchObject({ outcome: "refused", reason: "currency_mismatch" });
    expect((await ordersOf(a.tenantId)).length).toBe(0);
    const { open } = await listStoreAlerts(t.db, a.tenantId);
    expect(open.map((x) => x.kind).sort()).toEqual(["amount_mismatch", "currency_mismatch"]);
    expect(open.find((x) => x.kind === "amount_mismatch")!.message).toContain("$9.99 where $10.00 was asked");
  });

  it("holds a bank payment's stock until it clears, and gives it back if it fails", async () => {
    const a = await company();
    const soap = await product(a.tenantId, { stock: 2 });
    const row = await checkoutRow((await checkout(a, [{ productId: soap.id, quantity: 1 }])).checkoutId);
    expect((await webhook(sessionEvent("checkout.session.completed", a.accountId, row, { paid: false }))).outcome?.outcome).toBe("pending");
    expect((await checkoutRow(row.id)).status).toBe("processing");
    // The sweep never gives back a payment on its way.
    expect(await releaseLapsedStoreCheckouts(t.db, a.tenantId, new Date(Date.now() + 3 * 60 * 60 * 1000))).toBe(0);
    expect((await storeCheckoutStatus(t.db, a.tenantId, row.id))?.state).toBe("processing");
    expect((await webhook(sessionEvent("checkout.session.async_payment_succeeded", a.accountId, row))).outcome?.outcome).toBe("recorded");
    expect((await ordersOf(a.tenantId)).length).toBe(1);
    expect(await stockOf(soap.id)).toBe(1);

    const row2 = await checkoutRow((await checkout(a, [{ productId: soap.id, quantity: 1 }])).checkoutId);
    expect(await stockOf(soap.id)).toBe(0);
    await webhook(sessionEvent("checkout.session.completed", a.accountId, row2, { paid: false }));
    const failed = await webhook(sessionEvent("checkout.session.async_payment_failed", a.accountId, row2, { paid: false }));
    expect(failed.outcome?.outcome).toBe("released");
    expect(await stockOf(soap.id)).toBe(1);
    expect((await alertsOf(a.tenantId)).map((x) => x.kind)).toContain("bank_payment_failed");
  });
});

describe("refunds and disputes come back onto the order", () => {
  async function paidOrder(priceMinor = 10_000) {
    const a = await company();
    const soap = await product(a.tenantId, { priceMinor });
    const row = await checkoutRow((await checkout(a, [{ productId: soap.id, quantity: 1 }])).checkoutId);
    await webhook(sessionEvent("checkout.session.completed", a.accountId, row));
    return { a, pi: `pi_${row.id}` };
  }

  it("follows a part refund, then the rest, and a replay changes nothing", async () => {
    const { a, pi } = await paidOrder(10_000);
    const part = chargeEvent("charge.refunded", a.accountId, { payment_intent: pi, amount_refunded: 2_500, currency: "usd" });
    expect((await webhook(part)).outcome).toMatchObject({ outcome: "refunded", amount: 2_500, whole: false });
    let [order] = await ordersOf(a.tenantId);
    expect(Number(order!.refundedMinor)).toBe(2_500);
    expect(order!.status).toBe("paid");
    expect((await listStoreOrders(t.db, a.tenantId))[0]!.refundedMinor).toBe(2_500);
    // The same running total again (a new event id): nothing more.
    expect((await webhook(chargeEvent("charge.refunded", a.accountId, { payment_intent: pi, amount_refunded: 2_500, currency: "usd" }))).outcome?.outcome).toBe("duplicate");
    expect((await webhook(chargeEvent("charge.refunded", a.accountId, { payment_intent: pi, amount_refunded: 10_000, currency: "usd" }))).outcome).toMatchObject({ outcome: "refunded", amount: 7_500, whole: true });
    [order] = await ordersOf(a.tenantId);
    expect(Number(order!.refundedMinor)).toBe(10_000);
    expect(order!.status).toBe("refunded");
    expect((await alertsOf(a.tenantId)).filter((x) => x.kind === "refunded").length).toBe(2);
  });

  it("never counts more refunded than was paid, and ignores a refund on another company's payment", async () => {
    const { a, pi } = await paidOrder(5_000);
    const b = await company();
    expect((await webhook(chargeEvent("charge.refunded", b.accountId, { payment_intent: pi, amount_refunded: 5_000, currency: "usd" }))).outcome?.outcome).toBe("ignored");
    await webhook(chargeEvent("charge.refunded", a.accountId, { payment_intent: pi, amount_refunded: 9_999_999, currency: "usd" }));
    expect(Number((await ordersOf(a.tenantId))[0]!.refundedMinor)).toBe(5_000);
  });

  it("flags a dispute, marks one lost, and clears one won", async () => {
    const { a, pi } = await paidOrder();
    expect((await webhook(chargeEvent("charge.dispute.created", a.accountId, { payment_intent: pi, amount: 10_000, currency: "usd" }))).outcome).toMatchObject({ flag: "disputed" });
    expect((await webhook(chargeEvent("charge.dispute.closed", a.accountId, { payment_intent: pi, amount: 10_000, currency: "usd", status: "won" }))).outcome).toMatchObject({ flag: null });
    expect((await ordersOf(a.tenantId))[0]!.flag).toBeNull();
    await webhook(chargeEvent("charge.dispute.created", a.accountId, { payment_intent: pi, amount: 10_000, currency: "usd" }));
    expect((await webhook(chargeEvent("charge.dispute.closed", a.accountId, { payment_intent: pi, amount: 10_000, currency: "usd", status: "lost" }))).outcome).toMatchObject({ flag: "dispute_lost" });
    expect((await ordersOf(a.tenantId))[0]!.flag).toBe("dispute_lost");
    expect((await alertsOf(a.tenantId)).map((x) => x.kind)).toEqual(expect.arrayContaining(["dispute_opened", "dispute_lost"]));
  });

  it("asks for no webhook event invoicing's endpoint doesn't already send", () => {
    const invoiceEvents = [
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "checkout.session.async_payment_failed",
      "checkout.session.expired",
      "payment_intent.succeeded",
      "charge.refunded",
      "charge.dispute.created",
      "charge.dispute.closed",
    ];
    for (const type of STORE_CARD_EVENT_TYPES) expect(invoiceEvents).toContain(type);
  });
});

describe("the order emails", () => {
  it("are from \"{business} via {app}\", reply to the owner, and keep typed words out of the subject", () => {
    const mail = storeOrderEmails(
      {
        tenantId: "co",
        orderId: "o1",
        orderNumber: "ORD-20261017-000001-42",
        email: "buyer@example.test",
        totalMinor: 2_500,
        currency: "usd",
        shippingMinor: 0,
        shipTo: null,
        lines: [{ name: "Pine soap", quantity: 2, unitPriceMinor: 1_250 }],
        placedAt: new Date(),
      },
      { businessName: 'Green "Acres" <x>', appName: "Igloo", replyTo: "owner@green.test", ownerEmail: "owner@green.test", ordersUrl: "https://app.test/app/store" },
    );
    expect(mail.fromName).toBe("Green Acres x via Igloo");
    expect(mail.customer).toMatchObject({ to: "buyer@example.test", replyTo: "owner@green.test" });
    expect(mail.customer!.subject).toBe("Your order from Green Acres x — ORD-20261017-000001-42");
    expect(mail.customer!.text).toContain("2 × Pine soap — $25.00");
    expect(mail.customer!.text).toContain("Sent for Green Acres x by Igloo.");
    expect(mail.owner).toMatchObject({ to: "owner@green.test", replyTo: "buyer@example.test" });
  });
});

describe("sql/upgrade-0.1-to-0.2.sql", () => {
  it("adds the store to a 0.1 database, keeps the site's existing orders, and runs twice", async () => {
    const tables = STORE_TABLES.filter((table) => table !== storeCheckouts && table !== storeAlerts && table !== storeSettings);
    const v02 = schemaDdl(tables).concat(schemaDdl([storeCheckouts, storeAlerts, storeSettings]));
    const v01 = schemaDdl(tables)
      .filter((s) => !s.includes("store_"))
      .map((s) => s.replace(/,\n {2}"refunded_minor" bigint NOT NULL DEFAULT 0/, "").replace(/,\n {2}"flag" text/, "").replace(/,\n {2}"flagged_at" timestamp with time zone/, "").replace(/,\n {2}"(oversold_at|receipt_sent_at|notice_sent_at)" timestamp with time zone/g, ""));
    expect(v01.join("\n")).not.toMatch(/refunded_minor|"flag"/);
    const db = new PGlite();
    for (const s of v01) await db.exec(s);
    await db.exec(
      `insert into orders (id, tenant_id, idempotency_key, order_number, email, subtotal_minor, shipping_minor, tax_minor, discount_minor, total_minor) values ('o1', '*', 'payment_intent:pi_1', 'SHOP-1', 'a@b.test', 100, 0, 0, 0, 100)`,
    );
    const upgrade = readFileSync(join(__dirname, "..", "..", "sql", "upgrade-0.1-to-0.2.sql"), "utf8");
    await db.exec(upgrade);
    await db.exec(upgrade);
    const fresh = new PGlite();
    for (const s of v02) await fresh.exec(s);
    const shape = async (d: PGlite) => {
      const columns = await d.query<{ t: string; c: string; ty: string; n: string; df: string | null }>(
        `select table_name as t, column_name as c, data_type as ty, is_nullable as n, column_default as df from information_schema.columns where table_name in ('orders','store_checkouts','store_alerts','store_settings') order by 1, 2`,
      );
      const indexes = await d.query<{ def: string }>(`select indexdef as def from pg_indexes where tablename in ('orders','store_checkouts','store_alerts','store_settings') order by indexname`);
      return [...columns.rows.map((r) => `${r.t}.${r.c} ${r.ty} ${r.n} ${r.df ?? ""}`), ...indexes.rows.map((r) => r.def)];
    };
    expect(await shape(db)).toEqual(await shape(fresh));
    expect((await db.query(`select id, refunded_minor, flag from orders`)).rows).toEqual([{ id: "o1", refunded_minor: 0, flag: null }]);
    await db.close();
    await fresh.close();
  });
});

// Every assertion above on "this company's" rows is by tenant; one guard that
// nothing leaked into the site's own catalog or orders.
describe("the site's own (\"*\") rows", () => {
  it("are untouched by every store above", async () => {
    expect((await t.db.select().from(orders).where(eq(orders.tenantId, "*"))).length).toBe(0);
    expect((await t.db.select().from(storeCheckouts).where(and(eq(storeCheckouts.tenantId, "*")))).length).toBe(0);
  });
});

// --- The store review's findings, as regressions --------------------------------

describe("stock is two numbers: on the shelf, and held by open checkouts (review R3, R8)", () => {
  it("R3: an owner's edit while carts hold some keeps the hold, and a new shelf count is the shelf — not shelf minus carts", async () => {
    const a = await company();
    const soap = await product(a.tenantId, { stock: 5 });
    const row = await checkoutRow((await checkout(a, [{ productId: soap.id, quantity: 2 }])).checkoutId);
    expect(await shelfOf(soap.id)).toEqual({ shelf: 5, held: 2 });
    // The form saves the name only: the stock isn't sent, so nothing about it moves.
    await updateStoreProduct(t.db, a.tenantId, soap.id, { name: "Pine soap bar" });
    expect(await shelfOf(soap.id)).toEqual({ shelf: 5, held: 2 });
    // Three more come in: the owner counts 8 on the shelf, from the 5 the form showed.
    await updateStoreProduct(t.db, a.tenantId, soap.id, { stock: 8, stockWas: 5 });
    expect(await shelfOf(soap.id)).toEqual({ shelf: 8, held: 2 });
    expect(await stockOf(soap.id)).toBe(6);
    // The cart closes unpaid: only the hold comes back; the shelf is what the owner said.
    await webhook(sessionEvent("checkout.session.expired", a.accountId, row));
    expect(await shelfOf(soap.id)).toEqual({ shelf: 8, held: 0 });
    // And a payment takes it off both.
    const paid = await checkoutRow((await checkout(a, [{ productId: soap.id, quantity: 3 }])).checkoutId);
    await webhook(sessionEvent("checkout.session.completed", a.accountId, paid));
    expect(await shelfOf(soap.id)).toEqual({ shelf: 5, held: 0 });
  });

  it("R8: a sale while the owner is editing is never typed over — the save is refused in words", async () => {
    const a = await company();
    const soap = await product(a.tenantId, { stock: 5 });
    // The owner opens the form at 5 on the shelf; meanwhile a customer buys 2.
    const row = await checkoutRow((await checkout(a, [{ productId: soap.id, quantity: 2 }])).checkoutId);
    await webhook(sessionEvent("checkout.session.completed", a.accountId, row));
    expect(await shelfOf(soap.id)).toEqual({ shelf: 3, held: 0 });
    const error = await updateStoreProduct(t.db, a.tenantId, soap.id, { stock: 6, stockWas: 5 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreRefusal);
    expect((error as Error).message).toBe("2 sold while you were editing — 3 are on the shelf now. Check the number and save again.");
    expect(await shelfOf(soap.id)).toEqual({ shelf: 3, held: 0 });
    // From the right number, it saves.
    await updateStoreProduct(t.db, a.tenantId, soap.id, { stock: 6, stockWas: 3 });
    expect(await shelfOf(soap.id)).toEqual({ shelf: 6, held: 0 });
  });

  it("'Release held items' closes the checkouts holding it, at Stripe too, and the stock is back for sale", async () => {
    const a = await company();
    const soap = await product(a.tenantId, { stock: 3 });
    await checkout(a, [{ productId: soap.id, quantity: 1 }]);
    await checkout(a, [{ productId: soap.id, quantity: 2 }]);
    expect(await stockOf(soap.id)).toBe(0);
    const released = await releaseHeldStock(t.db, a.payments, a.tenantId, soap.id);
    expect(released?.released).toBe(2);
    expect(released?.product).toMatchObject({ stock: 3, held: 0 });
    expect(a.expired.length).toBe(2);
    const b = await company();
    expect(await releaseHeldStock(t.db, b.payments, b.tenantId, soap.id)).toBeNull();
  });
});

describe("cart spam can't tie up the stock", () => {
  it("holds for 30 minutes and gives back at 31", async () => {
    const a = await company();
    const soap = await product(a.tenantId, { stock: 1 });
    const opened = new Date(Date.now() - 30.5 * 60 * 1000);
    await checkout(a, [{ productId: soap.id, quantity: 1 }], cartId(), opened);
    expect(await releaseLapsedStoreCheckouts(t.db, a.tenantId, new Date(opened.getTime() + 30.9 * 60 * 1000))).toBe(0);
    expect(await releaseLapsedStoreCheckouts(t.db, a.tenantId, new Date(opened.getTime() + 31.1 * 60 * 1000))).toBe(1);
    expect(await stockOf(soap.id)).toBe(1);
  });

  it("lets one cart take at most the product's per-order cap (default 5; the owner can change it)", async () => {
    const a = await company();
    const soap = await product(a.tenantId, { stock: 50 });
    await expect(checkout(a, [{ productId: soap.id, quantity: 6 }])).rejects.toThrow("You can buy up to 5 of Pine soap in one order.");
    await updateStoreProduct(t.db, a.tenantId, soap.id, { maxPerOrder: 10 });
    await checkout(a, [{ productId: soap.id, quantity: 6 }]);
    expect(await stockOf(soap.id)).toBe(44);
  });

  it("lets one visitor have at most 3 open checkouts, and open at most 5 an hour", async () => {
    const a = await company();
    const soap = await product(a.tenantId, { stock: 100 });
    const visitor = "198.51.100.7";
    for (let i = 0; i < 3; i += 1) await checkout(a, [{ productId: soap.id, quantity: 1 }], cartId(), undefined, visitor);
    await expect(checkout(a, [{ productId: soap.id, quantity: 1 }], cartId(), undefined, visitor)).rejects.toThrow("You have 3 checkouts open already. Finish or close one, then try again.");
    // Another visitor is not held up.
    await checkout(a, [{ productId: soap.id, quantity: 1 }], cartId(), undefined, "198.51.100.8");
    // Closing them makes room for open ones, but not past 5 opened in the hour.
    await releaseHeldStock(t.db, a.payments, a.tenantId, soap.id);
    await checkout(a, [{ productId: soap.id, quantity: 1 }], cartId(), undefined, visitor);
    await checkout(a, [{ productId: soap.id, quantity: 1 }], cartId(), undefined, visitor);
    await expect(checkout(a, [{ productId: soap.id, quantity: 1 }], cartId(), undefined, visitor)).rejects.toThrow("That's a lot of checkouts in an hour.");
  });

  it("puts every caller with no network address in ONE shared visitor — never unlimited", async () => {
    const a = await company();
    const soap = await product(a.tenantId, { stock: 100 });
    for (let i = 0; i < 3; i += 1) await checkout(a, [{ productId: soap.id, quantity: 1 }], cartId(), undefined, null);
    await expect(checkout(a, [{ productId: soap.id, quantity: 1 }], cartId(), undefined, null)).rejects.toThrow(/3 checkouts open already/);
    expect(storeVisitorKey(new Request("https://x.test/", { headers: { "x-forwarded-for": "10.0.0.1, 2001:db8:aa:bb:1:2:3:4" } }))).toBe("2001:db8:aa:bb::/64");
    expect(storeVisitorKey(new Request("https://x.test/"))).toBeNull();
  });
});

describe("a customer can't lock themselves out of the last one (review R1)", () => {
  it("R1: the same cart gets its page back, and its own hold counts as its own on the store page and at Check out", async () => {
    const a = await company();
    const soap = await product(a.tenantId, { stock: 2 });
    const cart = cartId();
    const visitor = "192.0.2.10";
    const first = await checkout(a, [{ productId: soap.id, quantity: 2 }], cart, undefined, visitor);
    expect(await stockOf(soap.id)).toBe(0);
    // Back on the store page: not sold out to THIS cart; sold out to anyone else.
    expect((await listPublicStoreProducts(t.db, a.tenantId, { cartId: cart }))[0]).toMatchObject({ soldOut: false, fewLeft: 2 });
    expect((await listPublicStoreProducts(t.db, a.tenantId, { cartId: cartId() }))[0]!.soldOut).toBe(true);
    // Pressing Check out again: the same page, not "sold out".
    const again = await checkout(a, [{ productId: soap.id, quantity: 2 }], cart, undefined, visitor);
    expect(again).toMatchObject({ checkoutId: first.checkoutId, reused: true });
    // Taking one out: a new page for 1, the old one closed, its hold replaced.
    const fewer = await checkout(a, [{ productId: soap.id, quantity: 1 }], cart, undefined, visitor);
    expect(fewer.checkoutId).not.toBe(first.checkoutId);
    expect(await shelfOf(soap.id)).toEqual({ shelf: 2, held: 1 });
    // And back up to 2 again: its own 1 plus the 1 free.
    await checkout(a, [{ productId: soap.id, quantity: 2 }], cart, undefined, visitor);
    expect(await shelfOf(soap.id)).toEqual({ shelf: 2, held: 2 });
  });
});

describe("no lock is held while Stripe is called", () => {
  it("lets the product change while Stripe opens the page, then closes that page in words", async () => {
    const a = await company();
    const soap = await product(a.tenantId, { stock: 5, priceMinor: 1_000 });
    let edited = false;
    const slow: StoreCardPayments = {
      ...a.payments,
      async createSession(input) {
        // Runs OUTSIDE the checkout's transaction: on one PGlite connection this would hang if a lock were held.
        await updateStoreProduct(t.db, a.tenantId, soap.id, { priceMinor: 1_200 }, { payments: a.payments });
        edited = true;
        return a.payments.createSession(input);
      },
    };
    await expect(checkout({ tenantId: a.tenantId, payments: slow }, [{ productId: soap.id, quantity: 1 }])).rejects.toThrow("Something in your cart just changed.");
    expect(edited).toBe(true);
    expect(await shelfOf(soap.id)).toEqual({ shelf: 5, held: 0 });
    expect(a.expired.length).toBe(1);
  });

  it("gives the hold back, in a transaction of its own, when Stripe fails", async () => {
    const a = await company();
    const soap = await product(a.tenantId, { stock: 2 });
    const broken: StoreCardPayments = { ...a.payments, createSession: async () => Promise.reject(new Error("stripe is down")) };
    await expect(checkout({ tenantId: a.tenantId, payments: broken }, [{ productId: soap.id, quantity: 2 }])).rejects.toThrow("stripe is down");
    expect(await shelfOf(soap.id)).toEqual({ shelf: 2, held: 0 });
    const rows = await t.db.select().from(storeCheckouts).where(eq(storeCheckouts.tenantId, a.tenantId));
    expect(rows.map((r) => [r.status, r.stockHeld])).toEqual([["failed", false]]);
  });
});

describe("physical goods: shipping and the address", () => {
  it("adds the owner's flat shipping as a server line, asks Stripe for an address in the owner's countries, and keeps it on the order", async () => {
    const a = await company();
    await saveStoreSettings(t.db, a.tenantId, { fulfilment: "ship", shippingMinor: 700, shipCountries: ["us", "CA"], currency: "usd" });
    const soap = await product(a.tenantId, { priceMinor: 1_000 });
    const row = await checkoutRow((await checkout(a, [{ productId: soap.id, quantity: 2 }])).checkoutId);
    const session = a.sessions.at(-1)!;
    expect(session.amount).toBe(2_700);
    expect(session.lines.at(-1)).toEqual({ name: "Shipping", unitAmountMinor: 700, quantity: 1 });
    expect(session.shippingCountries).toEqual(["US", "CA"]);
    expect(row.amount).toBe(2_700);
    const event = sessionEvent("checkout.session.completed", a.accountId, row);
    (event.data.object as Record<string, unknown>).collected_information = {
      shipping_details: { name: "Robin Buyer", address: { line1: "1 Elm St", line2: null, city: "Provo", state: "UT", postal_code: "84601", country: "US" } },
    };
    expect((await webhook(event)).outcome?.outcome).toBe("recorded");
    const [order] = await listStoreOrders(t.db, a.tenantId);
    expect(order).toMatchObject({ totalMinor: 2_700, shippingMinor: 700, shipTo: { name: "Robin Buyer", line1: "1 Elm St", city: "Provo", region: "UT", postalCode: "84601", country: "US" } });
    const [raw] = await ordersOf(a.tenantId);
    expect(Number(raw!.subtotalMinor)).toBe(2_000);
    // Shipping is counted in the exact amount: Stripe reporting the goods alone is refused.
    const row2 = await checkoutRow((await checkout(a, [{ productId: soap.id, quantity: 1 }])).checkoutId);
    expect((await webhook(sessionEvent("checkout.session.completed", a.accountId, row2, { amount: 1_000 }))).outcome).toMatchObject({ reason: "amount_mismatch" });
  });

  it("asks for no address with pickup or digital only, and says whether prices include tax", async () => {
    const a = await company();
    const soap = await product(a.tenantId);
    await checkout(a, [{ productId: soap.id, quantity: 1 }]);
    expect(a.sessions.at(-1)!.shippingCountries).toBeNull();
    expect(await getStoreSettings(t.db, a.tenantId)).toMatchObject({ fulfilment: "pickup", pricesIncludeTax: true });
    await expect(saveStoreSettings(t.db, a.tenantId, { shipCountries: ["USA"] })).rejects.toThrow(/two-letter codes/);
  });
});

describe("the emails, once each", () => {
  it("sends what failed on the retry, and only that", async () => {
    const a = await company();
    const soap = await product(a.tenantId);
    const row = await checkoutRow((await checkout(a, [{ productId: soap.id, quantity: 1 }])).checkoutId);
    const calls: StoreEmailsOwed[] = [];
    let noticeWorks = false;
    const onOrder = (_order: StoreOrderPlaced, owed: StoreEmailsOwed) => {
      calls.push(owed);
      return { receipt: true, notice: noticeWorks };
    };
    const event = sessionEvent("checkout.session.completed", a.accountId, row);
    // The owner's notice fails: the order is written, the webhook asks Stripe to retry.
    expect((await webhook(event, { onOrder })).ledger).toBe("failed");
    expect((await ordersOf(a.tenantId)).length).toBe(1);
    noticeWorks = true;
    expect((await webhook(event, { onOrder })).ledger).toBe("processed");
    expect((await webhook(event, { onOrder })).ledger).toBe("duplicate");
    expect(calls).toEqual([
      { receipt: true, notice: true },
      { receipt: false, notice: true },
    ]);
  });
});

describe("refunds in another currency, and flags kept apart", () => {
  it("refuses a refund reported in a currency the order wasn't paid in", async () => {
    const a = await company();
    const soap = await product(a.tenantId, { priceMinor: 5_000 });
    const row = await checkoutRow((await checkout(a, [{ productId: soap.id, quantity: 1 }])).checkoutId);
    await webhook(sessionEvent("checkout.session.completed", a.accountId, row));
    const refund = await webhook(chargeEvent("charge.refunded", a.accountId, { payment_intent: `pi_${row.id}`, amount_refunded: 5_000, currency: "eur" }));
    expect(refund.outcome).toMatchObject({ outcome: "refused", reason: "currency_mismatch" });
    expect(Number((await ordersOf(a.tenantId))[0]!.refundedMinor)).toBe(0);
  });

  it("keeps an oversold order's mark when the order is also disputed", async () => {
    const a = await company();
    const soap = await product(a.tenantId, { stock: 1 });
    const first = await checkoutRow((await checkout(a, [{ productId: soap.id, quantity: 1 }])).checkoutId);
    await releaseHeldStock(t.db, a.payments, a.tenantId, soap.id);
    await checkout(a, [{ productId: soap.id, quantity: 1 }]);
    await webhook(sessionEvent("checkout.session.completed", a.accountId, first));
    await webhook(chargeEvent("charge.dispute.created", a.accountId, { payment_intent: `pi_${first.id}`, amount: 1_250, currency: "usd" }));
    const [order] = await listStoreOrders(t.db, a.tenantId);
    expect(order).toMatchObject({ oversold: true, flag: "disputed" });
  });
});
