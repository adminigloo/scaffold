import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ANSWERS, IncompatibleAnswersError, overlayNamesFor, packagesFor, type Answers } from "../answers.js";
import { planEmit, writePlan, type EmitPlan } from "../emit.js";
import { buildManifest, MANIFEST_FILENAME, renderManifest } from "../manifest.js";
import {
  AnswerSwitchError,
  applyUpgrade,
  loadPreviousGenerator,
  parseAnswerOverride,
  planUpgrade,
  upgradeNextSteps,
} from "../upgrade.js";
import { TEMPLATE_DIR } from "./configurations.js";

/**
 * CONSUMER FIT (create-app 0.39): what a project whose customers are PEOPLE
 * — the founder's Almanac, generated as `--tenant-noun none --model
 * subscription` — needs to become a proper consumer product, built into the
 * generator so every such project gets it:
 *
 *   1. `upgrade --audience consumers` / `--set` switch an answer by the same
 *      three-way as a version upgrade — on an untouched project, byte for
 *      byte a fresh generation with the new answers
 *   2. plans are not a shop: --model subscription ships no shop at all
 *   3. one person per account (billing-05.test.ts holds the details)
 *   4. crawlable public pages: no group-wide loading.tsx, and a test for it
 *   5. a production build on localhost is local for the first administrator
 *   6. one plan presentation, with a free tier and plans not on sale yet
 *   7. a consumer dashboard
 *   8. conversions on sign-up and first payment
 */
const sep = (path: string) => join(...path.split("/"));

const BUSINESS_PLANS: Answers = {
  ...DEFAULT_ANSWERS,
  projectName: "almanac",
  tenantNoun: "none",
  businessModel: "subscription",
  adminShell: "full",
  includeAi: true,
  includeEmail: true,
  includeFeedback: true,
  includeNotifications: true,
  includeMarketing: true,
  includeAnalytics: true,
  includeSeo: true,
  includeSeoReports: true,
};
const CONSUMER_PLANS: Answers = { ...BUSINESS_PLANS, audience: "consumers" };

async function plan(answers: Answers): Promise<EmitPlan> {
  return planEmit(TEMPLATE_DIR, "/out", answers);
}
function file(p: EmitPlan, path: string): string {
  const body = p.files.get(sep(path));
  if (body === undefined) throw new Error(`the plan has no ${path}`);
  return body;
}

// ---------------------------------------------------------------------------
// 1. Switching an answer
// ---------------------------------------------------------------------------

describe("upgrade --audience / --set: switching an answer", () => {
  let project: string;
  let previousDir: string;
  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), "adminigloo-switch-project-"));
    previousDir = await mkdtemp(join(tmpdir(), "adminigloo-switch-previous-"));
  });
  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
    await rm(previousDir, { recursive: true, force: true });
  });

  async function writeFiles(files: ReadonlyMap<string, string>): Promise<void> {
    for (const [relPath, contents] of files) {
      await mkdir(dirname(join(project, relPath)), { recursive: true });
      await writeFile(join(project, relPath), contents, "utf8");
    }
  }
  async function onDisk(path: string): Promise<string | null> {
    const full = join(project, sep(path));
    return existsSync(full) ? readFile(full, "utf8") : null;
  }
  async function allFiles(dir: string, base = dir): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await allFiles(full, base)));
      else out.push(full.slice(base.length + 1));
    }
    return out;
  }

  /**
   * The stand-in for the create-app that made the project (0.37.1 for
   * Almanac): a package whose planEmit answers `files` — what it wrote for a
   * none + subscription BUSINESS project, with its own (older) manifest.
   */
  async function previousGenerator(files: ReadonlyMap<string, string>, version: string): Promise<void> {
    await mkdir(join(previousDir, "dist"), { recursive: true });
    await mkdir(join(previousDir, "template"), { recursive: true });
    await writeFile(join(previousDir, "package.json"), JSON.stringify({ name: "@adminigloo/create-app", version }), "utf8");
    await writeFile(join(previousDir, "dist", "plan.json"), JSON.stringify(Object.fromEntries(files)), "utf8");
    await writeFile(
      join(previousDir, "dist", "index.js"),
      [
        'import { readFileSync } from "node:fs";',
        "export async function planEmit() {",
        '  return { files: new Map(Object.entries(JSON.parse(readFileSync(new URL("./plan.json", import.meta.url), "utf8")))) };',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  /** A business project as an older create-app wrote it: this version's plan, an older manifest, and its shop and loading files. */
  async function olderBusinessProject(version: string): Promise<Map<string, string>> {
    const files = new Map((await planEmit(TEMPLATE_DIR, project, BUSINESS_PLANS)).files);
    const { audience: _audience, ...olderAnswers } = BUSINESS_PLANS;
    const manifest = buildManifest(BUSINESS_PLANS, version);
    files.set(MANIFEST_FILENAME, renderManifest({ ...manifest, answers: olderAnswers as Answers, packages: { ...manifest.packages, "@adminigloo/billing": "^0.4.0" } }));
    // What 0.37/0.38 shipped that this version doesn't: the group-wide loading
    // boundary and, for --model subscription, the shop.
    files.set(sep("app/(site)/loading.tsx"), "export default function SiteLoading() { return null; }\n");
    files.set(sep("app/(site)/products/page.tsx"), "export default function Products() { return null; }\n");
    files.set(sep("scripts/seed-shop.ts"), "// the shop's seed\n");
    return files;
  }

  it("an untouched none + subscription project upgraded with --audience consumers is a fresh consumers generation, byte for byte", async () => {
    const old = await olderBusinessProject("0.37.1");
    await writeFiles(old);
    await previousGenerator(old, "0.37.1");
    const upgrade = await planUpgrade(TEMPLATE_DIR, project, {
      previous: await loadPreviousGenerator(previousDir),
      overrides: parseAnswerOverride("audience=consumers"),
    });
    expect(upgrade.switched).toEqual([["audience", "business", "consumers"]]);
    // The one file a switch never rewrites (review): src/plans.ts, whose tiers people pay for.
    expect([...upgrade.conflicts.keys()]).toEqual([sep("src/plans.ts")]);
    expect(upgrade.keptRetired.size).toBe(0);
    // Nothing lost: no tables, no companies, no plan check (review).
    expect(upgrade.losses).toEqual({ droppedTables: [], accounts: null, planCheck: [] });
    // The team, the invitations, the shop and the group-wide loading boundary go.
    for (const path of [
      "app/(site)/settings/team/page.tsx",
      "app/(site)/members/page.tsx",
      "app/(site)/invite/[token]/page.tsx",
      "src/server/invitation-mail.ts",
      "app/(site)/loading.tsx",
      "app/(site)/products/page.tsx",
      "scripts/seed-shop.ts",
    ]) {
      expect(upgrade.deletes.has(sep(path)), path).toBe(true);
    }
    await applyUpgrade(upgrade);

    const fresh = await planEmit(TEMPLATE_DIR, project, CONSUMER_PLANS);
    for (const [relPath, contents] of fresh.files) {
      if (relPath === ".env.local") continue;
      if (relPath === "package.json") continue; // merged; checked below
      if (relPath === sep("src/plans.ts")) {
        // Yours, kept; the consumer sample beside it.
        expect(await onDisk(relPath), relPath).toBe(old.get(relPath));
        expect(await onDisk("src/plans.ts.new"), "src/plans.ts.new").toBe(contents);
        continue;
      }
      expect(await onDisk(relPath), relPath).toBe(contents);
    }
    // Nothing left over that a fresh generation doesn't have (.env.local, package.json and the plan record's .new apart).
    const left = (await allFiles(project)).filter((path) => !fresh.files.has(path));
    expect(left).toEqual([sep("src/plans.ts.new")]);
    expect(JSON.parse((await onDisk("package.json")) ?? "{}")).toEqual(JSON.parse(file(fresh, "package.json")));
    expect(JSON.parse((await onDisk(MANIFEST_FILENAME)) ?? "{}").answers.audience).toBe("consumers");
    const steps = upgradeNextSteps(upgrade);
    expect(steps).toContain("audience: business -> consumers");
    expect(steps.replace(/\s+/g, " ")).toContain(
      "it takes the invite, remove, change-role and hand-over keys back from the shipped roles in the database and seals them",
    );
    expect(steps.replace(/\s+/g, " ")).toContain("it suspends anyone who is a member of somebody else's account");
  });

  it("never loses an edit: a changed file gets <file>.new, a changed retired file is kept and listed, your own files are left alone", async () => {
    const old = await olderBusinessProject("0.37.1");
    await writeFiles(old);
    await previousGenerator(old, "0.37.1");
    await writeFile(join(project, sep("src/plans.ts")), "// my own plans\n", "utf8");
    await writeFile(join(project, sep("app/(site)/settings/team/page.tsx")), "// my team page\n", "utf8");
    await mkdir(join(project, sep("src/weather")), { recursive: true });
    await writeFile(join(project, sep("src/weather/access-rules.ts")), "// hand-written\n", "utf8");
    const upgrade = await planUpgrade(TEMPLATE_DIR, project, {
      previous: await loadPreviousGenerator(previousDir),
      overrides: { audience: "consumers" },
    });
    await applyUpgrade(upgrade);
    expect(await onDisk("src/plans.ts")).toBe("// my own plans\n");
    expect(await onDisk("src/plans.ts.new")).toContain("free: {");
    expect(await onDisk("app/(site)/settings/team/page.tsx")).toBe("// my team page\n");
    expect(upgrade.keptRetired.has(sep("app/(site)/settings/team/page.tsx"))).toBe(true);
    expect(await onDisk("src/weather/access-rules.ts")).toBe("// hand-written\n");
  });

  it("on a project this version made, only the switch is applied — nothing to fetch", async () => {
    await writePlan(await planEmit(TEMPLATE_DIR, project, BUSINESS_PLANS));
    // NEGATIVE CONTROL: with nothing to switch, it is up to date.
    expect((await planUpgrade(TEMPLATE_DIR, project, { previous: null })).upToDate).toBe(true);
    const upgrade = await planUpgrade(TEMPLATE_DIR, project, { previous: null, overrides: { audience: "consumers" } });
    expect(upgrade.upToDate).toBe(false);
    await applyUpgrade(upgrade);
    const fresh = await planEmit(TEMPLATE_DIR, project, CONSUMER_PLANS);
    for (const [relPath, contents] of fresh.files) {
      if (relPath === ".env.local") continue;
      // A switch never rewrites the plan record (review): the new sample is beside it.
      expect(await onDisk(relPath === sep("src/plans.ts") ? "src/plans.ts.new" : relPath), relPath).toBe(contents);
    }
    expect(upgradeNextSteps(upgrade)).toContain("Switched ");
  });

  it("--set reads the flag spellings, and refuses what can't be switched or can't be generated", async () => {
    expect(parseAnswerOverride("model=both")).toEqual({ businessModel: "both" });
    expect(parseAnswerOverride("admin=minimal")).toEqual({ adminShell: "minimal" });
    expect(parseAnswerOverride("feedback=false")).toEqual({ includeFeedback: false });
    expect(parseAnswerOverride("seo-reports=true")).toEqual({ includeSeoReports: true });
    expect(() => parseAnswerOverride("projectName=x")).toThrow(AnswerSwitchError);
    expect(() => parseAnswerOverride("audience=everyone")).toThrow(/takes one of: business, consumers/);
    expect(() => parseAnswerOverride("nonsense")).toThrow(/<answer>=<value>/);
    await writePlan(await planEmit(TEMPLATE_DIR, project, { ...BUSINESS_PLANS, tenantNoun: "Company" }));
    await expect(planUpgrade(TEMPLATE_DIR, project, { previous: null, overrides: { audience: "consumers" } })).rejects.toThrow(IncompatibleAnswersError);
  });
});

// ---------------------------------------------------------------------------
// 2. Plans are not a shop
// ---------------------------------------------------------------------------

describe("plans are not a shop (--model subscription)", () => {
  const SHOP_FILES = [
    "app/(site)/products/page.tsx",
    "app/(site)/checkout/page.tsx",
    "app/(site)/account/orders/page.tsx",
    "app/admin/products/page.tsx",
    "src/components/account/LicenceKey.tsx",
    "scripts/seed-shop.ts",
    "src/server/fulfilment.ts",
    "src/server/routers/checkout.ts",
    "src/server/routers/catalog.ts",
  ];

  it("ships none of the shop, its packages or its tables", async () => {
    const p = await plan(BUSINESS_PLANS);
    for (const path of SHOP_FILES) expect(p.files.has(sep(path)), path).toBe(false);
    const schema = file(p, "src/db/schema.ts");
    expect(schema).not.toContain("/catalog/schema");
    expect(schema).not.toContain("/commerce/schema");
    const pkg = JSON.parse(file(p, "package.json")) as { dependencies: Record<string, string>; scripts: Record<string, string> };
    for (const name of ["@adminigloo/catalog", "@adminigloo/commerce", "@stripe/stripe-js", "@stripe/react-stripe-js"]) {
      expect(pkg.dependencies[name], name).toBeUndefined();
    }
    expect(pkg.scripts["db:seed:shop"]).toBeUndefined();
    expect(pkg.scripts["db:seed:demo"]).not.toContain("seed-shop");
    expect(file(p, "src/nav.ts")).not.toContain('"/products"');
    expect(file(p, "src/server/shop-hooks.ts")).toContain("this project sells plans only (no shop)");
    // Nothing generated imports the shop's packages.
    for (const [path, body] of p.files) {
      if (!/\.(ts|tsx)$/.test(path)) continue;
      expect(body, path).not.toMatch(/from "@adminigloo\/(catalog|commerce)(\/[a-z]+)?"/);
    }
  });

  it.each(["one-time", "both"] as const)("--model %s keeps the shop", async (businessModel) => {
    const p = await plan({ ...BUSINESS_PLANS, businessModel });
    for (const path of SHOP_FILES) expect(p.files.has(sep(path)), path).toBe(true);
    expect(packagesFor({ ...BUSINESS_PLANS, businessModel })).toContain("@adminigloo/commerce");
    expect(overlayNamesFor({ ...BUSINESS_PLANS, businessModel })).toEqual(expect.arrayContaining(["shop", "account-shop", "shop-admin"]));
    expect(file(p, "src/server/shop-hooks.ts")).toContain("return windowProductGrants(state);");
  });
});

// ---------------------------------------------------------------------------
// 4. Crawlable pages, and 5. the founder's own machine
// ---------------------------------------------------------------------------

describe("crawlable public pages", () => {
  it.each([BUSINESS_PLANS, CONSUMER_PLANS, { ...BUSINESS_PLANS, tenantNoun: "Company" as const }])(
    "no group-wide loading boundary over the public pages; the account pages keep one below their heading",
    async (answers) => {
      const p = await plan(answers);
      expect(p.files.has(sep("app/(site)/loading.tsx"))).toBe(false);
      expect(p.files.has(sep("app/(site)/account/loading.tsx"))).toBe(true);
      expect(file(p, "app/(site)/account/layout.tsx")).toContain("<PageHeader title={ACCOUNT_HEADING.title}");
    },
  );

  it("a generated test boots the build and checks every sitemap page as a crawler: 200 with its h1 in the shell, a 404, a 307", async () => {
    const p = await plan(BUSINESS_PLANS);
    const test = file(p, "tests/pages/public-pages.test.ts");
    expect(test).toContain('const PAGES: readonly string[] = ["/","/pricing","/privacy","/terms"];');
    expect(test).toContain('[{"path":"/admin","to":"/sign-in"},{"path":"/members","to":"/settings/team"}]');
    expect(test).toContain("toBeLessThan(shellEnd(html))");
    expect(test).toContain("expect(response.status).toBe(404);");
    expect(file(p, "vitest.pages.config.ts")).toContain('include: ["tests/pages/**/*.test.ts"]');
    expect((JSON.parse(file(p, "package.json")) as { scripts: Record<string, string> }).scripts["test:pages"]).toBe(
      "vitest run --config vitest.pages.config.ts",
    );
    // A consumers project has no /members to redirect.
    expect(file(await plan(CONSUMER_PLANS), "tests/pages/public-pages.test.ts")).toContain('[{"path":"/admin","to":"/sign-in"}]');
  });

  it("the first administrator: a set BOOTSTRAP_ADMIN_EMAIL always, else the first sign-in on the dev server only (review)", async () => {
    const p = await plan(CONSUMER_PLANS);
    const tenancy = file(p, "src/server/tenancy.ts");
    expect(tenancy).toContain('import { resolveAppEnv } from "@adminigloo/env";');
    expect(tenancy).toContain('if (email) return { mode: "email", email };');
    expect(tenancy).toContain('return resolveAppEnv() === "local" ? { mode: "first-user" } : { mode: "off" };');
    // NEGATIVE CONTROL: the guess (a localhost app URL) grants nothing; it only words the no-access page.
    expect(tenancy).not.toContain("isLocalRun()");
    expect(tenancy).not.toContain("import { isLocalRun");
    expect(file(p, "app/admin/layout.tsx")).toContain("deployed={!isLocalRun()}");
    // And the proof runs in the project.
    expect(file(p, "src/server/__tests__/first-administrator.test.ts")).toContain('expect(bootstrapPolicy()).toEqual({ mode: "off" });');
  });
});

// ---------------------------------------------------------------------------
// 6. One plan presentation
// ---------------------------------------------------------------------------

describe("one plan presentation", () => {
  it("the pricing page, the landing page's plans and the billing page all draw PlanCard from planColumns", async () => {
    const p = await plan(CONSUMER_PLANS);
    expect(file(p, "src/components/marketing/pricing/PlanColumns.tsx")).toContain("<PlanCard column={column}");
    expect(file(p, "src/components/marketing/PlansTeaser.tsx")).toContain("<PlanCard column={column}");
    expect(file(p, "src/components/account/PlanChooser.tsx")).toContain("<PlanCard");
    expect(file(p, "app/(site)/account/billing/page.tsx")).toContain("planColumns(plans, { line, interval, currency, headline: HEADLINE_FEATURES })");
  });

  it("checkout refuses a plan that isn't on sale, on every path in", async () => {
    const router = file(await plan(CONSUMER_PLANS), "src/server/routers/billing.ts");
    expect(router).toContain("const notSold = notOnSaleReason(tier);");
    expect(router).toContain('throw new TRPCError({ code: "PRECONDITION_FAILED", message: notSold });');
  });

  it("the consumer sample declares a free tier and no 'Most popular'", async () => {
    const record = file(await plan(CONSUMER_PLANS), "src/plans.ts");
    expect(record).toContain("free: {");
    expect(record).not.toContain("highlight: true,");
  });

  it("a person reads 'your account' — never workspace, company or team — and the operator's notes are staff-only", async () => {
    const p = await plan(CONSUMER_PLANS);
    const copy = file(p, "src/account-copy.ts");
    const said = [...copy.matchAll(/"([^"]*)"/g)].map((match) => match[1]).join("\n");
    expect(said).not.toMatch(/workspace|company|team/i);
    expect(copy).toContain('return "your account";');
    const chooser = file(p, "src/components/account/PlanChooser.tsx");
    expect(chooser).toContain("{simulated && props.staff ? (");
    const billing = file(p, "app/(site)/account/billing/page.tsx");
    expect(billing).toContain("{!stripe && !staff ? null : (");
    const pricing = file(p, "src/marketing-copy.ts");
    expect(pricing).toContain('title: "Start free. Upgrade when you want more."');
    expect(pricing).not.toContain("size of your business");
    // NEGATIVE CONTROL: a single business still names the workspace that pays.
    expect(file(await plan(BUSINESS_PLANS), "src/account-copy.ts")).toContain("return tenantName;");
  });

  it("the pricing page's buttons reach the plan chooser, through sign-up", async () => {
    const columns = file(await plan(CONSUMER_PLANS), "src/components/marketing/pricing/PlanColumns.tsx");
    expect(columns).toContain("const chooser = `/account/billing?plan=${encodeURIComponent(tierKey)}`;");
    expect(columns).toContain("`/sign-up?redirect_url=${encodeURIComponent(chooser)}`");
  });
});

// ---------------------------------------------------------------------------
// 7. The consumer dashboard, and 8. conversions
// ---------------------------------------------------------------------------

describe("the founder's dashboard for a consumer product", () => {
  it("subscribers, MRR and ARR, new and cancelled, failed payments, free to paid; no shop tiles without a shop", async () => {
    const p = await plan(CONSUMER_PLANS);
    const page = file(p, "app/admin/page.tsx");
    for (const label of ["Failed payments", "Paying", "MRR", "ARR", "Monthly / yearly", "New this month", "Cancelled this month", "Free to paid", "On each plan"]) {
      expect(page, label).toContain(label);
    }
    expect(page).not.toContain("Orders this month");
    expect(file(p, "src/server/subscriber-numbers.ts")).toContain("export function subscriberNumbers(");
    expect(p.files.has(sep("src/server/__tests__/subscriber-numbers.test.ts"))).toBe(true);
    // With a shop (--model both), the shop's tiles too.
    expect(file(await plan({ ...CONSUMER_PLANS, businessModel: "both" }), "app/admin/page.tsx")).toContain("Orders this month");
    // NEGATIVE CONTROL: a business's dashboard is unchanged in kind, and a plans-only one counts no orders.
    const business = file(await plan(BUSINESS_PLANS), "app/admin/page.tsx");
    expect(business).not.toContain("subscriberNumbers");
    expect(business).not.toContain("orderShipments");
  });
});

describe("conversions: which pages bring people who sign up and people who pay", () => {
  it("with analytics: sign-up passes /welcome, and the checkout's return marks a first payment", async () => {
    const p = await plan(CONSUMER_PLANS);
    expect(file(p, "src/conversions.ts")).toContain("return `/welcome?next=${encodeURIComponent(next)}`;");
    expect(file(p, "app/welcome/route.ts")).toContain("if (principal) await recordSignUp(principal.userId);");
    // A NEW account only, once (review).
    expect(file(p, "src/server/conversions.ts")).toContain("if (account === undefined || !isNewSignUp(account.createdAt)) return;");
    expect(file(p, "src/server/conversions.ts")).toContain('await recordConversion("Signed up", { userId, once: `signed-up:${userId}` });');
    // Stripe's own Checkout Session says it was paid — never a trial — and once (review).
    expect(file(p, "src/server/conversions.ts")).toContain("if (!paidCheckoutFor(session, tenant.id)) return;");
    expect(file(p, "src/server/conversions.ts")).toContain('await recordConversion("First payment", { userId, once: `first-payment:${userId}` });');
    expect(file(p, "src/server/conversions.ts")).toContain("await analytics.recordConversion({");
    expect(file(p, "app/(site)/account/billing/return/route.ts")).toContain(
      'await recordFirstPayment(principal.userId, req.nextUrl.searchParams.get("session_id"));',
    );
    expect(file(p, "src/__tests__/conversions.test.ts")).toContain('payment_status: "no_payment_required"');
    expect(file(p, "src/server/routers/billing.ts")).toContain('successPath: "/account/billing/return",');
    expect(file(p, "app/(site)/sign-up/[[...sign-up]]/page.tsx")).toContain("fallbackRedirectUrl={afterSignUpPath(AFTER_AUTH_PATH)}");
  });

  it("without analytics but with each person's emails (create-app 0.40): /welcome keeps what they ticked, and records no sign-up", async () => {
    const p = await plan({ ...CONSUMER_PLANS, includeAnalytics: false });
    const welcome = file(p, "app/welcome/route.ts");
    expect(welcome).toContain("applySignUpEmailChoice(principal.userId");
    expect(welcome).not.toContain("recordSignUp");
    expect(file(p, "src/conversions.ts")).toContain("/welcome?next=");
  });

  it("without analytics or email: no /welcome, and every hook is a no-op", async () => {
    const p = await plan({ ...CONSUMER_PLANS, includeAnalytics: false, includeEmail: false });
    expect(p.files.has(sep("app/welcome/route.ts"))).toBe(false);
    expect(file(p, "src/conversions.ts")).toContain("return next;");
    expect(file(p, "src/server/conversions.ts")).toContain(
      "export async function recordFirstPayment(_userId: string, _checkoutSessionId: string | null): Promise<void> {}",
    );
    expect(file(p, "src/server/conversions.ts")).toContain("export async function recordSignUp(_userId: string): Promise<void> {}");
    expect(p.files.has(sep("src/__tests__/conversions.test.ts"))).toBe(false);
  });
});
