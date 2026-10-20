/**
 * GETTING PAID, PART 1, AS THE GENERATOR WRITES IT (create-app 0.33):
 * customers pay invoices and deposits online. Read from the PLAN as text; the
 * generated project's own suite (the isolation proof on PGlite) runs the
 * routes, and the packages' suites hold the money rules.
 *
 *   - companies: each company's own Stripe account (Connect) at /app/payments,
 *     Pay now on its /t invoice pages, the Connect webhook, the fee;
 *   - one business: its own keys, no Connect, its own webhook;
 *   - with the estimator: the accepted quote's "Pay the deposit".
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ANSWERS, optionalEnvFor, packagesFor, type Answers } from "../answers.js";
import { planEmit, type EmitPlan } from "../emit.js";
import { featureSuiteNames } from "../feature-proofs-emit.js";
import { INVOICE_EVENTS } from "../payments-emit.js";
import { upgradeNotesFor } from "../upgrade-notes.js";
import { TEMPLATE_DIR } from "./configurations.js";

function answers(overrides: Partial<Answers> = {}): Answers {
  return { ...DEFAULT_ANSWERS, projectName: "igloo-paid", includeInvoicing: true, ...overrides };
}

const cache = new Map<string, Promise<EmitPlan>>();
function plan(overrides: Partial<Answers> = {}): Promise<EmitPlan> {
  const key = JSON.stringify(answers(overrides));
  let found = cache.get(key);
  if (!found) {
    found = planEmit(TEMPLATE_DIR, "/out", answers(overrides));
    cache.set(key, found);
  }
  return found;
}
function file(p: EmitPlan, ...segments: string[]): string {
  const contents = p.files.get(join(...segments));
  if (contents === undefined) throw new Error(`the plan has no ${segments.join("/")}`);
  return contents;
}
const has = (p: EmitPlan, ...segments: string[]) => p.files.has(join(...segments));
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const COMPANIES: Partial<Answers> = { tenantNoun: "Company", businessModel: "subscription", includeEstimator: true, includeScheduling: true, includeEmail: true };
const SINGLE: Partial<Answers> = { tenantNoun: "none", businessModel: "none" };

describe("companies: each company's own Stripe account", () => {
  it("writes the payments screen, its API, the Connect webhook and Pay now on the invoice pages", async () => {
    const p = await plan(COMPANIES);
    for (const path of [
      ["app", "(site)", "app", "payments", "page.tsx"],
      ["app", "api", "app", "[tenantId]", "payments", "[...path]", "route.ts"],
      ["app", "api", "webhooks", "stripe-connect", "route.ts"],
      ["src", "server", "payments.ts"],
      ["src", "server", "payments-webhook.ts"],
    ]) {
      expect(has(p, ...path), path.join("/")).toBe(true);
    }
    expect(has(p, "app", "api", "webhooks", "stripe-invoices", "route.ts")).toBe(false);
    const glue = code(file(p, "src", "server", "payments.ts"));
    expect(glue).toContain("resolveTenant: companyRoutes.resolveTenant");
    expect(glue).toContain("authorize: companyAuthorizer(overrides)");
    expect(glue).toContain("feeBps: PLATFORM_FEE_BPS");
    expect(glue).toContain("accountTakesCharges(row) ? { ready: true, accountId: row.accountId }");
    const invoicing = code(file(p, "src", "server", "invoicing.ts"));
    expect(invoicing).toContain("payments: invoiceCardPayments,");
    expect(invoicing).toContain("invoicePageUrl: async (token, tenantId) => (await companyLinks(tenantId)).invoice(token)");
    expect(file(p, "app", "(company)", "t", "[slug]", "invoice", "[token]", "page.tsx")).toContain('returned={query.paid === "1"}');
  });

  it("maps a Connect event to the company that owns the account, ledgered by account + event, and ignores an unknown account", async () => {
    const hook = code(file(await plan(COMPANIES), "src", "server", "payments-webhook.ts"));
    expect(hook).toContain("verifyStripeSignature(body, signature, secret, client.stripe)");
    expect(hook).toContain("const secret = env.STRIPE_CONNECT_WEBHOOK_SECRET;");
    expect(hook).toContain("assertEventLivemode(event, resolveAppEnv())");
    expect(hook).toContain("const owner = await companyForConnectEvent(db, event);");
    expect(hook).toContain('if (owner.kind === "ignored")');
    expect(hook).toContain("const key = connectLedgerKey(event);");
    expect(hook).toContain("handleInvoiceCardEvent(db, tenantId, event,");
    // The company never comes from the payment's metadata.
    expect(hook).not.toMatch(/metadata\??\.\[?["']?tenantId/);
  });

  it("declares the env, the keys, the nav and the proof's payments suite", async () => {
    const p = await plan(COMPANIES);
    const env = code(file(p, "src", "env.ts"));
    expect(env).toContain("...stripeConnectServer()");
    expect(env).toContain("STRIPE_CONNECT_WEBHOOK_SECRET: process.env.STRIPE_CONNECT_WEBHOOK_SECRET");
    expect(env).toContain("PLATFORM_FEE_BPS: process.env.PLATFORM_FEE_BPS");
    expect(optionalEnvFor(answers(COMPANIES))).toEqual(expect.arrayContaining(["STRIPE_CONNECT_WEBHOOK_SECRET", "PLATFORM_FEE_BPS"]));
    expect(code(file(p, "src", "permissions", "catalog.ts"))).toContain("...stripeConnectPermissions");
    expect(code(file(p, "src", "nav.ts"))).toContain('{ href: "/app/payments", label: "Card payments", permission: "payments.view", group: "Money" }');
    expect(featureSuiteNames(answers(COMPANIES))).toContain("stripe");
    const proof = code(file(p, "src", "server", "__tests__", "feature-isolation.test.ts"));
    expect(proof).toContain("adminRoutes: STRIPE_CONNECT_ADMIN_ROUTES");
    expect(proof).toContain("invoice_checkouts: await all(");
    expect(proof).toContain("stripe_connected_accounts: await all(");
    expect(code(file(p, "src", "test", "company-rows.ts"))).toContain("database.insert(stripeConnectedAccounts)");
  });

  it("offers the accepted quote's payment by stage, through the estimator's own quote → invoice flow, never on staff's draft", async () => {
    const p = await plan(COMPANIES);
    const deposit = code(file(p, "src", "server", "quote-deposit.ts"));
    expect(deposit).toContain('import { convertEstimateToInvoice } from "@/server/estimator-services";');
    expect(deposit).toContain("convertEstimateToInvoice!({ tenantId, estimateId: quote.estimateId, userId: null })");
    expect(deposit).toContain("startInvoiceCheckout(db, invoiceCardPayments,");
    // M1: the button follows the stage (invoicing's quotePaymentAction).
    expect(deposit).toContain("quotePaymentAction(invoice, business, { quoteTotal: quote.total, pending: pending?.amount ?? 0 })");
    // M2: a click converts only when no invoice exists, and never publishes staff's draft.
    expect(deposit).toContain('if (invoice?.status === "draft") return back(quoteUrl);');
    expect(deposit.indexOf("if (!invoice) {")).toBeGreaterThan(deposit.indexOf('if (invoice?.status === "draft")'));
    // M3 and L9: a refusal is a page, not a 500; only this site's own page may post.
    expect(deposit).toContain('error.name === "EstimatorInputError") return sorry(');
    expect(deposit).toContain('if (req.headers.get("sec-fetch-site")?.trim().toLowerCase() === "same-origin") return true;');
    expect(deposit).toContain("if (!origin) return false;");
    expect(has(p, "app", "api", "t", "[slug]", "quote-deposit", "[token]", "route.ts")).toBe(true);
    expect(file(p, "app", "(company)", "t", "[slug]", "quote", "[token]", "page.tsx")).toContain("payment={await quotePayment(company.slug, token)}");
  });

  it("H2 and L2, L4, L5, L8: owners hear about card problems; disconnecting closes pages; events in order; a budget per account; the site's name", async () => {
    const p = await plan({ ...COMPANIES, includeNotifications: true });
    const hook = code(file(p, "src", "server", "payments-webhook.ts"));
    expect(hook).toContain("await alertOnCardPayment(alert);");
    expect(hook).toContain("applyAccountUpdate(db, event.data.object as Stripe.Account, new Date(event.created * 1000))");
    expect(hook).toContain('key: `webhook:stripe-connect:${event.account ?? "platform"}`');
    expect(code(file(p, "src", "server", "alerts.ts"))).toContain("invoicingCardAlert(alert, { hrefs: { invoice: ALERT_HREFS.invoice } })");
    const glue = code(file(p, "src", "server", "payments.ts"));
    expect(glue).toContain("siteName: SITE_NAME,");
    expect(glue).toContain("await expireCompanyCheckouts(db, invoiceCardPayments, tenantId,");
    expect(glue).toContain("expiresAt: input.expiresAt,");
    // Without notifications, there is no bell to send to — and nothing pretends there is.
    expect(code(file(await plan(COMPANIES), "src", "server", "payments-webhook.ts"))).not.toContain("alertOnCardPayment");
  });

  it("M6: README and DEPLOYMENT say how to take card payments, with the endpoint and every event", async () => {
    // The docs list is @adminigloo/invoicing's own INVOICE_CARD_EVENT_TYPES (read from its source: create-app doesn't install it).
    const source = readFileSync(join(__dirname, "..", "..", "..", "invoicing", "src", "online.ts"), "utf8");
    const block = /export const INVOICE_CARD_EVENT_TYPES = \[([^\]]*)\]/.exec(source)![1]!;
    const INVOICE_CARD_EVENT_TYPES = [...block.matchAll(/"([a-z_.]+)"/g)].map((m) => m[1]!);
    expect(INVOICE_CARD_EVENT_TYPES).toEqual([...INVOICE_EVENTS]);
    for (const [overrides, url, extra] of [
      [COMPANIES, "/api/webhooks/stripe-connect", ["account.updated", "account.application.deauthorized", "Turn on Connect", "platform profile and branding", "CONNECTED accounts", "STRIPE_CONNECT_WEBHOOK_SECRET", "PLATFORM_FEE_BPS"]],
      [SINGLE, "/api/webhooks/stripe-invoices", ["STRIPE_INVOICE_WEBHOOK_SECRET"]],
    ] as const) {
      const p = await plan(overrides);
      for (const doc of [file(p, "README.md"), file(p, "DEPLOYMENT.md")]) {
        expect(doc).toContain("Taking card payments");
        expect(doc).toContain(url);
        for (const event of [...INVOICE_CARD_EVENT_TYPES, ...extra]) expect(doc, event).toContain(event);
      }
    }
  });

  it("tells an upgrading project which SQL to run and what to set in Stripe", () => {
    const notes = upgradeNotesFor(answers(COMPANIES), "0.32.0").join("\n");
    expect(notes).toContain("upgrade-0.4-to-0.5.sql");
    expect(notes).toContain("upgrade-0.3-to-0.4.sql");
    expect(notes).toContain("/api/webhooks/stripe-connect");
    expect(notes).toContain("account.updated");
    expect(upgradeNotesFor(answers(COMPANIES), "0.33.0").join("\n")).not.toContain("stripe-connect");
  });
});

describe("one business: its own Stripe keys, no Connect", () => {
  it("writes Pay now on the business's own account and its own webhook, with no payments screen", async () => {
    const p = await plan(SINGLE);
    expect(has(p, "app", "api", "webhooks", "stripe-invoices", "route.ts")).toBe(true);
    expect(has(p, "app", "api", "webhooks", "stripe-connect", "route.ts")).toBe(false);
    expect(has(p, "app", "(site)", "app", "payments", "page.tsx")).toBe(false);
    const glue = code(file(p, "src", "server", "payments.ts"));
    expect(glue).toContain("accountId: null");
    expect(glue).not.toContain("Connect");
    expect(glue).not.toContain("feeBps");
    const hook = code(file(p, "src", "server", "payments-webhook.ts"));
    expect(hook).toContain("const tenantId = INVOICING_TENANT;");
    expect(hook).toContain("const key = `invoices:${event.id}`;");
    expect(hook).not.toContain("companyForConnectEvent");
    const env = code(file(p, "src", "env.ts"));
    expect(env).toContain("STRIPE_SECRET_KEY: stripeServer().STRIPE_SECRET_KEY");
    expect(env).toContain("...stripeInvoicePaymentsServer()");
    expect(env).not.toContain("stripeConnectServer");
    expect(packagesFor(answers(SINGLE))).toContain("@adminigloo/stripe");
    expect(code(file(p, "src", "db", "schema.ts"))).toContain('from "@adminigloo/stripe/schema"');
    expect(file(p, "app", "(site)", "invoice", "[token]", "page.tsx")).toContain('returned={paid === "1"}');
  });

  it("emits a variant, never an `if` about the answers", async () => {
    for (const overrides of [COMPANIES, SINGLE]) {
      const p = await plan(overrides);
      for (const path of [["src", "server", "payments.ts"], ["src", "server", "payments-webhook.ts"]]) {
        expect(code(file(p, ...path))).not.toMatch(/tenantNoun|includeInvoicing|businessModel/);
      }
    }
  });
});

describe("without invoicing", () => {
  it("writes no payments files, and the quote page's deposit is never offered", async () => {
    const p = await plan({ includeInvoicing: false, includeEstimator: true, tenantNoun: "Company" });
    expect(has(p, "src", "server", "payments.ts")).toBe(false);
    expect(code(file(p, "src", "server", "quote-deposit.ts"))).toContain("return undefined;");
  });
});

describe("Needs your attention: the owner is told with or without alerts", () => {
  it("companies: /app/payments lists it, the header counts it, and the proof drives both routes with A's planted problem", async () => {
    const p = await plan(COMPANIES);
    const page = file(p, "app", "(site)", "app", "payments", "page.tsx");
    expect(page).toContain("<PaymentsAttention baseUrl={`/api/app/${company.id}/invoices`} locale={locale} />");
    const list = code(file(p, "src", "components", "PaymentsAttention.tsx"));
    expect(list).toContain("/v1/admin/attention");
    expect(list).toContain("Mark as handled");
    expect(list).toContain("Open it in Stripe");
    const badges = code(file(p, "src", "server", "nav-badges.ts"));
    expect(badges).toContain('return open > 0 ? { "/app/payments": open } : {};');
    expect(code(file(p, "src", "components", "AuthHeader.tsx"))).toContain("framed(link, viewer.badges)");
    expect(code(file(p, "src", "components", "SiteFrame.tsx"))).toContain("<Badge count={link.badge} />");
    const rows = code(file(p, "src", "test", "company-rows.ts"));
    expect(rows).toContain("database\n    .insert(invoiceCardAlerts)");
    expect(rows).toContain('rows["card-alert"] = cardAlert.id;');
    expect(code(file(p, "src", "server", "__tests__", "feature-isolation.test.ts"))).toContain("invoice_card_alerts: await all(");
    // Without notifications the webhook sends no bell — the list is how the owner hears.
    expect(code(file(p, "src", "server", "payments-webhook.ts"))).not.toContain("alertOnCardPayment");
  });

  it("one business: the same list on the admin invoices page; no badge to count", async () => {
    const p = await plan({ ...SINGLE, adminShell: "full" });
    expect(file(p, "app", "admin", "invoices", "page.tsx")).toContain('<PaymentsAttention baseUrl="/api/admin/invoices" />');
    expect(code(file(p, "src", "server", "nav-badges.ts"))).toContain("return {};");
  });

  it("every project has the badge module the header imports", async () => {
    const p = await plan({ includeInvoicing: false });
    expect(code(file(p, "src", "server", "nav-badges.ts"))).toContain("export async function navBadges(");
  });
});
