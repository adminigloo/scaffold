import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertAnswersCompatible,
  consumerProduct,
  DEFAULT_ANSWERS,
  IncompatibleAnswersError,
  optionalEnvFor,
  overlayNamesFor,
  type Answers,
} from "../answers.js";
import { collectAnswers, HELP, parseArgs } from "../cli.js";
import { planEmit, type EmitPlan } from "../emit.js";
import { personalPlans, plansEnforced, sellsPlans } from "../plans-emit.js";
import { ROUTER_SCOPES, TENANT_PROCEDURES } from "../tenancy-proofs-emit.js";
import { defaultsOnlyPrompter } from "../prompt.js";
import { packageVersions } from "../versions.js";
import { TEMPLATE_DIR } from "./configurations.js";

/**
 * BILLING 0.5 — product lines and personal plans. A project whose customers
 * are PEOPLE (`--tenant-noun none --audience consumers`) charges each person
 * for their own plans, several product lines stacked on one bill; nobody can
 * share an account; the founder sees who pays at /admin/billing/subscribers.
 * Every project made before keeps its answers (audience "business") and its
 * files. The emitted proofs (personal-plans.test.ts, product-lines.test.ts)
 * run in the generated projects; these pin what the generator writes.
 */

const OVERLAYS_DIR = join(TEMPLATE_DIR, "..", "overlays");

function answers(overrides: Partial<Answers> = {}): Answers {
  return { ...DEFAULT_ANSWERS, projectName: "weather-terminal", ...overrides };
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

const CONSUMERS: Partial<Answers> = { tenantNoun: "none", audience: "consumers", businessModel: "subscription", adminShell: "full", includeEmail: true, includeNotifications: true };
const ONE_BUSINESS: Partial<Answers> = { ...CONSUMERS, audience: "business" };
const CONSUMERS_SHOP: Partial<Answers> = { ...CONSUMERS, businessModel: "one-time" };
const COMPANIES: Partial<Answers> = { tenantNoun: "Company", businessModel: "subscription", adminShell: "full" };

describe("who signs up: --audience", () => {
  it("is business by default — every project made before keeps its shape — and consumers only with no companies", async () => {
    expect(DEFAULT_ANSWERS.audience).toBe("business");
    expect(parseArgs(["acme", "--tenant-noun", "none", "--audience", "consumers"]).audience).toBe("consumers");
    expect(parseArgs(["acme", "--audience=business"]).audience).toBe("business");
    expect(() => parseArgs(["acme", "--audience", "people"])).toThrow(/business, consumers/);
    // A bare word after --audience is its value, not the project name.
    expect(parseArgs(["--audience", "consumers", "acme"]).name).toBe("acme");
    expect(() => assertAnswersCompatible(answers({ tenantNoun: "Company", audience: "consumers" }))).toThrow(IncompatibleAnswersError);
    expect(HELP).toContain("--audience <a>");
    // --yes with no companies: the default, without a prompt standing in the way.
    const yes = await collectAnswers(parseArgs(["acme", "--tenant-noun", "none", "--yes"]), defaultsOnlyPrompter());
    expect(yes.audience).toBe("business");
    expect(consumerProduct(answers(CONSUMERS))).toBe(true);
    expect(consumerProduct(answers(ONE_BUSINESS))).toBe(false);
  });

  it("decides which plan check a project gets: companies, people, or none at all", () => {
    expect([plansEnforced(answers(COMPANIES)), personalPlans(answers(COMPANIES)), sellsPlans(answers(COMPANIES))]).toEqual([true, false, true]);
    expect([plansEnforced(answers(CONSUMERS)), personalPlans(answers(CONSUMERS)), sellsPlans(answers(CONSUMERS))]).toEqual([false, true, true]);
    expect(sellsPlans(answers(ONE_BUSINESS))).toBe(false);
    expect(sellsPlans(answers(CONSUMERS_SHOP))).toBe(false);
  });
});

describe("src/server/plan-gate.ts: the personal variant", () => {
  it("each person's plans, per product line; free accounts stay open; one person per account; a trial only if asked for", async () => {
    const gate = file(await plan(CONSUMERS), "src", "server", "plan-gate.ts");
    expect(gate).toContain("THE PLAN CHECK — personal plans (billing 0.5)");
    expect(gate).toContain("loadCompanyPlan(executor, { tenantId, trialStartedAt: null, trialDays: 0, plans })");
    expect(gate).toContain("limitFor: async (): Promise<number> => 1,");
    expect(gate).toContain("export const CHECKOUT_TRIAL_DAYS = env.BILLING_TRIAL_DAYS ?? 0;");
    expect(gate).toContain("export function gateLoaders<L>(loaders: L): L {\n  return loaders;\n}");
    expect(gate).toContain("export async function tenantEntitlements(");
    expect(gate).toContain("export function personalBannerSentence(");
  });

  it("every variant exports the same names, CHECKOUT_TRIAL_DAYS included", async () => {
    const names = ["companyPlanOption", "seatLimitOption", "gateLoaders", "storageAllowanceBytes", "planStandingOf", "estimateQuota", "assistantMessageLimit", "companyOnTrial", "companyPlanOpen", "CHECKOUT_TRIAL_DAYS"];
    for (const overrides of [CONSUMERS, ONE_BUSINESS, CONSUMERS_SHOP, COMPANIES]) {
      const gate = file(await plan(overrides), "src", "server", "plan-gate.ts");
      for (const name of names) expect(gate, `${JSON.stringify(overrides)} ${name}`).toMatch(new RegExp(`export (const|function|async function) ${name}\\b`));
    }
  });

  it("one person per account in EVERY consumers project, plans or not; a single business keeps inviting its staff", async () => {
    expect(file(await plan(CONSUMERS_SHOP), "src", "server", "plan-gate.ts")).toContain("limitFor: async (): Promise<number> => 1,");
    expect(file(await plan(ONE_BUSINESS), "src", "server", "plan-gate.ts")).toContain("export const seatLimitOption = {} as const;");
    for (const overrides of [CONSUMERS, CONSUMERS_SHOP]) {
      const tenancy = file(await plan(overrides), "src", "server", "tenancy.ts");
      expect(tenancy).toContain("...seatLimitOption,");
      expect(tenancy).toContain('import { seatLimitOption } from "./plan-gate";');
    }
    expect(file(await plan(ONE_BUSINESS), "src", "server", "tenancy.ts")).not.toContain("seatLimitOption");
  });

  it("a companies project reads its plan per product line too, and asks it for entitlements", async () => {
    const gate = file(await plan(COMPANIES), "src", "server", "plan-gate.ts");
    expect(gate).toContain("    // Per product line (billing 0.5): open while any line is paid for.\n    plans,");
    expect(gate).toContain("export async function tenantEntitlements(tenantId: string)");
    expect(gate).toContain("export const CHECKOUT_TRIAL_DAYS = 0;");
  });
});

describe("one question for every paid feature: requireEntitlement", () => {
  it("is emitted wherever plans are sold, for pages, route handlers and tRPC, and nowhere else", async () => {
    for (const overrides of [CONSUMERS, COMPANIES]) {
      const p = await plan(overrides);
      const access = file(p, "src", "server", "access.ts");
      expect(access).toContain("export async function entitlementOf(");
      expect(access).toContain("export async function pageEntitlement(");
      expect(access).toContain("export function withEntitlement<");
      expect(access).toContain("export function requireEntitlement(feature: string, permission = \"tenant.view\")");
      expect(access).toContain('code: "upgrade_required"');
      expect(file(p, "src", "components", "Entitled.tsx")).toContain("export async function Entitled(");
    }
    for (const overrides of [ONE_BUSINESS, CONSUMERS_SHOP]) {
      const p = await plan(overrides);
      expect(p.files.has(join("src", "server", "access.ts"))).toBe(false);
      expect(p.files.has(join("src", "components", "Entitled.tsx"))).toBe(false);
    }
  });

  it("the proof of personal plans ships with the projects that sell them, and only those", async () => {
    expect((await plan(CONSUMERS)).files.has(join("src", "server", "__tests__", "personal-plans.test.ts"))).toBe(true);
    for (const overrides of [ONE_BUSINESS, CONSUMERS_SHOP, COMPANIES]) {
      expect((await plan(overrides)).files.has(join("src", "server", "__tests__", "personal-plans.test.ts"))).toBe(false);
    }
    const proof = file(await plan(CONSUMERS), "src", "server", "__tests__", "personal-plans.test.ts");
    expect(proof).toContain("3. a second line STACKS on the first");
    expect(proof).toContain('rejects.toMatchObject({ code: "seats_full" })');
  });

  it("the banner speaks to the person, about their own plans", async () => {
    const banner = file(await plan(CONSUMERS), "src", "components", "PlanBannerSlot.tsx");
    expect(banner).toContain('import { personalBannerSentence, personalPlan } from "@/server/plan-gate";');
    expect(banner).toContain("currentTenantFor(principal.userId)");
  });
});

describe("a consumers project's sample plans, team and admin", () => {
  it("sample plans are a person's: two product lines, flags and quotas, no team members", async () => {
    const plans = file(await plan(CONSUMERS), "src", "plans.ts");
    expect(plans).toContain("export const plans = definePlans({\n  lines: {");
    expect(plans).toContain("membership: {");
    expect(plans).toContain("extras: {");
    expect(plans).not.toContain("seats");
    expect(plans).toContain("export const HEADLINE_FEATURES");
    expect(plans).toContain("export const DEFAULT_CURRENCY");
    // A companies project's sample is unchanged in shape (one implicit line).
    expect(file(await plan(COMPANIES), "src", "plans.ts")).toContain('seats: { kind: "quota", label: "team members"');
  });

  it("no team: the page says the account is just yours, and no nav links to it; a single business keeps its team", async () => {
    const p = await plan(CONSUMERS);
    const team = file(p, "app", "(site)", "settings", "team", "page.tsx");
    expect(team).toContain("This account is for one person.");
    expect(team).not.toContain("TeamManager");
    expect(file(p, "src", "nav.ts")).not.toContain('href: "/settings/team"');
    const business = await plan(ONE_BUSINESS);
    expect(file(business, "app", "(site)", "settings", "team", "page.tsx")).toContain("<TeamManager");
    expect(file(business, "src", "nav.ts")).toContain('href: "/settings/team"');
  });

  it("the founder's Subscribers page and its link, in consumers projects with an admin shell only", async () => {
    expect(overlayNamesFor(answers(CONSUMERS))).toContain("subscribers-admin");
    for (const overrides of [ONE_BUSINESS, COMPANIES, { ...CONSUMERS, adminShell: "none" as const }, { ...CONSUMERS, businessModel: "none" as const }]) {
      expect(overlayNamesFor(answers(overrides))).not.toContain("subscribers-admin");
    }
    const p = await plan(CONSUMERS);
    expect(p.files.has(join("app", "admin", "billing", "subscribers", "page.tsx"))).toBe(true);
    expect(file(p, "src", "components", "admin", "AdminNav.tsx") + file(p, "src", "nav.ts")).toContain("/admin/billing/subscribers");
    expect((await plan(COMPANIES)).files.has(join("app", "admin", "billing", "subscribers", "page.tsx"))).toBe(false);
  });

  it("the free trial at checkout is listed for personal plans; the day-plans-were-enforced isn't", async () => {
    expect(optionalEnvFor(answers(CONSUMERS))).toContain("BILLING_TRIAL_DAYS");
    expect(optionalEnvFor(answers(CONSUMERS))).not.toContain("PLANS_ENFORCED_FROM");
    expect(optionalEnvFor(answers(ONE_BUSINESS))).not.toContain("BILLING_TRIAL_DAYS");
    const p = await plan(CONSUMERS);
    expect(file(p, "src", "env.ts")).toContain("BILLING_TRIAL_DAYS: z.coerce.number()");
    expect(file(p, ".env.example")).toContain("BILLING_TRIAL_DAYS=");
    expect(file(p, ".env.local")).toContain("# BILLING_TRIAL_DAYS=7");
  });

  it("the invitation proofs lift the one-seat limit only to build their teams, and only in consumers projects", async () => {
    for (const name of ["tenant-isolation.test.ts", "invite-accept-route.test.ts", "invite-email-route.test.ts"]) {
      expect(file(await plan(CONSUMERS), "src", "server", "__tests__", name), name).toContain('vi.mock("@/server/plan-gate"');
      expect(file(await plan(ONE_BUSINESS), "src", "server", "__tests__", name), name).not.toContain('vi.mock("@/server/plan-gate"');
    }
  });
});

describe("the release lines a generated project needs", () => {
  it("billing 0.5 (product lines) and stripe 0.6 (items per line, one customer per tenant)", () => {
    expect(packageVersions()["billing"]).toMatch(/^0\.5\.\d+$/);
    expect(packageVersions()["stripe"]).toMatch(/^0\.6\.\d+$/);
  });
});

describe("the money paths in the overlays (billing 0.5)", () => {
  const read = (...segments: string[]) => readFile(join(OVERLAYS_DIR, ...segments), "utf8");

  it("adding a line is a priced, previewed, idempotent item on the ONE subscription", async () => {
    const router = await read("stripe", "src", "server", "routers", "billing.ts");
    expect(router).toContain('previewAddLine: requireTenant("subscriptions.manage")');
    expect(router).toContain('addLine: requireTenant("subscriptions.manage")');
    // A re-add after a drop is never the first add's key (review): the line's earlier items are in it,
    // and what's mirrored is the package's fresh read, refused when the new item isn't in it.
    expect(router).toContain("idempotencyKey: addLineIdempotencyKey(current, tier.line, { previousItemIds: before.map((each) => each.itemId) }),");
    expect(router).toContain("if (result.applied && result.itemId !== null) {");
    // "Is this line already on it at Stripe?" is answered the way the mirror reads an item.
    expect(router).toContain("await assertLineNotAtStripe(client, paying.stripeSubscriptionId, tier);");
    expect(router).toContain("const resolution = await resolveSubscriptionItem(snapshot, item);");
    expect(router).toContain("const published = await publishedPlanPrice(client, tier, row, priceMinor);");
    // A change of tier swaps the LINE's own item.
    expect(router).toContain("...(live.stripeItemId !== null ? { itemId: live.stripeItemId } : {}),");
    // Free months are refused on a line already paid by card, not on every line.
    expect(router).toContain("lineOfStoredRow(plans, paid.planKey, paid.line) === tier.line");
  });

  it("cancelling one of several lines removes its item (credited); the last one ends with its period", async () => {
    const account = await read("account", "src", "server", "routers", "account.ts");
    expect(account).toContain("left = await removeLine(stripe, {");
    expect(account).toContain("{ cancel_at_period_end: cancelAtPeriodEnd },");
  });

  it("the mirror never ends a line Stripe still bills, and reads an old Price by its own stamp (review)", async () => {
    const mirror = await read("stripe", "src", "server", "subscription.ts");
    expect(mirror).toContain("if (row.stripeItemId !== null && billedNow.has(row.stripeItemId)) continue;");
    expect(mirror).toContain("const stamped = planFromPriceMetadata(input);");
    expect(mirror).toContain("export async function resolveSubscriptionItem(");
  });

  it("every Stripe-sourced write mirrors the whole subscription, one line per item; a recurring product's grant follows it", async () => {
    const webhook = await read("stripe", "app", "api", "webhooks", "stripe", "route.ts");
    expect(webhook).toContain("const outcome = await mirrorStripeSubscription(snapshot, {");
    expect(webhook).toContain("await windowProductGrants({");
    expect(webhook).toContain('subscriptionId: metadata["subscriptionId"] || null,');
    const fulfilment = await read("stripe", "src", "server", "fulfilment.ts");
    expect(fulfilment).toContain('if (input.subscriptionId) lineMetadata["subscriptionId"] = input.subscriptionId;');
    expect(fulfilment).toContain("export async function windowProductGrants(");
  });

  it("one Stripe customer per tenant, for plans and products alike", async () => {
    const checkout = await read("stripe", "src", "server", "routers", "checkout.ts");
    expect(checkout).toContain("const customerId = await resolveStripeCustomer(client, {");
    expect(checkout).toContain("export async function findBillingCustomerId(");
    // ...but only in a person's OWN workspace: a member's own purchases never go on a company's customer (review).
    expect(checkout).toContain("if (tenant !== null && (await isOwnPersonalWorkspace(tenant.id, principal.userId))) {");
    const router = await read("stripe", "src", "server", "routers", "billing.ts");
    expect(router).toContain("...(ownWorkspace ? { userId: ctx.principal.userId } : {}),");
  });

  it("the new tenant procedures are on the tenant rung and proved isolated", () => {
    for (const path of ["billing.previewAddLine", "billing.addLine"]) {
      expect(ROUTER_SCOPES.find((row) => row.key === path)?.scope, path).toBe("tenant");
      expect(TENANT_PROCEDURES.some((p) => p.path === path), path).toBe(true);
    }
    for (const path of ["account.cancelSubscription", "account.resumeSubscription"]) {
      expect(TENANT_PROCEDURES.find((p) => p.path === path)?.allow?.["line"], path).toBeDefined();
    }
  });
});
