import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import type { StripeClient } from "../client.js";
import { changePlan, PlanChangeError, prepareCompanyCheckout, previewPlanChange } from "../plan-change.js";

const NOW_S = Math.floor(Date.now() / 1000);

/**
 * A recording fake: every Stripe call the plan change makes, with its
 * arguments. What's proved is the SHAPE of the calls — one subscription
 * edited in place, never a checkout or a second subscription — because
 * that's what the double-charge bug got wrong.
 */
function fakeStripe(opts: { status?: Stripe.Subscription.Status; priceId?: string; items?: number; pending?: boolean; previewTotal?: number } = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const items = Array.from({ length: opts.items ?? 1 }, (_, i) => ({ id: `si_${i}`, price: { id: opts.priceId ?? "price_crew", currency: "usd" } }));
  const sub = { id: "sub_1", status: opts.status ?? "active", customer: "cus_1", items: { data: items }, pending_update: null };
  const stripe = {
    subscriptions: {
      retrieve: async (...args: unknown[]) => (calls.push({ method: "subscriptions.retrieve", args }), sub),
      update: async (...args: unknown[]) => {
        calls.push({ method: "subscriptions.update", args });
        const params = args[1] as { items?: unknown };
        return { ...sub, pending_update: params.items && opts.pending ? { expires_at: 1 } : null };
      },
      create: async (...args: unknown[]) => (calls.push({ method: "subscriptions.create", args }), sub),
    },
    invoices: {
      createPreview: async (...args: unknown[]) => (calls.push({ method: "invoices.createPreview", args }), { total: opts.previewTotal ?? 1250, currency: "usd" }),
    },
    checkout: { sessions: { create: async (...args: unknown[]) => (calls.push({ method: "checkout.sessions.create", args }), {}) } },
  };
  const client = { stripe: stripe as unknown as Stripe, appUrl: "https://app.test", apiVersion: "2026-08-26.dahlia" } as StripeClient;
  return { client, calls };
}

describe("previewPlanChange", () => {
  it("previews the change on the company's existing subscription, prorated and charged now", async () => {
    const { client, calls } = fakeStripe({ previewTotal: 1250 });
    const preview = await previewPlanChange(client, { subscriptionId: "sub_1", newPriceId: "price_pro", prorationDate: NOW_S });
    expect(preview).toEqual({ samePrice: false, dueNowMinor: 1250, currency: "usd", prorationDate: NOW_S });
    const previewCall = calls.find((c) => c.method === "invoices.createPreview")!;
    expect(previewCall.args[0]).toEqual({
      customer: "cus_1",
      subscription: "sub_1",
      subscription_details: { items: [{ id: "si_0", price: "price_pro" }], proration_behavior: "always_invoice", proration_date: NOW_S },
    });
  });

  it("a cheaper plan previews as a credit (negative), not a charge", async () => {
    const { client } = fakeStripe({ previewTotal: -800 });
    expect((await previewPlanChange(client, { subscriptionId: "sub_1", newPriceId: "price_solo" })).dueNowMinor).toBe(-800);
  });

  it("the same plan is nothing to change, and costs no preview call", async () => {
    const { client, calls } = fakeStripe({ priceId: "price_pro" });
    const preview = await previewPlanChange(client, { subscriptionId: "sub_1", newPriceId: "price_pro" });
    expect(preview.samePrice).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(["subscriptions.retrieve"]);
  });

  it("refuses a cancelled subscription, and one with more than one priced item", async () => {
    await expect(previewPlanChange(fakeStripe({ status: "canceled" }).client, { subscriptionId: "sub_1", newPriceId: "price_pro" })).rejects.toBeInstanceOf(PlanChangeError);
    await expect(previewPlanChange(fakeStripe({ items: 2 }).client, { subscriptionId: "sub_1", newPriceId: "price_pro" })).rejects.toThrow(/exactly one/);
  });
});

describe("changePlan", () => {
  it("edits the ONE subscription in place: never a checkout, never a second subscription", async () => {
    const { client, calls } = fakeStripe();
    const result = await changePlan(client, {
      subscriptionId: "sub_1",
      newPriceId: "price_pro",
      prorationDate: NOW_S,
      metadata: { planKey: "pro" },
      idempotencyKey: "plan_change:t_1:pro:month:usd",
    });
    expect(result.applied).toBe(true);
    expect(calls.some((c) => c.method === "checkout.sessions.create" || c.method === "subscriptions.create")).toBe(false);
    const updates = calls.filter((c) => c.method === "subscriptions.update");
    expect(updates).toHaveLength(2);
    // 1: the price, payment-safe, with the previewed proration date.
    expect(updates[0]!.args).toEqual([
      "sub_1",
      { items: [{ id: "si_0", price: "price_pro" }], proration_behavior: "always_invoice", proration_date: NOW_S, payment_behavior: "pending_if_incomplete" },
      { idempotencyKey: "plan_change:t_1:pro:month:usd" },
    ]);
    // 2: only then, the plan's name on the subscription.
    expect(updates[1]!.args).toEqual(["sub_1", { metadata: { planKey: "pro" } }, { idempotencyKey: "plan_change:t_1:pro:month:usd:metadata" }]);
  });

  it("when the charge fails, the company keeps its old plan and nothing names the new one", async () => {
    const { client, calls } = fakeStripe({ pending: true });
    const result = await changePlan(client, { subscriptionId: "sub_1", newPriceId: "price_pro", metadata: { planKey: "pro" }, idempotencyKey: "k" });
    expect(result.applied).toBe(false);
    const updates = calls.filter((c) => c.method === "subscriptions.update");
    expect(updates).toHaveLength(1);
    expect(JSON.stringify(updates[0]!.args)).not.toContain("metadata");
  });
});

describe("the proration date is the preview's, never one the caller picks (review H1)", () => {
  it("refuses a date in the future or older than half an hour, before touching Stripe", async () => {
    for (const prorationDate of [NOW_S + 3600, NOW_S - 31 * 60, 1]) {
      const { client, calls } = fakeStripe();
      await expect(
        changePlan(client, { subscriptionId: "sub_1", newPriceId: "price_pro", prorationDate, metadata: {}, idempotencyKey: "k" }),
      ).rejects.toMatchObject({ code: "stale_preview" });
      expect(calls).toHaveLength(0);
    }
  });
});

describe("prepareCompanyCheckout (review H2)", () => {
  function fakeCustomers(opts: { found?: string | null; liveStatus?: Stripe.Subscription.Status | null; openSessions?: number }) {
    const calls: { method: string; args: unknown[] }[] = [];
    const stripe = {
      customers: {
        search: async (...args: unknown[]) => (calls.push({ method: "customers.search", args }), { data: opts.found ? [{ id: opts.found }] : [] }),
        create: async (...args: unknown[]) => (calls.push({ method: "customers.create", args }), { id: "cus_new" }),
      },
      subscriptions: {
        list: async (...args: unknown[]) => (
          calls.push({ method: "subscriptions.list", args }),
          { data: opts.liveStatus ? [{ id: "sub_live", status: opts.liveStatus }, { id: "sub_old", status: "canceled" }] : [{ id: "sub_old", status: "canceled" }] }
        ),
      },
      checkout: {
        sessions: {
          list: async (...args: unknown[]) => (calls.push({ method: "checkout.sessions.list", args }), { data: Array.from({ length: opts.openSessions ?? 0 }, (_, i) => ({ id: `cs_${i}` })) }),
          expire: async (...args: unknown[]) => (calls.push({ method: "checkout.sessions.expire", args }), {}),
        },
      },
    };
    return { client: { stripe: stripe as unknown as Stripe, appUrl: "https://app.test", apiVersion: "2026-08-26.dahlia" } as StripeClient, calls };
  }

  it("reuses the company's customer, finds a subscription Stripe holds before your tables know it, and closes other open checkouts", async () => {
    const { client, calls } = fakeCustomers({ found: "cus_a", liveStatus: "active", openSessions: 2 });
    const out = await prepareCompanyCheckout(client, { tenantId: "t_1", knownCustomerId: null, email: "o@a.test" });
    expect(out).toEqual({ customerId: "cus_a", existingSubscription: { id: "sub_live", status: "active" }, expiredSessions: 2 });
    expect(calls.filter((c) => c.method === "checkout.sessions.expire")).toHaveLength(2);
    expect(calls.some((c) => c.method === "customers.create")).toBe(false);
  });

  it("makes the company's customer once (keyed by company), and counts a checkout never finished as already started", async () => {
    const { client, calls } = fakeCustomers({ found: null, liveStatus: "incomplete" });
    const out = await prepareCompanyCheckout(client, { tenantId: "t_1", knownCustomerId: null, email: null });
    expect(out.customerId).toBe("cus_new");
    expect(out.existingSubscription).toEqual({ id: "sub_live", status: "incomplete" });
    const created = calls.find((c) => c.method === "customers.create")!;
    expect(created.args).toEqual([{ metadata: { tenantId: "t_1" } }, { idempotencyKey: "company_customer:t_1" }]);
  });

  it("a known customer skips the search", async () => {
    const { client, calls } = fakeCustomers({});
    const out = await prepareCompanyCheckout(client, { tenantId: "t_1", knownCustomerId: "cus_known", email: null });
    expect(out).toEqual({ customerId: "cus_known", existingSubscription: null, expiredSessions: 0 });
    expect(calls.some((c) => c.method === "customers.search")).toBe(false);
  });
});
