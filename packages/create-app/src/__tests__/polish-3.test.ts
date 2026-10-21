import { describe, expect, it } from "vitest";
import { DEFAULT_ANSWERS, type Answers } from "../answers.js";
import { planEmit, type EmitPlan } from "../emit.js";
import { upgradeNotesFor } from "../upgrade-notes.js";
import { TEMPLATE_DIR } from "./configurations.js";

/**
 * POLISH ROUND 3 (create-app 0.36.2), from walking a real back office:
 *
 *   1. Connect Stripe on a site not signed up for Connect said "Something went
 *      wrong. Please try again." and logged nothing.
 *   2. (the widgets' own suites: a payment line named its method twice)
 *   3. New invoice sat under the page title instead of beside it.
 *   4. The dashboard's "See all" under Overdue invoices opened the whole ledger.
 */

function answers(overrides: Partial<Answers> = {}): Answers {
  return { ...DEFAULT_ANSWERS, projectName: "igloo-back-office", ...overrides };
}

const FEATURES: Partial<Answers> = {
  adminShell: "full",
  includeAi: true,
  includeEmail: true,
  includeFeedback: true,
  includeSeoReports: true,
  includeNotifications: true,
  includeStorage: true,
  includeAssistant: true,
  includeMarketing: true,
  includeEstimator: true,
  includeScheduling: true,
  includeInvoicing: true,
  includeComms: true,
  includeBooking: true,
  includeStore: true,
  includeCustomers: true,
  includeAeo: true,
  includeAnalytics: true,
  includeSeo: true,
};
const COMPANIES: Partial<Answers> = { ...FEATURES, tenantNoun: "Company", businessModel: "subscription" };
const SINGLE: Partial<Answers> = { ...FEATURES, tenantNoun: "none", businessModel: "one-time" };

async function files(overrides: Partial<Answers>): Promise<Map<string, string>> {
  const p: EmitPlan = await planEmit(TEMPLATE_DIR, "/out", answers(overrides));
  const out = new Map<string, string>();
  for (const [path, contents] of p.files) out.set(path.replace(/\\/g, "/"), contents);
  return out;
}

function at(all: Map<string, string>, path: string): string {
  const found = all.get(path);
  if (found === undefined) throw new Error(`${path} was not emitted`);
  return found;
}

/** The source with its comments removed, so prose about a call isn't mistaken for one. */
function code(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

describe("1. when Stripe says no", () => {
  it("companies: every failure on the payments screen, Pay now and Check out is logged and reported, in the owner's words, with Stripe's own for staff", async () => {
    const all = await files(COMPANIES);
    const payments = code(at(all, "src/server/payments.ts"));
    expect(payments).toContain("export function reportStripeFailure(");
    expect(payments).toContain("log.error(");
    expect(payments).toContain('void reportError({ error, source: "route", tenantId: context.tenantId, context: { feature: "payments", step: context.step, stripe } });');
    // The payments screen: staff (the site's operator) read Stripe's sentence and the fix.
    expect(payments).toContain("staffDetail: () => operatorView(),");
    expect(payments).toContain("onError: (error, context) => void reportStripeFailure(error, { tenantId: context.tenantId, step: context.route, stripe: context.stripe }),");
    // Pay now and Check out: reported, and the customer told nothing was charged.
    expect(payments).toContain('throw new CardPaymentUnavailableError(customerWords(reportStripeFailure(error, { tenantId: input.tenantId, step: "invoice-checkout" })));');
    expect(payments).toContain('throw new StoreRefusal("unavailable", customerWords(reportStripeFailure(error, { tenantId: input.tenantId, step: "store-checkout" })));');
    expect(payments).toContain("so nothing was charged");

    const panel = at(all, "src/components/PaymentsPanel.tsx");
    expect(panel).toContain("data-payments-staff-detail");
    expect(code(panel)).toContain("props.staff === true && error.staff");
    for (const path of ["src/components/PaymentsPanel.tsx", "src/components/PaymentsAttention.tsx"]) {
      expect(at(all, path), path).not.toContain("Something went wrong");
    }
  });

  it("one business: Pay now and Check out report the same way, with no payments screen to show staff anything", async () => {
    const all = await files(SINGLE);
    const payments = code(at(all, "src/server/payments.ts"));
    expect(payments).toContain("export function reportStripeFailure(");
    expect(payments).toContain('step: "invoice-checkout"');
    expect(payments).toContain('step: "store-checkout"');
    expect(payments).not.toContain("operatorView");
  });
});

describe("3. a work page's primary action sits in its header", () => {
  it("every company work page that hosts a screen with buttons hands them to its header", async () => {
    const all = await files(COMPANIES);
    const screens: Array<[path: string, screen: string, companion: string | null]> = [
      ["app/(site)/app/invoices/page.tsx", "<InvoicesLedger", "<InvoicesLedgerActions"],
      ["app/(site)/app/estimates/page.tsx", "<EstimatesQueue", "<EstimatesQueueActions"],
      ["app/(site)/app/schedule/page.tsx", "<ScheduleCalendar", "<ScheduleCalendarActions"],
      ["app/(site)/app/customers/page.tsx", "<CustomersAdmin", "<CustomersActions"],
      ["app/(site)/app/feedback/epics/page.tsx", "<FeedbackEpics", "<FeedbackEpicsActions"],
      ["app/(site)/app/store/page.tsx", "<StoreAdmin", null],
      ["app/(site)/app/calls/page.tsx", "<CallsAdmin", null],
    ];
    for (const [path, screen, companion] of screens) {
      const page = code(at(all, path));
      // The screen itself (not its companion, whose name starts the same).
      const start = page.search(new RegExp(`${screen}\\s`));
      expect(start, `${path}: ${screen}`).toBeGreaterThan(0);
      const opening = page.slice(start, page.indexOf("/>", start));
      expect(opening, `${path}: ${screen} draws no buttons of its own`).toContain("actionsInHeader");
      const header = page.slice(page.indexOf("<PageHeader"), start);
      expect(header, `${path}: the header has actions`).toContain("actions=");
      if (companion) expect(header, `${path}: ${companion} in the header`).toContain(companion);
    }
    // The header's links stand in for the screens' own.
    expect(code(at(all, "app/(site)/app/store/page.tsx"))).toContain("See your store");
    expect(code(at(all, "app/(site)/app/calls/page.tsx"))).toContain("Open the booking page");
    // Viewers aren't offered what they can't do.
    expect(code(at(all, "app/(site)/app/invoices/page.tsx"))).toContain('actions={can.includes("invoices.manage") ? <InvoicesLedgerActions className={buttonClass("primary")} /> : null}');
    expect(code(at(all, "app/(site)/app/store/page.tsx"))).toContain('canManage={can.includes("store.manage")}');
  });

  it("the header links match each other (review): a secondary button, the arrow, 'opens in a new tab' for screen readers, noopener", async () => {
    const all = await files(COMPANIES);
    const linkOf = (path: string, words: string): string => {
      const page = code(at(all, path));
      const end = page.indexOf(words);
      expect(end, `${path}: ${words}`).toBeGreaterThan(0);
      return page.slice(page.lastIndexOf("<a ", end), page.indexOf("</a>", end));
    };
    const links = [linkOf("app/(site)/app/store/page.tsx", "See your store"), linkOf("app/(site)/app/calls/page.tsx", "Open the booking page")];
    for (const link of links) {
      expect(link).toContain('target="_blank" rel="noopener noreferrer" className={buttonClass("secondary")}');
      expect(link).toContain('↗<span className="sr-only"> (opens in a new tab)</span>');
    }
    // NEGATIVE CONTROL: the old store link (rel="noreferrer" alone, no arrow) is gone.
    expect(code(at(all, "app/(site)/app/store/page.tsx"))).not.toContain('rel="noreferrer" className');
    // The estimates header's other links are secondary buttons too, not underlined text beside the primary one.
    const estimates = code(at(all, "app/(site)/app/estimates/page.tsx"));
    expect(estimates).toContain('<Link href="/app/price-book" className={buttonClass("secondary")}>');
    expect(estimates).toContain('<Link href="/app/estimates/settings" className={buttonClass("secondary")}>');
    expect(estimates).not.toContain("underline underline-offset-2");
  });

  it("the emitted CallsAdmin passes actionsInHeader through to the package's screen", async () => {
    const all = await files(COMPANIES);
    expect(code(at(all, "src/components/CallsAdmin.tsx"))).toContain("actionsInHeader={props.actionsInHeader === true}");
  });
});

describe("4. the dashboard's See all opens the same list", () => {
  it("overdue invoices, newest leads and today's visits link to their filtered pages, and the pages read the filter", async () => {
    const all = await files(COMPANIES);
    const dashboard = code(at(all, "src/server/dashboard.ts"));
    expect(dashboard).toContain('href: "/app/invoices?status=overdue",');
    expect(dashboard).toContain('href: "/app/estimates?filter=leads",');
    expect(dashboard).toContain("const todayHref = `/app/schedule?date=${today}&view=day`;");
    expect(dashboard).not.toMatch(/key: "overdue",[\s\S]{0,200}href: "\/app\/invoices",/);

    const invoices = code(at(all, "app/(site)/app/invoices/page.tsx"));
    expect(invoices).toContain("const { status } = await searchParams;");
    expect(invoices).toContain("initialFilter={initialFilter}");
    const estimates = code(at(all, "app/(site)/app/estimates/page.tsx"));
    expect(estimates).toContain("const { filter } = await searchParams;");
    expect(estimates).toContain("initialFilter={initialFilter}");
    const schedule = code(at(all, "app/(site)/app/schedule/page.tsx"));
    expect(schedule).toContain('const initialView = view === "day" || view === "week" ? view : undefined;');
    expect(schedule).toContain("initialView={initialView}");
  });
});

describe("upgrade notes (0.36.2)", () => {
  it("say what a project gets and the one thing to do about a Connect refusal", () => {
    const notes = upgradeNotesFor(answers(COMPANIES), "0.36.1").join("\n");
    expect(notes).toContain("describeStripeFailure");
    expect(notes).toContain("https://dashboard.stripe.com/connect");
    expect(notes).toContain("page header");
    expect(notes).toContain("/app/invoices?status=overdue");
    expect(upgradeNotesFor(answers(COMPANIES), "0.36.2").join("\n")).not.toContain("describeStripeFailure");
    expect(upgradeNotesFor(answers(SINGLE), "0.36.1").join("\n")).not.toContain("dashboard.stripe.com/connect");
  });
});
