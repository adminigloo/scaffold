import { describe, expect, it } from "vitest";
import { DEFAULT_ANSWERS, type Answers } from "../answers.js";
import { planEmit, type EmitPlan } from "../emit.js";
import { upgradeNotesFor } from "../upgrade-notes.js";
import { TEMPLATE_DIR } from "./configurations.js";

/**
 * THE SHOWROOM (create-app 0.36): what an owner and their customers see is
 * the engineering, so it has to read as finished. These are the promises a
 * generated project keeps on every screen, checked on the plan itself.
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

async function plan(overrides: Partial<Answers>): Promise<EmitPlan> {
  return planEmit(TEMPLATE_DIR, "/out", answers(overrides));
}

function files(p: EmitPlan): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, contents] of p.files) out.set(path.replace(/\\/g, "/"), contents);
  return out;
}

/** The source with its comments removed (block, line and JSX comments), so prose about a setting isn't mistaken for a rendered one. */
function code(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

/** Every page an owner, their team or their customers can open: the work area, the dashboard, settings and each company's public pages. */
function ownerFacing(path: string): boolean {
  return (
    /\.tsx$/.test(path) &&
    !path.includes("__tests__") &&
    (path.startsWith("app/(site)/app/") ||
      path.startsWith("app/(site)/dashboard/") ||
      path.startsWith("app/(site)/settings/") ||
      path.startsWith("app/(company)/") ||
      path === "src/components/CompanyHome.tsx")
  );
}

describe("no operator detail on an owner's screens", () => {
  it("no environment variable, src/ path or /setup link in any work page or company page", async () => {
    const p = files(await plan(EVERYTHING));
    const pages = [...p.keys()].filter(ownerFacing);
    expect(pages.length).toBeGreaterThan(20);
    for (const path of pages) {
      const source = code(p.get(path)!);
      // An env var as RENDERED TEXT: inside a string or between tags, never a reference like env.X.
      expect(source, `${path} names a setting`).not.toMatch(/["'>`][^"'<`\n]*\b[A-Z][A-Z0-9]*_(KEY|SECRET|TOKEN|URL|DSN|EMAIL_FROM)\b/);
      expect(source, `${path} names a source file`).not.toMatch(/["'>`][^"'<`\n]*\bsrc\/[a-z]/);
      expect(source, `${path} links to /setup`).not.toContain('href="/setup');
    }
  });

  it("the billing page, the pricing page and sign-in keep their technical words behind the operator's view", async () => {
    const p = files(await plan(EVERYTHING));
    const billing = code(p.get("app/(site)/account/billing/page.tsx")!);
    expect(billing).not.toContain("from src/plans.ts");
    expect(billing).not.toContain("<code>STRIPE_SECRET_KEY</code>");
    expect(billing).toContain("staff={staff}");
    const pricing = code(p.get("app/(site)/pricing/page.tsx")!);
    expect(pricing).toContain("{!staff ? null : purchasable === null ? (");
    expect(pricing).not.toContain("Answer this one");
    const signIn = code(p.get("app/(site)/sign-in/[[...sign-in]]/page.tsx")!);
    expect(signIn).toContain("<OperatorOnly>");
    const operator = code(p.get("src/server/operator.ts")!);
    expect(operator).toContain('if (unconfigured) return process.env.NODE_ENV !== "production";');
    expect(operator).toContain("return (await loadStaffPermissions({ principal })) !== null;");
  });
});

describe("one page shape", () => {
  it("every work page uses the shared width, and the package screens draw no second title", async () => {
    const p = files(await plan(EVERYTHING));
    for (const path of [...p.keys()].filter((one) => one.startsWith("app/(site)/app/") && one.endsWith("page.tsx"))) {
      const source = p.get(path)!;
      if (source.includes("redirect(")) continue;
      expect(source, `${path} sets its own width`).toContain("WORK_MAIN");
      expect(source, `${path}`).not.toMatch(/<main className="mx-auto max-w-/);
    }
    for (const [path, widget] of [
      ["app/(site)/app/estimates/page.tsx", "<EstimatesQueue"],
      ["app/(site)/app/invoices/page.tsx", "<InvoicesLedger"],
      ["app/(site)/app/customers/page.tsx", "<CustomersAdmin"],
      ["app/(site)/app/calls/page.tsx", "<CallsAdmin"],
      ["app/(site)/app/store/page.tsx", "<StoreAdmin"],
      ["app/(site)/app/price-book/page.tsx", "<PriceBook"],
    ] as const) {
      const source = p.get(path)!;
      expect(source, path).toContain(widget);
      expect(source, path).toContain("<PageHeader");
      expect(source, path).toContain("title={false}");
    }
  });

  it("buttons are 44px and there is one card radius, handed to the package screens too", async () => {
    const p = files(await plan(EVERYTHING));
    expect(p.get("src/components/ui/Button.tsx")).toContain("inline-flex min-h-11");
    const css = p.get("app/globals.css")!;
    expect(css).toContain("--radius-card: 12px;");
    expect(css).toContain("--aiew-radius: var(--radius-card);");
    expect(css).toContain("--aisw-shadow: var(--shadow-card);");
  });
});

describe("the dashboard", () => {
  it("puts the setup checklist on it while setup is unfinished, and the numbers this project has", async () => {
    const all = files(await plan(EVERYTHING));
    const page = code(all.get("app/(site)/dashboard/page.tsx")!);
    // 0.36.1: one collapsible card above the numbers, never instead of them (dashboard-0361.test.ts).
    expect(page).toContain("<SetupChecklist");
    expect(page).toContain("collapsible");
    expect(page).not.toContain("APP_LINKS");
    const numbers = code(all.get("src/server/dashboard.ts")!);
    for (const label of ['label: "Today"', 'label: "New leads"', 'label: "Money owed"', 'label: "Paid this week"']) expect(numbers).toContain(label);
    expect(numbers).toContain('export const CREW_HOME: string | null = "/app/schedule/today";');
    // Only what is installed: an invoicing-only project has the money and no visits.
    const invoicing = code(files(await plan({ tenantNoun: "Company", includeInvoicing: true })).get("src/server/dashboard.ts")!);
    expect(invoicing).toContain('label: "Money owed"');
    expect(invoicing).not.toContain('label: "Today"');
    expect(invoicing).toContain("export const CREW_HOME: string | null = null;");
    // A single business has no company dashboard.
    expect(files(await plan({ tenantNoun: "none" })).has("src/server/dashboard.ts")).toBe(false);
  });
});

describe("a company's public page is a mini website", () => {
  it("reads its tagline, area and hours from company settings, and its services from the estimator's own pricing", async () => {
    const all = files(await plan(EVERYTHING));
    const home = code(all.get("src/server/company-home.ts")!);
    expect(home).toContain("startingPrices(db, tenantId, { settings, limit: 9 })");
    expect(home).toContain('primary: { path: "/estimate", label: "Get an instant estimate"');
    const settings = code(all.get("src/server/tenant-settings.ts")!);
    expect(settings).toContain('key: "public-page"');
    expect(settings).toContain('key: "formats"');
    expect(settings).toContain('locale: z.enum(["en-US", "en-CA", "en-GB", "en-AU"]).default("en-US")');
    const gate = code(all.get("src/components/PublicCompanyGate.tsx")!);
    expect(gate).toContain("...(openingHours.length > 0 ? { openingHours } : {}),");
    expect(gate).toContain("...(serviceArea ? { areaServed: serviceArea } : {}),");
    expect(all.get("app/(company)/t/[slug]/page.tsx")).toContain("<CompanyHomeView company={company} home={await companyHome(slug)} />");
    const view = code(all.get("src/components/CompanyHome.tsx")!);
    expect(view).toContain('page.path !== "/feedback"');
    // Without the estimator: no services, and the big button is the next customer page.
    const visits = code(files(await plan({ tenantNoun: "Company", includeScheduling: true })).get("src/server/company-home.ts")!);
    expect(visits).not.toContain("startingPrices");
    expect(visits).toContain('primary: { path: "/book-visit", label: "Book a visit"');
  });
});

describe("the landing page speaks to owners", () => {
  it("names only the features this project has, keeps every word in src/marketing-copy.ts, and greets a signed-in owner", async () => {
    const all = files(await plan(EVERYTHING));
    const copy = all.get("src/marketing-copy.ts")!;
    expect(copy).toContain("export const TRADE = {");
    expect(copy).toContain('title: "Quotes in minutes, not days"');
    expect(copy).toContain('export const DASHBOARD_HREF = "/dashboard";');
    expect(copy).not.toContain("Postgres");
    expect(all.get("src/components/marketing/Hero.tsx")).toContain("Go to your dashboard");
    expect(all.get("src/components/marketing/PlansTeaser.tsx")).toContain('from "@/plans"');
    const bare = files(await plan({ includeMarketing: true }));
    expect(bare.get("src/marketing-copy.ts")).not.toContain("estimate");
    expect(bare.get("src/components/marketing/PlansTeaser.tsx")).toContain("return null;");
  });
});

describe("plans in owner language", () => {
  it("leads with a promise, 'Everything included' and the headline numbers; the singular for one", async () => {
    const all = files(await plan(EVERYTHING));
    const record = all.get("src/plans.ts")!;
    expect(record).toContain('export const HEADLINE_FEATURES: readonly string[] = ["seats","storage_gb","estimates"];');
    expect(record).not.toContain("websites of your own counted");
    expect(record).toContain('export const DEFAULT_CURRENCY: string = plans.currencies.includes("usd") ? "usd"');
    expect(all.get("src/components/marketing/PlansTeaser.tsx")).toContain("const currency = DEFAULT_CURRENCY;");
    const billing = code(all.get("app/(site)/account/billing/page.tsx")!);
    expect(billing).toContain("else if (feature.limit === 1 && feature.labelOne) lines.push(`1 ${feature.labelOne}`);");
    const chooser = code(all.get("src/components/account/PlanChooser.tsx")!);
    expect(chooser).toContain("Everything included");
    expect(chooser).toContain("What&apos;s included");
    expect(chooser).not.toContain("is not sold");
  });
});

describe("upgrading to 0.36", () => {
  it("tells a 0.35 project what changed, and a 0.36.1 project nothing", () => {
    const notes = upgradeNotesFor(answers(EVERYTHING), "0.35.2").join("\n");
    expect(notes).toContain("src/marketing-copy.ts");
    expect(notes).toContain("Your public page");
    expect(notes).toContain("HEADLINE_FEATURES");
    expect(notes).toContain("sending allowance");
    expect(upgradeNotesFor(answers(EVERYTHING), "0.36.1")).toEqual([]);
  });
});
