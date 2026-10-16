/**
 * The emitted proof of billing 0.3: `src/server/__tests__/company-plans.test.ts`,
 * written only into a companies project that sells plans (the open stand-in
 * in every other project has nothing to prove). See plans-emit.ts.
 */
import type { Answers } from "./answers.js";

/** A permission that does new work, from the first installed feature that has one; null when none is installed. */
function workPermission(answers: Answers): string | null {
  if (answers.includeEstimator) return "estimator.estimates.manage";
  if (answers.includeScheduling) return "schedule.manage";
  if (answers.includeInvoicing) return "invoices.manage";
  if (answers.includeComms) return "comms.manage";
  if (answers.includeNotifications) return "alerts.manage";
  if (answers.includeStorage) return "files.manage";
  return null;
}

export function renderCompanyPlansTest(answers: Answers): string {
  const scope = answers.scope;
  const work = workPermission(answers);
  return `import { beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { users } from "${scope}/auth/schema";
import { plans as planTable } from "${scope}/billing/schema";
import { db } from "@/db";
import { plans } from "@/plans";
import { seedPermissions } from "@/permissions/seed";
import { admitPublic, companyAuthorizer } from "@/server/company-routes";
import { loadStaffPermissions, loadTenantPermissions } from "@/server/permissions";
import { companyPlan, estimateQuota, planLimit } from "@/server/plan-gate";
import { applySubscription } from "@/server/subscription";
import { tenancy } from "@/server/tenancy";

/**
 * EVERY COMPANY'S PLAN, AT EVERY CHECKPOINT (billing 0.3) — proved on this
 * project's own schema, in-process, on every \`pnpm test\`.
 *
 *   A  its free trial is over and it never chose a plan: it can SEE its work,
 *      its billing, its team and its settings, but can't do new work; its
 *      public pages say it isn't taking requests online.
 *   B  made today, on its free trial: everything open — A being closed
 *      closes nothing of B's.
 *   C  its trial over, then given a plan: open again, with that plan's
 *      limits (Starter's 3 team members stop the fourth invitation).
 *
 * The standing is cached 15 seconds per server copy, so the clock is moved
 * on between phases rather than waited for.
 */
vi.mock("@/db", async () => {
  const { createAppPglite } = await import("@/test/pglite");
  return { db: (await createAppPglite()).db };
});

vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(new Date());

/** A permission that does new work, from this project's first installed feature (null: none installed). GENERATED. */
const WORK_PERMISSION: string | null = ${JSON.stringify(work)};

interface Person {
  readonly id: string;
  readonly email: string;
}

const fx = {} as { A: Person; B: Person; C: Person; aId: string; bId: string; cId: string };

async function person(externalId: string, email: string): Promise<Person> {
  const [row] = await db.insert(users).values({ externalId, email, displayName: email }).returning();
  if (!row) throw new Error("could not create the test person");
  await tenancy.provisionUser({ userId: row.id, email });
  return { id: row.id, email };
}

async function companyOf(owner: Person, name: string): Promise<string> {
  const out = await tenancy.createCompany({
    userId: owner.id,
    name,
    requestKey: \`plans-\${owner.id}\`.slice(0, 64),
    purpose: "onboarding",
  });
  return out.company.id;
}

/** Make a company's free trial long over. */
async function endTrial(tenantId: string): Promise<void> {
  await db.execute(sql\`update tenants set created_at = now() - interval '60 days' where id = \${tenantId}\`);
}

/** Past the gate's 15-second cache, so the next ask reads again. */
function later(): void {
  vi.setSystemTime(new Date(Date.now() + 20_000));
}

const reqFor = (tenantId: string) => new Request(\`https://app.test/api/app/\${tenantId}/x\`);

beforeAll(async () => {
  await seedPermissions(db, { log: () => {} });
  // The plan record's rows, as \`pnpm db:seed:plans\` writes them.
  for (const row of plans.rows) {
    await db.insert(planTable).values({
      key: row.key,
      name: row.name,
      description: row.description,
      interval: row.interval,
      priceMinor: row.priceMinor,
      currency: row.currency,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
    });
  }
  fx.A = await person("ext_plan_a", "owner@alpha-lawn.test");
  fx.B = await person("ext_plan_b", "owner@bravo-roofing.test");
  fx.C = await person("ext_plan_c", "owner@cedar-cleaning.test");
  fx.aId = await companyOf(fx.A, "Alpha Lawn Care");
  fx.bId = await companyOf(fx.B, "Bravo Roofing");
  fx.cId = await companyOf(fx.C, "Cedar Cleaning");
  await endTrial(fx.aId);
  await endTrial(fx.cId);
});

describe("each company's plan, at every checkpoint (billing 0.3)", () => {
  it("1. standing: A's trial is over, B is on its free trial, and C (trial over) is closed until it has a plan", async () => {
    expect((await companyPlan(fx.aId)).standing).toMatchObject({ state: "none", open: false });
    const b = (await companyPlan(fx.bId)).standing;
    expect(b).toMatchObject({ state: "trial", open: true });
    expect(b.until!.getTime()).toBeGreaterThan(Date.now());
    expect((await companyPlan(fx.cId)).standing).toMatchObject({ state: "none", open: false });
  });

  it("2. the permission loaders (tRPC and every page): a closed company keeps reading, billing, its team and settings, never new work; staff are never trimmed", async () => {
    const a = await loadTenantPermissions({ principal: { userId: fx.A.id }, tenantId: fx.aId });
    expect(a).not.toBeNull();
    expect(a!.can("tenant.view")).toBe(true);
    expect(a!.can("tenant.edit")).toBe(true);
    expect(a!.can("subscriptions.manage")).toBe(true);
    expect(a!.can("members.invite")).toBe(true);
    if (WORK_PERMISSION !== null) {
      expect(a!.can(WORK_PERMISSION)).toBe(false);
      const b = await loadTenantPermissions({ principal: { userId: fx.B.id }, tenantId: fx.bId });
      expect(b!.can(WORK_PERMISSION)).toBe(true);
    }
    // A stranger is still "not a member", not "closed": the plan never answers for strangers.
    expect(await loadTenantPermissions({ principal: { userId: fx.B.id }, tenantId: fx.aId })).toBeNull();
    // Staff permissions pass straight through: a company's plan never decides
    // who is staff (the first person in a fresh project may be its admin).
    const staff = await loadStaffPermissions({ principal: { userId: fx.A.id } });
    if (staff !== null) expect(staff.toArray().length).toBeGreaterThan(0);
  });

  it("3. the feature routes: new work in a closed company is refused in plain words; reading still opens; B's work goes", async () => {
    if (WORK_PERMISSION === null) return;
    const as = (userId: string) => companyAuthorizer({ principal: async () => ({ userId }) });
    const refused = await as(fx.A.id)(reqFor(fx.aId), WORK_PERMISSION, fx.aId);
    expect(refused).toBeInstanceOf(Response);
    expect((refused as Response).status).toBe(403);
    const body = (await (refused as Response).json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/free trial has ended\\. An owner can choose a plan in Billing/);
    expect(await as(fx.A.id)(reqFor(fx.aId), "tenant.view", fx.aId)).toEqual({ userId: fx.A.id });
    expect(await as(fx.B.id)(reqFor(fx.bId), WORK_PERMISSION, fx.bId)).toEqual({ userId: fx.B.id });
  });

  it("4. the public pages: a closed company isn't taking requests online, by name; B's pages are open", async () => {
    const a = await admitPublic(fx.aId, new Request("https://app.test/api/estimator/estimates"));
    expect(a.open).toBe(false);
    if (!a.open) expect(a.message).toContain("Alpha Lawn Care isn't taking requests online right now.");
    expect(await admitPublic(fx.bId, new Request("https://app.test/api/estimator/estimates"))).toEqual({ open: true });
    // The links A already sent stay open: its customers can still see, accept, reschedule and pay.
    for (const path of ["estimator/v1/quote/tok/accept", "scheduling/v1/visit/tok", "invoicing/v1/invoice/tok"]) {
      expect(await admitPublic(fx.aId, new Request(\`https://app.test/api/t/alpha/\${path}\`)), path).toEqual({ open: true });
    }
  });

  it("5. a plan opens a closed company again, with that plan's limits: Starter's team stops at its seats", async () => {
    const starter = plans.rows.find((row) => row.tierKey === "starter" && row.interval === "month" && row.currency === "usd");
    expect(starter, "the sample plans sell Starter monthly in USD").toBeDefined();
    const now = new Date();
    await applySubscription({
      tenantId: fx.cId,
      tierKey: "starter",
      planKey: starter!.key,
      stripeSubscriptionId: null,
      stripeCustomerId: null,
      status: "active",
      currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      cancelAtPeriodEnd: false,
      canceledAt: null,
      trialEndsAt: null,
      observedAt: now,
      source: "simulated",
    });
    later();
    expect((await companyPlan(fx.cId)).standing).toMatchObject({ state: "active", open: true, tierKey: "starter" });
    expect(await planLimit(fx.cId, "seats")).toBe(3);
    // The owner is one; two more invitations fit; the next is refused for seats.
    await tenancy.sendInvitation({ actorUserId: fx.C.id, tenantId: fx.cId, email: "one@cedar-cleaning.test", roleKey: "member" });
    await tenancy.sendInvitation({ actorUserId: fx.C.id, tenantId: fx.cId, email: "two@cedar-cleaning.test", roleKey: "member" });
    await expect(
      tenancy.sendInvitation({ actorUserId: fx.C.id, tenantId: fx.cId, email: "three@cedar-cleaning.test", roleKey: "member" }),
    ).rejects.toMatchObject({ code: "seats_full" });
    // A's plan is still closed: C's plan opened only C.
    expect((await companyPlan(fx.aId)).standing.open).toBe(false);
  });

  it("5b. one free trial per owner, and a closed company holds the smallest plan's limits", async () => {
    // A's owner makes a second company: it starts its trial when their first did, so it is already over.
    const second = await tenancy.createCompany({ userId: fx.A.id, name: "Alpha Two", requestKey: \`plans-second-\${fx.A.id}\`.slice(0, 64), purpose: "additional" });
    later();
    expect((await companyPlan(second.company.id)).standing).toMatchObject({ state: "none", open: false });
    // A closed company can't invite without end: it is held to the smallest plan's team.
    expect(await planLimit(fx.aId, "seats")).toBe(3);
  });

  it("6. online estimate requests stop at the plan's monthly number, and only for that company", async () => {
    // The plan's number, set to 0 here so the check can be seen without
    // making a month of estimates. In a project without the estimator there
    // is nothing to limit, and the quota is always open.
    await db.execute(sql\`update entitlements set limit_value = 0 where tenant_id = \${fx.cId} and feature = 'estimates'\`);
    later();
    const limited = (await planLimit(fx.cId, "estimates")) !== undefined;
    const c = await estimateQuota(fx.cId);
    expect(c.open).toBe(!limited);
    if (!c.open) expect(c.message).toBe("Cedar Cleaning isn't taking online estimate requests right now. Please call or email them instead.");
    expect((await estimateQuota(fx.bId)).open).toBe(true);
  });
});
`;
}
