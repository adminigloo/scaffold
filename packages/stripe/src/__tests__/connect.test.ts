import { PGlite } from "@electric-sql/pglite";
import { eq, is, SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STRIPE_API_VERSION, type StripeClient } from "../client.js";
import {
  accountTakesCharges,
  applyAccountUpdate,
  companyAccountParams,
  companyForConnectEvent,
  connectLedgerKey,
  connectedAccountFor,
  createDirectCheckoutSession,
  describePlatformFee,
  disconnectConnectedAccount,
  markAccountDeauthorized,
  platformFeeMinor,
  startConnectOnboarding,
  type StripeDb,
} from "../connect.js";
import { createConnectAdminHandlers } from "../connect-handlers.js";
import { STRIPE_CONNECT_ADMIN_ROUTES } from "../connect-routes.js";
import { runLedgeredEvent } from "../ledger-run.js";
import { stripeConnectedAccounts, stripeEvents } from "../schema.js";
import { verifyStripeSignature } from "../webhook.js";

const dialect = new PgDialect();
function ddl(table: PgTable): string[] {
  const config = getTableConfig(table);
  const literal = (value: unknown) => (is(value, SQL) ? dialect.sqlToQuery(value).sql : String(value));
  const cols = config.columns.map((c) => {
    let line = `"${c.name}" ${c.getSQLType()}`;
    if (c.primary) line += " PRIMARY KEY";
    else if (c.notNull) line += " NOT NULL";
    if (c.default !== undefined) line += ` DEFAULT ${literal(c.default)}`;
    return line;
  });
  const out = [`CREATE TABLE "${config.name}" (${cols.join(", ")})`];
  for (const index of config.indexes) {
    const columns = index.config.columns.map((c) => `"${(c as { name: string }).name}"`).join(", ");
    const where = index.config.where ? ` WHERE ${dialect.sqlToQuery(index.config.where).sql}` : "";
    out.push(`CREATE ${index.config.unique ? "UNIQUE " : ""}INDEX "${index.config.name}" ON "${config.name}" (${columns})${where}`);
  }
  return out;
}

let client: PGlite;
let db: StripeDb;
beforeAll(async () => {
  client = new PGlite();
  for (const table of [stripeEvents, stripeConnectedAccounts]) for (const s of ddl(table)) await client.exec(s);
  db = drizzle(client) as unknown as StripeDb;
});
afterAll(async () => client.close());

/** A Stripe stand-in that records every call: no network, ever. */
function fakeStripe() {
  const calls: { method: string; args: unknown[] }[] = [];
  let accounts = 0;
  const stripe = {
    accounts: {
      create: async (...args: unknown[]) => {
        calls.push({ method: "accounts.create", args });
        accounts += 1;
        return { id: `acct_fake${accounts}_${Math.random().toString(36).slice(2, 8)}`, charges_enabled: false, payouts_enabled: false, details_submitted: false };
      },
      retrieve: async (id: string) => {
        calls.push({ method: "accounts.retrieve", args: [id] });
        return { id, charges_enabled: true, payouts_enabled: true, details_submitted: true };
      },
    },
    accountLinks: {
      create: async (...args: unknown[]) => {
        calls.push({ method: "accountLinks.create", args });
        return { url: "https://connect.stripe.test/setup/abc" };
      },
    },
    checkout: {
      sessions: {
        create: async (...args: unknown[]) => {
          calls.push({ method: "checkout.sessions.create", args });
          return { id: "cs_test_1", url: "https://checkout.stripe.test/c/pay/cs_test_1" };
        },
      },
    },
  };
  const wrapped = { stripe: stripe as unknown as Stripe, appUrl: "https://app.test", apiVersion: STRIPE_API_VERSION } as StripeClient;
  return { client: wrapped, calls };
}

describe("the platform fee", () => {
  it("is exact in cents, rounded DOWN to the whole cent", () => {
    expect(platformFeeMinor(10_000, 0)).toBe(0);
    expect(platformFeeMinor(10_000, 250)).toBe(250); // 2.5% of $100.00 = $2.50
    expect(platformFeeMinor(1_001, 250)).toBe(25); // 25.025¢ → 25¢, never 26¢
    expect(platformFeeMinor(1_039, 250)).toBe(25); // 25.975¢ → 25¢: down, not to the nearest
    expect(platformFeeMinor(1, 9_999)).toBe(0);
    expect(platformFeeMinor(123_456_789, 10_000)).toBe(123_456_789);
    expect(platformFeeMinor(0, 500)).toBe(0);
  });

  it("refuses a rate or an amount that isn't whole", () => {
    expect(() => platformFeeMinor(100, 2.5)).toThrow(RangeError);
    expect(() => platformFeeMinor(100, -1)).toThrow(RangeError);
    expect(() => platformFeeMinor(100, 10_001)).toThrow(RangeError);
    expect(() => platformFeeMinor(10.5, 100)).toThrow(RangeError);
  });

  it("is told to the owner in plain words", () => {
    expect(describePlatformFee(0)).toMatch(/^No fee/);
    expect(describePlatformFee(250)).toContain("2.5% of each payment goes to this site ($2.50 on $100.00)");
  });
});

describe("a company's own account", () => {
  it("is Standard-style through the controller settings, stamped with the company", () => {
    const params = companyAccountParams("co_1", { email: "owner@green.test" });
    expect(params.controller).toEqual({
      stripe_dashboard: { type: "full" },
      fees: { payer: "account" },
      losses: { payments: "stripe" },
      requirement_collection: "stripe",
    });
    expect(params.metadata).toEqual({ tenantId: "co_1" });
    expect(params.email).toBe("owner@green.test");
  });

  it("is made once and reused: a second connect, and a connect after disconnecting, never make a second account", async () => {
    const { client: stripe, calls } = fakeStripe();
    const input = { tenantId: "co_reuse", returnUrl: "https://app.test/app/payments?connected=1", refreshUrl: "https://app.test/app/payments" };
    const first = await startConnectOnboarding(db, stripe, input);
    const second = await startConnectOnboarding(db, stripe, input);
    expect(second.accountId).toBe(first.accountId);
    expect(await disconnectConnectedAccount(db, "co_reuse")).toBe(true);
    expect(accountTakesCharges(await connectedAccountFor(db, "co_reuse"))).toBe(false);
    const third = await startConnectOnboarding(db, stripe, input);
    expect(third.accountId).toBe(first.accountId);
    expect((await connectedAccountFor(db, "co_reuse"))?.disconnectedAt).toBeNull();
    expect(calls.filter((c) => c.method === "accounts.create")).toHaveLength(1);
    const link = calls.find((c) => c.method === "accountLinks.create")!.args[0] as Record<string, string>;
    expect(link).toMatchObject({ account: first.accountId, type: "account_onboarding", return_url: input.returnUrl, refresh_url: input.refreshUrl });
  });

  it("M5: after the company deauthorizes this site, Connect makes a NEW account; the old one still maps to the company", async () => {
    const { client: stripe, calls } = fakeStripe();
    const input = { tenantId: "co_deauth", returnUrl: "https://app.test/r", refreshUrl: "https://app.test/f" };
    const first = await startConnectOnboarding(db, stripe, input);
    expect(await markAccountDeauthorized(db, first.accountId)).toBe("co_deauth");
    expect(await connectedAccountFor(db, "co_deauth")).toBeNull();
    const second = await startConnectOnboarding(db, stripe, input);
    expect(second.accountId).not.toBe(first.accountId);
    const keys = calls.filter((c) => c.method === "accounts.create").map((c) => (c.args[1] as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toEqual(["connect-account:co_deauth:0", "connect-account:co_deauth:1"]);
    // A refund on the OLD account still finds the company.
    expect(await companyForConnectEvent(db, { account: first.accountId })).toMatchObject({ kind: "company", tenantId: "co_deauth" });
    expect((await connectedAccountFor(db, "co_deauth"))?.accountId).toBe(second.accountId);
  });

  it("L4: an account.updated older than the one applied changes nothing", async () => {
    await db.insert(stripeConnectedAccounts).values({ tenantId: "co_order", accountId: "acct_order" });
    const newer = new Date("2026-10-17T12:00:00Z");
    expect(await applyAccountUpdate(db, { id: "acct_order", charges_enabled: true, payouts_enabled: true, details_submitted: true }, newer)).toBe("co_order");
    expect(await applyAccountUpdate(db, { id: "acct_order", charges_enabled: false, payouts_enabled: false, details_submitted: false }, new Date("2026-10-17T11:00:00Z"))).toBeNull();
    expect((await connectedAccountFor(db, "co_order"))?.chargesEnabled).toBe(true);
  });

  it("takes charges only once Stripe says so, from account.updated matched on the account", async () => {
    await db.insert(stripeConnectedAccounts).values({ tenantId: "co_upd", accountId: "acct_upd" });
    expect(accountTakesCharges(await connectedAccountFor(db, "co_upd"))).toBe(false);
    expect(await applyAccountUpdate(db, { id: "acct_upd", charges_enabled: true, payouts_enabled: false, details_submitted: true })).toBe("co_upd");
    const row = await connectedAccountFor(db, "co_upd");
    expect(row).toMatchObject({ chargesEnabled: true, payoutsEnabled: false, detailsSubmitted: true });
    expect(accountTakesCharges(row)).toBe(true);
    expect(await applyAccountUpdate(db, { id: "acct_nobody", charges_enabled: true, payouts_enabled: true, details_submitted: true })).toBeNull();
  });
});

describe("the Connect webhook's company", () => {
  it("is the one that owns event.account; an event from an unknown account is ignored", async () => {
    await db.insert(stripeConnectedAccounts).values({ tenantId: "co_map", accountId: "acct_map" });
    expect(await companyForConnectEvent(db, { account: "acct_map" })).toEqual({ kind: "company", tenantId: "co_map", accountId: "acct_map" });
    expect(await companyForConnectEvent(db, { account: "acct_stranger" })).toEqual({ kind: "ignored", reason: "unknown-account", accountId: "acct_stranger" });
    expect(await companyForConnectEvent(db, {})).toEqual({ kind: "ignored", reason: "no-account", accountId: null });
  });

  it("keys the ledger on the account AND the event", () => {
    expect(connectLedgerKey({ id: "evt_1", account: "acct_a" })).toBe("acct_a:evt_1");
    expect(connectLedgerKey({ id: "evt_1", account: "acct_b" })).not.toBe(connectLedgerKey({ id: "evt_1", account: "acct_a" }));
    expect(() => connectLedgerKey({ id: "evt_1" })).toThrow();
  });

  it("verifies a signed Connect payload with the package's own helper", () => {
    const sdk = new Stripe("sk_test_00000000000000000000000000", { apiVersion: STRIPE_API_VERSION });
    const secret = "whsec_connect_test_secret";
    const body = JSON.stringify({ id: "evt_c1", object: "event", account: "acct_map", type: "account.updated", livemode: false, created: 1, data: { object: {} } });
    const signature = sdk.webhooks.generateTestHeaderString({ payload: body, secret });
    expect(verifyStripeSignature(body, signature, secret, sdk).account).toBe("acct_map");
    expect(() => verifyStripeSignature(body.replace("acct_map", "acct_evil"), signature, secret, sdk)).toThrow();
  });
});

describe("the ledger, as one call", () => {
  it("runs an event replayed twice ONCE", async () => {
    let runs = 0;
    const event = { key: "acct_map:evt_twice", type: "checkout.session.completed", tenantId: "co_map", payload: { id: "evt_twice" } };
    expect(await runLedgeredEvent(db, event, async () => void (runs += 1))).toEqual({ outcome: "processed" });
    expect(await runLedgeredEvent(db, event, async () => void (runs += 1))).toEqual({ outcome: "duplicate" });
    expect(runs).toBe(1);
  });

  it("releases a failed handler so the retry runs it", async () => {
    const event = { key: "acct_map:evt_retry", type: "charge.refunded", tenantId: "co_map", payload: {} };
    const failed = await runLedgeredEvent(db, event, async () => {
      throw new Error("database blinked");
    });
    expect(failed.outcome).toBe("failed");
    let ran = false;
    expect(await runLedgeredEvent(db, event, async () => void (ran = true))).toEqual({ outcome: "processed" });
    expect(ran).toBe(true);
  });
});

describe("a direct charge", () => {
  it("goes to the company's account with the fee in cents, the amount and metadata the server chose", async () => {
    const { client: stripe, calls } = fakeStripe();
    await createDirectCheckoutSession(stripe, {
      tenantId: "co_1",
      accountId: "acct_1",
      amountMinor: 1_001,
      currency: "USD",
      description: "Invoice INV-2026-0001 from Green Acres",
      successUrl: "https://app.test/t/green/invoice/tok?paid=1",
      cancelUrl: "https://app.test/t/green/invoice/tok",
      feeBps: 250,
      metadata: { invoiceId: "inv_1", checkoutId: "chk_1" },
      idempotencyKey: "invoice-checkout:chk_1",
    });
    const [params, opts] = calls[0]!.args as [Stripe.Checkout.SessionCreateParams, Stripe.RequestOptions];
    expect(opts).toEqual({ idempotencyKey: "invoice-checkout:chk_1", stripeAccount: "acct_1" });
    expect(params.line_items?.[0]?.price_data).toMatchObject({ currency: "usd", unit_amount: 1_001 });
    expect(params.payment_intent_data?.application_fee_amount).toBe(25);
    expect(params.metadata).toEqual({ invoiceId: "inv_1", checkoutId: "chk_1", tenantId: "co_1" });
    expect(params.payment_intent_data?.metadata).toEqual({ invoiceId: "inv_1", checkoutId: "chk_1", tenantId: "co_1" });
  });

  it("takes no fee and no account for a single business on its own keys", async () => {
    const { client: stripe, calls } = fakeStripe();
    await createDirectCheckoutSession(stripe, {
      tenantId: "primary",
      accountId: null,
      amountMinor: 5_000,
      currency: "usd",
      description: "Invoice",
      successUrl: "https://x.test/a",
      cancelUrl: "https://x.test/b",
      feeBps: 500,
      idempotencyKey: "k",
    });
    const [params, opts] = calls[0]!.args as [Stripe.Checkout.SessionCreateParams, Stripe.RequestOptions];
    expect(opts).toEqual({ idempotencyKey: "k" });
    expect(params.payment_intent_data?.application_fee_amount).toBeUndefined();
  });
});

describe("the payments screen API", () => {
  const handlers = (stripe: StripeClient | null, allowed: string[] = ["payments.view", "payments.manage"]) =>
    createConnectAdminHandlers({
      db,
      stripe: () => stripe,
      resolveTenant: (req) => new URL(req.url).pathname.split("/")[3] ?? null,
      authorize: (_req, permission) => allowed.includes(permission),
      returnUrl: () => "https://app.test/app/payments?connected=1",
      refreshUrl: () => "https://app.test/app/payments",
      feeBps: 250,
      webhookReady: true,
      siteName: "Igloo Back Office",
      onDisconnect: (tenantId) => void disconnected.push(tenantId),
    });
  const disconnected: string[] = [];
  const call = (h: ReturnType<typeof handlers>, tenant: string, kind: string, body: unknown = {}) => {
    const r = STRIPE_CONNECT_ADMIN_ROUTES.find((x) => x.kind === kind)!;
    const url = `https://app.test/api/app/${tenant}/payments/${r.path}`;
    return h.handle(
      r.method === "GET"
        ? new Request(url)
        : new Request(url, { method: "POST", headers: { "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify(body) }),
    );
  };

  it("says card payments aren't set up — in the owner's words, naming no setting — and refuses to connect; never a 500", async () => {
    const h = handlers(null);
    const status = (await (await call(h, "co_none", "status")).json()) as { configured: boolean; configuredReason: string; takingPayments: boolean; feeOn100: number; feeText: string };
    expect(status).toMatchObject({ configured: false, takingPayments: false, feeOn100: 250 });
    expect(status.configuredReason).toBe("Card payments aren't set up on this site yet — contact Igloo Back Office.");
    expect(status.configuredReason).not.toMatch(/[A-Z]{3,}_[A-Z]/);
    expect(status.feeText).toContain("not returned on refunds");
    expect((await call(h, "co_none", "connect")).status).toBe(409);
  });

  it("asks the country (the US by default), shows which account is connected, and links ITS dashboard; disconnecting closes open pages", async () => {
    const { client: stripe, calls } = fakeStripe();
    const h = handlers(stripe);
    await call(h, "co_ca", "connect", { country: "ca" });
    await call(h, "co_us", "connect");
    const creates = calls.filter((c) => c.method === "accounts.create").map((c) => (c.args[0] as { country?: string }).country);
    expect(creates).toEqual(["CA", "US"]);
    const row = (await connectedAccountFor(db, "co_ca"))!;
    await db.update(stripeConnectedAccounts).set({ displayName: "Green Acres LLC" }).where(eq(stripeConnectedAccounts.id, row.id));
    const status = (await (await call(h, "co_ca", "status")).json()) as { account: unknown; dashboardUrl: string };
    expect(status.account).toEqual({ name: "Green Acres LLC", last4: row.accountId.slice(-4) });
    expect(status.dashboardUrl).toBe(`https://dashboard.stripe.com/${row.accountId}/payouts`);
    await call(h, "co_ca", "disconnect");
    expect(disconnected).toEqual(["co_ca"]);
  });

  it("connects, reads the account back on return, and asks each route's own permission", async () => {
    const { client: stripe } = fakeStripe();
    const h = handlers(stripe);
    const connect = (await (await call(h, "co_screen", "connect")).json()) as { url: string };
    expect(connect.url).toContain("connect.stripe.test");
    const status = (await (await call(h, "co_screen", "status")).json()) as { takingPayments: boolean; connected: boolean };
    expect(status).toMatchObject({ connected: true, takingPayments: true });
    const viewer = handlers(stripe, ["payments.view"]);
    expect((await call(viewer, "co_screen", "disconnect")).status).toBe(403);
    expect((await call(viewer, "co_screen", "status")).status).toBe(200);
  });
});
