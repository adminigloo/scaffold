import { describe, expect, it } from "vitest";
import { DEFAULT_ANSWERS, type Answers } from "../answers.js";
import { planEmit, type EmitPlan } from "../emit.js";
import { upgradeNotesFor } from "../upgrade-notes.js";
import { TEMPLATE_DIR } from "./configurations.js";

/**
 * THE DASHBOARD, ROUND 2 (create-app 0.36.1). A demo company with 26
 * customers, visits today and money owed saw "7 of 9 done" and nothing else:
 * the checklist hid the numbers. Now the numbers always show, an unfinished
 * setup is one collapsible card above them, and under them up to three short
 * lists — each only for what's installed and what the person may open, read
 * from the company's own rows.
 */

function answers(overrides: Partial<Answers> = {}): Answers {
  return { ...DEFAULT_ANSWERS, projectName: "igloo-back-office", ...overrides };
}

const EVERYTHING: Partial<Answers> = {
  tenantNoun: "Company",
  businessModel: "subscription",
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

async function files(overrides: Partial<Answers>): Promise<Map<string, string>> {
  const p: EmitPlan = await planEmit(TEMPLATE_DIR, "/out", answers(overrides));
  const out = new Map<string, string>();
  for (const [path, contents] of p.files) out.set(path.replace(/\\/g, "/"), contents);
  return out;
}

/** The source with its comments removed, so prose about a call isn't mistaken for one. */
function code(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

/** Each `if (can.includes("…")) {` block of the dashboard, by the permission it asks for. */
function blocksByPermission(source: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = source.split(/if \(can\.includes\("([^"]+)"\)\) \{/);
  for (let i = 1; i < parts.length; i += 2) out.set(parts[i]!, parts[i + 1]!);
  return out;
}

describe("the numbers are never hidden behind the checklist", () => {
  it("reads the numbers whatever the checklist says, and puts an unfinished setup in one collapsible card above them", async () => {
    const page = code((await files(EVERYTHING)).get("app/(site)/dashboard/page.tsx")!);
    expect(page).toContain("dashboardOverview(company.id, can, locale).catch(() => NOTHING_READ)");
    expect(page).not.toContain("settingUp ? []");
    expect(page).toContain("<DashboardBody");
    // The card only while something is left, and gone once it's done, skipped or hidden.
    expect(page).toContain("const settingUp = checklist !== null && checklist.items.length > 0 && !checklist.complete && !checklist.hidden;");
    expect(page).toContain("settingUp && checklist ? (");
    expect(page).toMatch(/<SetupChecklist[\s\S]*?initial=\{checklist\}[\s\S]*?collapsible[\s\S]*?defaultOpen=\{overview\.fresh\}/);
    // Only a brand-new company's page leads with "a few things to finish".
    expect(page).toContain("settingUp && overview.fresh");
  });

  it("draws the card, the numbers, the hint and the lists in that order: two columns at lg, the stat cards' card", async () => {
    const view = code((await files(EVERYTHING)).get("src/components/Dashboard.tsx")!);
    const order = ["data-dashboard-setup", "data-dashboard-numbers", "data-dashboard-hint", "data-dashboard-lists"].map((mark) => view.indexOf(mark));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(view).toContain('className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"');
    expect(view).toContain('className="grid items-start gap-4 lg:grid-cols-2"');
    expect(view).toContain('const CARD = "rounded-[--radius-card] border border-line bg-surface shadow-card";');
    expect((await files(EVERYTHING)).get("src/components/ui/StatCard.tsx")).toContain('"block rounded-[--radius-card] border border-line bg-surface p-5 shadow-card"');
    expect(view).toContain("See all");
    expect(view).toContain("{list.empty}");
    // Every line is a 44px link to its record.
    expect(view).toContain('<Link\n      href={row.href}\n      className="flex min-h-11');
  });
});

describe("the lists under the numbers", () => {
  it("are today's visits, the newest leads and the overdue invoices, each behind its page's permission", async () => {
    const dashboard = code((await files(EVERYTHING)).get("src/server/dashboard.ts")!);
    expect(dashboard).toContain("export const DASHBOARD_LIST_ROWS = 5;");
    const blocks = blocksByPermission(dashboard);
    expect([...blocks.keys()]).toEqual(["schedule.view", "estimator.view", "invoices.view"]);
    const visits = blocks.get("schedule.view")!;
    expect(visits).toContain('title: "Today\'s visits"');
    expect(visits).toContain('empty: "No visits today"');
    expect(visits).toContain("listCalendar(db, tenantId, { from: today, to: today }, { settings, now })");
    expect(visits).toContain("href: `/app/schedule?visit=${encodeURIComponent(visit.id)}`");
    expect(visits).toContain('new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: settings.timeZone })');
    expect(visits).toContain('figure: visit.resourceName ?? "No crew yet"');
    const leads = blocks.get("estimator.view")!;
    expect(leads).toContain('title: "Newest leads"');
    // The Estimates page's own Leads: its count and its newest, from the queue's search.
    expect(leads).toContain('searchEstimates(db, tenantId, { filter: "leads", limit: DASHBOARD_LIST_ROWS })');
    expect(leads).toContain("const leads = found.counts.leads;");
    expect(leads).toContain("href: `/app/estimates/${encodeURIComponent(row.id)}`");
    expect(leads).toContain("figure: leadPrice(row, locale)");
    const money = blocks.get("invoices.view")!;
    expect(money).toContain('title: "Overdue invoices"');
    expect(money).toContain('listOverdueInvoices(db, tenantId, { now, timeZone, dueSince: "2000-01-01", limit: DASHBOARD_LIST_ROWS })');
    expect(money).toContain("href: `/app/invoices/${encodeURIComponent(invoice.id)}`");
    expect(money).toContain("Math.max(1, daysBetween(todayInZone(invoice.dueDate, timeZone), today))");
    // "N overdue" on Money owed is the list's own rule.
    expect(money).toContain("and(lt(invoices.dueDate, now), gt(invoices.total, invoices.amountPaid))");
  });

  it("reads only the company's own rows: every read is given the company and the estimate lines are scoped through their estimate", async () => {
    const dashboard = code((await files(EVERYTHING)).get("src/server/dashboard.ts")!);
    expect(dashboard).toContain("eq(estimatorEstimates.tenantId, tenantId), inArray(estimatorEstimateItems.estimateId, [...estimateIds])");
    expect(dashboard).toContain(".innerJoin(estimatorEstimates, eq(estimatorEstimates.id, estimatorEstimateItems.estimateId))");
    for (const read of [
      "getSchedulingSettings(db, tenantId)",
      "listCalendar(db, tenantId,",
      "searchEstimates(db, tenantId,",
      "askedFor(tenantId,",
      "invoicingBusiness(tenantId)",
      "listOverdueInvoices(db, tenantId,",
    ]) {
      expect(dashboard, read).toContain(read);
    }
    expect(dashboard.match(/eq\(invoices\.tenantId, tenantId\)/g)).toHaveLength(2);
  });

  it("are emitted per feature: an invoicing-only project lists overdue invoices and nothing else, a bare one returns nothing", async () => {
    const invoicing = code((await files({ tenantNoun: "Company", includeInvoicing: true })).get("src/server/dashboard.ts")!);
    expect(invoicing).toContain('title: "Overdue invoices"');
    expect(invoicing).not.toContain("Today's visits");
    expect(invoicing).not.toContain("Newest leads");
    expect(invoicing).not.toContain("/scheduling");
    expect(invoicing).not.toContain("/estimator");
    const visits = code((await files({ tenantNoun: "Company", includeScheduling: true })).get("src/server/dashboard.ts")!);
    expect(visits).toContain('title: "Today\'s visits"');
    expect(visits).not.toContain("drizzle-orm");
    const bare = code((await files({ tenantNoun: "Company" })).get("src/server/dashboard.ts")!);
    expect(bare).toContain("return { numbers: [], lists: [], fresh: false, hint: null };");
    expect(bare).not.toContain("can.includes(");
    // The page is the same file everywhere: what differs is the generated dashboard.ts.
    const pages = await Promise.all(
      [{ tenantNoun: "Company" as const }, { tenantNoun: "Company" as const, includeInvoicing: true }].map(async (o) => (await files(o)).get("app/(site)/dashboard/page.tsx")),
    );
    expect(pages[0]).toBe(pages[1]);
  });

  it("call a company with nothing to count fresh, and give it one plain sentence naming only what fills its numbers", async () => {
    const dashboard = code((await files(EVERYTHING)).get("src/server/dashboard.ts")!);
    expect(dashboard).toContain("const fresh = pieces.length > 0 && pieces.every((piece) => !piece.busy);");
    expect(dashboard).toContain("hint: fresh ? `Your numbers fill in as work comes in: ${sentence(sources)}.` : null,");
    for (const source of ['source: "the visits you book"', 'source: "estimate requests from your website"', 'source: "the invoices you send"']) {
      expect(dashboard).toContain(source);
    }
    const visits = code((await files({ tenantNoun: "Company", includeScheduling: true })).get("src/server/dashboard.ts")!);
    expect(visits).not.toContain("estimate requests");
  });
});

describe("the isolation proof covers the dashboard", () => {
  it("plants a visit today, a lead and an overdue invoice for two companies, and checks neither's dashboard shows the other's", async () => {
    const proof = (await files(EVERYTHING)).get("src/server/__tests__/feature-isolation.test.ts")!;
    expect(proof).toContain('describe("feature isolation: the dashboard"');
    expect(proof).toContain('import { dashboardOverview } from "@/server/dashboard";');
    expect(proof).toContain('const DASHBOARD_CAN: readonly string[] = ["schedule.view", "estimator.view", "invoices.view"];');
    expect(proof).toContain('const ofA = await plant(fx.aId, fx.aRows, "alpha");');
    expect(proof).toContain('const ofB = await plant(fx.bId, fx.bRows, "bravo");');
    expect(proof).toContain("expect(ofA.filter((s) => textB.includes(s)), \"B's dashboard shows A's rows\").toEqual([]);");
    expect(proof).toContain("expect(ofB.filter((s) => !textB.includes(s)), \"B's dashboard is missing B's own rows\").toEqual([]);");
    expect(proof).toContain('scheduledDate: todayIn(now, timeZone),');
    expect(proof).toContain('source: "public_tool"');
    expect(proof).toContain("dueDate: new Date(now.getTime() - 3 * 86_400_000),");
    // Only what's installed is planted and asked for.
    const invoicing = (await files({ tenantNoun: "Company", includeInvoicing: true })).get("src/server/__tests__/feature-isolation.test.ts")!;
    expect(invoicing).toContain('const DASHBOARD_CAN: readonly string[] = ["invoices.view"];');
    expect(invoicing).not.toContain("bookVisit(");
    expect(invoicing).not.toContain("createEstimate(");
  });
});

describe("upgrading to 0.36.1", () => {
  it("tells a 0.36.0 companies project what its dashboard does now, a single business nothing", () => {
    const notes = upgradeNotesFor(answers(EVERYTHING), "0.36.0").join("\n");
    expect(notes).toContain("2 things left to set up");
    expect(notes).toContain("today's visits, the newest leads and the overdue invoices");
    expect(notes).toContain("`dashboardOverview`");
    expect(notes).toContain("@adminigloo/tenancy-widget 0.4");
    expect(upgradeNotesFor(answers({ tenantNoun: "Company" }), "0.36.0").join("\n")).not.toContain("Under the numbers");
    // Nothing about the dashboard for a single business (0.36.2's notes are polish-3.test.ts's).
    expect(upgradeNotesFor(answers({ ...EVERYTHING, tenantNoun: "none" }), "0.36.0").join("\n")).not.toContain("dashboard no longer hides");
    expect(upgradeNotesFor(answers(EVERYTHING), "0.36.2")).toEqual([]);
  });
});
