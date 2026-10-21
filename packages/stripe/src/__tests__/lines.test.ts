import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import type { StripeClient } from "../client.js";
import {
  addLine,
  addLineIdempotencyKey,
  changePlan,
  isPlanSubscriptionFor,
  PlanChangeError,
  prepareCompanyCheckout,
  previewAddLine,
  previewPlanChange,
  removeLine,
  resolveStripeCustomer,
} from "../plan-change.js";
import { subscriptionSnapshot } from "../subscription.js";

const NOW_S = Math.floor(Date.now() / 1000);

/**
 * PRODUCT LINES (stripe 0.6): Weather and Sports as two ITEMS of one
 * subscription. A recording fake: what is proved is the shape of the Stripe
 * calls — the line's own item swapped, an item added (never a second
 * subscription or checkout), an item removed with the unused time credited —
 * because those shapes are what a double charge or a lost line is made of.
 */
function twoLineStripe(
  opts: { pending?: boolean; items?: { id: string; price: string }[]; status?: Stripe.Subscription.Status; replay?: unknown } = {},
) {
  const calls: { method: string; args: unknown[] }[] = [];
  const items = (opts.items ?? [
    { id: "si_weather", price: "price_weather_basic" },
    { id: "si_sports", price: "price_sports" },
  ]).map((item) => ({ id: item.id, price: { id: item.price, currency: "usd" } }));
  // Stripe's state, kept between calls: an update changes what the next retrieve reads.
  let sub = { id: "sub_1", status: opts.status ?? "active", customer: "cus_1", items: { data: items }, pending_update: null as unknown, latest_invoice: "in_0" };
  let invoiceSeq = 0;
  const stripe = {
    subscriptions: {
      retrieve: async (...args: unknown[]) => (calls.push({ method: "subscriptions.retrieve", args }), structuredClone(sub)),
      update: async (...args: unknown[]) => {
        calls.push({ method: "subscriptions.update", args });
        // A REPLAY: Stripe answers a reused key with its stored answer and does nothing.
        if (opts.replay !== undefined) return structuredClone(opts.replay);
        const params = args[1] as { items?: { id?: string; price?: string; deleted?: boolean }[]; proration_behavior?: string };
        if (params.items && opts.pending) return { ...structuredClone(sub), pending_update: { expires_at: 1 } };
        let next = sub.items.data;
        for (const change of params.items ?? []) {
          if (change.deleted) next = next.filter((item) => item.id !== change.id);
          else if (change.id) next = next.map((item) => (item.id === change.id ? { ...item, price: { id: change.price!, currency: "usd" } } : item));
          else next = [...next, { id: "si_new", price: { id: change.price!, currency: "usd" } }];
        }
        // An invoiced change (always_invoice) moves the latest invoice on.
        const invoiced = params.proration_behavior === "always_invoice" ? `in_${(invoiceSeq += 1)}` : sub.latest_invoice;
        sub = { ...sub, items: { data: next }, pending_update: null, latest_invoice: invoiced };
        return structuredClone(sub);
      },
      create: async (...args: unknown[]) => (calls.push({ method: "subscriptions.create", args }), sub),
    },
    subscriptionItems: {
      update: async (...args: unknown[]) => (calls.push({ method: "subscriptionItems.update", args }), {}),
    },
    invoices: {
      createPreview: async (...args: unknown[]) => (calls.push({ method: "invoices.createPreview", args }), { total: 333, currency: "usd" }),
    },
    checkout: { sessions: { create: async (...args: unknown[]) => (calls.push({ method: "checkout.sessions.create", args }), {}) } },
  };
  const client = { stripe: stripe as unknown as Stripe, appUrl: "https://app.test", apiVersion: "2026-08-26.dahlia" } as StripeClient;
  return { client, calls };
}

const neverASecondSubscription = (calls: { method: string }[]) =>
  expect(calls.some((c) => c.method === "subscriptions.create" || c.method === "checkout.sessions.create")).toBe(false);

describe("changing ONE line's tier on a two-line subscription", () => {
  it("previews and swaps the named item only; the other line's item is never in the call", async () => {
    const { client, calls } = twoLineStripe();
    const preview = await previewPlanChange(client, { subscriptionId: "sub_1", itemId: "si_weather", newPriceId: "price_weather_pro", prorationDate: NOW_S });
    expect(preview).toMatchObject({ samePrice: false, dueNowMinor: 333 });
    expect((calls.find((c) => c.method === "invoices.createPreview")!.args[0] as { subscription_details: unknown }).subscription_details).toEqual({
      items: [{ id: "si_weather", price: "price_weather_pro" }],
      proration_behavior: "always_invoice",
      proration_date: NOW_S,
    });

    const result = await changePlan(client, {
      subscriptionId: "sub_1",
      itemId: "si_weather",
      newPriceId: "price_weather_pro",
      prorationDate: NOW_S,
      metadata: { planKey: "weather-pro" },
      idempotencyKey: "plan_change:t:weather-pro:month:usd:1",
    });
    expect(result.applied).toBe(true);
    const updates = calls.filter((c) => c.method === "subscriptions.update");
    // ONE subscription edit (the price); the subscription's own metadata is NOT
    // restamped — with two lines it can only ever describe one of them.
    expect(updates).toHaveLength(1);
    expect(updates[0]!.args[1]).toMatchObject({ items: [{ id: "si_weather", price: "price_weather_pro" }], payment_behavior: "pending_if_incomplete" });
    // The metadata goes on the line's own item.
    expect(calls.find((c) => c.method === "subscriptionItems.update")!.args.slice(0, 2)).toEqual(["si_weather", { metadata: { planKey: "weather-pro" } }]);
    neverASecondSubscription(calls);
  });

  it("an item that's gone is refused (changed elsewhere); with no item named, two items are refused as before", async () => {
    await expect(
      previewPlanChange(twoLineStripe().client, { subscriptionId: "sub_1", itemId: "si_gone", newPriceId: "price_weather_pro" }),
    ).rejects.toMatchObject({ code: "no_such_item" });
    // NEGATIVE CONTROL: the single-item rule still holds when no item is named.
    await expect(previewPlanChange(twoLineStripe().client, { subscriptionId: "sub_1", newPriceId: "price_weather_pro" })).rejects.toMatchObject({
      code: "not_one_item",
    });
  });
});

describe("adding a line: an item on the ONE subscription, prorated and charged now", () => {
  it("previews the new item alone (the others untouched), then adds exactly that item", async () => {
    const { client, calls } = twoLineStripe({ items: [{ id: "si_weather", price: "price_weather_basic" }] });
    const preview = await previewAddLine(client, { subscriptionId: "sub_1", newPriceId: "price_sports", prorationDate: NOW_S });
    expect(preview).toMatchObject({ samePrice: false, dueNowMinor: 333, prorationDate: NOW_S });
    expect((calls.find((c) => c.method === "invoices.createPreview")!.args[0] as { subscription_details: unknown }).subscription_details).toEqual({
      items: [{ price: "price_sports", quantity: 1 }],
      proration_behavior: "always_invoice",
      proration_date: NOW_S,
    });

    const key = addLineIdempotencyKey({ id: "sub_1", items: { data: [{ id: "si_weather" }] }, latest_invoice: "in_0" }, "sports");
    const result = await addLine(client, {
      subscriptionId: "sub_1",
      newPriceId: "price_sports",
      prorationDate: NOW_S,
      itemMetadata: { planKey: "sports", planLine: "sports" },
      idempotencyKey: key,
    });
    expect(result).toMatchObject({ applied: true, itemId: "si_new" });
    // What comes back is a FRESH read after the update, not the update's own answer.
    const methods = calls.map((c) => c.method);
    expect(methods.lastIndexOf("subscriptions.retrieve")).toBeGreaterThan(methods.indexOf("subscriptions.update"));
    expect(result.subscription.items.data.map((item) => item.id)).toEqual(["si_weather", "si_new"]);
    const update = calls.find((c) => c.method === "subscriptions.update")!;
    expect(update.args[1]).toEqual({
      items: [{ price: "price_sports", quantity: 1 }],
      proration_behavior: "always_invoice",
      proration_date: NOW_S,
      payment_behavior: "pending_if_incomplete",
    });
    expect(update.args[2]).toEqual({ idempotencyKey: key });
    expect(calls.find((c) => c.method === "subscriptionItems.update")!.args.slice(0, 2)).toEqual(["si_new", { metadata: { planKey: "sports", planLine: "sports" } }]);
    neverASecondSubscription(calls);
  });

  it("a failed charge adds nothing and names nothing; the same price twice is refused; a stale preview never reaches Stripe", async () => {
    const pending = twoLineStripe({ pending: true, items: [{ id: "si_weather", price: "price_weather_basic" }] });
    const held = await addLine(pending.client, { subscriptionId: "sub_1", newPriceId: "price_sports", prorationDate: NOW_S, itemMetadata: { planKey: "sports" }, idempotencyKey: "k" });
    expect(held).toMatchObject({ applied: false, itemId: null });
    expect(pending.calls.some((c) => c.method === "subscriptionItems.update")).toBe(false);

    await expect(
      addLine(twoLineStripe().client, { subscriptionId: "sub_1", newPriceId: "price_sports", prorationDate: NOW_S, itemMetadata: {}, idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "already_on_price" });

    const stale = twoLineStripe();
    await expect(
      addLine(stale.client, { subscriptionId: "sub_1", newPriceId: "price_x", prorationDate: NOW_S - 31 * 60, itemMetadata: {}, idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "stale_preview" });
    expect(stale.calls).toHaveLength(0);
  });

  it("the add key is the state's: two tabs from the same items share it, a later add after a removal does not", () => {
    const a = addLineIdempotencyKey({ id: "sub_1", items: { data: [{ id: "si_b" }, { id: "si_a" }] }, latest_invoice: "in_1" }, "sports");
    const b = addLineIdempotencyKey({ id: "sub_1", items: { data: [{ id: "si_a" }, { id: "si_b" }] }, latest_invoice: { id: "in_1" } }, "sports");
    expect(a).toBe(b);
    // Readable where it matters (the subscription and the line), and always short enough for Stripe.
    expect(a).toMatch(/^plan_line_add:sub_1:sports:[0-9a-f]{32}$/);
    const many = addLineIdempotencyKey({ id: "sub_1", items: { data: Array.from({ length: 40 }, (_, i) => ({ id: `si_${"x".repeat(24)}${i}` })) } }, "sports");
    expect(many.length).toBeLessThanOrEqual(255);
    expect(addLineIdempotencyKey({ id: "sub_1", items: { data: [{ id: "si_a" }] }, latest_invoice: "in_1" }, "sports")).not.toBe(a);
    expect(addLineIdempotencyKey({ id: "sub_1", items: { data: [{ id: "si_a" }, { id: "si_b" }] }, latest_invoice: "in_1" }, "weather")).not.toBe(a);
  });

  it("REVIEW: add, drop, re-add — the same items again, and still a NEW key (never the first add's)", async () => {
    // Weather alone; add Sports; drop Sports: the items are exactly what they were before the add.
    const { client } = twoLineStripe({ items: [{ id: "si_weather", price: "price_weather_basic" }] });
    const before = await client.stripe.subscriptions.retrieve("sub_1");
    const firstKey = addLineIdempotencyKey(before, "sports");
    await addLine(client, { subscriptionId: "sub_1", newPriceId: "price_sports", prorationDate: NOW_S, itemMetadata: {}, idempotencyKey: firstKey });
    await removeLine(client, { subscriptionId: "sub_1", itemId: "si_new", idempotencyKey: "plan_line_remove:sub_1:si_new" });
    const afterDrop = await client.stripe.subscriptions.retrieve("sub_1");
    expect(afterDrop.items.data.map((item) => item.id)).toEqual(before.items.data.map((item) => item.id));
    // The add and the drop were each invoiced at once, so the latest invoice moved on: a new key.
    expect(addLineIdempotencyKey(afterDrop, "sports")).not.toBe(firstKey);
    // And our own row's memory of the item Sports held makes it new on its own, whatever the invoice says.
    const sameInvoice = { ...afterDrop, latest_invoice: before.latest_invoice };
    expect(addLineIdempotencyKey(sameInvoice, "sports", { previousItemIds: ["si_new"] })).not.toBe(firstKey);
    // NEGATIVE CONTROL: with neither, the key of the items alone comes round again — the replay the review found.
    expect(addLineIdempotencyKey(sameInvoice, "sports")).toBe(firstKey);
  });

  it("REVIEW: a replayed answer naming an item that's gone adds nothing — refused, nothing stamped, never reported as added", async () => {
    // Stripe replays the first add's stored answer (si_new on Sports); the subscription itself holds only Weather.
    const replayed = { id: "sub_1", status: "active", customer: "cus_1", pending_update: null, items: { data: [
      { id: "si_weather", price: { id: "price_weather_basic", currency: "usd" } },
      { id: "si_new", price: { id: "price_sports", currency: "usd" } },
    ] } };
    const { client, calls } = twoLineStripe({ items: [{ id: "si_weather", price: "price_weather_basic" }], replay: replayed });
    await expect(
      addLine(client, { subscriptionId: "sub_1", newPriceId: "price_sports", prorationDate: NOW_S, itemMetadata: { planKey: "sports" }, idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "not_added" });
    expect(calls.some((c) => c.method === "subscriptionItems.update")).toBe(false);
  });

  it("refuses a subscription that isn't running", async () => {
    await expect(previewAddLine(twoLineStripe({ status: "canceled" }).client, { subscriptionId: "sub_1", newPriceId: "p" })).rejects.toBeInstanceOf(PlanChangeError);
  });
});

describe("dropping one line, keeping the others", () => {
  it("removes the line's item now, its unused time INVOICED AT ONCE as a credit (never left pending for a bill that may not come)", async () => {
    const { client, calls } = twoLineStripe();
    const left = await removeLine(client, { subscriptionId: "sub_1", itemId: "si_sports", idempotencyKey: "plan_line_remove:sub_1:si_sports" });
    expect(left.items.data.map((item) => item.id)).toEqual(["si_weather"]);
    // always_invoice, not create_prorations: pending prorations wait for the subscription's NEXT
    // invoice, and if the last line is then cancelled at the period's end there is none — the credit
    // was stranded. Invoiced now, Stripe puts it on the customer's balance.
    expect(calls.find((c) => c.method === "subscriptions.update")!.args.slice(1)).toEqual([
      { items: [{ id: "si_sports", deleted: true }], proration_behavior: "always_invoice" },
      { idempotencyKey: "plan_line_remove:sub_1:si_sports" },
    ]);
  });

  it("the last line is a cancellation (to the end of the paid period), never a removal today", async () => {
    const { client, calls } = twoLineStripe({ items: [{ id: "si_weather", price: "price_weather_basic" }] });
    await expect(removeLine(client, { subscriptionId: "sub_1", itemId: "si_weather", idempotencyKey: "k" })).rejects.toMatchObject({ code: "last_item" });
    expect(calls.some((c) => c.method === "subscriptions.update")).toBe(false);
  });
});

describe("ONE Stripe customer per tenant (review B5)", () => {
  function customers(
    opts: {
      byTenant?: string | null;
      byUser?: { id: string; metadata: Record<string, string> }[];
      subscriptions?: number;
      listed?: { id: string; status: string; metadata: Record<string, string> }[];
    } = {},
  ) {
    const calls: { method: string; args: unknown[] }[] = [];
    const stripe = {
      customers: {
        search: async (...args: unknown[]) => {
          calls.push({ method: "customers.search", args });
          const query = (args[0] as { query: string }).query;
          if (query.includes("tenantId")) return { data: opts.byTenant ? [{ id: opts.byTenant, metadata: {} }] : [] };
          return { data: opts.byUser ?? [] };
        },
        update: async (...args: unknown[]) => (calls.push({ method: "customers.update", args }), {}),
        create: async (...args: unknown[]) => (calls.push({ method: "customers.create", args }), { id: "cus_new" }),
      },
      subscriptions: {
        list: async (...args: unknown[]) => (
          calls.push({ method: "subscriptions.list", args }),
          { data: opts.listed ?? Array.from({ length: opts.subscriptions ?? 0 }, (_, i) => ({ id: `sub_${i}`, status: "canceled", metadata: {} })) }
        ),
      },
      checkout: { sessions: { list: async () => ({ data: [] }), expire: async () => ({}) } },
    };
    return { client: { stripe: stripe as unknown as Stripe, appUrl: "https://app.test", apiVersion: "2026-08-26.dahlia" } as StripeClient, calls };
  }

  it("the tenant's own customer first; then a person's customer the shop made (adopted and stamped with the tenant)", async () => {
    expect(await resolveStripeCustomer(customers({ byTenant: "cus_t" }).client, { tenantId: "ws_1", userId: "u_1", knownCustomerId: null, email: null })).toBe("cus_t");

    const legacy = customers({ byUser: [{ id: "cus_shop", metadata: { appUserId: "u_1" } }] });
    expect(await resolveStripeCustomer(legacy.client, { tenantId: "ws_1", userId: "u_1", knownCustomerId: null, email: null })).toBe("cus_shop");
    expect(legacy.calls.find((c) => c.method === "customers.update")!.args).toEqual(["cus_shop", { metadata: { tenantId: "ws_1" } }]);
    expect(legacy.calls.some((c) => c.method === "customers.create")).toBe(false);
  });

  it("never adopts a customer that already belongs to ANOTHER tenant (that's the other company's card)", async () => {
    const other = customers({ byUser: [{ id: "cus_other", metadata: { appUserId: "u_1", tenantId: "org_2" } }] });
    expect(await resolveStripeCustomer(other.client, { tenantId: "ws_1", userId: "u_1", knownCustomerId: null, email: "p@x.test" })).toBe("cus_new");
    expect(other.calls.find((c) => c.method === "customers.create")!.args).toEqual([
      { metadata: { tenantId: "ws_1", appUserId: "u_1" }, email: "p@x.test" },
      { idempotencyKey: "company_customer:ws_1" },
    ]);
  });

  it("a portal asks without writing: no customer yet is null, not an empty new one; a person's old customer is found but not stamped", async () => {
    const none = customers();
    expect(await resolveStripeCustomer(none.client, { tenantId: "ws_1", userId: "u_1", knownCustomerId: null, email: null, create: false })).toBeNull();
    expect(none.calls.some((c) => c.method === "customers.create")).toBe(false);
    const legacy = customers({ byUser: [{ id: "cus_shop", metadata: { appUserId: "u_1" } }] });
    expect(await resolveStripeCustomer(legacy.client, { tenantId: "ws_1", userId: "u_1", knownCustomerId: null, email: null, create: false })).toBe("cus_shop");
    expect(legacy.calls.some((c) => c.method === "customers.update" || c.method === "customers.create")).toBe(false);
  });

  it("REVIEW (companies): with no userId — a company — a member's own customer is never adopted, and a new one names only the tenant", async () => {
    const legacy = customers({ byUser: [{ id: "cus_member", metadata: { appUserId: "u_1" } }] });
    expect(await resolveStripeCustomer(legacy.client, { tenantId: "org_1", knownCustomerId: null, email: "owner@co.test" })).toBe("cus_new");
    expect(legacy.calls.some((c) => c.method === "customers.update")).toBe(false);
    expect(legacy.calls.some((c) => (c.args[0] as { query?: string }).query?.includes("appUserId"))).toBe(false);
    expect(legacy.calls.find((c) => c.method === "customers.create")!.args[0]).toEqual({ metadata: { tenantId: "org_1" }, email: "owner@co.test" });
  });

  it("REVIEW: a recurring product from the shop on the tenant's customer neither blocks a plan nor uses up the free trial", async () => {
    const box = { id: "sub_box", status: "active", metadata: { tenantId: "*", variantId: "var_box" } };
    const withBox = await prepareCompanyCheckout(customers({ byTenant: "cus_t", listed: [box] }).client, { tenantId: "ws_1", knownCustomerId: null, email: null });
    expect(withBox).toMatchObject({ existingSubscription: null, hadSubscription: false });
    // Another tenant's subscription on this customer isn't this tenant's plan either.
    const other = { id: "sub_other", status: "active", metadata: { tenantId: "org_2", planKey: "pro" } };
    expect((await prepareCompanyCheckout(customers({ byTenant: "cus_t", listed: [other] }).client, { tenantId: "ws_1", knownCustomerId: null, email: null })).existingSubscription).toBeNull();
    // NEGATIVE CONTROLS: this tenant's live plan blocks (never a second subscription); one with no
    // metadata of ours (made in the dashboard) blocks too; an ended plan is a used-up trial.
    const plan = { id: "sub_plan", status: "active", metadata: { tenantId: "ws_1", planKey: "weather-basic" } };
    expect((await prepareCompanyCheckout(customers({ byTenant: "cus_t", listed: [box, plan] }).client, { tenantId: "ws_1", knownCustomerId: null, email: null })).existingSubscription).toEqual({ id: "sub_plan", status: "active" });
    const bare = { id: "sub_bare", status: "active", metadata: {} };
    expect((await prepareCompanyCheckout(customers({ byTenant: "cus_t", listed: [bare] }).client, { tenantId: "ws_1", knownCustomerId: null, email: null })).existingSubscription).toEqual({ id: "sub_bare", status: "active" });
    const ended = { id: "sub_old", status: "canceled", metadata: { tenantId: "ws_1", planKey: "weather-basic" } };
    expect((await prepareCompanyCheckout(customers({ byTenant: "cus_t", listed: [box, ended] }).client, { tenantId: "ws_1", knownCustomerId: null, email: null })).hadSubscription).toBe(true);
    expect(isPlanSubscriptionFor(box, "ws_1")).toBe(false);
    expect(isPlanSubscriptionFor(plan, "ws_1")).toBe(true);
  });

  it("a plan checkout uses that same customer, and says whether it ever had a subscription (one free trial each)", async () => {
    const fresh = await prepareCompanyCheckout(customers({ byTenant: "cus_t" }).client, { tenantId: "ws_1", userId: "u_1", knownCustomerId: null, email: null });
    expect(fresh).toMatchObject({ customerId: "cus_t", hadSubscription: false });
    const returning = await prepareCompanyCheckout(customers({ byTenant: "cus_t", subscriptions: 1 }).client, { tenantId: "ws_1", knownCustomerId: null, email: null });
    expect(returning.hadSubscription).toBe(true);
  });
});

describe("subscriptionSnapshot reads every item (one per line)", () => {
  it("lists each item with its own price, period and metadata", () => {
    const item = (id: string, price: string, interval: string, metadata: Record<string, string> = {}) => ({
      id,
      current_period_start: 1_772_323_200,
      current_period_end: 1_774_915_200,
      quantity: 1,
      metadata,
      price: { id: price, currency: "usd", recurring: { interval } },
    });
    const snapshot = subscriptionSnapshot({
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      cancel_at_period_end: false,
      canceled_at: null,
      trial_end: null,
      currency: "usd",
      metadata: { tenantId: "ws_1", planKey: "weather-basic" },
      items: { data: [item("si_w", "price_w", "month"), item("si_s", "price_s", "month", { planKey: "sports" })] },
    } as unknown as Stripe.Subscription);
    expect(snapshot.items.map((each) => [each.itemId, each.priceId, each.interval, each.metadata])).toEqual([
      ["si_w", "price_w", "month", {}],
      ["si_s", "price_s", "month", { planKey: "sports" }],
    ]);
    expect(snapshot.items[1]!.currentPeriodEnd).toEqual(new Date("2026-03-31T00:00:00Z"));
    // The single-item fields stay the first item's.
    expect(snapshot.priceId).toBe("price_w");
  });
});
