import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ANSWERS, type Answers } from "../answers.js";
import { planEmit, type EmitPlan } from "../emit.js";
import { COMPANY_ROWS_KEPT, FORGET_ENTRIES, forgetSteps } from "../forget-company-emit.js";
import { upgradeNotesFor } from "../upgrade-notes.js";
import { TEMPLATE_DIR } from "./configurations.js";

/**
 * DELETE A COMPANY (create-app 0.37): src/server/forget-company.ts is
 * generated for the packages a project installed — one import and one call
 * per package that keeps company rows, the files' bytes only with storage,
 * the "still paying" check only with plans for sale — and never an `if`
 * about an answer. tenancy.ts hands it to the service as `deletion` (lazily,
 * like onEvent); the staff key is in the catalog; the proof is in both modes.
 */

const EVERYTHING: Partial<Answers> = {
  tenantNoun: "Company",
  businessModel: "subscription",
  includeAi: true,
  includeEmail: true,
  includeFeedback: true,
  includeSeoReports: true,
  includeNotifications: true,
  includeStorage: true,
  includeAssistant: true,
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
const BARE: Partial<Answers> = { tenantNoun: "none", businessModel: "none" };

const plans = new Map<string, Promise<EmitPlan>>();
function plan(overrides: Partial<Answers>): Promise<EmitPlan> {
  const key = JSON.stringify(overrides);
  if (!plans.has(key)) plans.set(key, planEmit(TEMPLATE_DIR, "/out", { ...DEFAULT_ANSWERS, projectName: "acme", ...overrides }));
  return plans.get(key)!;
}
function file(p: EmitPlan, ...segments: string[]): string {
  const found = p.files.get(join(...segments));
  if (found === undefined) throw new Error(`no ${segments.join("/")}`);
  return found;
}

describe("src/server/forget-company.ts", () => {
  it("with every feature: one forget per package that keeps company rows, the files after the commit, the plan check", async () => {
    const body = file(await plan(EVERYTHING), "src", "server", "forget-company.ts");
    const steps = forgetSteps({ ...DEFAULT_ANSWERS, projectName: "acme", ...EVERYTHING });
    expect(steps.map((s) => s.pkg).sort()).toEqual(Object.keys(FORGET_ENTRIES).sort());
    for (const step of steps) {
      expect(body).toMatch(new RegExp(`import \\{ forgetTenant as ${step.alias}[ ,][^}]*\\} from "@adminigloo/${step.entry}";`));
      expect(body).toContain(`add(await ${step.alias}(tx, tenantId`);
    }
    expect(body).toContain("listTenantObjects(tx, tenantId, { tables: files.tables })");
    expect(body).toContain("files.deleteObjects(objects)");
    expect(body).toContain("livePaidSubscription(tx, tenantId)");
    for (const table of Object.keys(COMPANY_ROWS_KEPT)) expect(body).toContain(`  ${table}: `);
    expect(body).not.toMatch(/\bif \(answers|includeStorage|businessModel/);
  });

  it("a single business with no plans or files: no storage, no plan check, roles still forgotten", async () => {
    const body = file(await plan(BARE), "src", "server", "forget-company.ts");
    expect(body).toContain('import { forgetTenant as forgetPermissions } from "@adminigloo/permissions/server";');
    expect(body).not.toContain("@adminigloo/storage");
    expect(body).not.toContain("livePaidSubscription");
    expect(body).not.toContain("@adminigloo/billing");
    expect(body).toContain("return { counts: await forgetCompanyRows(tx, tenantId) };");
  });

  it("tenancy.ts hands it to the service lazily; the plan check only where plans are sold", async () => {
    const every = file(await plan(EVERYTHING), "src", "server", "tenancy.ts");
    expect(every).toContain('forget: (tx, tenantId) => import("./forget-company").then((m) => m.companyDeletion.forget(tx, tenantId)),');
    expect(every).toContain("livePaidSubscription: (tx, tenantId) =>");
    const bare = file(await plan(BARE), "src", "server", "tenancy.ts");
    expect(bare).toContain("deletion: {");
    expect(bare).not.toContain("livePaidSubscription");
  });

  it("the staff key is declared (admin only) and the proof is emitted in both modes", async () => {
    for (const overrides of [EVERYTHING, BARE]) {
      const p = await plan(overrides);
      const catalog = file(p, "src", "permissions", "catalog.ts");
      expect(catalog).toMatch(/"staff\.tenants\.delete": \{[^}]*defaultFor: \["admin"\],/s);
      const proof = file(p, "src", "server", "__tests__", "forget-company.test.ts");
      expect(proof).toContain('from "@adminigloo/testing/forget"');
      expect(proof).toContain("tenancy.deleteCompany({ actorUserId: fx.staff, tenantId: fx.aId, confirmSlug: fx.aSlug })");
      expect(proof).toContain("kept: COMPANY_ROWS_KEPT");
    }
    const proof = file(await plan(EVERYTHING), "src", "server", "__tests__", "forget-company.test.ts");
    expect(proof).toContain('"estimator_estimate_items.estimate_id": "estimator_estimates.id"');
    expect(file(await plan(BARE), "src", "server", "__tests__", "forget-company.test.ts")).toContain("personalWorkspaceId(ownerId)");
  });

  it("a Stripe event after a (forced) delete writes nothing back: the mirror checks, the proof replays one (review)", async () => {
    const every = await plan(EVERYTHING);
    const mirror = file(every, "src", "server", "subscription.ts");
    expect(mirror).toContain('import { tenants } from "@adminigloo/tenancy/schema";');
    expect(mirror).toContain("if (company?.deletedAt) {");
    expect(mirror).toContain("tenantGone: true,");
    // The guard comes before the plan is resolved and before anything is written.
    expect(mirror.indexOf("company?.deletedAt")).toBeLessThan(mirror.indexOf("plans.tier(input.tierKey)"));
    expect(file(every, "app", "api", "webhooks", "stripe", "route.ts")).toContain("if (result.tenantGone) {");
    const proof = file(every, "src", "server", "__tests__", "forget-company.test.ts");
    expect(proof).toContain("writes nothing back");
    expect(proof).toContain("tenantGone: true");
    expect(proof).toContain('import { applySubscription } from "@/server/subscription";');
    // NEGATIVE CONTROL: a project that sells nothing has no mirror to replay.
    const bare = file(await plan(BARE), "src", "server", "__tests__", "forget-company.test.ts");
    expect(bare).not.toContain("applySubscription");
    expect(bare).not.toContain("tenantGone");
  });

  it("tells a 0.36 project what's new, and which columns to add for its features", () => {
    const notes = upgradeNotesFor({ ...DEFAULT_ANSWERS, ...EVERYTHING, projectName: "acme" }, "0.36.1").join("\n");
    expect(notes).toContain("src/server/forget-company.ts");
    expect(notes).toContain("estimator_estimates.entered_at/entered_by");
    expect(notes).toContain("analytics_sessions.import_key");
    expect(notes).toContain("orders.payment_method");
    const bare = upgradeNotesFor({ ...DEFAULT_ANSWERS, ...BARE, projectName: "acme" }, "0.36.1").join("\n");
    expect(bare).toContain("src/server/forget-company.ts");
    expect(bare).not.toContain("pnpm db:generate");
    expect(upgradeNotesFor({ ...DEFAULT_ANSWERS, ...EVERYTHING, projectName: "acme" }, "0.37.0").join("\n")).not.toContain("forget-company");
  });
});
