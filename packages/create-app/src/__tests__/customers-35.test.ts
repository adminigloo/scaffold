/**
 * THE CUSTOMER LIST, AS THE GENERATOR WRITES IT (create-app 0.35). Read from
 * the PLAN as text; the generated project's own suite (the isolation proof on
 * PGlite) drives CUSTOMERS_ADMIN_ROUTES as another company, and
 * @adminigloo/customers' suite holds the matching rules (one company only,
 * Gmail folding, E.164, a double-create is one customer, the timeline).
 *
 *   - on by default with any field feature; --no-customers turns it off;
 *   - companies: /app/customers, its API, the hooks on every installed
 *     feature's own seam, the backfill, "Customer: … →" on record pages;
 *   - one business: /admin/customers on staff keys, the same hooks;
 *   - emitted variants: a feature that isn't installed has no hook and no
 *     import, and no emitted file asks about the answers.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ANSWERS, IncompatibleAnswersError, assertAnswersCompatible, customersByDefault, packagesFor, type Answers } from "../answers.js";
import { collectAnswers, parseArgs } from "../cli.js";
import { planEmit, type EmitPlan } from "../emit.js";
import { FEATURE_ENTITIES, featureSuiteNames } from "../feature-proofs-emit.js";
import { defaultsOnlyPrompter } from "../prompt.js";
import { upgradeNotesFor } from "../upgrade-notes.js";
import { packageVersions } from "../versions.js";
import { TEMPLATE_DIR } from "./configurations.js";

function answers(overrides: Partial<Answers> = {}): Answers {
  return { ...DEFAULT_ANSWERS, projectName: "igloo-customers", includeCustomers: true, ...overrides };
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

/** Project (a) of the verify run: companies, plans, and every field feature. */
const COMPANIES: Partial<Answers> = {
  tenantNoun: "Company",
  businessModel: "subscription",
  adminShell: "minimal",
  includeEstimator: true,
  includeScheduling: true,
  includeInvoicing: true,
  includeBooking: true,
  includeStore: true,
  includeComms: true,
  includeEmail: true,
};
/** Project (b): one business with the estimator and invoicing. */
const SINGLE: Partial<Answers> = { tenantNoun: "none", businessModel: "none", adminShell: "minimal", includeEstimator: true, includeInvoicing: true };

describe("the answer", () => {
  it("is on by default whenever a field feature is, and --no-customers turns it off", async () => {
    const on = await collectAnswers(parseArgs(["acme", "--yes", "--tenant-noun", "Company", "--invoicing"]), defaultsOnlyPrompter());
    expect(on.includeCustomers).toBe(true);
    const off = await collectAnswers(parseArgs(["acme", "--yes", "--tenant-noun", "Company", "--invoicing", "--no-customers"]), defaultsOnlyPrompter());
    expect(off.includeCustomers).toBe(false);
    const none = await collectAnswers(parseArgs(["acme", "--yes", "--tenant-noun", "Company"]), defaultsOnlyPrompter());
    expect(none.includeCustomers).toBe(false);
    for (const feature of ["includeEstimator", "includeScheduling", "includeInvoicing", "includeBooking", "includeStore", "includeComms"] as const) {
      expect(customersByDefault({ ...DEFAULT_ANSWERS, tenantNoun: "Company", [feature]: true }), feature).toBe(true);
    }
    // One business with no admin panel has nowhere to work the list: not on by default, refused when asked.
    expect(customersByDefault({ ...DEFAULT_ANSWERS, tenantNoun: "none", adminShell: "none", includeInvoicing: true })).toBe(false);
    expect(() => assertAnswersCompatible(answers({ tenantNoun: "none", adminShell: "none" }))).toThrow(IncompatibleAnswersError);
  });

  it("installs @adminigloo/customers and pins it, with invoicing 0.6 and comms 0.5", () => {
    expect(packagesFor(answers(COMPANIES))).toContain("@adminigloo/customers");
    expect(packagesFor(answers({ ...COMPANIES, includeCustomers: false }))).not.toContain("@adminigloo/customers");
    // The release line (0.3 adds forgetTenant).
    expect(packageVersions()["customers"]).toMatch(/^0\.3\.\d+$/);
    expect(packageVersions()["invoicing"]).toMatch(/^0\.7\.\d+$/);
    expect(packageVersions()["comms"]).toMatch(/^0\.6\.\d+$/);
  });
});

describe("companies: each company's own customer list", () => {
  it("writes the screen, its API, the hooks and the backfill — on the company's own keys", async () => {
    const p = await plan(COMPANIES);
    for (const path of [
      ["src", "server", "customer-activity.ts"],
      ["src", "server", "customers.ts"],
      ["app", "api", "app", "[tenantId]", "customers", "[...path]", "route.ts"],
      ["app", "(site)", "app", "customers", "page.tsx"],
      ["scripts", "customers-backfill.ts"],
    ]) {
      expect(has(p, ...path), path.join("/")).toBe(true);
    }
    expect(has(p, "app", "admin", "customers", "page.tsx")).toBe(false);
    const glue = file(p, "src", "server", "customers.ts");
    expect(glue).toContain("resolveTenant: companyRoutes.resolveTenant");
    expect(glue).toContain("authorize: companyAuthorizer(overrides)");
    expect(code(glue)).not.toContain("CUSTOMERS_TENANT");
    const page = file(p, "app", "(site)", "app", "customers", "page.tsx");
    expect(page).toContain('<CompanyGate path="/app/customers" permission="customers.view">');
    expect(page).toContain('canManage={can.includes("customers.manage")}');
    expect(page).toContain('estimate: "/app/estimates/{id}"');
    const manifest = JSON.parse(file(p, "package.json")) as { dependencies: Record<string, string>; scripts: Record<string, string> };
    expect(manifest.dependencies["@adminigloo/customers"]).toMatch(/^\^0\.3\.\d+$/);
    expect(manifest.scripts["customers:backfill"]).toBe("tsx scripts/customers-backfill.ts");
    expect(file(p, "src", "db", "schema.ts")).toContain("@adminigloo/customers/schema");
  });

  it("hooks every installed feature's own seam, the customer list after the alerts and before the emails", async () => {
    const p = await plan({ ...COMPANIES, includeNotifications: true });
    const activity = file(p, "src", "server", "customer-activity.ts");
    for (const hook of ["customerOnEstimatorEvent", "customerOnSchedulingEvent", "customerOnInvoicingEvent", "customerOnBookingEvent", "customerOnStoreOrder", "customerOnMessageSent"]) {
      expect(activity, hook).toContain(`export async function ${hook}(`);
    }
    // Inside the company the event is for, never anything the customer sent.
    expect(activity).toContain("tenantId: event.tenantId");
    expect(activity).toContain("tenantId: order.tenantId");
    expect(activity).toContain("tenantId: sent.tenantId");
    expect(activity).toContain('mode: "find"');
    // A stranger's form never changes a customer it matches; staff vouch for their own.
    expect(activity).toContain('source: event.actor.type === "staff" ? "staff" : "public",');
    expect(activity.match(/source: "public",/g)?.length).toBe(2);
    // A quote turned into an invoice goes to the quote's customer, changing nothing about them.
    expect(activity).toContain('await customerDirectory.linkedTo(event.tenantId, "estimate", event.estimateId)');
    // Each move of a visit or a call, and each payment, is its own entry.
    expect(activity).toContain("occurrence: String(visit.sequence),");
    expect(activity).toContain("occurrence: String(call.sequence),");
    expect(file(p, "app", "api", "app", "[tenantId]", "customers", "[...path]", "route.ts")).toContain("export const maxDuration = 60;");
    expect(file(p, "src", "server", "estimator-notify.ts")).toContain(
      "LISTENERS: readonly EstimatorEventListener[] = [(event) => alertOnEstimatorEvent(event), (event) => customerOnEstimatorEvent(event), estimatorComms.onEvent]",
    );
    expect(file(p, "src", "server", "scheduling-notify.ts")).toContain(
      "LISTENERS: readonly SchedulingEventListener[] = [(event) => alertOnSchedulingEvent(event), (event) => customerOnSchedulingEvent(event), schedulingComms.onEvent]",
    );
    expect(file(p, "src", "server", "invoicing.ts")).toContain("onEvent: (event) => alertOnInvoicingEvent(event).finally(() => customerOnInvoicingEvent(event)),");
    expect(file(p, "src", "server", "payments-webhook.ts")).toContain("customerOnInvoicingEvent(paid)");
    expect(file(p, "src", "server", "booking.ts")).toContain("await customerOnBookingEvent(event);\n      await sendBookingEmails(event);");
    expect(file(p, "src", "server", "store.ts")).toContain("await customerOnStoreOrder(order);\n      return sendOrderEmails(order, owed);");
    expect(file(p, "src", "server", "comms-senders.ts")).toContain('onSent: (sent) => import("./customer-activity").then((m) => m.customerOnMessageSent(sent)),');
  });

  it("puts \"Customer: … →\" on the company's estimate and invoice pages", async () => {
    const p = await plan(COMPANIES);
    expect(file(p, "app", "(site)", "app", "estimates", "[id]", "page.tsx")).toContain('<CustomerLinkSlot tenantId={company.id} kind="estimate" refId={id} />');
    expect(file(p, "app", "(site)", "app", "invoices", "[id]", "page.tsx")).toContain('<CustomerLinkSlot tenantId={company.id} kind="invoice" refId={id} />');
    const slot = file(p, "src", "components", "CustomerLinkSlot.tsx");
    expect(slot).toContain("customerForRecord(props.tenantId");
    expect(slot).toContain("/app/customers?customer=");
  });

  it("is in the isolation proof, the company's nav and its permissions", async () => {
    const p = await plan(COMPANIES);
    expect(featureSuiteNames(answers(COMPANIES))).toContain("customers");
    expect(FEATURE_ENTITIES.customers).toEqual(["customer", "customer-address", "spare-customer", "customer-notice"]);
    const proof = file(p, "src", "server", "__tests__", "feature-isolation.test.ts");
    expect(proof).toContain('import { CUSTOMERS_ADMIN_ROUTES, customersCompanyPermissions } from "@adminigloo/customers";');
    expect(proof).toContain("adminRoutes: CUSTOMERS_ADMIN_ROUTES");
    const rows = file(p, "src", "test", "company-rows.ts");
    expect(rows).toContain('rows["spare-customer"] = spare.customer.id;');
    expect(rows).toContain("await mergeCustomers(database, tenantId, listed.customer.id, duplicate.customer.id);");
    expect(proof).toContain("customer_merges: await all(");
    expect(Object.values(Object.fromEntries(p.files)).some((body) => body.includes('href: "/app/customers"'))).toBe(true);
  });

  it("asks nothing about the answers at runtime, and lists only what's installed", async () => {
    const p = await plan({ tenantNoun: "Company", includeInvoicing: true });
    const activity = file(p, "src", "server", "customer-activity.ts");
    expect(activity).toContain("customerOnInvoicingEvent");
    for (const absent of ["customerOnEstimatorEvent", "customerOnSchedulingEvent", "customerOnBookingEvent", "customerOnStoreOrder", "customerOnMessageSent", "@adminigloo/booking", "@adminigloo/comms", "@adminigloo/estimator"]) {
      expect(activity, absent).not.toContain(absent);
    }
    for (const [path, body] of p.files) {
      if (/customer/i.test(path)) expect(code(body), path).not.toMatch(/includeCustomers|answers\./);
    }
    expect(file(p, "src", "server", "invoicing.ts")).toContain("onEvent: (event) => customerOnInvoicingEvent(event),");
    const backfill = file(p, "scripts", "customers-backfill.ts");
    expect(backfill).toContain("invoices");
    expect(backfill).not.toContain("estimatorEstimates");
    // In the company's own currency, and as staff's own details.
    expect(backfill).toContain("resolveInvoicingBusiness(await invoicingBusiness(tenantId)).currency");
    expect(backfill).toContain('source: "staff" as const');
  });
});

describe("one business: /admin/customers on staff keys", () => {
  it("writes the admin page, the staff-ladder handler and the hooks of its two features", async () => {
    const p = await plan(SINGLE);
    expect(has(p, "app", "admin", "customers", "page.tsx")).toBe(true);
    expect(has(p, "app", "api", "admin", "customers", "[...path]", "route.ts")).toBe(true);
    expect(has(p, "app", "(site)", "app", "customers", "page.tsx")).toBe(false);
    const glue = file(p, "src", "server", "customers.ts");
    expect(glue).toContain('export const CUSTOMERS_TENANT = "primary";');
    expect(glue).toContain('authorizeStaffFor(CUSTOMERS_STAFF_KEYS, "Sign in to see customers.")');
    expect(has(p, "src", "server", "staff-access.ts")).toBe(true);
    const page = file(p, "app", "admin", "customers", "page.tsx");
    expect(page).toContain('can?.can("customers.view")');
    expect(page).toContain('invoice: "/admin/invoices/{id}"');
    expect(file(p, "app", "admin", "invoices", "[id]", "page.tsx")).toContain('<CustomerLinkSlot kind="invoice" refId={id} />');
    expect(file(p, "src", "components", "CustomerLinkSlot.tsx")).toContain("/admin/customers?customer=");
    const activity = file(p, "src", "server", "customer-activity.ts");
    expect(activity).toContain("customerOnEstimatorEvent");
    expect(activity).toContain('eq(invoices.estimateId, event.estimateId)');
    expect(file(p, "src", "server", "estimator-notify.ts")).toContain("(event) => customerOnEstimatorEvent(event)");
  });
});

describe("--no-customers", () => {
  it("writes no list and no hook, and the record pages' slot is nothing", async () => {
    const p = await plan({ ...COMPANIES, includeCustomers: false });
    for (const path of [["src", "server", "customer-activity.ts"], ["src", "server", "customers.ts"], ["scripts", "customers-backfill.ts"], ["app", "(site)", "app", "customers", "page.tsx"]]) {
      expect(has(p, ...path), path.join("/")).toBe(false);
    }
    for (const [path, body] of p.files) expect(body, path).not.toContain("customerOn");
    expect(file(p, "src", "components", "CustomerLinkSlot.tsx")).toContain("return null;");
    expect(file(p, "src", "components", "CustomerLinkSlot.tsx")).not.toContain("@/server/customers");
  });
});

describe("upgrading", () => {
  it("tells a 0.34 project with the list what to run, and one without how to add it", () => {
    const withList = upgradeNotesFor(answers(COMPANIES), "0.34.0").join("\n");
    expect(withList).toContain("customers/sql/customers-0.1.0.sql");
    expect(withList).toContain("pnpm customers:backfill");
    const without = upgradeNotesFor(answers({ ...COMPANIES, includeCustomers: false }), "0.34.0").join("\n");
    expect(without).toContain("add customers");
    expect(upgradeNotesFor(answers(COMPANIES), "0.36.1").join("\n")).not.toContain("customers:backfill");
  });
});
