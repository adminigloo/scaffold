/**
 * GETTING PAID, PART 2, AS THE GENERATOR WRITES IT (create-app 0.34): each
 * business sells its own products online. Read from the PLAN as text; the
 * generated project's own suite (the isolation proof on PGlite) drives the
 * store's routes as another company, and @adminigloo/commerce's suite holds
 * the money rules (server prices, stock, exact amounts, replays, refunds).
 *
 *   - companies: /app/store, /t/{web address}/store and its thank-you page,
 *     paid on the company's own connected account through the Connect webhook;
 *   - one business: /admin/store and /store on its own keys, its own webhook;
 *   - a store with no invoicing still gets the payments screen and webhook;
 *   - the site's own checkout refuses a company's product.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ANSWERS, IncompatibleAnswersError, assertAnswersCompatible, optionalEnvFor, packagesFor, type Answers } from "../answers.js";
import { planEmit, type EmitPlan } from "../emit.js";
import { FEATURE_ENTITIES, featureSuiteNames } from "../feature-proofs-emit.js";
import { INVOICE_EVENTS, STORE_EVENTS } from "../payments-emit.js";
import { upgradeNotesFor } from "../upgrade-notes.js";
import { packageVersions } from "../versions.js";
import { TEMPLATE_DIR } from "./configurations.js";

function answers(overrides: Partial<Answers> = {}): Answers {
  return { ...DEFAULT_ANSWERS, projectName: "igloo-store", includeStore: true, ...overrides };
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

/** Project (a) of the verify run: companies, plans, the store, invoicing and files. */
const COMPANIES: Partial<Answers> = { tenantNoun: "Company", businessModel: "subscription", includeInvoicing: true, includeStorage: true, includeEmail: true };
/** A companies store with nothing else that takes money. */
const STORE_ONLY: Partial<Answers> = { tenantNoun: "Company", businessModel: "none" };
/** Project (b): one business, nothing else. */
const SINGLE: Partial<Answers> = { tenantNoun: "none", businessModel: "none", adminShell: "minimal" };

describe("companies: each company's own store", () => {
  it("writes the store screen, its API, the store page, the cart's thank-you page — and no fixed business", async () => {
    const p = await plan(COMPANIES);
    for (const path of [
      ["src", "server", "store.ts"],
      ["app", "api", "app", "[tenantId]", "store", "[...path]", "route.ts"],
      ["app", "api", "t", "[slug]", "store", "[...path]", "route.ts"],
      ["app", "(site)", "app", "store", "page.tsx"],
      ["app", "(company)", "t", "[slug]", "store", "page.tsx"],
      ["app", "(company)", "t", "[slug]", "store", "thanks", "[checkout]", "page.tsx"],
    ]) {
      expect(has(p, ...path), path.join("/")).toBe(true);
    }
    expect(has(p, "app", "admin", "store", "page.tsx")).toBe(false);
    const glue = code(file(p, "src", "server", "store.ts"));
    expect(glue).toContain("resolveTenant: companyRoutes.resolveTenant");
    expect(glue).toContain("authorize: companyAuthorizer(overrides)");
    expect(glue).toContain("admit: admitPublic,");
    expect(glue).toContain("resolveTenant: resolvePublicTenant,");
    expect(glue).toContain("payments: storeCardPayments,");
    // Photos are the company's own files, counted in its allowance, with a limit on uploads.
    expect(glue).toContain("photoStore: storePhotoStore,");
    expect(glue).toContain("photoRateLimit: storePhotoRateLimit,");
    expect(code(file(p, "src", "server", "files.ts"))).toContain("export const storePhotoStore: StoragePurposeStore | undefined = files.purposeStore(STORE_PHOTO_PURPOSE.key);");
    // A trial company's receipts are capped like booking's; emails go once each.
    expect(glue).toContain("await companyOnTrial(tenantId)");
    expect(glue).toContain("onOrder: (order, owed) => sendOrderEmails(order, owed),");
    // No caller address shares one bucket: never unlimited.
    expect(glue).toContain('const caller = storeVisitorKey(req) ?? "unknown";');
    expect(glue).toContain("productLimit: (tenantId) => storeProductLimit(tenantId),");
    expect(glue).not.toContain("STORE_TENANT");
    expect(glue).not.toContain('"primary"');
    // "{Company} via {site}", replies to the owner's verified sign-in address.
    expect(glue).toContain('person.roleKey === "owner"');
    expect(glue).toContain("appName: SITE_NAME,");
    expect(glue).toContain("replyTo: owner,");
    expect(file(p, "app", "(site)", "app", "store", "page.tsx")).toContain('<CompanyGate path="/app/store" permission="store.view">');
    expect(file(p, "app", "(company)", "t", "[slug]", "store", "page.tsx")).toContain("<Storefront baseUrl={`/api/t/${company.slug}/store`} />");
  });

  it("charges the company's own account for the lines the server priced, with the fee and the hour", async () => {
    const payments = code(file(await plan(COMPANIES), "src", "server", "payments.ts"));
    expect(payments).toContain("export const storeCardPayments: StoreCardPayments = {");
    expect(payments).toContain("lines: input.lines,");
    expect(payments).toContain("metadata: { storeCheckoutId: input.checkoutId },");
    expect(payments).toContain("idempotencyKey: `store-checkout:${input.checkoutId}`");
    expect(payments).toContain("feeBps: PLATFORM_FEE_BPS,");
    expect(payments).toContain("expiresAt: input.expiresAt,");
    expect(payments).toContain("accountTakesCharges(row) ? { ready: true, accountId: row.accountId }");
    // Disconnecting closes the store's open pages too (their stock comes back).
    expect(payments).toContain("await expireCompanyStoreCheckouts(db, storeCardPayments, tenantId, report);");
    expect(payments).toContain("await expireCompanyCheckouts(db, invoiceCardPayments, tenantId, report);");
  });

  it("records store orders from the Connect webhook, for the company that owns the account — beside invoices", async () => {
    const hook = code(file(await plan(COMPANIES), "src", "server", "payments-webhook.ts"));
    expect(hook).toContain("const owner = await companyForConnectEvent(db, event);");
    expect(hook).toContain("const key = connectLedgerKey(event);");
    expect(hook).toContain("outcome = await handleInvoiceCardEvent(db, tenantId, event,");
    expect(hook).toContain("storeOutcome = await handleStoreEvent(db, tenantId, event, storeEventOptions(tenantId));");
    // The company is never read from the payment's metadata.
    expect(hook).not.toMatch(/metadata\??\.\[?["']?tenantId/);
    expect(hook).not.toMatch(/storeCheckoutId/);
  });

  it("puts the store on the nav, its keys on the company roles, the products limit on the plans, both lists on /app/payments", async () => {
    const p = await plan(COMPANIES);
    expect(code(file(p, "src", "nav.ts"))).toContain('{ href: "/app/store", label: "Store", permission: "store.view", group: "Money" }');
    expect(code(file(p, "src", "permissions", "catalog.ts"))).toContain("...storeCompanyPermissions");
    expect(code(file(p, "src", "permissions", "catalog.ts"))).not.toMatch(/\.\.\.storePermissions\b/);
    const plans = file(p, "src", "plans.ts");
    expect(plans).toContain('products: { kind: "quota", label: "products in your store"');
    expect(plans).toContain("products: 20,");
    expect(code(file(p, "src", "server", "plan-gate.ts"))).toContain('return planLimit(tenantId, "products");');
    const page = file(p, "app", "(site)", "app", "payments", "page.tsx");
    expect(page).toContain("<PaymentsAttention baseUrl={`/api/app/${company.id}/invoices`} locale={locale} />");
    expect(page).toContain('<StoreAttention baseUrl={`/api/app/${company.id}/store`} heading="Store payments that need your attention" locale={locale} />');
    const badges = code(file(p, "src", "server", "nav-badges.ts"));
    expect(badges).toContain("open += await openStoreAlertCount(db, tenantId);");
    expect(badges).toContain("open += await openCardAlertCount(db, tenantId);");
    expect(file(p, "src", "db", "schema.ts")).toContain('from "@adminigloo/commerce/schema"');
  });

  it("drives the store's routes in the isolation proof, with a row of A's for every entity", async () => {
    const p = await plan(COMPANIES);
    expect(featureSuiteNames(answers(COMPANIES))).toEqual(expect.arrayContaining(["commerce", "stripe"]));
    const proof = code(file(p, "src", "server", "__tests__", "feature-isolation.test.ts"));
    expect(proof).toContain("adminRoutes: STORE_ADMIN_ROUTES");
    expect(proof).toContain("publicRoutes: STORE_PUBLIC_ROUTES");
    expect(proof).toMatch(/import \{[^}]*STORE_ADMIN_ROUTES[^}]*\} from "@adminigloo\/commerce";/);
    for (const table of ["products", "product_variants", "store_checkouts", "orders", "order_items", "store_alerts"]) expect(proof).toContain(`    ${table}: await all(`);
    const rows = code(file(p, "src", "test", "company-rows.ts"));
    for (const entity of FEATURE_ENTITIES["commerce"]!) expect(rows).toContain(`rows["${entity}"] =`);
  });

  it("works with no invoicing: the payments screen and the Connect webhook come with the store", async () => {
    const p = await plan(STORE_ONLY);
    expect(packagesFor(answers(STORE_ONLY))).toEqual(expect.arrayContaining(["@adminigloo/stripe", "@adminigloo/catalog", "@adminigloo/commerce"]));
    expect(packagesFor(answers(STORE_ONLY))).not.toContain("@adminigloo/billing");
    expect(has(p, "app", "api", "webhooks", "stripe-connect", "route.ts")).toBe(true);
    expect(has(p, "app", "(site)", "app", "payments", "page.tsx")).toBe(true);
    expect(has(p, "src", "components", "PaymentsAttention.tsx")).toBe(false);
    const hook = code(file(p, "src", "server", "payments-webhook.ts"));
    expect(hook).not.toContain("invoicing");
    expect(hook).toContain("handleStoreEvent(db, tenantId, event");
    expect(code(file(p, "src", "server", "payments.ts"))).not.toContain("invoic");
    expect(code(file(p, "src", "permissions", "catalog.ts"))).toContain("...stripeConnectPermissions");
    expect(code(file(p, "src", "nav.ts"))).toContain('{ href: "/app/payments", label: "Card payments", permission: "payments.view", group: "Money" }');
    expect(optionalEnvFor(answers(STORE_ONLY))).toEqual(expect.arrayContaining(["STRIPE_SECRET_KEY", "STRIPE_CONNECT_WEBHOOK_SECRET", "PLATFORM_FEE_BPS"]));
    // Plans aren't sold here, so the store has no product limit to check.
    expect(code(file(p, "src", "server", "store.ts"))).not.toContain("productLimit");
    expect(file(p, "package.json")).toContain('"stripe": "^22.6.0"');
  });
});

describe("one business: its own store on its own keys", () => {
  it("writes /admin/store, /store and the thank-you page on staff keys, through its own webhook", async () => {
    const p = await plan(SINGLE);
    for (const path of [
      ["src", "server", "store.ts"],
      ["app", "api", "admin", "store", "[...path]", "route.ts"],
      ["app", "api", "store", "[...path]", "route.ts"],
      ["app", "admin", "store", "page.tsx"],
      ["app", "(site)", "store", "page.tsx"],
      ["app", "(site)", "store", "thanks", "[checkout]", "page.tsx"],
      ["app", "api", "webhooks", "stripe-invoices", "route.ts"],
    ]) {
      expect(has(p, ...path), path.join("/")).toBe(true);
    }
    expect(has(p, "app", "api", "webhooks", "stripe-connect", "route.ts")).toBe(false);
    const glue = code(file(p, "src", "server", "store.ts"));
    expect(glue).toContain('export const STORE_TENANT = "primary";');
    expect(glue).toContain('authorize: authorizeStaffFor(STORE_STAFF_KEYS, "Sign in to see the store."),');
    const hook = code(file(p, "src", "server", "payments-webhook.ts"));
    expect(hook).toContain("const tenantId = STORE_TENANT;");
    expect(hook).toContain("const key = `store:${event.id}`;");
    expect(hook).not.toContain("companyForConnectEvent");
    const payments = code(file(p, "src", "server", "payments.ts"));
    expect(payments).toContain("accountId: null,");
    expect(payments).not.toContain("feeBps");
    expect(code(file(p, "src", "permissions", "catalog.ts"))).toContain("...storePermissions");
    expect(file(p, "src", "env.ts")).toContain("...stripeInvoicePaymentsServer()");
    expect(code(file(p, "src", "server", "staff-access.ts"))).toContain("export function authorizeStaffFor");
  });

  it("refuses a single-business store with no admin panel, in words", () => {
    expect(() => assertAnswersCompatible(answers({ tenantNoun: "none", adminShell: "none" }))).toThrow(IncompatibleAnswersError);
    expect(() => assertAnswersCompatible(answers({ tenantNoun: "Company", adminShell: "none" }))).not.toThrow();
  });
});

describe("the site's own catalog, apart", () => {
  it("refuses a company's product at the site's own checkout, and skips store orders at the site's webhook", () => {
    const overlays = join(__dirname, "..", "..", "overlays", "stripe");
    const checkout = readFileSync(join(overlays, "src", "server", "routers", "checkout.ts"), "utf8");
    expect(checkout).toContain("if (!variant || variant.tenantId !== STOREFRONT_TENANT_ID) {");
    const hook = readFileSync(join(overlays, "app", "api", "webhooks", "stripe", "route.ts"), "utf8");
    expect(hook).toContain('if (metadata["storeCheckoutId"]) {');
  });

  it("keeps the site's own plan purchases on the site's webhook with the store beside them", async () => {
    const p = await plan({ ...COMPANIES });
    expect(has(p, "app", "api", "webhooks", "stripe", "route.ts")).toBe(true);
    expect(file(p, "app", "api", "webhooks", "stripe", "route.ts")).toContain('if (metadata["storeCheckoutId"]) {');
  });
});

describe("the review's cross-cutting fixes", () => {
  it("never leaves a public throttle unlimited for a caller with no address, in any generated file", async () => {
    for (const p of [await plan(COMPANIES), await plan(SINGLE), await plan({ tenantNoun: "Company", businessModel: "none", includeScheduling: true, includeEstimator: true, includeBooking: true, includeInvoicing: true, adminShell: "minimal" })]) {
      for (const [path, body] of p.files) expect(body, path).not.toContain("if (!caller) return true");
    }
  });

  it("counts only this site's own (\"*\") orders and products on the admin dashboard", async () => {
    const dash = code(file(await plan({ ...COMPANIES, businessModel: "one-time" }), "app", "admin", "page.tsx"));
    expect(dash).toContain("eq(orders.tenantId, FIRM_WIDE)");
    expect(dash).toContain("eq(products.tenantId, FIRM_WIDE)");
  });

  it("words the one-business endpoint plainly", async () => {
    expect(file(await plan({ ...SINGLE, includeInvoicing: true }), "DEPLOYMENT.md")).toContain("this one endpoint handles card payments for invoices and the store");
    expect(file(await plan(SINGLE), "DEPLOYMENT.md")).toContain("Automatic sales tax isn't supported yet");
  });
});

describe("docs, versions and the upgrade notes", () => {
  it("lists only events the endpoint already had — the store adds none", async () => {
    for (const event of STORE_EVENTS) expect(INVOICE_EVENTS as readonly string[]).toContain(event);
    const doc = file(await plan(STORE_ONLY), "DEPLOYMENT.md");
    expect(doc).toContain("Taking card payments");
    for (const event of STORE_EVENTS) expect(doc, event).toContain(event);
    expect(doc).toContain("stock is held for the 30 minutes");
  });

  it("pins commerce 0.2 (0.3 since the showroom) and stripe 0.4.1, and tells a 0.33 project what to run", () => {
    // The release lines (commerce 0.4: sales by hand; catalog 0.4: its server entry's forgetTenant).
    expect(packageVersions()["commerce"]).toMatch(/^0\.4\.\d+$/);
    expect(packageVersions()["stripe"]).toMatch(/^0\.5\.\d+$/);
    expect(packageVersions()["catalog"]).toMatch(/^0\.4\.\d+$/);
    const notes = upgradeNotesFor(answers(COMPANIES), "0.33.0").join("\n");
    expect(notes).toContain("upgrade-0.1-to-0.2.sql");
    expect(notes).toContain("catalog/sql/upgrade-0.2-to-0.3.sql");
    expect(notes).toContain("/app/store");
    // Nothing more about the store's 0.34 upgrade for a project past it (a later release's notes aren't this test's).
    expect(upgradeNotesFor(answers(COMPANIES), "0.36.1").join("\n")).not.toContain("catalog/sql/upgrade-0.2-to-0.3.sql");
  });
});
