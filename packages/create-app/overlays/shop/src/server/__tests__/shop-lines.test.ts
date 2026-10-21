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
 * THE SHOP'S RECURRING PRODUCTS BESIDE PLANS (billing 0.5, a project with a
 * shop): a monthly box bought from the shop never shuts anyone out of a plan,
 * and a member's own box never lands on a company's Stripe customer. The rest
 * of the money rules are src/server/__tests__/product-lines.test.ts.
 *
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
});
