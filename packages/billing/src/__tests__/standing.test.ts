import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  createPlanGate,
  gatePermissionLoaders,
  gatePermissionSet,
  openWhilePlanClosed,
  planClosedMessage,
  planStanding,
  type PlanStanding,
} from "../standing.js";
import { companyStripeCustomer, liveStripeSubscription, loadCompanyPlan } from "../server.js";

const NOW = new Date("2026-10-16T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

function sub(status: "trialing" | "active" | "past_due" | "canceled" | "unpaid" | "incomplete", cancelAtPeriodEnd = false) {
  return { status, cancelAtPeriodEnd, currentPeriodEnd: at(20), tierKey: "crew" } as const;
}

describe("planStanding", () => {
  const base = { trialStartedAt: null, trialDays: 14, now: NOW } as const;

  it("a new company with no plan is on its free trial until the trial ends", () => {
    const s = planStanding({ ...base, subscription: null, planRowExpiries: [], trialStartedAt: at(-3) });
    expect(s).toEqual({ state: "trial", open: true, until: at(11), tierKey: null });
  });

  it("the trial is closed AT its end, not a moment later", () => {
    expect(planStanding({ ...base, subscription: null, planRowExpiries: [], trialStartedAt: at(-14) }).open).toBe(false);
  });

  it("no plan and the trial over: closed, as 'none'", () => {
    const s = planStanding({ ...base, subscription: null, planRowExpiries: [], trialStartedAt: at(-30) });
    expect(s.state).toBe("none");
    expect(s.open).toBe(false);
  });

  it("no trial configured and no plan: closed", () => {
    expect(planStanding({ ...base, subscription: null, planRowExpiries: [], trialStartedAt: at(-1), trialDays: 0 }).open).toBe(false);
  });

  it("a paid, renewing plan is open with no end", () => {
    const s = planStanding({ ...base, subscription: sub("active"), planRowExpiries: [null, null] });
    expect(s).toEqual({ state: "active", open: true, until: null, tierKey: "crew" });
  });

  it("cancelled at period end: open until the paid-for period ends, then 'ended'", () => {
    const ending = planStanding({ ...base, subscription: sub("active", true), planRowExpiries: [at(20), at(20)] });
    expect(ending).toMatchObject({ state: "ending", open: true, until: at(20) });
    const after = planStanding({ ...base, now: at(21), subscription: sub("active", true), planRowExpiries: [at(20)] });
    expect(after).toMatchObject({ state: "ended", open: false });
  });

  it("a failed payment keeps the company open through the grace, then closes it", () => {
    expect(planStanding({ ...base, subscription: sub("past_due"), planRowExpiries: [at(10)] })).toMatchObject({ state: "grace", open: true, until: at(10) });
    expect(planStanding({ ...base, now: at(11), subscription: sub("past_due"), planRowExpiries: [at(10)] }).open).toBe(false);
  });

  it("a plan with no limit rows (options only, review M1): the subscription's own window decides", () => {
    expect(planStanding({ ...base, subscription: sub("active"), planRowExpiries: [] })).toMatchObject({ state: "active", open: true, until: null });
    expect(planStanding({ ...base, subscription: sub("active", true), planRowExpiries: [] })).toMatchObject({ state: "ending", open: true, until: at(20) });
    expect(planStanding({ ...base, now: at(21), subscription: sub("canceled"), planRowExpiries: [] }).open).toBe(false);
    // A failed payment: the period end plus 14 days of grace.
    expect(planStanding({ ...base, now: at(30), subscription: sub("past_due"), planRowExpiries: [] })).toMatchObject({ state: "grace", open: true });
    expect(planStanding({ ...base, now: at(35), subscription: sub("past_due"), planRowExpiries: [] }).open).toBe(false);
  });

  it("an unfinished checkout (incomplete) doesn't end the trial", () => {
    const s = planStanding({ ...base, subscription: sub("incomplete"), planRowExpiries: [], trialStartedAt: at(-2) });
    expect(s.state).toBe("trial");
    expect(s.open).toBe(true);
  });

  it("an ended plan is never rescued by the trial", () => {
    const s = planStanding({ ...base, subscription: sub("canceled"), planRowExpiries: [at(-1)], trialStartedAt: at(-1) });
    expect(s.state).toBe("ended");
    expect(s.open).toBe(false);
  });
});

describe("what stays open while the plan is closed", () => {
  it("reading, billing, the team and company settings stay; doing work waits", () => {
    for (const p of ["estimator.view", "invoices.view", "schedule.route", "subscriptions.manage", "plans.view", "billing.portal.open", "members.invite", "tenant.edit"]) {
      expect(openWhilePlanClosed(p), p).toBe(true);
    }
    for (const p of ["estimator.estimates.manage", "schedule.manage", "invoices.manage", "invoices.payments.record", "comms.manage", "files.manage", "alerts.manage"]) {
      expect(openWhilePlanClosed(p), p).toBe(false);
    }
  });

  it("says plainly what happened and what to do", () => {
    const ended: PlanStanding = { state: "ended", open: false, until: null, tierKey: "crew" };
    expect(planClosedMessage(ended, "company")).toBe("This company's plan has ended. An owner can choose a plan in Billing to keep using this.");
    expect(planClosedMessage({ ...ended, state: "none" }, "team")).toBe("This team's free trial has ended. An owner can choose a plan in Billing to keep using this.");
  });
});

describe("createPlanGate", () => {
  const closed: PlanStanding = { state: "ended", open: false, until: null, tierKey: "crew" };
  const open: PlanStanding = { state: "active", open: true, until: null, tierKey: "crew" };

  it("refuses work and allows reading for a closed company; allows everything for an open one", async () => {
    const gate = createPlanGate({ standing: async (t) => (t === "a" ? open : closed) });
    expect(await gate.allows("a", "invoices.manage")).toBe(true);
    expect(await gate.allows("b", "invoices.manage")).toBe(false);
    expect(await gate.allows("b", "invoices.view")).toBe(true);
    expect(await gate.isOpen("b")).toBe(false);
  });

  it("reads once per company inside the cache window, again after it", async () => {
    let reads = 0;
    let clock = 0;
    const gate = createPlanGate({ standing: async () => (reads++, open), cacheMs: 1000, now: () => clock });
    await gate.isOpen("a");
    await gate.isOpen("a");
    expect(reads).toBe(1);
    clock = 1001;
    await gate.isOpen("a");
    expect(reads).toBe(2);
  });

  it("a failed read is not cached", async () => {
    let calls = 0;
    const gate = createPlanGate({
      standing: async () => {
        calls++;
        if (calls === 1) throw new Error("db down");
        return open;
      },
      cacheMs: 60_000,
    });
    await expect(gate.isOpen("a")).rejects.toThrow("db down");
    await Promise.resolve();
    expect(await gate.isOpen("a")).toBe(true);
  });

  it("needs a standing reader", () => {
    expect(() => createPlanGate({} as never)).toThrow(/standing/);
  });
});

describe("gating permission sets and loaders", () => {
  const set = (keys: string[]) => ({
    can: (p: string) => keys.includes(p),
    canAll: (ps: readonly string[]) => ps.every((p) => keys.includes(p)),
    canAny: (ps: readonly string[]) => ps.some((p) => keys.includes(p)),
    toArray: () => keys,
  });

  it("a closed company's set keeps only what stays open, never more than was granted", () => {
    const gated = gatePermissionSet(set(["invoices.view", "invoices.manage", "subscriptions.manage"]), false);
    expect(gated.can("invoices.manage")).toBe(false);
    expect(gated.can("invoices.view")).toBe(true);
    expect(gated.can("estimator.view")).toBe(false); // not granted in the first place
    expect(gated.toArray()).toEqual(["invoices.view", "subscriptions.manage"]);
    expect(gated.canAny(["invoices.manage", "invoices.view"])).toBe(true);
    expect(gated.canAll(["invoices.manage", "invoices.view"])).toBe(false);
  });

  it("an open company's set is returned untouched", () => {
    const s = set(["invoices.manage"]);
    expect(gatePermissionSet(s, true)).toBe(s);
  });

  it("wrapped loaders trim tenant sets, keep 'not a member' as null, and leave staff alone", async () => {
    const staff = set(["staff.dashboard.view", "staff.tenants.manage"]);
    const loaders = {
      loadTenantPermissions: async ({ tenantId }: { principal: { userId: string }; tenantId: string }) => (tenantId === "x" ? null : set(["schedule.manage", "schedule.view"])),
      loadStaffPermissions: async () => staff,
    };
    const gated = gatePermissionLoaders(loaders, { isOpen: async (t) => t === "open" });
    expect((await gated.loadTenantPermissions({ principal: { userId: "u" }, tenantId: "open" }))!.can("schedule.manage")).toBe(true);
    const closedSet = await gated.loadTenantPermissions({ principal: { userId: "u" }, tenantId: "closed" });
    expect(closedSet!.can("schedule.manage")).toBe(false);
    expect(closedSet!.can("schedule.view")).toBe(true);
    expect(await gated.loadTenantPermissions({ principal: { userId: "u" }, tenantId: "x" })).toBeNull();
    expect(await gated.loadStaffPermissions()).toBe(staff);
  });
});

describe("loadCompanyPlan (PGlite)", () => {
  async function setup() {
    const pg = new PGlite();
    await pg.exec(`
      create table plans (id text primary key, tenant_id text not null default '*', key text not null, name text not null,
        description text, interval text not null, price_minor bigint, currency text not null default 'usd',
        stripe_product_id text, stripe_price_id text, is_active boolean not null default true, sort_order integer not null default 0,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now());
      create table subscriptions (id text primary key, tenant_id text not null, plan_id text not null references plans(id),
        stripe_subscription_id text, stripe_customer_id text, status text not null, current_period_start timestamptz,
        current_period_end timestamptz, cancel_at_period_end boolean not null default false, canceled_at timestamptz,
        trial_ends_at timestamptz, last_event_at timestamptz, last_event_id text,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now());
      create table entitlements (id text primary key, tenant_id text not null, feature text not null, limit_value integer,
        used_value integer not null default 0, source text not null, source_ref text, expires_at timestamptz,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now());
      insert into plans (id, key, name, interval) values ('p1', 'crew:month:usd', 'Crew', 'month'), ('p2', 'solo:month:usd', 'Solo', 'month');
    `);
    return { pg, db: drizzle(pg) };
  }

  it("company A's paid plan never opens company B, and B's trial is its own", async () => {
    const { pg, db } = await setup();
    await pg.exec(`
      insert into subscriptions (id, tenant_id, plan_id, stripe_subscription_id, stripe_customer_id, status, created_at)
        values ('s1', 'a', 'p1', 'sub_a', 'cus_a', 'active', '2026-10-01');
      insert into entitlements (id, tenant_id, feature, limit_value, used_value, source) values
        ('e1', 'a', 'seats', 5, 2, 'plan'), ('e2', 'a', 'storage_gb', 10, 0, 'plan');
    `);
    const a = await loadCompanyPlan(db, { tenantId: "a", now: NOW, trialStartedAt: at(-60), trialDays: 14 });
    expect(a.standing).toMatchObject({ state: "active", open: true, tierKey: "crew" });
    expect(a.entitlements.get("seats")).toMatchObject({ limit: 5, used: 2, remaining: 3 });

    const b = await loadCompanyPlan(db, { tenantId: "b", now: NOW, trialStartedAt: at(-60), trialDays: 14 });
    expect(b.standing).toMatchObject({ state: "none", open: false });
    expect(b.entitlements.size).toBe(0);
    await pg.close();
  });

  it("the newest subscription decides: a cancelled old plan doesn't close a company that subscribed again", async () => {
    const { pg, db } = await setup();
    await pg.exec(`
      insert into subscriptions (id, tenant_id, plan_id, stripe_subscription_id, stripe_customer_id, status, created_at)
        values ('s1', 'a', 'p2', 'sub_old', 'cus_a', 'canceled', '2026-08-01'),
               ('s2', 'a', 'p1', 'sub_new', 'cus_a', 'active', '2026-10-01');
      insert into entitlements (id, tenant_id, feature, limit_value, source) values ('e1', 'a', 'seats', 5, 'plan');
    `);
    const a = await loadCompanyPlan(db, { tenantId: "a", now: NOW, trialStartedAt: null, trialDays: 0 });
    expect(a.standing).toMatchObject({ state: "active", tierKey: "crew" });
    expect(await liveStripeSubscription(db, "a")).toEqual({ stripeSubscriptionId: "sub_new", stripeCustomerId: "cus_a", planKey: "crew:month:usd", status: "active" });
    await pg.close();
  });

  it("finds the Stripe customer a company paid with before, so a new checkout reuses it", async () => {
    const { pg, db } = await setup();
    await pg.exec(`
      insert into subscriptions (id, tenant_id, plan_id, stripe_subscription_id, stripe_customer_id, status, created_at)
        values ('s1', 'a', 'p1', 'sub_old', 'cus_a', 'canceled', '2026-08-01'),
               ('s2', 'a', 'p1', null, null, 'trialing', '2026-10-01'),
               ('s3', 'b', 'p1', 'sub_b', 'cus_b', 'active', '2026-10-01');
    `);
    expect(await companyStripeCustomer(db, "a")).toBe("cus_a");
    expect(await liveStripeSubscription(db, "a")).toBeNull(); // the live row has no Stripe subscription
    expect(await companyStripeCustomer(db, "c")).toBeNull();
    await pg.close();
  });
});
