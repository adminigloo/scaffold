import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { Principal } from "__SCOPE__/auth";
import { users } from "__SCOPE__/auth/schema";
import { entitlements, plans as planTable, subscriptions } from "__SCOPE__/billing/schema";
import { productGrants, products, productVariants } from "__SCOPE__/catalog/schema";
import { FIRM_WIDE } from "__SCOPE__/permissions";
import { addLineIdempotencyKey, subscriptionSnapshot, type StripeSubscriptionSnapshot } from "__SCOPE__/stripe";
import { tenants } from "__SCOPE__/tenancy/schema";
import { createScaffoldContext } from "__SCOPE__/trpc";
import { db } from "@/db";
import { plans } from "@/plans";
import { seedPermissions } from "@/permissions/seed";
import { appRouter } from "@/server/routers/_app";
import { mirrorStripeSubscription } from "@/server/subscription";
import { tenancy } from "@/server/tenancy";
import { createCallerFactory } from "@/server/trpc";

/**
 * PRODUCT LINES, AND THE MONEY RULES AROUND THEM (billing 0.5) — in every
 * project that takes money, whatever its own src/plans.ts says: this file
 * swaps in a two-line record (Weather Basic/Pro, and Sports) so the stacking
 * is proved everywhere, on the project's own schema and its own routers.
 *
 *   one Stripe subscription, one item per line, one row per line
 *   a line dropped from the subscription ends that line's rows and no other's
 *   a stale event never rolls a line back; a truncated item list closes nothing
 *   adding a line: the server's price, the preview's proration date (stale is
 *     refused before Stripe is touched), the plan's own cadence, one
 *     idempotency key per state, refused when the line is already on it
 *   changing a tier swaps that line's own item; cancelling one of two lines
 *     removes its item with the unused time credited; free months are refused
 *     only on a line already paid by card
 *   never a second subscription: checkout is refused while one is live
 *   (review fixes) a dropped line added back is a NEW add, never a replay of
 *     the first one's stored answer; a line is granted only from a fresh
 *     read; a line on a repriced tier's old Price is never ended while Stripe
 *     bills it; a shop subscription never blocks a plan; a member's own
 *     billing never lands on a company's customer
 *
 * Every rule is shown with its negative control beside it.
 */
vi.mock("@/db", async () => {
  const { createAppPglite } = await import("@/test/pglite");
  return { db: (await createAppPglite()).db };
});

vi.mock("@/plans", async () => {
  const { definePlans } = await import("__SCOPE__/billing");
  return {
    plans: definePlans({
      lines: {
        weather: {
          name: "Weather",
          features: {
            weather_live: { kind: "flag", label: "Live weather" },
            weather_tools: { kind: "flag", label: "Pro tools" },
            alert_rules: { kind: "quota", label: "alert rules" },
          },
          tiers: [
            { key: "weather-basic", name: "Weather Basic", prices: { month: { usd: 500n }, year: { usd: 5000n } }, features: { weather_live: true, weather_tools: false, alert_rules: 0 } },
            { key: "weather-pro", name: "Weather Pro", highlight: true, prices: { month: { usd: 2000n }, year: { usd: 20000n } }, features: { weather_live: true, weather_tools: true, alert_rules: 25 } },
          ],
        },
        sports: {
          name: "Sports",
          features: { sports_live: { kind: "flag", label: "Live sports" } },
          tiers: [{ key: "sports", name: "Sports", prices: { month: { usd: 500n }, year: { usd: 5000n } }, features: { sports_live: true } }],
        },
      },
    }),
    HEADLINE_FEATURES: [],
    DEFAULT_CURRENCY: "usd",
  };
});

// ---------------------------------------------------------------------------
// A recording Stripe: one subscription store, every call kept.
// ---------------------------------------------------------------------------

interface FakeItem {
  id: string;
  price: { id: string; currency: string; recurring: { interval: string }; unit_amount: number; active: boolean; product: string };
  quantity: number;
  current_period_start: number;
  current_period_end: number;
  metadata: Record<string, string>;
}
interface FakeSub {
  id: string;
  object: "subscription";
  customer: string;
  status: string;
  cancel_at_period_end: boolean;
  canceled_at: number | null;
  trial_end: number | null;
  currency: string;
  metadata: Record<string, string>;
  items: { data: FakeItem[]; has_more: boolean };
  pending_update: null | { expires_at: number };
}

const NOW_S = Math.floor(Date.now() / 1000);
const fake = vi.hoisted(() => ({
  calls: [] as { method: string; args: unknown[] }[],
  subs: new Map<string, unknown>(),
  prices: new Map<string, unknown>(),
  itemSeq: 0,
  client: null as unknown,
}));

function priceObject(id: string, amount: number, currency: string, interval: string) {
  return { id, currency, recurring: { interval }, unit_amount: amount, active: true, product: `prod_${id}` };
}

function fakeStripe() {
  const record = (method: string, args: unknown[]) => fake.calls.push({ method, args });
  const stripe = {
    products: {
      update: async (...args: unknown[]) => (record("products.update", args), { id: args[0] as string }),
      create: async (...args: unknown[]) => {
        record("products.create", args);
        const tier = ((args[0] as { metadata: { tierKey: string } }).metadata.tierKey);
        return { id: `prod_${tier}` };
      },
    },
    prices: {
      retrieve: async (...args: unknown[]) => fake.prices.get(args[0] as string) ?? null,
      list: async (...args: unknown[]) => {
        const key = (args[0] as { lookup_keys: string[] }).lookup_keys[0]!;
        const found = [...fake.prices.values()].find((p) => (p as { lookup_key?: string }).lookup_key === key);
        return { data: found ? [found] : [] };
      },
      create: async (...args: unknown[]) => {
        record("prices.create", args);
        const params = args[0] as { product: string; unit_amount: number; currency: string; lookup_key: string; recurring?: { interval: string } };
        const price = { ...priceObject(`price_${params.lookup_key}`, params.unit_amount, params.currency, params.recurring?.interval ?? "month"), product: params.product, lookup_key: params.lookup_key };
        fake.prices.set(price.id, price);
        return price;
      },
    },
    customers: {
      search: async (...args: unknown[]) => (record("customers.search", args), { data: [] }),
      // One customer per tenant: the id names the tenant it was made for (or,
      // for a person's own customer, the person).
      create: async (...args: unknown[]) => {
        record("customers.create", args);
        const metadata = (args[0] as { metadata: { tenantId?: string; appUserId?: string } }).metadata;
        return { id: metadata.tenantId !== undefined ? `cus_${metadata.tenantId}` : `cus_person_${metadata.appUserId}` };
      },
      update: async (...args: unknown[]) => (record("customers.update", args), {}),
    },
    subscriptions: {
      retrieve: async (...args: unknown[]) => (record("subscriptions.retrieve", args), structuredClone(fake.subs.get(args[0] as string))),
      list: async (...args: unknown[]) => {
        record("subscriptions.list", args);
        const customer = (args[0] as { customer?: string }).customer;
        return { data: [...fake.subs.values()].filter((sub) => customer === undefined || (sub as FakeSub).customer === customer) };
      },
      update: async (...args: unknown[]) => {
        record("subscriptions.update", args);
        const sub = fake.subs.get(args[0] as string) as FakeSub;
        const params = args[1] as { items?: { id?: string; price?: string; deleted?: boolean }[]; cancel_at_period_end?: boolean; metadata?: Record<string, string> };
        for (const change of params.items ?? []) {
          if (change.deleted) sub.items.data = sub.items.data.filter((item) => item.id !== change.id);
          else if (change.id) {
            const item = sub.items.data.find((each) => each.id === change.id)!;
            item.price = fake.prices.get(change.price!) as FakeItem["price"];
          } else {
            fake.itemSeq += 1;
            sub.items.data.push({ id: `si_new${fake.itemSeq}`, price: fake.prices.get(change.price!) as FakeItem["price"], quantity: 1, current_period_start: NOW_S - 86400, current_period_end: NOW_S + 29 * 86400, metadata: {} });
          }
        }
        if (params.cancel_at_period_end !== undefined) sub.cancel_at_period_end = params.cancel_at_period_end;
        if (params.metadata) sub.metadata = { ...sub.metadata, ...params.metadata };
        return structuredClone(sub);
      },
    },
    subscriptionItems: { update: async (...args: unknown[]) => (record("subscriptionItems.update", args), {}) },
    invoices: { createPreview: async (...args: unknown[]) => (record("invoices.createPreview", args), { total: 250, currency: "usd" }) },
    checkout: {
      sessions: {
        list: async (...args: unknown[]) => (record("checkout.sessions.list", args), { data: [] }),
        expire: async (...args: unknown[]) => (record("checkout.sessions.expire", args), {}),
        create: async (...args: unknown[]) => (record("checkout.sessions.create", args), { id: "cs_1", url: "https://checkout.stripe.test/cs_1" }),
      },
    },
  };
  return { stripe, appUrl: "https://app.test", apiVersion: "2026-08-26.dahlia" };
}

vi.mock("@/server/stripe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/stripe")>()),
  get stripe() {
    return fake.client;
  },
}));

const createCaller = createCallerFactory(appRouter);

interface Owner {
  readonly principal: Principal;
  readonly tenantId: string;
}

async function owner(externalId: string, email: string): Promise<Owner> {
  const [row] = await db.insert(users).values({ externalId, email, displayName: email }).returning();
  if (!row) throw new Error("could not create the test person");
  await tenancy.provisionUser({ userId: row.id, email });
  let session = await tenancy.resolveSession({ userId: row.id });
  if (session.state !== "ready") {
    // A companies project: the person names their company first.
    await tenancy.createCompany({ userId: row.id, name: `Lines ${externalId}`, requestKey: `lines-${row.id}`.slice(0, 64), purpose: "onboarding" });
    session = await tenancy.resolveSession({ userId: row.id });
  }
  if (session.state !== "ready") throw new Error(`no tenant for ${email}`);
  return { principal: { userId: row.id, externalId: `ext_${row.id}`, email }, tenantId: session.company.id };
}

/** The plans table, as `pnpm db:seed:plans` writes it, with the fake Stripe's price ids cached. */
async function seedPlans(): Promise<void> {
  for (const row of plans.rows) {
    const priceId = `price_${row.key}`;
    fake.prices.set(priceId, { ...priceObject(priceId, Number(row.priceMinor), row.currency, row.interval), product: `prod_${row.tierKey}`, lookup_key: row.key });
    await db.insert(planTable).values({
      key: row.key,
      name: row.name,
      description: row.description,
      interval: row.interval,
      priceMinor: row.priceMinor,
      currency: row.currency,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
      stripeProductId: `prod_${row.tierKey}`,
      stripePriceId: priceId,
    });
  }
}

function item(id: string, rowKey: string): FakeItem {
  return {
    id,
    price: fake.prices.get(`price_${rowKey}`) as FakeItem["price"],
    quantity: 1,
    current_period_start: NOW_S - 86400,
    current_period_end: NOW_S + 29 * 86400,
    metadata: {},
  };
}

/** A Stripe subscription for `tenantId` billing these plan rows, stored in the fake. */
function stripeSubscription(id: string, tenantId: string, rows: readonly [string, string][]): FakeSub {
  const sub: FakeSub = {
    id,
    object: "subscription",
    customer: "cus_lines",
    status: "active",
    cancel_at_period_end: false,
    canceled_at: null,
    trial_end: null,
    currency: "usd",
    metadata: { tenantId, planKey: rows[0]![1].split(":")[0]! },
    items: { data: rows.map(([itemId, rowKey]) => item(itemId, rowKey)), has_more: false },
    pending_update: null,
  };
  fake.subs.set(id, sub);
  return sub;
}

function snapshotOf(sub: FakeSub): StripeSubscriptionSnapshot {
  return subscriptionSnapshot(structuredClone(sub) as never);
}

async function rowsOf(tenantId: string) {
  return db.select().from(subscriptions).where(eq(subscriptions.tenantId, tenantId));
}

async function grantsOf(tenantId: string) {
  return db.select().from(entitlements).where(and(eq(entitlements.tenantId, tenantId), eq(entitlements.source, "plan")));
}

const at = (secondsFromNow: number) => new Date((NOW_S + secondsFromNow) * 1000);

beforeAll(async () => {
  await seedPermissions(db, { log: () => {} });
  await seedPlans();
});

beforeEach(() => {
  fake.client = fakeStripe();
  fake.calls.length = 0;
});

describe("the mirror: one Stripe subscription, one row per product line (billing 0.5)", () => {
  it("two items are two lines on one subscription, each granting its own rows", async () => {
    const o = await owner("ext_lines_mirror", "mirror@lines.test");
    const sub = stripeSubscription("sub_mirror", o.tenantId, [["si_w", "weather-basic:month:usd"], ["si_s", "sports:month:usd"]]);
    const outcome = await mirrorStripeSubscription(snapshotOf(sub), { observedAt: at(0), observedBy: "evt_1" });
    expect(outcome.kind).toBe("mirrored");
    const rows = await rowsOf(o.tenantId);
    expect(rows.map((row) => [row.line, row.stripeSubscriptionId, row.stripeItemId, row.status]).sort()).toEqual([
      ["sports", "sub_mirror", "si_s", "active"],
      ["weather", "sub_mirror", "si_w", "active"],
    ]);
    expect(new Set((await grantsOf(o.tenantId)).map((g) => g.sourceRef))).toEqual(new Set(["weather-basic", "sports"]));
  });

  it("an item that's gone ends ITS line only; a stale event can't bring it back; a truncated list closes nothing", async () => {
    const o = await owner("ext_lines_drop", "drop@lines.test");
    const sub = stripeSubscription("sub_drop", o.tenantId, [["si_w", "weather-basic:month:usd"], ["si_s", "sports:month:usd"]]);
    await mirrorStripeSubscription(snapshotOf(sub), { observedAt: at(0), observedBy: "evt_a" });
    const twoLines = snapshotOf(sub);
    const weatherGrants = (await grantsOf(o.tenantId)).filter((g) => g.sourceRef === "weather-basic");

    // NEGATIVE CONTROL first: the same drop, but Stripe said the list was cut short — nothing is closed.
    sub.items.data = sub.items.data.filter((each) => each.id !== "si_s");
    sub.items.has_more = true;
    await mirrorStripeSubscription(snapshotOf(sub), { observedAt: at(5), observedBy: "evt_b" });
    expect((await rowsOf(o.tenantId)).find((row) => row.line === "sports")?.status).toBe("active");

    // The whole list, without Sports: Sports ends, its rows go; Weather's are the same rows, untouched.
    sub.items.has_more = false;
    await mirrorStripeSubscription(snapshotOf(sub), { observedAt: at(10), observedBy: "evt_c" });
    const rows = await rowsOf(o.tenantId);
    expect(rows.find((row) => row.line === "sports")?.status).toBe("canceled");
    expect(rows.find((row) => row.line === "weather")?.status).toBe("active");
    const after = await grantsOf(o.tenantId);
    expect(after.filter((g) => g.sourceRef === "sports")).toEqual([]);
    expect(after.filter((g) => g.sourceRef === "weather-basic").map((g) => g.id).sort()).toEqual(weatherGrants.map((g) => g.id).sort());

    // An OLDER event (still listing Sports), delivered late: refused per line by the watermark.
    const late = await mirrorStripeSubscription(twoLines, { observedAt: at(1), observedBy: "evt_late" });
    expect(late.kind === "mirrored" && late.lines.every((line) => !line.result.applied)).toBe(true);
    expect((await rowsOf(o.tenantId)).find((row) => row.line === "sports")?.status).toBe("canceled");
  });

  it("two items on ONE line: the first is mirrored, the rest reported — never two live rows for one line", async () => {
    const o = await owner("ext_lines_dup", "dup@lines.test");
    const sub = stripeSubscription("sub_dup", o.tenantId, [["si_1", "weather-basic:month:usd"], ["si_2", "weather-pro:month:usd"]]);
    const outcome = await mirrorStripeSubscription(snapshotOf(sub), { observedAt: at(0), observedBy: "evt_dup" });
    expect(outcome.kind === "mirrored" && outcome.duplicates).toEqual(["si_2"]);
    const live = (await rowsOf(o.tenantId)).filter((row) => row.status !== "canceled");
    expect(live).toHaveLength(1);
  });

  it("a row mirrored before lines existed is re-labelled in place, not duplicated", async () => {
    const o = await owner("ext_lines_legacy", "legacy@lines.test");
    const [plan] = await db.select({ id: planTable.id }).from(planTable).where(eq(planTable.key, "weather-basic:month:usd"));
    await db.insert(subscriptions).values({ tenantId: o.tenantId, planId: plan!.id, line: "main", stripeSubscriptionId: "sub_legacy", stripeCustomerId: "cus_lines", status: "active" });
    const [before] = await rowsOf(o.tenantId);
    const sub = stripeSubscription("sub_legacy", o.tenantId, [["si_legacy", "weather-basic:month:usd"]]);
    await mirrorStripeSubscription(snapshotOf(sub), { observedAt: at(0), observedBy: "evt_legacy" });
    const rows = await rowsOf(o.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: before!.id, line: "weather", stripeItemId: "si_legacy" });
  });

  it("the PRICE decides the plan, never metadata naming another one", async () => {
    const o = await owner("ext_lines_price", "price@lines.test");
    const sub = stripeSubscription("sub_price", o.tenantId, [["si_p", "weather-basic:month:usd"]]);
    sub.items.data[0]!.metadata = { planKey: "weather-pro" };
    sub.metadata.planKey = "weather-pro";
    await mirrorStripeSubscription(snapshotOf(sub), { observedAt: at(0), observedBy: "evt_price" });
    const [row] = await db
      .select({ key: planTable.key })
      .from(subscriptions)
      .innerJoin(planTable, eq(planTable.id, subscriptions.planId))
      .where(eq(subscriptions.tenantId, o.tenantId));
    expect(row?.key).toBe("weather-basic:month:usd");
  });
});

describe("the money paths, through the routers (billing 0.5)", () => {
  let o: Owner;
  let caller: ReturnType<typeof createCaller>;

  beforeAll(async () => {
    o = await owner("ext_lines_money", "money@lines.test");
    fake.client = fakeStripe();
    const sub = stripeSubscription("sub_money", o.tenantId, [["si_w", "weather-basic:month:usd"]]);
    await mirrorStripeSubscription(snapshotOf(sub), { observedAt: at(0), observedBy: "evt_money" });
    caller = createCaller(createScaffoldContext({ principal: o.principal }));
  });

  it("never a second subscription: checkout is refused while one is live, and nothing is opened at Stripe", async () => {
    await expect(caller.billing.subscribeToPlan({ tenantId: o.tenantId, tierKey: "sports", interval: "month", currency: "usd" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(fake.calls.some((c) => c.method === "checkout.sessions.create")).toBe(false);
  });

  it("NEGATIVE CONTROL: with nothing live, checkout opens — one line item, the server's price, the tenant's one customer", async () => {
    const fresh = await owner("ext_lines_fresh", "fresh@lines.test");
    const freshCaller = createCaller(createScaffoldContext({ principal: fresh.principal }));
    const out = await freshCaller.billing.subscribeToPlan({ tenantId: fresh.tenantId, tierKey: "sports", interval: "month", currency: "usd" });
    expect(out.url).toContain("checkout.stripe.test");
    const params = fake.calls.find((c) => c.method === "checkout.sessions.create")!.args[0] as {
      line_items: unknown[];
      customer: string;
      subscription_data: { metadata: Record<string, string> };
    };
    expect(params.line_items).toEqual([{ price: "price_sports:month:usd", quantity: 1 }]);
    expect(params.customer).toBe(`cus_${fresh.tenantId}`);
    expect(params.subscription_data.metadata).toMatchObject({ tenantId: fresh.tenantId, planKey: "sports", planLine: "sports" });
  });

  it("adding a line: priced by the server, previewed, then added as ONE item on the same subscription", async () => {
    // Refused first, before any Stripe write: another cadence than the plan's
    // (one subscription bills on one), and a preview older than half an hour.
    fake.calls.length = 0;
    await expect(
      caller.billing.previewAddLine({ tenantId: o.tenantId, tierKey: "sports", interval: "year", currency: "usd" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(
      caller.billing.addLine({ tenantId: o.tenantId, tierKey: "sports", interval: "month", currency: "usd", prorationDate: NOW_S - 31 * 60 }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(fake.calls.some((c) => c.method === "subscriptions.update")).toBe(false);

    fake.calls.length = 0;
    const preview = await caller.billing.previewAddLine({ tenantId: o.tenantId, tierKey: "sports", interval: "month", currency: "usd" });
    expect(preview).toMatchObject({ samePrice: false, today: "charge" });
    const previewCall = fake.calls.find((c) => c.method === "invoices.createPreview")!.args[0] as { subscription: string; subscription_details: { items: unknown[] } };
    expect(previewCall.subscription).toBe("sub_money");
    expect(previewCall.subscription_details.items).toEqual([{ price: "price_sports:month:usd", quantity: 1 }]);

    fake.calls.length = 0;
    const added = await caller.billing.addLine({ tenantId: o.tenantId, tierKey: "sports", interval: "month", currency: "usd", prorationDate: preview.prorationDate });
    expect(added.applied).toBe(true);
    const update = fake.calls.find((c) => c.method === "subscriptions.update")!;
    expect(update.args[0]).toBe("sub_money");
    expect(update.args[1]).toMatchObject({ items: [{ price: "price_sports:month:usd", quantity: 1 }], payment_behavior: "pending_if_incomplete", proration_date: preview.prorationDate });
    expect(update.args[2]).toEqual({ idempotencyKey: addLineIdempotencyKey({ id: "sub_money", items: { data: [{ id: "si_w" }] } }, "sports") });
    expect(fake.calls.some((c) => c.method === "checkout.sessions.create" || c.method === "subscriptions.create")).toBe(false);
    // Mirrored at once: two lines, one subscription.
    const live = (await rowsOf(o.tenantId)).filter((row) => row.status !== "canceled");
    expect(live.map((row) => row.line).sort()).toEqual(["sports", "weather"]);
    expect(new Set(live.map((row) => row.stripeSubscriptionId))).toEqual(new Set(["sub_money"]));
  });

  it("refuses to add a line that's already on the plan (here, or at Stripe a second ago) — before any Stripe write", async () => {
    fake.calls.length = 0;
    await expect(
      caller.billing.addLine({ tenantId: o.tenantId, tierKey: "sports", interval: "month", currency: "usd", prorationDate: NOW_S }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // Our rows a step behind (the webhook not in yet): Stripe's own items still refuse it.
    await db.update(subscriptions).set({ status: "canceled" }).where(and(eq(subscriptions.tenantId, o.tenantId), eq(subscriptions.line, "sports")));
    await expect(
      caller.billing.addLine({ tenantId: o.tenantId, tierKey: "sports", interval: "month", currency: "usd", prorationDate: NOW_S }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await db.update(subscriptions).set({ status: "active" }).where(and(eq(subscriptions.tenantId, o.tenantId), eq(subscriptions.line, "sports")));
    expect(fake.calls.some((c) => c.method === "subscriptions.update")).toBe(false);
  });

  it("changing Weather's tier swaps Weather's own item, never Sports'", async () => {
    const preview = await caller.billing.previewPlanChange({ tenantId: o.tenantId, tierKey: "weather-pro", interval: "month", currency: "usd" });
    fake.calls.length = 0;
    await caller.billing.changePlan({ tenantId: o.tenantId, tierKey: "weather-pro", interval: "month", currency: "usd", prorationDate: preview.prorationDate });
    const update = fake.calls.find((c) => c.method === "subscriptions.update")!;
    expect((update.args[1] as { items: unknown[] }).items).toEqual([{ id: "si_w", price: "price_weather-pro:month:usd" }]);
    // A stale proration date never reaches Stripe.
    fake.calls.length = 0;
    await expect(
      caller.billing.changePlan({ tenantId: o.tenantId, tierKey: "weather-basic", interval: "month", currency: "usd", prorationDate: NOW_S - 31 * 60 }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(fake.calls.some((c) => c.method === "subscriptions.update")).toBe(false);
  });

  it("free months: refused on a line already paid by card, given on a line that isn't — and marked as free months", async () => {
    const staff = await owner("ext_lines_staff", "staff@lines.test");
    await db.execute(sql`insert into principal_role (principal_id, scope, tenant_id, template_id)
      select ${staff.principal.userId}, 'staff', '*', id from role_template where scope = 'staff' and key = 'admin' and tenant_id = '*'
      on conflict do nothing`);
    const staffCaller = createCaller(createScaffoldContext({ principal: staff.principal }));
    const other = await owner("ext_lines_comp", "comp@lines.test");
    const sub = stripeSubscription("sub_comp", other.tenantId, [["si_cw", "weather-basic:month:usd"]]);
    await mirrorStripeSubscription(snapshotOf(sub), { observedAt: at(0), observedBy: "evt_comp" });
    await expect(staffCaller.billing.compPlan({ tenantId: other.tenantId, tierKey: "weather-pro", months: 2 })).rejects.toMatchObject({ code: "CONFLICT" });
    await staffCaller.billing.compPlan({ tenantId: other.tenantId, tierKey: "sports", months: 2 });
    const rows = await rowsOf(other.tenantId);
    const sports = rows.find((row) => row.line === "sports")!;
    expect(sports).toMatchObject({ stripeSubscriptionId: null, status: "active", cancelAtPeriodEnd: true });
    expect(sports.lastEventId).toMatch(/^comp:/);
    // The paid Weather line is exactly as it was.
    expect(rows.find((row) => row.line === "weather")).toMatchObject({ stripeSubscriptionId: "sub_comp", status: "active" });
  });

  it("cancelling one of two lines removes its item now (credited) and leaves the other renewing", async () => {
    fake.calls.length = 0;
    await caller.account.cancelSubscription({ tenantId: o.tenantId, line: "sports" });
    const update = fake.calls.find((c) => c.method === "subscriptions.update")!;
    const sportsItem = (await rowsOf(o.tenantId)).find((row) => row.line === "sports")!.stripeItemId;
    // Invoiced AT ONCE (review): the credit goes on the customer's balance now, so it isn't
    // stranded as pending items if the last line is later cancelled and no bill comes.
    expect(update.args[1]).toEqual({ items: [{ id: sportsItem, deleted: true }], proration_behavior: "always_invoice" });
    const rows = await rowsOf(o.tenantId);
    expect(rows.find((row) => row.line === "sports")?.status).toBe("canceled");
    expect(rows.find((row) => row.line === "weather")).toMatchObject({ status: "active", cancelAtPeriodEnd: false });
    expect((await grantsOf(o.tenantId)).some((g) => g.sourceRef === "sports")).toBe(false);
    // The LAST line is a cancellation at the period's end, never a removal today.
    fake.calls.length = 0;
    await caller.account.cancelSubscription({ tenantId: o.tenantId, line: "weather" });
    const last = fake.calls.find((c) => c.method === "subscriptions.update")!;
    expect(last.args[1]).toEqual({ cancel_at_period_end: true });
    expect((await rowsOf(o.tenantId)).find((row) => row.line === "weather")).toMatchObject({ status: "active", cancelAtPeriodEnd: true });
  });
});

// ---------------------------------------------------------------------------
// The review's attacks on billing 0.5 / stripe 0.6, each fixed, each with its
// negative control. Stripe's idempotency is kept faithfully here: the same key
// with the same parameters REPLAYS the first answer and runs nothing; the same
// key with different parameters is an idempotency_error.
// ---------------------------------------------------------------------------

const idem = new Map<string, { params: string; response: unknown }>();
const requested: { method: string; key: string | undefined; replayed: boolean }[] = [];

function stripeWithIdempotency() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = fakeStripe() as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrap = (method: string, fn: (...args: any[]) => Promise<unknown>) => async (...args: unknown[]) => {
    const last = args[args.length - 1] as { idempotencyKey?: string } | undefined;
    const key = args.length >= 2 && last && typeof last === "object" ? last.idempotencyKey : undefined;
    if (!key) {
      requested.push({ method, key, replayed: false });
      return fn(...args);
    }
    const params = JSON.stringify(args.slice(0, -1), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    const hit = idem.get(key);
    if (hit) {
      if (hit.params !== params) {
        throw Object.assign(new Error("Keys for idempotent requests can only be used with the same parameters they were first used with."), { type: "idempotency_error" });
      }
      requested.push({ method, key, replayed: true });
      return structuredClone(hit.response);
    }
    requested.push({ method, key, replayed: false });
    const response = await fn(...args);
    idem.set(key, { params, response: structuredClone(response) });
    return response;
  };
  const s = client.stripe;
  s.subscriptions.update = wrap("subscriptions.update", s.subscriptions.update);
  s.subscriptionItems.update = wrap("subscriptionItems.update", s.subscriptionItems.update);
  s.customers.create = wrap("customers.create", s.customers.create);
  // The shop's recurring checkout makes its own subscription.
  s.subscriptions.create = wrap("subscriptions.create", async (...args: unknown[]) => {
    fake.calls.push({ method: "subscriptions.create", args });
    const params = args[0] as { customer: string; items: { price: string; quantity: number }[]; metadata: Record<string, string> };
    const id = `sub_shop_${fake.subs.size + 1}`;
    const sub = {
      id,
      object: "subscription",
      customer: params.customer,
      status: "incomplete",
      cancel_at_period_end: false,
      canceled_at: null,
      trial_end: null,
      currency: "usd",
      metadata: params.metadata,
      items: { data: params.items.map((each, i) => ({ id: `si_shop_${id}_${i}`, price: { ...priceObject(each.price, 900, "usd", "month") }, quantity: each.quantity, current_period_start: NOW_S, current_period_end: NOW_S + 30 * 86400, metadata: {} })), has_more: false },
      pending_update: null,
    };
    fake.subs.set(id, sub);
    return { ...structuredClone(sub), latest_invoice: { id: `in_${id}`, confirmation_secret: { client_secret: "seti_secret" }, payments: { data: [{ payment: { payment_intent: `pi_${id}` } }] } } };
  });
  s.paymentIntents = { update: async (...args: unknown[]) => (fake.calls.push({ method: "paymentIntents.update", args }), {}) };
  return client;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const itemIdsOf = (subId: string) => (fake.subs.get(subId) as FakeSub).items.data.map((each) => each.id);
const sportsRow = async (tenantId: string) => (await rowsOf(tenantId)).find((row) => row.line === "sports");
const holdsSports = async (tenantId: string) => (await grantsOf(tenantId)).some((g) => g.sourceRef === "sports");

/** Is this tenant the person's own personal workspace (consumers, and one-business projects), or a company? */
async function ownWorkspace(o: Owner): Promise<boolean> {
  const [row] = await db.select({ kind: tenants.kind, owner: tenants.ownerUserId }).from(tenants).where(eq(tenants.id, o.tenantId));
  return row?.kind === "personal" && row.owner === o.principal.userId;
}

/** A shop product sold monthly, as the catalog admin would make it. */
async function monthlyBox(slug: string): Promise<string> {
  const [product] = await db.insert(products).values({ tenantId: FIRM_WIDE, slug, name: "Monthly box", kind: "subscription", status: "active" }).returning({ id: products.id });
  const [variant] = await db
    .insert(productVariants)
    .values({ productId: product!.id, name: "Monthly", priceMinor: 900n, currency: "usd", interval: "month", stripePriceId: `price_${slug}` })
    .returning({ id: productVariants.id });
  await db.insert(productGrants).values({ variantId: variant!.id, kind: "entitlement", config: { feature: "box_access", limit: 1 } });
  return variant!.id;
}

describe("REVIEW FIX: adding a dropped line back is a new add — never the first add's replayed answer", () => {
  it("add, drop, re-add WITH THE FIRST PREVIEW'S DATE: Stripe really adds (and charges) the item, and only then is Sports granted", async () => {
    const o = await owner("ext_fix_replay", "replay@fix.test");
    fake.client = stripeWithIdempotency();
    const sub = stripeSubscription("sub_fix_replay", o.tenantId, [["si_rw", "weather-basic:month:usd"]]);
    await mirrorStripeSubscription(snapshotOf(sub), { observedAt: at(-60), observedBy: "evt_fr0" });
    const caller = createCaller(createScaffoldContext({ principal: o.principal }));

    const preview = await caller.billing.previewAddLine({ tenantId: o.tenantId, tierKey: "sports", interval: "month", currency: "usd" });
    expect((await caller.billing.addLine({ tenantId: o.tenantId, tierKey: "sports", interval: "month", currency: "usd", prorationDate: preview.prorationDate })).applied).toBe(true);
    const firstItem = (await sportsRow(o.tenantId))!.stripeItemId;
    await pause(5);
    await caller.account.cancelSubscription({ tenantId: o.tenantId, line: "sports" });
    expect(itemIdsOf("sub_fix_replay")).toEqual(["si_rw"]);
    expect(await holdsSports(o.tenantId)).toBe(false);

    const executed = () => requested.filter((r) => r.method === "subscriptions.update" && !r.replayed).length;
    const executedBefore = executed();
    await pause(5);
    // The same request the first add made — same proration date — sent again.
    const again = await caller.billing.addLine({ tenantId: o.tenantId, tierKey: "sports", interval: "month", currency: "usd", prorationDate: preview.prorationDate });
    expect(again.applied).toBe(true);
    // Stripe RAN it (a new key), so it added and charged a new item...
    expect(executed()).toBe(executedBefore + 1);
    expect(requested.some((r) => r.method === "subscriptions.update" && r.replayed)).toBe(false);
    expect(itemIdsOf("sub_fix_replay")).toHaveLength(2);
    // ...and the line our tables hold is exactly the item Stripe now bills.
    const sports = await sportsRow(o.tenantId);
    expect(sports?.status).toBe("active");
    expect(sports?.stripeItemId).not.toBe(firstItem);
    expect(itemIdsOf("sub_fix_replay")).toContain(sports?.stripeItemId);
    expect(await holdsSports(o.tenantId)).toBe(true);
  });

  it("add, drop, re-add with a FRESH preview: added, not refused as 'changed from another window'", async () => {
    const o = await owner("ext_fix_readd", "readd@fix.test");
    fake.client = stripeWithIdempotency();
    const sub = stripeSubscription("sub_fix_readd", o.tenantId, [["si_aw", "weather-basic:month:usd"]]);
    await mirrorStripeSubscription(snapshotOf(sub), { observedAt: at(-60), observedBy: "evt_fa0" });
    const caller = createCaller(createScaffoldContext({ principal: o.principal }));
    const p1 = await caller.billing.previewAddLine({ tenantId: o.tenantId, tierKey: "sports", interval: "month", currency: "usd" });
    await caller.billing.addLine({ tenantId: o.tenantId, tierKey: "sports", interval: "month", currency: "usd", prorationDate: p1.prorationDate });
    await pause(5);
    await caller.account.cancelSubscription({ tenantId: o.tenantId, line: "sports" });
    await pause(1100);
    const p2 = await caller.billing.previewAddLine({ tenantId: o.tenantId, tierKey: "sports", interval: "month", currency: "usd" });
    expect(p2.prorationDate).not.toBe(p1.prorationDate);
    const out = await caller.billing.addLine({ tenantId: o.tenantId, tierKey: "sports", interval: "month", currency: "usd", prorationDate: p2.prorationDate });
    expect(out.applied).toBe(true);
    expect(itemIdsOf("sub_fix_readd")).toHaveLength(2);
    expect((await sportsRow(o.tenantId))?.status).toBe("active");

    // NEGATIVE CONTROL: two tabs adding from the SAME state still share one key — the
    // second is refused (Stripe holds Sports now), and Stripe still bills ONE Sports item.
    await expect(
      caller.billing.addLine({ tenantId: o.tenantId, tierKey: "sports", interval: "month", currency: "usd", prorationDate: p2.prorationDate }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((fake.subs.get("sub_fix_readd") as FakeSub).items.data.filter((each) => each.price.product === "prod_sports")).toHaveLength(1);
  });

  it("an update answered from a stale stored response (an item that isn't there) grants NOTHING: the mirror reads Stripe again", async () => {
    const o = await owner("ext_fix_stale", "stale@fix.test");
    fake.client = fakeStripe();
    const sub = stripeSubscription("sub_fix_stale", o.tenantId, [["si_sw", "weather-basic:month:usd"]]);
    await mirrorStripeSubscription(snapshotOf(sub), { observedAt: at(-60), observedBy: "evt_fs0" });
    const caller = createCaller(createScaffoldContext({ principal: o.principal }));
    const preview = await caller.billing.previewAddLine({ tenantId: o.tenantId, tierKey: "sports", interval: "month", currency: "usd" });
    // Stripe answers the add with a stored response naming a Sports item, and adds nothing.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fake.client as any).stripe.subscriptions.update = async (...args: unknown[]) => {
      fake.calls.push({ method: "subscriptions.update", args });
      const ghost = structuredClone(fake.subs.get("sub_fix_stale") as FakeSub);
      ghost.items.data.push(item("si_ghost", "sports:month:usd"));
      return ghost;
    };
    await expect(
      caller.billing.addLine({ tenantId: o.tenantId, tierKey: "sports", interval: "month", currency: "usd", prorationDate: preview.prorationDate }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/Nothing was added or charged/) });
    expect(await sportsRow(o.tenantId)).toBeUndefined();
    expect(await holdsSports(o.tenantId)).toBe(false);
    expect(fake.calls.some((c) => c.method === "subscriptionItems.update")).toBe(false);
  });
});

describe("REVIEW FIX: a paid line on a repriced tier's OLD Price is never ended while Stripe bills it", () => {
  it("through addLine: Weather on the old Price stays live with its grants when Sports is added; 'Add Weather' is refused, here and at Stripe", async () => {
    const o = await owner("ext_fix_reprice", "reprice@fix.test");
    fake.client = stripeWithIdempotency();
    // What Weather Basic was sold at before the founder repriced it: a Price made by hand
    // (no stamp of ours), no longer the cached one, still billing the people on it.
    fake.prices.set("price_wb_hand", { ...priceObject("price_wb_hand", 400, "usd", "month"), product: "prod_weather-basic" });
    const sub = stripeSubscription("sub_fix_reprice", o.tenantId, [["si_old", "weather-basic:month:usd"]]);
    sub.items.data[0]!.price = fake.prices.get("price_wb_hand") as FakeItem["price"];
    sub.metadata.planKey = "weather-basic";
    await mirrorStripeSubscription(snapshotOf(sub), { observedAt: at(-60), observedBy: "evt_rp0" });
    expect((await rowsOf(o.tenantId)).find((row) => row.line === "weather")).toMatchObject({ status: "active", stripeItemId: "si_old" });

    const caller = createCaller(createScaffoldContext({ principal: o.principal }));
    const preview = await caller.billing.previewAddLine({ tenantId: o.tenantId, tierKey: "sports", interval: "month", currency: "usd" });
    expect((await caller.billing.addLine({ tenantId: o.tenantId, tierKey: "sports", interval: "month", currency: "usd", prorationDate: preview.prorationDate })).applied).toBe(true);
    expect(itemIdsOf("sub_fix_reprice")).toContain("si_old");
    // Weather is still live, on the same item, with its grants: our own row names si_old.
    expect((await rowsOf(o.tenantId)).find((row) => row.line === "weather")).toMatchObject({ status: "active", stripeItemId: "si_old" });
    expect((await grantsOf(o.tenantId)).some((g) => g.sourceRef === "weather-basic")).toBe(true);
    expect(await holdsSports(o.tenantId)).toBe(true);

    // "Add Weather" is refused, by our rows...
    await expect(
      caller.billing.previewAddLine({ tenantId: o.tenantId, tierKey: "weather-basic", interval: "month", currency: "usd" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // ...and by Stripe's own items, read the way the mirror reads them, when our rows are a step behind.
    await db.update(subscriptions).set({ status: "canceled" }).where(and(eq(subscriptions.tenantId, o.tenantId), eq(subscriptions.line, "weather")));
    await expect(
      caller.billing.addLine({ tenantId: o.tenantId, tierKey: "weather-basic", interval: "month", currency: "usd", prorationDate: NOW_S }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await db.update(subscriptions).set({ status: "active" }).where(and(eq(subscriptions.tenantId, o.tenantId), eq(subscriptions.line, "weather")));
    const weatherItems = (fake.subs.get("sub_fix_reprice") as FakeSub).items.data.filter((each) => each.price.product === "prod_weather-basic");
    expect(weatherItems.map((each) => each.id)).toEqual(["si_old"]);
  });

  it("through the webhook and the staff resync: the next event or a repair never closes it either", async () => {
    const o = await owner("ext_fix_repwh", "repwh@fix.test");
    fake.client = fakeStripe();
    fake.prices.set("price_wb_hand2", { ...priceObject("price_wb_hand2", 400, "usd", "month"), product: "prod_weather-basic" });
    const sub = stripeSubscription("sub_fix_repwh", o.tenantId, [["si_old2", "weather-basic:month:usd"]]);
    sub.items.data[0]!.price = fake.prices.get("price_wb_hand2") as FakeItem["price"];
    sub.metadata.planKey = "weather-basic";
    await mirrorStripeSubscription(snapshotOf(sub), { observedAt: at(-120), observedBy: "evt_rw0" });
    // Sports is added (in the dashboard, say): the renewal-style event lists both items.
    sub.items.data.push(item("si_s2", "sports:month:usd"));
    const event = await mirrorStripeSubscription(snapshotOf(sub), { observedAt: at(-60), observedBy: "evt_rw1" });
    expect(event.kind === "mirrored" && event.closed).toEqual([]);
    expect((await rowsOf(o.tenantId)).find((row) => row.line === "weather")).toMatchObject({ status: "active", stripeItemId: "si_old2" });

    const staff = await owner("ext_fix_repwh_staff", "repwh-staff@fix.test");
    await db.execute(sql`insert into principal_role (principal_id, scope, tenant_id, template_id)
      select ${staff.principal.userId}, 'staff', '*', id from role_template where scope = 'staff' and key = 'admin' and tenant_id = '*'
      on conflict do nothing`);
    // Resync reads every subscription Stripe holds: just this one, here.
    const saved = new Map(fake.subs);
    fake.subs.clear();
    fake.subs.set("sub_fix_repwh", sub);
    try {
      const out = await createCaller(createScaffoldContext({ principal: staff.principal })).billing.resync({ limit: 50 });
      expect(out.status).toBe("ok");
    } finally {
      for (const [id, each] of saved) fake.subs.set(id, each);
    }
    const rows = await rowsOf(o.tenantId);
    expect(rows.find((row) => row.line === "weather")).toMatchObject({ status: "active", stripeItemId: "si_old2" });
    expect(rows.find((row) => row.line === "sports")?.status).toBe("active");
    expect((await grantsOf(o.tenantId)).some((g) => g.sourceRef === "weather-basic")).toBe(true);

    // NEGATIVE CONTROL: when Weather's item really is gone, the same event ends Weather.
    sub.items.data = sub.items.data.filter((each) => each.id !== "si_old2");
    await mirrorStripeSubscription(snapshotOf(sub), { observedAt: new Date(Date.now() + 1000), observedBy: "evt_rw2" });
    expect((await rowsOf(o.tenantId)).find((row) => row.line === "weather")?.status).toBe("canceled");
  });

  it("a Price we published before a repricing names its plan in its own metadata: read even with no row of ours yet", async () => {
    const o = await owner("ext_fix_stamp", "stamp@fix.test");
    // ensurePlanPrice stamps every Price it makes with { planKey, tierKey }.
    fake.prices.set("price_wb_v1", { ...priceObject("price_wb_v1", 400, "usd", "month"), product: "prod_weather-basic", metadata: { planKey: "weather-basic:month:usd", tierKey: "weather-basic" } });
    fake.prices.set("price_wb_bare", { ...priceObject("price_wb_bare", 400, "usd", "month"), product: "prod_weather-basic" });
    const sub = stripeSubscription("sub_fix_stamp", o.tenantId, [["si_v1", "weather-basic:month:usd"], ["si_sp", "sports:month:usd"]]);
    sub.items.data[0]!.price = fake.prices.get("price_wb_v1") as FakeItem["price"];
    await mirrorStripeSubscription(snapshotOf(sub), { observedAt: at(0), observedBy: "evt_st0" });
    expect((await rowsOf(o.tenantId)).find((row) => row.line === "weather")).toMatchObject({ status: "active", stripeItemId: "si_v1" });

    // NEGATIVE CONTROL: a Price with no stamp, on an item no row of ours names, is not guessed at.
    const p = await owner("ext_fix_bare", "bare@fix.test");
    const bare = stripeSubscription("sub_fix_bare", p.tenantId, [["si_bare", "weather-basic:month:usd"], ["si_sp2", "sports:month:usd"]]);
    bare.items.data[0]!.price = fake.prices.get("price_wb_bare") as FakeItem["price"];
    const outcome = await mirrorStripeSubscription(snapshotOf(bare), { observedAt: at(0), observedBy: "evt_st1" });
    expect(outcome.kind === "mirrored" && outcome.skipped.map((each) => each.itemId)).toEqual(["si_bare"]);
    expect((await rowsOf(p.tenantId)).find((row) => row.line === "weather")).toBeUndefined();
  });
});

describe("REVIEW FIX: a shop subscription never shuts anyone out of a plan", () => {
  it("someone with a monthly box from the shop can still subscribe to a plan; a live PLAN at Stripe still refuses (never two)", async () => {
    const p = await owner("ext_fix_shop", "shop@fix.test");
    fake.client = stripeWithIdempotency();
    const variantId = await monthlyBox("fix-shop-box");
    const caller = createCaller(createScaffoldContext({ principal: p.principal }));
    expect((await caller.checkout.createIntent({ variantId, quantity: 1 })).status).toBe("requires_payment");
    const created = fake.calls.find((c) => c.method === "subscriptions.create")!.args[0] as { customer: string };
    // In a person's own workspace the box is on the workspace's one customer, the one plans use;
    // anywhere else, on the person's own.
    expect(created.customer).toBe((await ownWorkspace(p)) ? `cus_${p.tenantId}` : `cus_person_${p.principal.userId}`);
    for (const each of fake.subs.values()) if ((each as FakeSub).customer === created.customer) (each as FakeSub).status = "active";

    const out = await caller.billing.subscribeToPlan({ tenantId: p.tenantId, tierKey: "weather-basic", interval: "month", currency: "usd" });
    expect(out.url).toContain("checkout.stripe.test");
    const session = fake.calls.find((c) => c.method === "checkout.sessions.create")!.args[0] as { customer: string };
    expect(session.customer).toBe(`cus_${p.tenantId}`);

    // NEGATIVE CONTROL: a live plan subscription on that customer at Stripe (paid, webhook not in yet) still refuses.
    stripeSubscription("sub_fix_shop_plan", p.tenantId, [["si_fsp", "weather-basic:month:usd"]]).customer = `cus_${p.tenantId}`;
    fake.calls.length = 0;
    await expect(
      caller.billing.subscribeToPlan({ tenantId: p.tenantId, tierKey: "weather-basic", interval: "month", currency: "usd" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fake.calls.some((c) => c.method === "checkout.sessions.create")).toBe(false);
  });
});

describe("REVIEW FIX: a company's Stripe customer is the company's, never a member's own", () => {
  it("(companies) a member's own monthly box goes on the member's customer, and the owner can subscribe the company", async (ctx) => {
    const o = await owner("ext_fix_co_owner", "owner@fixco.test");
    if (await ownWorkspace(o)) ctx.skip(); // a personal workspace has no other members to buy for themselves
    const [mrow] = await db.insert(users).values({ externalId: "ext_fix_co_member", email: "member@fixco.test", displayName: "Member" }).returning();
    await tenancy.provisionUser({ userId: mrow!.id, email: "member@fixco.test" });
    const invite = await tenancy.sendInvitation({ actorUserId: o.principal.userId, tenantId: o.tenantId, email: "member@fixco.test", roleKey: "member" });
    expect((await tenancy.acceptInvitation({ token: invite.token, userId: mrow!.id })).status).toBe("accepted");
    const member = { userId: mrow!.id, externalId: "ext_fix_co_member", email: "member@fixco.test" };

    fake.client = stripeWithIdempotency();
    const variantId = await monthlyBox("fix-co-box");
    await createCaller(createScaffoldContext({ principal: member })).checkout.createIntent({ variantId, quantity: 1 });
    const created = fake.calls.find((c) => c.method === "subscriptions.create")!.args[0] as { customer: string };
    expect(created.customer).toBe(`cus_person_${member.userId}`);
    expect(created.customer).not.toBe(`cus_${o.tenantId}`);
    for (const each of fake.subs.values()) if ((each as FakeSub).customer === created.customer) (each as FakeSub).status = "active";

    const out = await createCaller(createScaffoldContext({ principal: o.principal })).billing.subscribeToPlan({ tenantId: o.tenantId, tierKey: "weather-basic", interval: "month", currency: "usd" });
    expect(out.url).toContain("checkout.stripe.test");
    expect((fake.calls.find((c) => c.method === "checkout.sessions.create")!.args[0] as { customer: string }).customer).toBe(`cus_${o.tenantId}`);
  });

  it("a person's own pre-0.6 shop customer is adopted only for their OWN workspace — never as a company's", async () => {
    const o = await owner("ext_fix_adopt", "adopt@fix.test");
    const own = await ownWorkspace(o);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = fakeStripe() as any;
    client.stripe.customers.search = async (...args: unknown[]) => {
      fake.calls.push({ method: "customers.search", args });
      const query = (args[0] as { query: string }).query;
      return { data: query.includes("appUserId") ? [{ id: "cus_shop_of_person", metadata: { appUserId: o.principal.userId } }] : [] };
    };
    fake.client = client;
    fake.calls.length = 0;
    await createCaller(createScaffoldContext({ principal: o.principal })).billing.subscribeToPlan({ tenantId: o.tenantId, tierKey: "weather-basic", interval: "month", currency: "usd" });
    const session = fake.calls.find((c) => c.method === "checkout.sessions.create")!.args[0] as { customer: string };
    if (own) {
      // NEGATIVE CONTROL (a person's own workspace): their shop customer is theirs, and is adopted.
      expect(session.customer).toBe("cus_shop_of_person");
      expect(fake.calls.find((c) => c.method === "customers.update")!.args).toEqual(["cus_shop_of_person", { metadata: { tenantId: o.tenantId } }]);
    } else {
      // A company: never the person's customer, never stamped, and the company's own names only the company.
      expect(session.customer).toBe(`cus_${o.tenantId}`);
      expect(fake.calls.some((c) => c.method === "customers.update")).toBe(false);
      expect((fake.calls.find((c) => c.method === "customers.create")!.args[0] as { metadata: Record<string, string> }).metadata).toEqual({ tenantId: o.tenantId });
    }
  });
});
