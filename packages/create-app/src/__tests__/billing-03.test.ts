import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ANSWERS, optionalEnvFor, type Answers } from "../answers.js";
import { planEmit, type EmitPlan } from "../emit.js";
import { plansEnforced } from "../plans-emit.js";
import { TEMPLATE_DIR } from "./configurations.js";

/**
 * BILLING 0.3 — plans for every package. A companies project that sells
 * subscriptions asks ONE plan check at every checkpoint; every other project
 * gets an open stand-in, so no emitted file carries an `if` about which.
 * The emitted proof (company-plans.test.ts) is run in a generated project by
 * the integration check; these pin what the generator writes.
 */

const OVERLAYS_DIR = join(TEMPLATE_DIR, "..", "overlays");

function answers(overrides: Partial<Answers> = {}): Answers {
  return { ...DEFAULT_ANSWERS, projectName: "igloo-back-office", ...overrides };
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

const SAAS: Partial<Answers> = {
  tenantNoun: "Company",
  businessModel: "subscription",
  adminShell: "full",
  includeEstimator: true,
  includeScheduling: true,
  includeStorage: true,
  includeNotifications: true,
};
const SINGLE: Partial<Answers> = { ...SAAS, tenantNoun: "none" };
const NO_PLANS: Partial<Answers> = { ...SAAS, businessModel: "none" };
const BARE_SAAS: Partial<Answers> = { tenantNoun: "Team", businessModel: "both", adminShell: "minimal" };

describe("which projects enforce plans", () => {
  it("only a companies project that sells subscriptions (subscription or both)", () => {
    expect(plansEnforced(answers(SAAS))).toBe(true);
    expect(plansEnforced(answers(BARE_SAAS))).toBe(true);
    expect(plansEnforced(answers(SINGLE))).toBe(false);
    expect(plansEnforced(answers(NO_PLANS))).toBe(false);
    expect(plansEnforced(answers({ ...SAAS, businessModel: "one-time" }))).toBe(false);
  });
});

describe("src/server/plan-gate.ts, in every project", () => {
  it("the real gate where plans are sold; the open stand-in everywhere else, with the same exports", async () => {
    const real = file(await plan(SAAS), "src", "server", "plan-gate.ts");
    expect(real).toContain("export const planGate = createPlanGate({");
    expect(real).toContain("cacheMs: 15_000");
    expect(real).toContain("export const TRIAL_DAYS = env.BILLING_TRIAL_DAYS ?? 14;");
    for (const overrides of [SINGLE, NO_PLANS]) {
      const open = file(await plan(overrides), "src", "server", "plan-gate.ts");
      expect(open).toContain("the open variant");
      expect(open).not.toContain("createPlanGate");
      for (const name of ["companyPlanOption", "seatLimitOption", "gateLoaders", "storageAllowanceBytes", "planStandingOf", "estimateQuota"]) {
        expect(real, name).toContain(name);
        expect(open, name).toContain(name);
      }
    }
  });

  it("the seat check runs on the tenancy service's own transaction (a second connection would wait on it forever)", async () => {
    const real = file(await plan(SAAS), "src", "server", "plan-gate.ts");
    expect(real).toContain('planLimit(tenantId, "seats", tx as BillingDb)');
    expect(real).not.toContain('await import("./tenancy");\n  const company');
  });

  it("counts only customers' online estimate requests, and only with the estimator", async () => {
    expect(file(await plan(SAAS), "src", "server", "plan-gate.ts")).toContain('ne(estimatorEstimates.source, "staff")');
    const bare = file(await plan(BARE_SAAS), "src", "server", "plan-gate.ts");
    expect(bare).not.toContain("estimatorEstimates");
    expect(bare).toContain("This project has no estimator");
  });
});

describe("every checkpoint asks it", () => {
  it("the permission loaders (tRPC rung and page gates) are wrapped in every project", async () => {
    for (const overrides of [SAAS, SINGLE]) {
      const permissions = file(await plan(overrides), "src", "server", "permissions.ts");
      expect(permissions).toContain('import { gateLoaders } from "./plan-gate";');
      expect(permissions).toContain("gateLoaders(\n  createDrizzlePermissionLoaders(db, { membership: tenancyMembershipGate }),\n)");
    }
  });

  it("the company routes and public pages take the plan option", async () => {
    const routes = file(await plan(SAAS), "src", "server", "company-routes.ts");
    expect(routes.match(/\.\.\.companyPlanOption/g)).toHaveLength(3);
    expect(routes).toContain("createPublicCompanySeams({ tenancy, ...companyPlanOption })");
  });

  it("the tenancy service's seat limit comes from the plan (companies only)", async () => {
    expect(file(await plan(SAAS), "src", "server", "tenancy.ts")).toContain("...seatLimitOption,");
    expect(file(await plan(SINGLE), "src", "server", "tenancy.ts")).not.toContain("seatLimitOption");
  });

  it("files ask the plan for the room; the estimate page and widget ask for this month's estimates", async () => {
    const p = await plan(SAAS);
    expect(file(p, "src", "server", "files.ts")).toContain("storageAllowanceBytes(tenantId, filesAllowanceBytes(tenantId))");
    const estimator = file(p, "src", "server", "estimator.ts");
    expect(estimator.match(/admit: admitEstimateRequest/g)).toHaveLength(2);
  });

  it("the banner is above every page, and says nothing where plans aren't sold", async () => {
    const layout = file(await plan(SAAS), "app", "(site)", "layout.tsx");
    expect(layout).toContain("<PlanBannerSlot />");
    expect(file(await plan(SAAS), "src", "components", "PlanBannerSlot.tsx")).toContain("Free trial:");
    expect(file(await plan(SINGLE), "src", "components", "PlanBannerSlot.tsx")).toContain("return null;");
  });

  it("the banner finds the company by the app's own user, not Clerk's id (it never showed in Igloo Back Office)", async () => {
    const banner = file(await plan(SAAS), "src", "components", "PlanBannerSlot.tsx");
    expect(banner).toContain("tenancy.resolveSession({ userId: principal.userId })");
    expect(banner).not.toContain("@clerk/nextjs/server");
  });
});

describe("what a plan sells", () => {
  it("team members always; storage with files; online estimates with the estimator — and nothing nothing enforces", async () => {
    const full = file(await plan(SAAS), "src", "plans.ts");
    expect(full).toContain('seats: { kind: "quota", label: "team members"');
    expect(full).toContain('storage_gb: { kind: "quota", label: "GB of photos and files"');
    expect(full).toContain('estimates: { kind: "quota", label: "online estimate requests a month"');
    // The old sample sold single sign-on, exports, projects and support tiers, which nothing in the suite enforces.
    expect(full).not.toMatch(/^\s+(sso|exports|projects|support):/m);
    const bare = file(await plan(BARE_SAAS), "src", "plans.ts");
    expect(bare).not.toContain("storage_gb");
    expect(bare).not.toContain("estimates:");
  });

  it("the free trial and the enforced-from day are listed where plans are sold, and only there", () => {
    expect(optionalEnvFor(answers(SAAS))).toEqual(expect.arrayContaining(["BILLING_TRIAL_DAYS", "PLANS_ENFORCED_FROM"]));
    expect(optionalEnvFor(answers(SINGLE))).not.toContain("BILLING_TRIAL_DAYS");
  });
});

describe("the proof ships with the projects that need it", () => {
  it("company-plans.test.ts in an enforcing project, nowhere else", async () => {
    expect((await plan(SAAS)).files.has(join("src", "server", "__tests__", "company-plans.test.ts"))).toBe(true);
    expect((await plan(BARE_SAAS)).files.has(join("src", "server", "__tests__", "company-plans.test.ts"))).toBe(true);
    expect((await plan(SINGLE)).files.has(join("src", "server", "__tests__", "company-plans.test.ts"))).toBe(false);
    const proof = file(await plan(SAAS), "src", "server", "__tests__", "company-plans.test.ts");
    expect(proof).toContain('const WORK_PERMISSION: string | null = "estimator.estimates.manage";');
    expect(file(await plan(BARE_SAAS), "src", "server", "__tests__", "company-plans.test.ts")).toContain("const WORK_PERMISSION: string | null = null;");
  });
});

describe("never charged twice (the double-charge fix)", () => {
  it("a company that pays changes its plan in place; a second checkout is refused; a returning company keeps its Stripe customer", async () => {
    const router = await readFile(join(OVERLAYS_DIR, "stripe", "src", "server", "routers", "billing.ts"), "utf8");
    expect(router).toContain("if (live) throw alreadyPaysRefusal(live.status, multiLine);");
    // Stripe is asked too (review H2): a subscription paid but not yet mirrored, and every other open checkout closed.
    expect(router).toContain("if (prepared.existingSubscription) throw alreadyPaysRefusal(prepared.existingSubscription.status, multiLine);");
    expect(router).toContain("Use Change plan, so it's never charged twice.");
    expect(router).toContain("customer: prepared.customerId,");
    expect(router).toContain("previewPlanChange: requireTenant(\"subscriptions.manage\")");
    expect(router).toContain("changePlan: requireTenant(\"subscriptions.manage\")");
    expect(router).toContain("idempotencyKey: `plan_change:${ctx.tenantId}:${row.key}:${input.prorationDate}`");
    const chooser = await readFile(join(OVERLAYS_DIR, "account", "src", "components", "account", "PlanChooser.tsx"), "utf8");
    expect(chooser).toContain("const changing = props.hasPaidPlan && !simulated;");
  });

  it("a subscription's plan is read from its PRICE first, so metadata can never name a plan nobody paid for", async () => {
    const subscription = await readFile(join(OVERLAYS_DIR, "stripe", "src", "server", "subscription.ts"), "utf8");
    const price = subscription.indexOf("if (input.priceId !== null) {");
    const metadata = subscription.indexOf("const declared = input.planMetadata?.trim();");
    expect(price).toBeGreaterThan(0);
    expect(metadata).toBeGreaterThan(price);
  });
});
