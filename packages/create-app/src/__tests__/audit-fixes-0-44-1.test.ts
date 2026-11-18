import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ANSWERS, type Answers } from "../answers.js";
import { planEmit, type EmitPlan } from "../emit.js";
import { upgradeNotesFor } from "../upgrade-notes.js";
import { TEMPLATE_DIR } from "./configurations.js";

/**
 * FIXES FROM THE 2026-11-16 AUDIT of Almanac and Hinderstap (create-app 0.44.1):
 *
 *   - a deployment with STRIPE_SECRET_KEY and no STRIPE_WEBHOOK_SECRET charged
 *     the card and never wrote the order or plan, because the webhook answered
 *     503 to every delivery (Almanac fixed its own copy on 2026-10-30);
 *   - CI ran the same typecheck and tests as the deploy on every push, which
 *     used about 40% of a month's Actions minutes on Hinderstap.
 *
 * The behaviour itself is proved in the generated project, by
 * src/server/__tests__/product-lines.test.ts and shop-lines.test.ts. These pin
 * what the generator writes.
 */
const sep = (path: string) => join(...path.split("/"));

async function plan(answers: Answers): Promise<EmitPlan> {
  return planEmit(TEMPLATE_DIR, "/out", answers);
}
function file(p: EmitPlan, path: string): string {
  const body = p.files.get(sep(path));
  if (body === undefined) throw new Error(`the plan has no ${path}`);
  return body;
}

const MONEY_MODELS = ["one-time", "subscription", "both"] as const;

describe("a checkout that can't record a payment doesn't take one", () => {
  for (const businessModel of MONEY_MODELS) {
    it(`asks for the webhook secret before saying "stripe" (--model ${businessModel})`, async () => {
      const mode = file(await plan({ ...DEFAULT_ANSWERS, businessModel }), "src/server/checkout-mode.ts");
      const stripeBranch = mode.slice(mode.indexOf("if (stripe) {"), mode.indexOf('kind: "stripe",'));
      expect(stripeBranch).toContain("if (!env.STRIPE_WEBHOOK_SECRET) {");
      expect(stripeBranch).toContain('kind: "unavailable"');
      expect(stripeBranch).toContain("STRIPE_WEBHOOK_SECRET isn't");
    });
  }

  it("has every money-taking procedure ask the same predicate", async () => {
    const p = await plan({ ...DEFAULT_ANSWERS, businessModel: "both" });
    // From each procedure's name to the first `const client = stripe;` after
    // it: the refusal has to come before the client is used.
    const before = (source: string, from: string) => {
      const start = source.indexOf(from);
      expect(start).toBeGreaterThan(-1);
      return source.slice(start, source.indexOf("const client = stripe;", start));
    };
    const checkout = file(p, "src/server/routers/checkout.ts");
    expect(before(checkout, "createIntent: protectedProcedure")).toContain('const mode = checkoutMode();\n      if (mode.kind !== "stripe") {');

    const billing = file(p, "src/server/routers/billing.ts");
    expect(before(billing, "subscribeToPlan: requireTenant")).toContain('const mode = checkoutMode();\n      if (mode.kind !== "stripe") {');
    // changePlan, addLine and their previews go through stripeOrThrow.
    expect(billing).toContain('if (!stripe || checkoutMode().kind !== "stripe") {');
  });

  it("tells an upgrading project that takes money to set the webhook secret, and one that doesn't nothing about it", () => {
    const money = upgradeNotesFor({ ...DEFAULT_ANSWERS, businessModel: "both" }, "0.44.0").join("\n");
    expect(money).toContain("Set STRIPE_WEBHOOK_SECRET on every deployment that has a secret key");
    expect(money).toContain("restricted key (rk_…)");
    const none = upgradeNotesFor({ ...DEFAULT_ANSWERS, businessModel: "none" }, "0.44.0").join("\n");
    expect(none).not.toContain("STRIPE_WEBHOOK_SECRET");
    // NEGATIVE CONTROL: a project already on 0.44.1 isn't told again.
    expect(upgradeNotesFor({ ...DEFAULT_ANSWERS, businessModel: "both" }, "0.44.1").join("\n")).not.toContain("STRIPE_WEBHOOK_SECRET");
  });
});

describe("CI runs on pull requests and by hand, never on a push", () => {
  it("has no push trigger, and cancels a pull request's older run", async () => {
    const ci = file(await plan(DEFAULT_ANSWERS), ".github/workflows/ci.yml");
    const triggers = ci.slice(ci.indexOf("\non:"), ci.indexOf("\nconcurrency:"));
    expect(triggers).toContain("pull_request:");
    expect(triggers).toContain("workflow_dispatch:");
    expect(triggers).not.toMatch(/^\s*push:/m);
    expect(ci).toContain("cancel-in-progress: true");
  });

  it("NEGATIVE CONTROL: the deploy still checks every push once, before it migrates", async () => {
    const deploy = file(await plan(DEFAULT_ANSWERS), ".github/workflows/deploy.yml");
    expect(deploy).toMatch(/on:\n {2}push:\n {4}branches: \[staging, main\]/);
    const verify = deploy.slice(deploy.indexOf("  verify:"), deploy.indexOf("  migrate-staging:"));
    expect(verify).toContain("if: github.event_name == 'push'");
    expect(verify).toContain("- run: pnpm typecheck");
    expect(verify).toContain("- run: pnpm test");
    expect(deploy).toContain("needs: verify");
  });
});
