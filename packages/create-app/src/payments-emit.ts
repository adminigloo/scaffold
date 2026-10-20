/**
 * GETTING PAID, PART 1 (create-app 0.33): customers pay invoices and
 * deposits online.
 *
 *   companies   each company connects ITS OWN Stripe account at /app/payments
 *               (Stripe Connect, Standard-style), "Pay now" on its /t invoice
 *               pages charges that account directly, and the Connect webhook
 *               (/api/webhooks/stripe-connect, STRIPE_CONNECT_WEBHOOK_SECRET)
 *               records the money for the company that owns the account.
 *   one business  the business's own Stripe keys, no Connect: the same "Pay
 *               now", and its own webhook (/api/webhooks/stripe-invoices,
 *               STRIPE_INVOICE_WEBHOOK_SECRET).
 *
 * Emitted variants: every file below is one mode's or the other's, never an
 * `if` about the answers. Only with --invoicing or --store (getting paid, part
 * 2: the store rides the same account, webhook and payments screen).
 */

import { invoicingOnEvent } from "./customers-emit.js";
import { tenantLabel, type Answers } from "./answers.js";
import { companiesMode } from "./tenancy-emit.js";

/**
 * Does this project take card payments from a business's own customers —
 * "Pay now" on invoices (part 1), a store of its own (part 2), or both? Both
 * ride the same Stripe account per business, the same webhook and the same
 * payments screen.
 */
export function cardPaymentsOn(answers: Pick<Answers, "includeInvoicing" | "includeStore">): boolean {
  return answers.includeInvoicing || answers.includeStore;
}

/** Every file Pay now and the store's payments write, by path (POSIX separators; emit.ts joins them). */
export function paymentsFiles(answers: Answers): ReadonlyArray<readonly [string, string]> {
  if (!cardPaymentsOn(answers)) {
    return answers.includeEstimator ? [["src/server/quote-deposit.ts", renderQuoteDepositStub(answers)]] : [];
  }
  const companies = companiesMode(answers);
  const files: Array<readonly [string, string]> = [
    ["src/server/payments.ts", companies ? renderCompanyPayments(answers) : renderSinglePayments(answers)],
    ["src/server/payments-webhook.ts", renderPaymentsWebhook(answers)],
  ];
  // "Needs your attention" for invoices: on /app/payments, or the admin invoices page for one business.
  if (answers.includeInvoicing) files.push(["src/components/PaymentsAttention.tsx", renderPaymentsAttention(answers)]);
  if (!answers.includeInvoicing) {
    if (answers.includeEstimator) files.push(["src/server/quote-deposit.ts", renderQuoteDepositStub(answers)]);
  }
  if (companies) {
    files.push(
      ["app/api/webhooks/stripe-connect/route.ts", webhookRoute("Connect", "the companies' own Stripe accounts", paidFor(answers))],
      ["app/api/app/[tenantId]/payments/[...path]/route.ts", paymentsAdminRoute(answers)],
      ["app/(site)/app/payments/page.tsx", renderPaymentsPage(answers)],
      ["src/components/PaymentsPanel.tsx", renderPaymentsPanel(answers)],
    );
  } else {
    files.push(["app/api/webhooks/stripe-invoices/route.ts", webhookRoute(answers.includeInvoicing ? "invoice" : "payments", "this business's own Stripe account", paidFor(answers))]);
  }
  if (answers.includeEstimator && answers.includeInvoicing) {
    files.push(["src/server/quote-deposit.ts", renderQuoteDeposit(answers)]);
    files.push([companies ? "app/api/t/[slug]/quote-deposit/[token]/route.ts" : "app/api/quote-deposit/[token]/route.ts", quoteDepositRoute(answers)]);
  }
  return files;
}

// ---------------------------------------------------------------------------
// src/server/payments.ts
// ---------------------------------------------------------------------------

function renderCompanyPayments(answers: Answers): string {
  const scope = answers.scope;
  const noun = tenantLabel(answers).toLowerCase();
  const invoicing = answers.includeInvoicing;
  const store = answers.includeStore;
  const what = [...(invoicing ? ['"Pay now" on its invoices'] : []), ...(store ? ["its store's Check out"] : [])].join(" and ");
  return `import {
  accountTakesCharges,
  connectedAccountFor,
  createConnectAdminHandlers,
  createDirectCheckoutSession,
  createStripeClient,
  expireDirectCheckoutSession,
  type StripeClient,
} from "${scope}/stripe";
${invoicing ? `import { expireCompanyCheckouts, type InvoiceCardPayments } from "${scope}/invoicing";\n` : ""}${store ? `import { expireCompanyStoreCheckouts, type StoreCardPayments } from "${scope}/commerce/store";\n` : ""}import { db } from "@/db";
import { env } from "@/env";
import { SITE_NAME } from "@/seo";
import { companyLinks } from "@/server/company-links";
import { companyAuthorizer, companyRoutes, type FeatureHandlerOverrides } from "@/server/company-routes";
import { reportError } from "@/server/error-reporter";
import { tenancy } from "@/server/tenancy";

/**
 * HOW A ${noun.toUpperCase()}'S CUSTOMERS PAY BY CARD (getting paid, parts 1 and 2).
 *
 * Each ${noun} connects ITS OWN Stripe account at /app/payments (Stripe
 * Connect, Standard-style: the ${noun} signs in to its own Stripe dashboard,
 * pays its own Stripe fees, and Stripe handles refunds and disputes it can't
 * cover). ${what} charges that account directly; the money
 * and the payout are the ${noun}'s. This site's cut, if any, is PLATFORM_FEE_BPS
 * (basis points; 0, the default, takes nothing), shown to the owner before
 * they connect.
 *
 * This site's own Stripe account still bills ${noun}s for their plans; it
 * never sees these payments.
 */

/** The site's Stripe client, or null without STRIPE_SECRET_KEY (cached by the package). */
export function paymentsStripe(): StripeClient | null {
  return createStripeClient({ secretKey: env.STRIPE_SECRET_KEY, appUrl: env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000" });
}

/** Can ANY ${noun} take card payments here? The key, and the Connect webhook's secret to record them. */
export function cardPaymentsConfigured(): boolean {
  return paymentsStripe() !== null && Boolean(env.STRIPE_CONNECT_WEBHOOK_SECRET);
}

/** This site's cut of each payment, in basis points (250 = 2.5%). */
// Number(): a test or a skipped validation hands the raw text (or nothing) through.
export const PLATFORM_FEE_BPS: number = Number(env.PLATFORM_FEE_BPS ?? 0);

/** A ${noun} is ready once its own account is connected and Stripe has turned charges on. */
async function readyFor(tenantId: string): Promise<{ ready: true; accountId: string } | { ready: false }> {
  if (!cardPaymentsConfigured()) return { ready: false };
  const row = await connectedAccountFor(db, tenantId);
  return row && accountTakesCharges(row) ? { ready: true, accountId: row.accountId } : { ready: false };
}

async function expirePage(input: { readonly accountId: string | null; readonly sessionId: string }): Promise<void> {
  const client = paymentsStripe();
  if (client) await expireDirectCheckoutSession(client, { accountId: input.accountId, sessionId: input.sessionId });
}
${invoicing ? `
/** Pay now's Stripe side, for @adminigloo/invoicing. */
export const invoiceCardPayments: InvoiceCardPayments = {
  ready: readyFor,
  async createSession(input) {
    const client = paymentsStripe();
    if (!client || !input.accountId) throw new Error("Card payments aren't set up for this ${noun}.");
    const session = await createDirectCheckoutSession(client, {
      tenantId: input.tenantId,
      accountId: input.accountId,
      amountMinor: input.amount,
      currency: input.currency,
      description: input.description,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      feeBps: PLATFORM_FEE_BPS,
      metadata: { checkoutId: input.checkoutId, invoiceId: input.invoiceId },
      customerEmail: input.customerEmail,
      expiresAt: input.expiresAt,
      idempotencyKey: \`invoice-checkout:\${input.checkoutId}\`,
    });
    if (!session.url) throw new Error(\`Stripe opened checkout \${session.id} with no page to send the customer to.\`);
    return { id: session.id, url: session.url };
  },
  expireSession: expirePage,
};
` : ""}${store ? `
/**
 * The store's Stripe side, for @adminigloo/commerce (getting paid, part 2):
 * the lines and the total the SERVER priced, direct on the ${noun}'s account,
 * with this site's fee; the page closes in an hour.
 */
export const storeCardPayments: StoreCardPayments = {
  ready: readyFor,
  async createSession(input) {
    const client = paymentsStripe();
    if (!client || !input.accountId) throw new Error("Card payments aren't set up for this ${noun}.");
    const session = await createDirectCheckoutSession(client, {
      tenantId: input.tenantId,
      accountId: input.accountId,
      amountMinor: input.amount,
      currency: input.currency,
      description: input.description,
      lines: input.lines,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      feeBps: PLATFORM_FEE_BPS,
      metadata: { storeCheckoutId: input.checkoutId },
      expiresAt: input.expiresAt,
      idempotencyKey: \`store-checkout:\${input.checkoutId}\`,
    });
    if (!session.url) throw new Error(\`Stripe opened checkout \${session.id} with no page to send the customer to.\`);
    return { id: session.id, url: session.url };
  },
  expireSession: expirePage,
};
` : ""}
/**
 * The ${noun}'s payments screen API (/api/app/{${noun} id}/payments): its status,
 * "Connect Stripe" and "Disconnect", for the ${noun} in the path, on
 * \`payments.view\` and \`payments.manage\`. \`overrides.principal\` is how the
 * project's isolation proof calls it as somebody else.
 */
export function buildPaymentsAdminHandlers(overrides: FeatureHandlerOverrides = {}) {
  return createConnectAdminHandlers({
    db,
    stripe: paymentsStripe,
    resolveTenant: companyRoutes.resolveTenant,
    authorize: companyAuthorizer(overrides),
    returnUrl: async (tenantId) => (await companyLinks(tenantId)).app("/app/payments?connected=1"),
    refreshUrl: async (tenantId) => (await companyLinks(tenantId)).app("/app/payments"),
    feeBps: PLATFORM_FEE_BPS,
    accountEmail: async (tenantId) => (await tenancy.companyProfile(tenantId))?.contactEmail ?? null,
    webhookReady: Boolean(env.STRIPE_CONNECT_WEBHOOK_SECRET),
    // The owner's "contact {site}" when card payments aren't set up here.
    siteName: SITE_NAME,
    // Disconnecting closes the ${noun}'s open payment pages, so none is paid after.
    onDisconnect: async (tenantId) => {
      const report = (error: unknown) => void reportError({ error, source: "route", tenantId, context: { feature: "payments", step: "disconnect" } });${invoicing ? `
      await expireCompanyCheckouts(db, invoiceCardPayments, tenantId, report);` : ""}${store ? `
      await expireCompanyStoreCheckouts(db, storeCardPayments, tenantId, report);` : ""}
    },
    onError: (error, context) => void reportError({ error, source: "route", tenantId: context.tenantId, context: { feature: "payments", route: context.route } }),
  });
}
`;
}

function renderSinglePayments(answers: Answers): string {
  const scope = answers.scope;
  const invoicing = answers.includeInvoicing;
  const store = answers.includeStore;
  const what = [...(invoicing ? ['"Pay now" shows on an invoice'] : []), ...(store ? ["the store takes orders"] : [])].join(" and ");
  return `import { createDirectCheckoutSession, createStripeClient, expireDirectCheckoutSession, type StripeClient } from "${scope}/stripe";
${invoicing ? `import type { InvoiceCardPayments } from "${scope}/invoicing";\n` : ""}${store ? `import type { StoreCardPayments } from "${scope}/commerce/store";\n` : ""}import { env } from "@/env";

/**
 * HOW CUSTOMERS PAY BY CARD (getting paid, parts 1 and 2): on this business's
 * OWN Stripe account — STRIPE_SECRET_KEY, no Connect, no fee. ${what}
 * once the key and the payments webhook's secret (STRIPE_INVOICE_WEBHOOK_SECRET,
 * the endpoint /api/webhooks/stripe-invoices) are both set.
 */

/** The Stripe client, or null without STRIPE_SECRET_KEY (cached by the package). */
export function paymentsStripe(): StripeClient | null {
  return createStripeClient({ secretKey: env.STRIPE_SECRET_KEY, appUrl: env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000" });
}

export function cardPaymentsConfigured(): boolean {
  return paymentsStripe() !== null && Boolean(env.STRIPE_INVOICE_WEBHOOK_SECRET);
}

async function readyHere(): Promise<{ ready: true; accountId: null } | { ready: false }> {
  return cardPaymentsConfigured() ? { ready: true, accountId: null } : { ready: false };
}

async function expirePage(input: { readonly sessionId: string }): Promise<void> {
  const client = paymentsStripe();
  if (client) await expireDirectCheckoutSession(client, { accountId: null, sessionId: input.sessionId });
}
${invoicing ? `
/** Pay now's Stripe side, for @adminigloo/invoicing: the site's own account (accountId null). */
export const invoiceCardPayments: InvoiceCardPayments = {
  ready: readyHere,
  async createSession(input) {
    const client = paymentsStripe();
    if (!client) throw new Error("Card payments aren't set up (STRIPE_SECRET_KEY).");
    const session = await createDirectCheckoutSession(client, {
      tenantId: input.tenantId,
      accountId: null,
      amountMinor: input.amount,
      currency: input.currency,
      description: input.description,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      metadata: { checkoutId: input.checkoutId, invoiceId: input.invoiceId },
      customerEmail: input.customerEmail,
      expiresAt: input.expiresAt,
      idempotencyKey: \`invoice-checkout:\${input.checkoutId}\`,
    });
    if (!session.url) throw new Error(\`Stripe opened checkout \${session.id} with no page to send the customer to.\`);
    return { id: session.id, url: session.url };
  },
  expireSession: expirePage,
};
` : ""}${store ? `
/** The store's Stripe side, for @adminigloo/commerce: the server-priced lines, on the site's own account. */
export const storeCardPayments: StoreCardPayments = {
  ready: readyHere,
  async createSession(input) {
    const client = paymentsStripe();
    if (!client) throw new Error("Card payments aren't set up (STRIPE_SECRET_KEY).");
    const session = await createDirectCheckoutSession(client, {
      tenantId: input.tenantId,
      accountId: null,
      amountMinor: input.amount,
      currency: input.currency,
      description: input.description,
      lines: input.lines,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      metadata: { storeCheckoutId: input.checkoutId },
      expiresAt: input.expiresAt,
      idempotencyKey: \`store-checkout:\${input.checkoutId}\`,
    });
    if (!session.url) throw new Error(\`Stripe opened checkout \${session.id} with no page to send the customer to.\`);
    return { id: session.id, url: session.url };
  },
  expireSession: expirePage,
};
` : ""}`;
}

// ---------------------------------------------------------------------------
// src/server/payments-webhook.ts
// ---------------------------------------------------------------------------

function renderPaymentsWebhook(answers: Answers): string {
  const scope = answers.scope;
  const companies = companiesMode(answers);
  const noun = tenantLabel(answers).toLowerCase();
  const invoicing = answers.includeInvoicing;
  const store = answers.includeStore;
  const alerts = answers.includeNotifications && invoicing;
  const stripeNames = companies
    ? ["applyAccountUpdate", "assertEventLivemode", "companyForConnectEvent", "connectLedgerKey", "ledgerRunStatus", "markAccountDeauthorized", "runLedgeredEvent", "verifyStripeSignature"]
    : ["assertEventLivemode", "ledgerRunStatus", "runLedgeredEvent", "verifyStripeSignature"];
  const imports = [
    `import { NextResponse } from "next/server";`,
    `import type Stripe from "stripe";`,
    `import { resolveAppEnv } from "${scope}/env";`,
    ...(store ? [`import { handleStoreEvent, type StoreEventOutcome } from "${scope}/commerce/store";`] : []),
    ...(invoicing ? [`import { handleInvoiceCardEvent, resolveInvoicingBusiness, type CardAlert, type CardEventOutcome } from "${scope}/invoicing";`] : []),
    `import { RATE_LIMIT_POLICIES, rateLimitHeaders } from "${scope}/observability";`,
    `import { ${stripeNames.join(", ")} } from "${scope}/stripe";`,
    `import { db } from "@/db";`,
    `import { env } from "@/env";`,
    ...(alerts ? [`import { alertOnCardPayment, alertOnInvoicingEvent } from "@/server/alerts";`] : []),
    ...(invoicing && answers.includeCustomers ? [`import { customerOnInvoicingEvent } from "@/server/customer-activity";`] : []),
    `import { reportError } from "@/server/error-reporter";`,
    ...(invoicing ? [companies ? `import { invoicingBusiness } from "@/server/invoicing";` : `import { INVOICING_TENANT, invoicingBusiness } from "@/server/invoicing";`] : []),
    `import { log } from "@/server/logger";`,
    `import { paymentsStripe } from "@/server/payments";`,
    `import { limiter } from "@/server/rate-limit";`,
    ...(store ? [companies || invoicing ? `import { storeEventOptions } from "@/server/store";` : `import { STORE_TENANT, storeEventOptions } from "@/server/store";`] : []),
  ];
  const secret = companies ? "STRIPE_CONNECT_WEBHOOK_SECRET" : "STRIPE_INVOICE_WEBHOOK_SECRET";
  const whose = companies
    ? `  // WHOSE EVENT: the ${noun} that connected the account Stripe signed this for —
  // never the payment's metadata, which is only checked against it.
  if (event.type === "account.updated") {
    // Applied only if newer than the last one (Stripe delivers out of order).
    const tenantId = await applyAccountUpdate(db, event.data.object as Stripe.Account, new Date(event.created * 1000));
    if (!tenantId) log.warn({ eventId: event.id, account: event.account }, "payments: account.updated for an account no ${noun} connected, or older than the one applied — ignored");
    return NextResponse.json({ received: true });
  }
  if (event.type === "account.application.deauthorized") {
    if (event.account) await markAccountDeauthorized(db, event.account);
    return NextResponse.json({ received: true });
  }
  const owner = await companyForConnectEvent(db, event);
  if (owner.kind === "ignored") {
    log.warn({ eventId: event.id, eventType: event.type, account: owner.accountId, why: owner.reason }, "payments: an event from a Stripe account no ${noun} connected — ignored");
    return NextResponse.json({ received: true, ignored: true });
  }
  const tenantId = owner.tenantId;
  const key = connectLedgerKey(event);`
    : `  // This endpoint is the business's own account: an event from a connected
  // account is not this business's.
  if (event.account) {
    log.warn({ eventId: event.id, account: event.account }, "payments: an event from a connected account at the invoice endpoint — ignored");
    return NextResponse.json({ received: true, ignored: true });
  }
  const tenantId = ${invoicing ? "INVOICING_TENANT" : "STORE_TENANT"};
  // Its own key space: the site store's endpoint can receive the same event id.
  const key = \`${invoicing ? "invoices" : "store"}:\${event.id}\`;`;
  return `${imports.join("\n")}

/**
 * THE ${companies ? "CONNECT" : invoicing ? "INVOICE PAYMENTS" : "STORE PAYMENTS"} WEBHOOK (getting paid, parts 1 and 2): Stripe tells this site
 * a customer paid ${[...(invoicing ? ["an invoice"] : []), ...(store ? ["a store order"] : [])].join(" or ")}${companies ? ` on a ${noun}'s own account` : ""}, a payment was refunded or
 * disputed, or a checkout expired${companies ? `, or a ${noun}'s account changed` : ""}.
 *
 *   1. the signature, with ${secret} (this endpoint's own);
 *   2. the mode (a test event never reaches a live site, and the reverse);
 *   3. ${companies ? `the ${noun}: the one that connected \`event.account\`. An unknown account is
 *      logged and ignored (200), so Stripe doesn't retry it for days;` : `the business: this site's one (${invoicing ? "INVOICING_TENANT" : "STORE_TENANT"});`}
 *   4. the ledger (stripe_events, keyed ${companies ? "by account AND event" : invoicing ? "\"invoices:<event>\"" : "\"store:<event>\""}): an event is
 *      handled once however often it arrives, a failure is retried;
 *   5. ${[...(invoicing ? ["@adminigloo/invoicing's"] : []), ...(store ? ["@adminigloo/commerce's (the store's)"] : [])].join(" and ")} rules: the payment is recorded only for a
 *      checkout this ${companies ? noun : "business"} started, in the exact amount and
 *      currency it asked; anything else is logged, reported, and not
 *      recorded. Each ignores the other's payments (they carry other metadata).
 */
export async function handlePaymentsWebhook(req: Request): Promise<Response> {
  const client = paymentsStripe();
  const secret = env.${secret};
  if (!client || !secret) return new NextResponse("card payments not configured", { status: 503 });
  const signature = req.headers.get("stripe-signature");
  if (!signature) return new NextResponse("missing signature", { status: 400 });
  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = verifyStripeSignature(body, signature, secret, client.stripe);
  } catch {
    return new NextResponse("bad signature", { status: 400 });
  }
  try {
    assertEventLivemode(event, resolveAppEnv());
  } catch (error) {
    void reportError({ error, source: "webhook", context: { provider: "stripe-${companies ? "connect" : "invoices"}", eventId: event.id } });
    return new NextResponse("livemode mismatch", { status: 400 });
  }
  // One budget per connected account, so one busy ${companies ? noun : "account"} can't hold up the rest.
  const verdict = await limiter.limit({ key: \`webhook:stripe-${companies ? "connect" : "invoices"}:\${event.account ?? "platform"}\`, policy: RATE_LIMIT_POLICIES.webhook });
  if (!verdict.allowed) return new NextResponse("slow down", { status: 429, headers: rateLimitHeaders(verdict, RATE_LIMIT_POLICIES.webhook) });

${whose}
${invoicing ? "  let outcome: CardEventOutcome | null = null;\n" : ""}${store ? "  let storeOutcome: StoreEventOutcome | null = null;\n" : ""}  const result = await runLedgeredEvent(db, { key, type: event.type, tenantId, payload: event }, async () => {${invoicing ? `
    outcome = await handleInvoiceCardEvent(db, tenantId, event, {
      onAlert: (alert) => reportCardAlert(alert),
      format: async (id) => {
        const b = resolveInvoicingBusiness(await invoicingBusiness(${companies ? "id" : ""}));
        void id;
        return { currency: b.currency, locale: b.locale, timeZone: b.timeZone };
      },${invoicingOnEvent(answers, "paid") ? `
      // A customer's payment settled an invoice: the "invoice paid" alert${answers.includeCustomers ? ", and the invoice paid on its customer's timeline" : ""}.
      onEvent: ${invoicingOnEvent(answers, "paid")},` : ""}
      report: (error) => void reportError({ error, source: "webhook", tenantId, context: { provider: "stripe", eventId: event.id } }),
    });` : ""}${store ? `
    // A store order (getting paid, part 2): only for this ${companies ? noun : "business"}'s checkout, in exactly its amount.
    storeOutcome = await handleStoreEvent(db, tenantId, event, storeEventOptions(tenantId));` : ""}
  });
  if (result.outcome === "failed") {
    await reportError({ error: result.error, source: "webhook", url: req.url, tenantId, context: { provider: "stripe", eventType: event.type, eventId: event.id } });
    return new NextResponse("handler failed", { status: 500 });
  }
  if (result.outcome === "in-flight") return new NextResponse("in flight", { status: 500 });
  return NextResponse.json({ received: true, duplicate: result.outcome === "duplicate", outcome: ${
    invoicing && store
      ? '[outcome as CardEventOutcome | null, storeOutcome as StoreEventOutcome | null].find((o) => o !== null && o.outcome !== "ignored")?.outcome ?? null'
      : invoicing
        ? "(outcome as CardEventOutcome | null)?.outcome ?? null"
        : "(storeOutcome as StoreEventOutcome | null)?.outcome ?? null"
  } }, { status: ledgerRunStatus(result) });
}
${invoicing ? `
/**
 * Money Stripe took that didn't land cleanly (the wrong amount, a checkout
 * this ${companies ? noun : "business"} never started, money on a voided invoice, an overpayment), a
 * refund, a dispute, a failed bank payment: ${alerts ? `to the ${companies ? noun + "'s" : "business's"} owners (the
 * bell and email, with the payment's page in Stripe), ` : "(this project has no alerts: create-app add notifications sends\n * these to the owners' bell and email) "}in the log, and in /admin/errors.
 */
async function reportCardAlert(alert: CardAlert): Promise<void> {${alerts ? `
  // The ${companies ? noun + "'s" : "business's"} own people: the bell and an email, with the Stripe link.
  await alertOnCardPayment(alert);` : ""}
  log.error({ tenantId: alert.tenantId, kind: alert.kind, invoiceId: alert.invoiceId, paymentIntentId: alert.paymentIntentId }, \`payments: \${alert.message}\`);
  void reportError({
    error: new Error(alert.message),
    source: "webhook",
    tenantId: alert.tenantId,
    context: { feature: "payments", kind: alert.kind, invoiceId: alert.invoiceId, paymentIntentId: alert.paymentIntentId },
  });
}
` : ""}`;
}

/** What the customers pay for, in words: "invoices", "store orders", or both. */
function paidFor(answers: Answers): string {
  return [...(answers.includeInvoicing ? ["invoices"] : []), ...(answers.includeStore ? ["store orders"] : [])].join(" and ");
}

function webhookRoute(kind: string, whose: string, what: string): string {
  return `import { handlePaymentsWebhook } from "@/server/payments-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The ${kind} webhook: card payments on ${what}, from ${whose}
 * (src/server/payments-webhook.ts). Reads the RAW body; never req.json().
 */
export const POST = handlePaymentsWebhook;
`;
}

// ---------------------------------------------------------------------------
// The company's payments screen
// ---------------------------------------------------------------------------

function paymentsAdminRoute(answers: Answers): string {
  const noun = tenantLabel(answers).toLowerCase();
  return `import { buildPaymentsAdminHandlers } from "@/server/payments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A ${noun}'s payments screen: /app/payments calls
 * /api/app/{${noun} id}/payments/v1/admin/{status,connect,disconnect}
 * (STRIPE_CONNECT_ADMIN_ROUTES). The ${noun} is the one in the path, asked on
 * every call; only an owner connects or disconnects. Never cross-origin.
 */
const { handle } = buildPaymentsAdminHandlers();

export const GET = handle;
export const POST = handle;
`;
}

function renderPaymentsPage(answers: Answers): string {
  const noun = tenantLabel(answers).toLowerCase();
  const invoicing = answers.includeInvoicing;
  const store = answers.includeStore;
  return `${store ? `import { StoreAttention } from "${answers.scope}/commerce/widget";\n` : ""}import { CompanyGate } from "@/components/CompanyGate";
${invoicing ? `import { PaymentsAttention } from "@/components/PaymentsAttention";\n` : ""}import { PaymentsPanel } from "@/components/PaymentsPanel";
import { PageHeader, WORK_MAIN } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The ${noun}'s payments (getting paid, part 1): connect its own Stripe
 * account so customers can pay invoices and deposits by card, see whether
 * charges and payouts are on and this site's fee, open its Stripe dashboard,
 * or disconnect. Everything goes through /api/app/{id}/payments, which checks
 * the person's permission on every call.
 */
export default async function CompanyPaymentsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  return (
    <CompanyGate path="/app/payments" permission="payments.view">
      {({ company, isStaff, locale }) => (
        <main className={WORK_MAIN}>
          <PageHeader
            title="Card payments"
            description="${answers.includeInvoicing && answers.includeStore ? "Customers pay your invoices, deposits and store orders by card, into your own Stripe account." : answers.includeStore ? "Customers buy from your store by card, into your own Stripe account." : "Customers pay your invoices and deposits by card, into your own Stripe account."}"
          />
          <div className="max-w-3xl space-y-8">
            <PaymentsPanel baseUrl={\`/api/app/\${company.id}/payments\`} justConnected={query.connected === "1"} staff={isStaff} />
${invoicing ? `            <PaymentsAttention baseUrl={\`/api/app/\${company.id}/invoices\`} locale={locale} />\n` : ""}${store ? `            <StoreAttention baseUrl={\`/api/app/\${company.id}/store\`} heading=${JSON.stringify(invoicing ? "Store payments that need your attention" : "Needs your attention")} locale={locale} />\n` : ""}          </div>
        </main>
      )}
    </CompanyGate>
  );
}
`;
}

function renderPaymentsPanel(answers: Answers): string {
  const noun = tenantLabel(answers).toLowerCase();
  return `"use client";

import { useCallback, useEffect, useState } from "react";
import type { PaymentsStatusWire } from "${answers.scope}/stripe";
import { SetupNotices, buttonClass } from "@/components/ui";

/** Countries a ${noun} can connect from (Stripe asks once; it can't change later). */
const COUNTRIES: ReadonlyArray<readonly [code: string, name: string]> = [
  ["US", "United States"],
  ["CA", "Canada"],
  ["GB", "United Kingdom"],
  ["IE", "Ireland"],
  ["AU", "Australia"],
  ["NZ", "New Zealand"],
];

/**
 * Card payments for this ${noun}, in plain words: connected or not, WHICH
 * Stripe account (its name and the last 4 of its id), whether Stripe has
 * turned charges and payouts on, this site's fee, a link to that account's
 * own Stripe dashboard (payouts, refunds, disputes), Connect (with the
 * country) and Disconnect (confirmed first). The server decides everything;
 * this screen only asks.
 */
export function PaymentsPanel(props: {
  readonly baseUrl: string;
  readonly justConnected: boolean;
  /** Staff of the site: also read why card payments aren't switched on (the operator's job). */
  readonly staff?: boolean;
}) {
  const [status, setStatus] = useState<PaymentsStatusWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [country, setCountry] = useState("US");
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(\`\${props.baseUrl}/v1/admin/status\`, { cache: "no-store" });
      const body = (await res.json()) as PaymentsStatusWire & { error?: { message: string } };
      if (!res.ok) throw new Error(body.error?.message ?? "Something went wrong.");
      setStatus(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    }
  }, [props.baseUrl]);
  useEffect(() => void load(), [load]);

  const post = async (action: "connect" | "disconnect") => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(\`\${props.baseUrl}/v1/admin/\${action}\`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action === "connect" ? { country } : {}),
      });
      const body = (await res.json()) as { url?: string; error?: { message: string } } & PaymentsStatusWire;
      if (!res.ok) throw new Error(body.error?.message ?? "Something went wrong.");
      if (action === "connect" && body.url) {
        window.location.assign(body.url);
        return;
      }
      setStatus(body);
      setConfirming(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    }
    setBusy(false);
  };

  const accountLine = status?.account
    ? \`\${status.account.name ?? "Your Stripe account"} (account ending \${status.account.last4})\`
    : null;

  return (
    <section className="space-y-5">
      {error ? <p role="alert" className="rounded-control bg-danger-soft p-3 text-sm text-danger">{error}</p> : null}
      {status && !status.configured ? (
        // The operator's job (this site's own Stripe keys), not the owner's:
        // one plain sentence, and the technical reason for staff only.
        <SetupNotices
          staff={props.staff === true}
          items={[
            {
              key: "card-payments",
              operator: true,
              text: "Card payments aren't switched on for this site yet, so you can't connect Stripe here.",
              ...(status.configuredReason ? { detail: status.configuredReason } : {}),
            },
          ]}
        />
      ) : null}
      {!status ? (
        <p className="text-sm text-ink-muted">Loading…</p>
      ) : (
        <div className="space-y-4 rounded-[--radius-card] border border-line bg-surface p-5 shadow-card">
          {!status.connected && !status.disconnected ? (
            <p className="text-sm leading-relaxed text-ink-muted">
              ${answers.includeInvoicing ? "Once you're connected, every invoice you send has a Pay now button: customers pay the deposit or the balance by card, and the payment lands on the invoice by itself." : "Once you're connected, customers pay for their order by card and the money lands in your own Stripe account."}
            </p>
          ) : null}
          <p className="text-base font-medium text-ink" data-payments-state={status.takingPayments ? "on" : status.connected ? "pending" : "off"}>
            {status.takingPayments
              ? "${answers.includeInvoicing && answers.includeStore ? "On: customers see Pay now on your invoices and can buy from your store." : answers.includeStore ? "On: customers can buy from your store." : "On: customers see Pay now on your invoices."}"
              : status.connected
                ? props.justConnected
                  ? "Thanks — Stripe is checking your details. ${answers.includeInvoicing ? "Pay now" : "Your store"} turns on as soon as Stripe says you can take payments."
                  : "Connected, but Stripe isn't letting this account take payments yet. Finish your details in Stripe."
                : status.disconnected
                  ? "${answers.includeInvoicing ? "Off: you disconnected Stripe. Customers pay the ways your invoices describe." : "Off: you disconnected Stripe. Your store shows its products but takes no orders."}"
                  : "Off: connect your Stripe account to take card payments."}
          </p>
          {accountLine ? <p className="text-sm text-ink-muted" data-payments-account="">Connected to {accountLine}</p> : null}
          {status.connected ? (
            <ul className="text-sm text-ink-muted">
              <li>Taking payments: {status.chargesEnabled ? "yes" : "not yet"}</li>
              <li>Payouts to your bank: {status.payoutsEnabled ? "yes" : "not yet"}</li>
            </ul>
          ) : null}
          <p className="text-sm text-ink-muted">{status.feeText}</p>
          <div className="flex flex-wrap items-center gap-3">
            {!status.account && status.configured ? (
              <label className="text-sm">
                Your business is in{" "}
                <select value={country} onChange={(e) => setCountry(e.target.value)} className="min-h-11 rounded-control border border-line bg-surface px-3 py-2 text-sm text-ink">
                  {COUNTRIES.map(([code, name]) => (
                    <option key={code} value={code}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {!status.connected || !status.chargesEnabled ? (
              <button type="button" disabled={busy || !status.configured} onClick={() => void post("connect")} className={buttonClass("primary")}>
                {status.connected ? "Finish setting up in Stripe" : "Connect Stripe"}
              </button>
            ) : null}
            {status.account ? (
              <a href={status.dashboardUrl} target="_blank" rel="noreferrer" className={buttonClass("secondary")}>
                Payouts and refunds in Stripe
              </a>
            ) : null}
            {status.connected && !confirming ? (
              <button type="button" disabled={busy} onClick={() => setConfirming(true)} className={buttonClass("secondary")}>
                Disconnect
              </button>
            ) : null}
          </div>
          {confirming ? (
            <div role="group" aria-label="Disconnect Stripe?" className="space-y-3 rounded-control border-l-2 border-warn bg-warn-soft/60 p-3 text-sm text-ink">
              <p>Disconnect Stripe? Customers can't pay by card until you connect again, and any payment page already open is closed. Payments you already took stay in your Stripe account.</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={busy} onClick={() => void post("disconnect")} className={buttonClass("danger")}>
                  Yes, disconnect
                </button>
                <button type="button" onClick={() => setConfirming(false)} className={buttonClass("secondary")}>
                  Keep it connected
                </button>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
`;
}

/**
 * "Taking card payments" — the same steps in README.md and DEPLOYMENT.md:
 * what to turn on in Stripe, the endpoint and its FULL event list, and the
 * variables, for this project's mode.
 */
export function cardPaymentsSetup(answers: Answers, heading: string): string {
  if (!cardPaymentsOn(answers)) return "";
  const companies = companiesMode(answers);
  const noun = tenantLabel(answers).toLowerCase();
  const invoicing = answers.includeInvoicing;
  const store = answers.includeStore;
  // The store's events are all on invoicing's list: with both, nothing is added.
  const events = [...(invoicing ? INVOICE_EVENTS : STORE_EVENTS), ...(companies ? ["account.updated", "account.application.deauthorized"] : [])];
  const takes = [...(invoicing ? ["on its invoices and deposits"] : []), ...(store ? ["for its store's orders"] : [])].join(" and ");
  const storeNote = store
    ? [
        `The store: every price is read from the product when the customer presses Check out, stock is held for the 30 minutes Stripe's page stays open (and comes back if it closes unpaid), and an order is written only when Stripe reports exactly the amount asked — anything else, a refund or a dispute shows under "Needs your attention"${companies ? " at /app/payments" : " at /admin/store"}.`,
        "",
        `Shipping and tax: in the store's settings the owner chooses "I ship it" (customers give an address on Stripe's page and pay a flat shipping price the owner sets, in the countries the owner lists) or "Pickup or digital only", and whether prices include any sales tax (on by default). **Automatic sales tax isn't supported yet**: customers pay exactly the prices set, plus shipping.`,
        "",
      ]
    : [];
  const lines = companies
    ? [
        `${heading} Taking card payments`,
        "",
        `Each ${noun} takes card (and bank) payments ${takes} into ITS OWN Stripe account (Stripe Connect, Standard: its own Stripe dashboard, its own Stripe fees; Stripe carries losses). This site's own Stripe account only bills ${noun}s for their plans.`,
        "",
        "1. **Turn on Connect** for this site's Stripe account (Dashboard → Connect → Get started), choosing that " + `${noun}s` + " get the full Stripe dashboard.",
        "2. **Fill in the platform profile and branding** (Connect → Settings: your business name, icon, colour and support details). Stripe's hosted onboarding shows them to every owner who connects, and refuses to start without them.",
        "3. **Add a webhook endpoint that listens to events on CONNECTED accounts** (Developers → Webhooks → Add endpoint → \"Listen to events on Connected accounts\") at `{your site}/api/webhooks/stripe-connect`, with these events:",
        "",
        ...events.map((e) => `   - \`${e}\``),
        "",
        "4. **Set the variables** (Vercel → Settings → Environment Variables, both environments): `STRIPE_SECRET_KEY` (this site's account), `STRIPE_CONNECT_WEBHOOK_SECRET` (the endpoint's `whsec_…`), and optionally `PLATFORM_FEE_BPS` — this site's cut of each payment in basis points (250 = 2.5%; default 0, none; rounded down to the cent, shown to each owner, not returned on refunds). Use test-mode keys and a test-mode endpoint on staging.",
        `5. **Each ${noun}'s owner** connects at /app/payments (they choose their country once). ${invoicing ? "Pay now appears on their invoices" : "Their store takes orders"} as soon as Stripe turns charges on.`,
        "",
        ...storeNote,
        ...(invoicing
          ? [
              `Every payment is recorded on the right invoice, or the ${noun}'s owners are told (the alert bell and email, with the payment's page in Stripe) — a wrong amount, a payment on a cancelled invoice, an overpayment after the invoice changed, a refund, a dispute, a bank payment that failed.`,
              "",
            ]
          : []),
      ]
    : [
        `${heading} Taking card payments`,
        "",
        `Customers pay ${[...(invoicing ? ["invoices and deposits"] : []), ...(store ? ["for store orders"] : [])].join(" and ")} by card (or bank) on this business's OWN Stripe account — no Connect, no fee.`,
        "",
        `1. **Add a webhook endpoint on your own account** (Developers → Webhooks → Add endpoint → "Listen to events on Your account") at \`{your site}/api/webhooks/stripe-invoices\`${store ? ` — this one endpoint handles card payments for ${invoicing ? "invoices and the store" : "the store (its name says invoices; it is the one card-payments endpoint)"} —` : ","} with these events:`,
        "",
        ...events.map((e) => `   - \`${e}\``),
        "",
        `2. **Set the variables**: \`STRIPE_SECRET_KEY\` and \`STRIPE_INVOICE_WEBHOOK_SECRET\` (that endpoint's \`whsec_…\` — separate from the site store's \`STRIPE_WEBHOOK_SECRET\`). Until both are set, ${invoicing ? "invoices show How to pay only" : "the store shows its products and takes no orders"}. Use test-mode keys and a test-mode endpoint on staging.`,
        "",
        ...storeNote,
        ...(invoicing
          ? [
              "Every payment is recorded on the right invoice, or reported (in /admin/errors, and to the alert bell and email with notifications) — a wrong amount, a payment on a cancelled invoice, an overpayment, a refund, a dispute, a bank payment that failed.",
              "",
            ]
          : []),
      ];
  return `${lines.join("\n")}\n`;
}

/** @adminigloo/commerce's STORE_CARD_EVENT_TYPES (a store with no invoicing): the same list less payment_intent.succeeded. */
export const STORE_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
] as const;

/** @adminigloo/invoicing's INVOICE_CARD_EVENT_TYPES, spelled out for the docs (the generator test checks they agree). */
export const INVOICE_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "payment_intent.succeeded",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
] as const;

// ---------------------------------------------------------------------------
// The accepted quote's deposit (estimator + invoicing)
// ---------------------------------------------------------------------------

function renderQuoteDepositStub(answers: Answers): string {
  return `import type { QuotePayment } from "${answers.scope}/estimator-widget";

/**
 * What an accepted quote offers to pay. Nothing: ${answers.projectName} was
 * generated without invoicing, so a quote never becomes an invoice to pay.
 * \`add invoicing\` wires it in.
 */
export async function quotePayment(..._args: string[]): Promise<QuotePayment | undefined> {
  return undefined;
}
`;
}

function renderQuoteDeposit(answers: Answers): string {
  const scope = answers.scope;
  const companies = companiesMode(answers);
  const noun = tenantLabel(answers).toLowerCase();
  const who = companies ? noun : "business";
  return `import { and, eq } from "drizzle-orm";
import { getQuoteByToken } from "${scope}/estimator";
import type { QuotePayment } from "${scope}/estimator-widget";
import {
  CardPaymentUnavailableError,
  invoices,
  pendingCardPayments,
  quotePaymentAction,
  resolveInvoicingBusiness,
  setInvoiceStatus,
  startInvoiceCheckout,
  type InvoiceRow,
} from "${scope}/invoicing";
import { db } from "@/db";
import { env } from "@/env";
${companies ? `import { companyLinks } from "@/server/company-links";
import { admitPublic, publicCompanies, resolvePublicTenant } from "@/server/company-routes";` : `import { ESTIMATOR_TENANT } from "@/server/estimator-staff";`}
import { convertEstimateToInvoice } from "@/server/estimator-services";
${companies ? `import { invoicingBusiness } from "@/server/invoicing";` : `import { invoiceLink, invoicingBusiness } from "@/server/invoicing";`}
import { invoiceCardPayments } from "@/server/payments";

/**
 * What an accepted quote's page offers to pay (getting paid, part 1), through
 * the estimator's own accepted-quote → invoice flow (\`convertEstimateToInvoice\`,
 * src/server/estimator-services.ts). The stage decides the button —
 * "Pay the deposit", then "Pay the balance", or "Pay now" with no deposit —
 * and nothing is shown when nothing is due (@adminigloo/invoicing's
 * \`quotePaymentAction\`).
 *
 * The customer's click raises the invoice ONLY when the quote has none yet.
 * If staff already have a draft for it, the click never publishes or charges
 * it: the page says "Your invoice is on its way."
 */

/** The ${who}'s invoice for an estimate, if there is one. */
async function invoiceForQuote(tenantId: string, estimateId: string): Promise<InvoiceRow | null> {
  const [row] = (await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.tenantId, tenantId), eq(invoices.estimateId, estimateId)))
    .limit(1)) as InvoiceRow[];
  return row ?? null;
}

/** What the accepted quote at this address offers — a button, a sentence, or nothing. */
export async function quotePayment(${companies ? "slug: string, token: string" : "token: string"}): Promise<QuotePayment | undefined> {${companies ? `
  // The ${noun} the web address names (a probe request: nothing is written).
  const tenantId = await publicCompanies.resolveTenant(new Request(new URL(\`/api/t/\${encodeURIComponent(slug)}/\`, "http://localhost")));
  if (!tenantId) return undefined;` : `
  const tenantId = ESTIMATOR_TENANT;`}
  if (!(await invoiceCardPayments.ready(tenantId)).ready) return undefined;
  const quote = await getQuoteByToken(db, tenantId, token);
  if (!quote || quote.status !== "accepted") return undefined;
  const business = resolveInvoicingBusiness(await invoicingBusiness(${companies ? "tenantId" : ""}));
  const invoice = await invoiceForQuote(tenantId, quote.estimateId);
  const pending = invoice ? await pendingCardPayments(db, tenantId, invoice.id) : null;
  const action = quotePaymentAction(invoice, business, { quoteTotal: quote.total, pending: pending?.amount ?? 0 });
  if (!action) return undefined;
  if ("note" in action) return action;
  return { href: ${companies ? "`/api/t/${encodeURIComponent(slug)}/quote-deposit/${encodeURIComponent(token)}`" : "`/api/quote-deposit/${encodeURIComponent(token)}`"}, label: action.label };
}

/**
 * The form came from this site's own page: Sec-Fetch-Site same-origin, or an
 * Origin that is this app's. A request with neither is refused — a form post
 * from a browser always carries one of them.
 */
function fromThisSite(req: Request): boolean {
  if (req.headers.get("sec-fetch-site")?.trim().toLowerCase() === "same-origin") return true;
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    const app = new URL(env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000");
    const from = new URL(origin);
    return from.host === app.host || from.host === new URL(req.url).host;
  } catch {
    return false;
  }
}

/** A plain page for a click that couldn't start a payment: nothing was charged. */
function sorry(message: string, back: string): Response {
  const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
  return new Response(
    \`<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>Payment</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><p>\${escape(message)}</p><p>Nothing was charged. <a href="\${escape(back)}">Back to your quote</a></p></body>\`,
    { status: 409, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex" } },
  );
}

/** The form's POST: 303 to Stripe, or back to the quote or the invoice page with nothing charged. */
export async function payQuoteDeposit(req: Request, token: string): Promise<Response> {
  const back = (url: string) => Response.redirect(url, 303);
  if (!fromThisSite(req)) return new Response("This request came from another site, so it was refused.", { status: 403 });
${companies ? `  const tenantId = await resolvePublicTenant(req);
  if (!tenantId) return new Response("Not found", { status: 404 });
  const links = await companyLinks(tenantId);
  const quoteUrl = links.quote(token);
  if (!(await admitPublic(tenantId, req)).open) return back(quoteUrl);
  const invoiceUrl = (viewToken: string) => links.invoice(viewToken);` : `  const tenantId = ESTIMATOR_TENANT;
  const app = env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const quoteUrl = new URL(\`quote/\${encodeURIComponent(token)}\`, app.endsWith("/") ? app : \`\${app}/\`).toString();
  const invoiceUrl = (viewToken: string) => invoiceLink(viewToken);`}
  try {
    const quote = await getQuoteByToken(db, tenantId, token);
    if (!quote || quote.status !== "accepted") return back(quoteUrl);
    let invoice = await invoiceForQuote(tenantId, quote.estimateId);
    // Staff's draft: never published or charged by a customer's click.
    if (invoice?.status === "draft") return back(quoteUrl);
    if (!invoice) {
      const made = await convertEstimateToInvoice!({ tenantId, estimateId: quote.estimateId, userId: null });
      await setInvoiceStatus(db, { tenantId, id: made.id, status: "sent" });
      invoice = await invoiceForQuote(tenantId, quote.estimateId);
      if (!invoice) return back(quoteUrl);
    }
    const page = invoiceUrl(invoice.viewToken);
    const started = await startInvoiceCheckout(db, invoiceCardPayments, {
      tenantId,
      token: invoice.viewToken,
      business: resolveInvoicingBusiness(await invoicingBusiness(${companies ? "tenantId" : ""})),
      successUrl: \`\${page}?paid=1\`,
      cancelUrl: page,
    });
    return back(started ? started.url : page);
  } catch (error) {
    if (error instanceof CardPaymentUnavailableError) return sorry(error.message, quoteUrl);
    // The estimator's own refusal (already invoiced, not accepted): its words, not a 500.
    if (error instanceof Error && error.name === "EstimatorInputError") return sorry(error.message, quoteUrl);
    throw error;
  }
}
`;
}

function quoteDepositRoute(answers: Answers): string {
  const companies = companiesMode(answers);
  return `import { payQuoteDeposit } from "@/server/quote-deposit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "Pay the deposit" on an accepted quote (src/server/quote-deposit.ts): a POST from the quote page. */
export async function POST(req: Request, { params }: { readonly params: Promise<{ readonly token: string${companies ? "; readonly slug: string" : ""} }> }) {
  const { token } = await params;
  return payQuoteDeposit(req, token);
}
`;
}

// ---------------------------------------------------------------------------
// "Needs your attention" and the nav's badge
// ---------------------------------------------------------------------------

function renderPaymentsAttention(answers: Answers): string {
  const companies = companiesMode(answers);
  const who = companies ? tenantLabel(answers).toLowerCase() : "business";
  return `"use client";

import { useCallback, useEffect, useState } from "react";
import type { CardAlertsWire, CardAlertWire } from "${answers.scope}/invoicing-widget";
import { buttonClass } from "@/components/ui";

/** A date and time in the ${who}'s locale (default en-US), never the browser's. */
function when(iso: string, locale = "en-US"): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  }
}

/**
 * NEEDS YOUR ATTENTION (getting paid, part 1): every card payment the ${who}
 * has to look at — money Stripe took that couldn't be recorded as it was, an
 * overpayment to refund, a refund, a dispute, a bank payment that failed —
 * each in plain words with a link to it in Stripe and "Mark as handled".
 * Kept by @adminigloo/invoicing whether or not this project has alerts, so the
 * owner is always told. Over ${companies ? "/api/app/{id}/invoices" : "/api/admin/invoices"}/v1/admin/attention.
 */
export function PaymentsAttention(props: { readonly baseUrl: string; readonly locale?: string }) {
  const [items, setItems] = useState<CardAlertsWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(\`\${props.baseUrl}/v1/admin/attention\`, { cache: "no-store" });
      if (res.status === 403) return setItems({ open: [], handled: [] });
      const body = (await res.json()) as CardAlertsWire & { error?: { message: string } };
      if (!res.ok) throw new Error(body.error?.message ?? "Something went wrong.");
      setItems(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    }
  }, [props.baseUrl]);
  useEffect(() => void load(), [load]);

  const handled = async (item: CardAlertWire) => {
    setBusy(item.id);
    try {
      const res = await fetch(\`\${props.baseUrl}/v1/admin/attention/\${encodeURIComponent(item.id)}/resolve\`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!res.ok) throw new Error("That didn't save. Please try again.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    }
    setBusy(null);
  };

  return (
    <section className="space-y-3" aria-labelledby="payments-attention" data-payments-attention="">
      <h2 id="payments-attention" className="text-lg font-semibold">
        Needs your attention{items && items.open.length > 0 ? \` (\${items.open.length})\` : ""}
      </h2>
      {error ? <p role="alert" className="rounded-control bg-danger-soft p-3 text-sm text-danger">{error}</p> : null}
      {!items ? (
        <p className="text-sm text-ink-muted">Loading…</p>
      ) : items.open.length === 0 ? (
        <p className="text-sm text-ink-muted">Nothing needs your attention. Card payments that can't be recorded as they are, refunds and disputes show here.</p>
      ) : (
        <ul className="space-y-2">
          {items.open.map((item) => (
            <li key={item.id} className="rounded-control border-l-2 border-warn bg-warn-soft/60 p-3 text-sm text-ink" data-attention-item={item.kind}>
              <p>{item.message}</p>
              <p className="mt-2 flex flex-wrap items-center gap-3">
                <span className="text-xs text-ink-muted">{when(item.createdAt, props.locale)}</span>
                {item.stripeUrl ? (
                  <a href={item.stripeUrl} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2">
                    Open it in Stripe
                  </a>
                ) : null}
                <button type="button" disabled={busy === item.id} onClick={() => void handled(item)} className={buttonClass("secondary")}>
                  Mark as handled
                </button>
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
`;
}

/**
 * src/server/nav-badges.ts, in EVERY project (the header imports it): a count
 * beside a header link while something there needs the person. Two variants,
 * no \`if\`: a companies project with invoicing counts the active company's
 * open card-payment problems on "Card payments"; anything else has none.
 */
export function renderNavBadges(answers: Answers): string {
  if (companiesMode(answers) && cardPaymentsOn(answers)) {
    const invoicing = answers.includeInvoicing;
    const store = answers.includeStore;
    const key = invoicing ? "invoices.payments.reverse" : "store.manage";
    return `${invoicing ? `import { openCardAlertCount } from "${answers.scope}/invoicing";\n` : ""}${store ? `import { openStoreAlertCount } from "${answers.scope}/commerce/store";\n` : ""}import { db } from "@/db";

/**
 * Counts beside header links, by href, for the person's ACTIVE company: the
 * card payments that need its owner (getting paid, parts 1 and 2), shown on
 * "Card payments" while any is open — only to someone who may handle them
 * (\`${key}\`${invoicing && store ? " for invoices, `store.manage` for the store" : ""}). A failure shows no badge, never a broken header.
 */
export async function navBadges(tenantId: string | null, can: readonly string[]): Promise<Readonly<Record<string, number>>> {
  if (!tenantId) return {};
  try {
    let open = 0;${invoicing ? `
    if (can.includes("invoices.payments.reverse")) open += await openCardAlertCount(db, tenantId);` : ""}${store ? `
    if (can.includes("store.manage")) open += await openStoreAlertCount(db, tenantId);` : ""}
    return open > 0 ? { "/app/payments": open } : {};
  } catch {
    return {};
  }
}
`;
  }
  return `/**
 * Counts beside header links, by href. None in this project: the only badge
 * (card payments that need a company's owner) comes with companies and
 * invoicing.
 */
export async function navBadges(_tenantId: string | null, _can: readonly string[]): Promise<Readonly<Record<string, number>>> {
  return {};
}
`;
}
