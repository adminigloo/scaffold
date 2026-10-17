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
 * `if` about the answers. Only with --invoicing.
 */

import { tenantLabel, type Answers } from "./answers.js";
import { companiesMode } from "./tenancy-emit.js";

/** Every file Pay now writes, by path (POSIX separators; emit.ts joins them). */
export function paymentsFiles(answers: Answers): ReadonlyArray<readonly [string, string]> {
  if (!answers.includeInvoicing) {
    return answers.includeEstimator ? [["src/server/quote-deposit.ts", renderQuoteDepositStub(answers)]] : [];
  }
  const companies = companiesMode(answers);
  const files: Array<readonly [string, string]> = [
    ["src/server/payments.ts", companies ? renderCompanyPayments(answers) : renderSinglePayments(answers)],
    ["src/server/payments-webhook.ts", renderPaymentsWebhook(answers)],
    // "Needs your attention": on /app/payments, or the admin invoices page for one business.
    ["src/components/PaymentsAttention.tsx", renderPaymentsAttention(answers)],
  ];
  if (companies) {
    files.push(
      ["app/api/webhooks/stripe-connect/route.ts", webhookRoute("Connect", "the companies' own Stripe accounts")],
      ["app/api/app/[tenantId]/payments/[...path]/route.ts", paymentsAdminRoute(answers)],
      ["app/(site)/app/payments/page.tsx", renderPaymentsPage(answers)],
      ["src/components/PaymentsPanel.tsx", renderPaymentsPanel(answers)],
    );
  } else {
    files.push(["app/api/webhooks/stripe-invoices/route.ts", webhookRoute("invoice", "this business's own Stripe account")]);
  }
  if (answers.includeEstimator) {
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
  return `import {
  accountTakesCharges,
  connectedAccountFor,
  createConnectAdminHandlers,
  createDirectCheckoutSession,
  createStripeClient,
  expireDirectCheckoutSession,
  type StripeClient,
} from "${scope}/stripe";
import { expireCompanyCheckouts, type InvoiceCardPayments } from "${scope}/invoicing";
import { db } from "@/db";
import { env } from "@/env";
import { SITE_NAME } from "@/seo";
import { companyLinks } from "@/server/company-links";
import { companyAuthorizer, companyRoutes, type FeatureHandlerOverrides } from "@/server/company-routes";
import { reportError } from "@/server/error-reporter";
import { tenancy } from "@/server/tenancy";

/**
 * HOW A ${noun.toUpperCase()}'S CUSTOMERS PAY BY CARD (getting paid, part 1).
 *
 * Each ${noun} connects ITS OWN Stripe account at /app/payments (Stripe
 * Connect, Standard-style: the ${noun} signs in to its own Stripe dashboard,
 * pays its own Stripe fees, and Stripe handles refunds and disputes it can't
 * cover). "Pay now" on its invoices charges that account directly; the money
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

/**
 * Pay now's Stripe side, for @adminigloo/invoicing: a ${noun} is ready once its
 * own account is connected and Stripe has turned charges on.
 */
export const invoiceCardPayments: InvoiceCardPayments = {
  async ready(tenantId) {
    if (!cardPaymentsConfigured()) return { ready: false };
    const row = await connectedAccountFor(db, tenantId);
    return row && accountTakesCharges(row) ? { ready: true, accountId: row.accountId } : { ready: false };
  },
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
  async expireSession(input) {
    const client = paymentsStripe();
    if (client) await expireDirectCheckoutSession(client, { accountId: input.accountId, sessionId: input.sessionId });
  },
};

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
      await expireCompanyCheckouts(db, invoiceCardPayments, tenantId, (error) => void reportError({ error, source: "route", tenantId, context: { feature: "payments", step: "disconnect" } }));
    },
    onError: (error, context) => void reportError({ error, source: "route", tenantId: context.tenantId, context: { feature: "payments", route: context.route } }),
  });
}
`;
}

function renderSinglePayments(answers: Answers): string {
  const scope = answers.scope;
  return `import { createDirectCheckoutSession, createStripeClient, expireDirectCheckoutSession, type StripeClient } from "${scope}/stripe";
import type { InvoiceCardPayments } from "${scope}/invoicing";
import { env } from "@/env";

/**
 * HOW CUSTOMERS PAY BY CARD (getting paid, part 1): on this business's OWN
 * Stripe account — STRIPE_SECRET_KEY, no Connect, no fee. "Pay now" shows on
 * an invoice once the key and the invoice webhook's secret
 * (STRIPE_INVOICE_WEBHOOK_SECRET, the endpoint /api/webhooks/stripe-invoices)
 * are both set; without them the page shows "How to pay" only.
 */

/** The Stripe client, or null without STRIPE_SECRET_KEY (cached by the package). */
export function paymentsStripe(): StripeClient | null {
  return createStripeClient({ secretKey: env.STRIPE_SECRET_KEY, appUrl: env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000" });
}

export function cardPaymentsConfigured(): boolean {
  return paymentsStripe() !== null && Boolean(env.STRIPE_INVOICE_WEBHOOK_SECRET);
}

/** Pay now's Stripe side, for @adminigloo/invoicing: the site's own account (accountId null). */
export const invoiceCardPayments: InvoiceCardPayments = {
  async ready() {
    return cardPaymentsConfigured() ? { ready: true, accountId: null } : { ready: false };
  },
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
  async expireSession(input) {
    const client = paymentsStripe();
    if (client) await expireDirectCheckoutSession(client, { accountId: null, sessionId: input.sessionId });
  },
};
`;
}

// ---------------------------------------------------------------------------
// src/server/payments-webhook.ts
// ---------------------------------------------------------------------------

function renderPaymentsWebhook(answers: Answers): string {
  const scope = answers.scope;
  const companies = companiesMode(answers);
  const noun = tenantLabel(answers).toLowerCase();
  const alerts = answers.includeNotifications;
  const stripeNames = companies
    ? ["applyAccountUpdate", "assertEventLivemode", "companyForConnectEvent", "connectLedgerKey", "ledgerRunStatus", "markAccountDeauthorized", "runLedgeredEvent", "verifyStripeSignature"]
    : ["assertEventLivemode", "ledgerRunStatus", "runLedgeredEvent", "verifyStripeSignature"];
  const imports = [
    `import { NextResponse } from "next/server";`,
    `import type Stripe from "stripe";`,
    `import { resolveAppEnv } from "${scope}/env";`,
    `import { handleInvoiceCardEvent, resolveInvoicingBusiness, type CardAlert, type CardEventOutcome } from "${scope}/invoicing";`,
    `import { RATE_LIMIT_POLICIES, rateLimitHeaders } from "${scope}/observability";`,
    `import { ${stripeNames.join(", ")} } from "${scope}/stripe";`,
    `import { db } from "@/db";`,
    `import { env } from "@/env";`,
    ...(alerts ? [`import { alertOnCardPayment, alertOnInvoicingEvent } from "@/server/alerts";`] : []),
    `import { reportError } from "@/server/error-reporter";`,
    companies ? `import { invoicingBusiness } from "@/server/invoicing";` : `import { INVOICING_TENANT, invoicingBusiness } from "@/server/invoicing";`,
    `import { log } from "@/server/logger";`,
    `import { paymentsStripe } from "@/server/payments";`,
    `import { limiter } from "@/server/rate-limit";`,
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
  const tenantId = INVOICING_TENANT;
  // Its own key space: the store's endpoint can receive the same event id.
  const key = \`invoices:\${event.id}\`;`;
  return `${imports.join("\n")}

/**
 * THE ${companies ? "CONNECT" : "INVOICE PAYMENTS"} WEBHOOK (getting paid, part 1): Stripe tells this site
 * a customer paid an invoice${companies ? ` on a ${noun}'s own account` : ""}, a payment was refunded or
 * disputed, or a checkout expired${companies ? `, or a ${noun}'s account changed` : ""}.
 *
 *   1. the signature, with ${secret} (this endpoint's own);
 *   2. the mode (a test event never reaches a live site, and the reverse);
 *   3. ${companies ? `the ${noun}: the one that connected \`event.account\`. An unknown account is
 *      logged and ignored (200), so Stripe doesn't retry it for days;` : "the business: this site's one (INVOICING_TENANT);"}
 *   4. the ledger (stripe_events, keyed ${companies ? "by account AND event" : "\"invoices:<event>\""}): an event is
 *      handled once however often it arrives, a failure is retried;
 *   5. @adminigloo/invoicing's rules: the payment is recorded only for a
 *      checkout this ${companies ? noun : "business"} started, for its invoice, in the exact amount
 *      and currency it asked; anything else is logged, reported, and not
 *      recorded.
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
  let outcome: CardEventOutcome | null = null;
  const result = await runLedgeredEvent(db, { key, type: event.type, tenantId, payload: event }, async () => {
    outcome = await handleInvoiceCardEvent(db, tenantId, event, {
      onAlert: (alert) => reportCardAlert(alert),
      format: async (id) => {
        const b = resolveInvoicingBusiness(await invoicingBusiness(${companies ? "id" : ""}));
        void id;
        return { currency: b.currency, locale: b.locale, timeZone: b.timeZone };
      },${alerts ? `
      // A customer's payment settled an invoice: the "invoice paid" alert.
      onEvent: (paid) => alertOnInvoicingEvent(paid),` : ""}
      report: (error) => void reportError({ error, source: "webhook", tenantId, context: { provider: "stripe", eventId: event.id } }),
    });
  });
  if (result.outcome === "failed") {
    await reportError({ error: result.error, source: "webhook", url: req.url, tenantId, context: { provider: "stripe", eventType: event.type, eventId: event.id } });
    return new NextResponse("handler failed", { status: 500 });
  }
  if (result.outcome === "in-flight") return new NextResponse("in flight", { status: 500 });
  return NextResponse.json({ received: true, duplicate: result.outcome === "duplicate", outcome: (outcome as CardEventOutcome | null)?.outcome ?? null }, { status: ledgerRunStatus(result) });
}

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
`;
}

function webhookRoute(kind: string, whose: string): string {
  return `import { handlePaymentsWebhook } from "@/server/payments-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The ${kind} webhook: card payments on invoices, from ${whose}
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
  return `import { CompanyGate } from "@/components/CompanyGate";
import { PaymentsAttention } from "@/components/PaymentsAttention";
import { PaymentsPanel } from "@/components/PaymentsPanel";

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
      {({ company }) => (
        <main className="mx-auto max-w-3xl space-y-8 px-4 py-8 sm:px-6">
          <PaymentsPanel baseUrl={\`/api/app/\${company.id}/payments\`} justConnected={query.connected === "1"} />
          <PaymentsAttention baseUrl={\`/api/app/\${company.id}/invoices\`} />
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
export function PaymentsPanel(props: { readonly baseUrl: string; readonly justConnected: boolean }) {
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
      <header>
        <h1 className="text-2xl font-semibold">Card payments</h1>
        <p className="mt-1 text-sm text-neutral-600">Let customers pay your invoices and deposits by card, into your own Stripe account.</p>
      </header>
      {error ? <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
      {!status ? (
        <p className="text-sm text-neutral-600">Loading…</p>
      ) : (
        <div className="space-y-4 rounded-lg border border-neutral-200 p-5">
          {!status.configured ? <p className="text-sm text-amber-800">{status.configuredReason}</p> : null}
          <p className="text-base font-medium" data-payments-state={status.takingPayments ? "on" : status.connected ? "pending" : "off"}>
            {status.takingPayments
              ? "On: customers see Pay now on your invoices."
              : status.connected
                ? props.justConnected
                  ? "Thanks — Stripe is checking your details. Pay now turns on as soon as Stripe says you can take payments."
                  : "Connected, but Stripe isn't letting this account take payments yet. Finish your details in Stripe."
                : status.disconnected
                  ? "Off: you disconnected Stripe. Customers pay the ways your invoices describe."
                  : "Off: connect your Stripe account to take card payments."}
          </p>
          {accountLine ? <p className="text-sm text-neutral-700" data-payments-account="">Connected to {accountLine}</p> : null}
          {status.connected ? (
            <ul className="text-sm text-neutral-700">
              <li>Taking payments: {status.chargesEnabled ? "yes" : "not yet"}</li>
              <li>Payouts to your bank: {status.payoutsEnabled ? "yes" : "not yet"}</li>
            </ul>
          ) : null}
          <p className="text-sm text-neutral-700">{status.feeText}</p>
          <div className="flex flex-wrap items-center gap-3">
            {!status.account && status.configured ? (
              <label className="text-sm">
                Your business is in{" "}
                <select value={country} onChange={(e) => setCountry(e.target.value)} className="rounded-md border border-neutral-300 px-2 py-1">
                  {COUNTRIES.map(([code, name]) => (
                    <option key={code} value={code}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {!status.connected || !status.chargesEnabled ? (
              <button type="button" disabled={busy || !status.configured} onClick={() => void post("connect")} className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                {status.connected ? "Finish setting up in Stripe" : "Connect Stripe"}
              </button>
            ) : null}
            {status.account ? (
              <a href={status.dashboardUrl} target="_blank" rel="noreferrer" className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium">
                Payouts and refunds in Stripe
              </a>
            ) : null}
            {status.connected && !confirming ? (
              <button type="button" disabled={busy} onClick={() => setConfirming(true)} className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium">
                Disconnect
              </button>
            ) : null}
          </div>
          {confirming ? (
            <div role="group" aria-label="Disconnect Stripe?" className="space-y-2 rounded-md bg-amber-50 p-3 text-sm text-amber-900">
              <p>Disconnect Stripe? Customers can't pay by card until you connect again, and any payment page already open is closed. Payments you already took stay in your Stripe account.</p>
              <div className="flex gap-3">
                <button type="button" disabled={busy} onClick={() => void post("disconnect")} className="rounded-md bg-amber-900 px-3 py-1.5 font-medium text-white">
                  Yes, disconnect
                </button>
                <button type="button" onClick={() => setConfirming(false)} className="rounded-md border border-amber-900 px-3 py-1.5 font-medium">
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
  if (!answers.includeInvoicing) return "";
  const companies = companiesMode(answers);
  const noun = tenantLabel(answers).toLowerCase();
  const events = [...INVOICE_EVENTS, ...(companies ? ["account.updated", "account.application.deauthorized"] : [])];
  const lines = companies
    ? [
        `${heading} Taking card payments`,
        "",
        `Each ${noun} takes card (and bank) payments on its invoices and deposits into ITS OWN Stripe account (Stripe Connect, Standard: its own Stripe dashboard, its own Stripe fees; Stripe carries losses). This site's own Stripe account only bills ${noun}s for their plans.`,
        "",
        "1. **Turn on Connect** for this site's Stripe account (Dashboard → Connect → Get started), choosing that " + `${noun}s` + " get the full Stripe dashboard.",
        "2. **Fill in the platform profile and branding** (Connect → Settings: your business name, icon, colour and support details). Stripe's hosted onboarding shows them to every owner who connects, and refuses to start without them.",
        "3. **Add a webhook endpoint that listens to events on CONNECTED accounts** (Developers → Webhooks → Add endpoint → \"Listen to events on Connected accounts\") at `{your site}/api/webhooks/stripe-connect`, with these events:",
        "",
        ...events.map((e) => `   - \`${e}\``),
        "",
        "4. **Set the variables** (Vercel → Settings → Environment Variables, both environments): `STRIPE_SECRET_KEY` (this site's account), `STRIPE_CONNECT_WEBHOOK_SECRET` (the endpoint's `whsec_…`), and optionally `PLATFORM_FEE_BPS` — this site's cut of each payment in basis points (250 = 2.5%; default 0, none; rounded down to the cent, shown to each owner, not returned on refunds). Use test-mode keys and a test-mode endpoint on staging.",
        `5. **Each ${noun}'s owner** connects at /app/payments (they choose their country once). Pay now appears on their invoices as soon as Stripe turns charges on.`,
        "",
        `Every payment is recorded on the right invoice, or the ${noun}'s owners are told (the alert bell and email, with the payment's page in Stripe) — a wrong amount, a payment on a cancelled invoice, an overpayment after the invoice changed, a refund, a dispute, a bank payment that failed.`,
        "",
      ]
    : [
        `${heading} Taking card payments`,
        "",
        "Customers pay invoices and deposits by card (or bank) on this business's OWN Stripe account — no Connect, no fee.",
        "",
        "1. **Add a webhook endpoint on your own account** (Developers → Webhooks → Add endpoint → \"Listen to events on Your account\") at `{your site}/api/webhooks/stripe-invoices`, with these events:",
        "",
        ...events.map((e) => `   - \`${e}\``),
        "",
        "2. **Set the variables**: `STRIPE_SECRET_KEY` and `STRIPE_INVOICE_WEBHOOK_SECRET` (that endpoint's `whsec_…` — separate from the store's `STRIPE_WEBHOOK_SECRET`). Until both are set, invoices show How to pay only. Use test-mode keys and a test-mode endpoint on staging.",
        "",
        "Every payment is recorded on the right invoice, or reported (in /admin/errors, and to the alert bell and email with notifications) — a wrong amount, a payment on a cancelled invoice, an overpayment, a refund, a dispute, a bank payment that failed.",
        "",
      ];
  return `${lines.join("\n")}\n`;
}

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

/**
 * NEEDS YOUR ATTENTION (getting paid, part 1): every card payment the ${who}
 * has to look at — money Stripe took that couldn't be recorded as it was, an
 * overpayment to refund, a refund, a dispute, a bank payment that failed —
 * each in plain words with a link to it in Stripe and "Mark as handled".
 * Kept by @adminigloo/invoicing whether or not this project has alerts, so the
 * owner is always told. Over ${companies ? "/api/app/{id}/invoices" : "/api/admin/invoices"}/v1/admin/attention.
 */
export function PaymentsAttention(props: { readonly baseUrl: string }) {
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
      {error ? <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
      {!items ? (
        <p className="text-sm text-neutral-600">Loading…</p>
      ) : items.open.length === 0 ? (
        <p className="text-sm text-neutral-600">Nothing needs your attention. Card payments that can't be recorded as they are, refunds and disputes show here.</p>
      ) : (
        <ul className="space-y-2">
          {items.open.map((item) => (
            <li key={item.id} className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" data-attention-item={item.kind}>
              <p>{item.message}</p>
              <p className="mt-2 flex flex-wrap items-center gap-3">
                <span className="text-xs text-amber-800">{new Date(item.createdAt).toLocaleString()}</span>
                {item.stripeUrl ? (
                  <a href={item.stripeUrl} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2">
                    Open it in Stripe
                  </a>
                ) : null}
                <button type="button" disabled={busy === item.id} onClick={() => void handled(item)} className="rounded-md border border-amber-900 px-2 py-1 font-medium">
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
  if (companiesMode(answers) && answers.includeInvoicing) {
    return `import { openCardAlertCount } from "${answers.scope}/invoicing";
import { db } from "@/db";

/**
 * Counts beside header links, by href, for the person's ACTIVE company: the
 * card payments that need its owner (getting paid, part 1), shown on "Card
 * payments" while any is open — only to someone who may handle them
 * (\`invoices.payments.reverse\`). A failure shows no badge, never a broken header.
 */
export async function navBadges(tenantId: string | null, can: readonly string[]): Promise<Readonly<Record<string, number>>> {
  if (!tenantId || !can.includes("invoices.payments.reverse")) return {};
  try {
    const open = await openCardAlertCount(db, tenantId);
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
