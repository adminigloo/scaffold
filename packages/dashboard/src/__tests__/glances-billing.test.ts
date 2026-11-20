import { afterEach, describe, expect, it } from "vitest";
import * as billing from "@adminigloo/billing/schema";
import * as tenancy from "@adminigloo/tenancy/schema";
import { createPgliteDb } from "../../../testing/src/pglite.js";
import { plansGlance } from "../glances/billing.js";

const NOW = new Date("2026-11-19T18:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY_MS);
const daysFromNow = (d: number) => new Date(NOW.getTime() + d * DAY_MS);

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup() {
  const t = await createPgliteDb({ schema: { ...billing, ...tenancy }, logQueries: false });
  close = () => t.close();
  await t.db.insert(billing.plans).values({ id: "plan-1", key: "pro", name: "Pro", interval: "month", priceMinor: 1000n });
  return t.db;
}

async function tenant(db: Awaited<ReturnType<typeof setup>>, id: string, name: string) {
  await db.insert(tenancy.tenants).values({ id, kind: "org", slug: id, name });
}

describe("plansGlance", () => {
  it("is empty when nobody has a subscription", async () => {
    const db = await setup();
    const glance = await plansGlance({ db, now: NOW });
    expect(glance.tiles?.map((tile) => tile.value)).toEqual([0, 0, 0, 0]);
    expect(glance.list?.rows).toEqual([]);
    expect(glance.status).toEqual({ text: "0 companies on a paid plan.", tone: "neutral" });
  });

  it("counts companies by state (not rows), spots trials ending soon and comped companies, and lists who needs a look", async () => {
    const db = await setup();
    await Promise.all([
      tenant(db, "t1", "T1 Co"),
      tenant(db, "t2", "T2 Co"),
      tenant(db, "t3", "T3 Co"),
      tenant(db, "t4", "T4 Co"),
      tenant(db, "t5", "T5 Co"),
      tenant(db, "t6", "T6 Co"),
      tenant(db, "t7", "T7 Co"),
      tenant(db, "t8", "T8 Co"),
    ]);
    await db.insert(billing.subscriptions).values([
      // t1 pays for two product lines on one company: the "Active" tile must
      // count T1 Co once, not twice, and must still see it as comped (one of
      // its two lines has no Stripe object).
      { tenantId: "t1", planId: "plan-1", line: "default", status: "active", stripeSubscriptionId: "sub_t1_default" },
      { tenantId: "t1", planId: "plan-1", line: "sports", status: "active", stripeSubscriptionId: null },
      { tenantId: "t2", planId: "plan-1", line: "default", status: "active", stripeSubscriptionId: "sub_t2" },
      { tenantId: "t3", planId: "plan-1", line: "default", status: "trialing", trialEndsAt: daysFromNow(3) },
      { tenantId: "t4", planId: "plan-1", line: "default", status: "trialing", trialEndsAt: daysFromNow(20) },
      { tenantId: "t5", planId: "plan-1", line: "default", status: "past_due", currentPeriodEnd: daysAgo(3) },
      { tenantId: "t6", planId: "plan-1", line: "default", status: "unpaid", currentPeriodEnd: daysAgo(2) },
      { tenantId: "t7", planId: "plan-1", line: "default", status: "incomplete", currentPeriodEnd: daysAgo(1) },
      { tenantId: "t8", planId: "plan-1", line: "default", status: "canceled" },
    ]);

    const glance = await plansGlance({ db, now: NOW });
    const [trialing, active, needsPayment, canceled] = glance.tiles ?? [];

    expect(trialing).toMatchObject({ value: 2, hint: "1 trial ends within 7 days." });
    // T1 Co has two "active" rows and must still be counted once.
    expect(active).toMatchObject({ value: 2, tone: "good", hint: "1 is comped, free." });
    expect(needsPayment).toMatchObject({ value: 3, tone: "bad" });
    expect(canceled).toMatchObject({ value: 1 });
    expect(glance.status).toEqual({ text: "3 companies past due or unpaid.", tone: "bad" });
    expect(glance.attention).toBe(3);

    // Past due, unpaid and incomplete first (most overdue first), then
    // trials (soonest-ending first).
    expect(glance.list?.rows.map((r) => r.title)).toEqual(["T5 Co", "T6 Co", "T7 Co", "T3 Co", "T4 Co"]);
    expect(glance.list?.rows[0]).toMatchObject({ badge: "Past due", tone: "bad" });
    expect(glance.list?.rows[1]).toMatchObject({ badge: "Unpaid", tone: "bad" });
    expect(glance.list?.rows[2]).toMatchObject({ badge: "Needs payment", tone: "bad" });
    expect(glance.list?.rows[3]).toMatchObject({ badge: "Trial ending", tone: "warn", meta: "in 3 days" });
  });
});
