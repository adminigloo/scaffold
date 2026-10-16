import type Stripe from "stripe";
import type { StripeClient } from "./client.js";

/**
 * Changing a company's plan ON ITS EXISTING SUBSCRIPTION (stripe 0.3).
 *
 * THE BUG THIS REPLACES. "Change plan" used to open a fresh Checkout Session,
 * which made a second Stripe customer and a second subscription: the business
 * paid for both plans and could only cancel one of them from the portal. A
 * plan change is an edit to the one subscription the company already has —
 * swap the price on its item, let Stripe prorate, charge the difference now.
 *
 * Preview first, then change, with the SAME `prorationDate`, so the amount the
 * owner agreed to on screen is the amount Stripe charges.
 */

/** Stripe's customer id on a subscription, whether expanded or not. */
function customerIdOf(subscription: Stripe.Subscription): string {
  const c = subscription.customer;
  return typeof c === "string" ? c : c.id;
}

/** The one priced item a plan subscription carries. */
function planItemOf(subscription: Stripe.Subscription): Stripe.SubscriptionItem {
  const items = subscription.items?.data ?? [];
  if (items.length !== 1 || !items[0]) {
    throw new PlanChangeError(
      "not_one_item",
      `Subscription ${subscription.id} has ${items.length} items; a plan subscription has exactly one. Change it in the Stripe dashboard.`,
    );
  }
  return items[0];
}

export class PlanChangeError extends Error {
  readonly name = "PlanChangeError";
  constructor(
    readonly code: "not_one_item" | "not_changeable" | "stale_preview",
    message: string,
  ) {
    super(message);
  }
}

/** Statuses a plan can be changed from. A cancelled or never-paid subscription starts a new checkout instead. */
const CHANGEABLE: readonly Stripe.Subscription.Status[] = ["active", "trialing", "past_due"];

export interface PlanChangeInput {
  readonly subscriptionId: string;
  /** The Stripe price of the plan being moved to. */
  readonly newPriceId: string;
  /** Unix seconds. The preview's own, passed back to `changePlan` so the charge matches what was shown. */
  readonly prorationDate?: number;
}

export interface PlanChangePreview {
  /** Nothing to change: the subscription is already on this price. */
  readonly samePrice: boolean;
  /**
   * What the change costs right now, in minor units, signed. Positive: charged
   * today. Negative: credited toward the next bills (a move to a cheaper plan).
   */
  readonly dueNowMinor: number;
  readonly currency: string;
  /** Pass this back to `changePlan`. */
  readonly prorationDate: number;
}

async function changeableSubscription(client: StripeClient, subscriptionId: string): Promise<Stripe.Subscription> {
  const subscription = await client.stripe.subscriptions.retrieve(subscriptionId);
  if (!CHANGEABLE.includes(subscription.status)) {
    throw new PlanChangeError(
      "not_changeable",
      `Subscription ${subscription.id} is ${subscription.status}; a plan can only be changed on an active subscription.`,
    );
  }
  return subscription;
}

export async function previewPlanChange(client: StripeClient, input: PlanChangeInput): Promise<PlanChangePreview> {
  const subscription = await changeableSubscription(client, input.subscriptionId);
  const item = planItemOf(subscription);
  const prorationDate = input.prorationDate ?? Math.floor(Date.now() / 1000);
  if (item.price.id === input.newPriceId) {
    return { samePrice: true, dueNowMinor: 0, currency: item.price.currency, prorationDate };
  }
  const invoice = await client.stripe.invoices.createPreview({
    customer: customerIdOf(subscription),
    subscription: subscription.id,
    subscription_details: {
      items: [{ id: item.id, price: input.newPriceId }],
      proration_behavior: "always_invoice",
      proration_date: prorationDate,
    },
  });
  return { samePrice: false, dueNowMinor: invoice.total, currency: invoice.currency, prorationDate };
}

export interface ChangePlanInput extends PlanChangeInput {
  /** Stamped on the subscription once the change has gone through, so later events name the new plan (e.g. `{ planKey: "pro" }`). */
  readonly metadata: Record<string, string>;
  /** Derive it from the company and the plan, so a double click changes the plan once. */
  readonly idempotencyKey: string;
}

export interface ChangePlanResult {
  /** The subscription as Stripe left it. */
  readonly subscription: Stripe.Subscription;
  /**
   * FALSE when the prorated charge didn't go through: Stripe kept the old plan
   * and holds the change as pending until the invoice is paid. The company
   * stays on the plan it was paying for.
   */
  readonly applied: boolean;
}

/**
 * How old a preview's proration date may be when the change is confirmed
 * (review H1). The date decides how much of the period is charged or
 * credited, so it must be the one Stripe just quoted — never one the caller
 * picked: an upgrade dated just before the period ends would cost almost
 * nothing, and a downgrade dated at its start would credit time already used.
 */
export const PRORATION_DATE_MAX_AGE_SECONDS = 30 * 60;

/**
 * Swap the plan's price on the company's one subscription.
 *
 * TWO CALLS, IN THIS ORDER, ON PURPOSE.
 *  1. The price, with `payment_behavior: "pending_if_incomplete"`: if the
 *     prorated charge fails, Stripe keeps the subscription on the OLD plan
 *     instead of handing over the new one unpaid. Stripe accepts only a few
 *     fields with that behaviour, and metadata isn't one of them.
 *  2. Only once the change applied, the metadata. Never before: metadata naming
 *     a plan the company hasn't paid for would be read as that plan. (The app
 *     also reads the PRICE first when it mirrors a subscription, so the new plan
 *     is recognised from step 1's own event.)
 */
export async function changePlan(client: StripeClient, input: ChangePlanInput): Promise<ChangePlanResult> {
  if (input.prorationDate !== undefined) {
    const now = Math.floor(Date.now() / 1000);
    if (input.prorationDate > now + 60 || input.prorationDate < now - PRORATION_DATE_MAX_AGE_SECONDS) {
      throw new PlanChangeError(
        "stale_preview",
        "That price was worked out too long ago. Look at the plan again to see today's price, then confirm.",
      );
    }
  }
  const subscription = await changeableSubscription(client, input.subscriptionId);
  const item = planItemOf(subscription);
  const changed = await client.stripe.subscriptions.update(
    subscription.id,
    {
      items: [{ id: item.id, price: input.newPriceId }],
      proration_behavior: "always_invoice",
      ...(input.prorationDate === undefined ? {} : { proration_date: input.prorationDate }),
      payment_behavior: "pending_if_incomplete",
    },
    { idempotencyKey: input.idempotencyKey },
  );
  if (changed.pending_update) return { subscription: changed, applied: false };
  const stamped = await client.stripe.subscriptions.update(
    subscription.id,
    { metadata: input.metadata },
    { idempotencyKey: `${input.idempotencyKey}:metadata` },
  );
  return { subscription: stamped, applied: true };
}

// ---------------------------------------------------------------------------
// Starting a company's first subscription, safely (review H2)
// ---------------------------------------------------------------------------

/** Subscription statuses at Stripe that mean "this company already has one". */
const LIVE_AT_STRIPE: readonly Stripe.Subscription.Status[] = ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"];

export interface CompanyCheckoutInput {
  readonly tenantId: string;
  /** The Stripe customer this company paid with before, from your own records, if any. */
  readonly knownCustomerId: string | null;
  /** Put on a newly made customer, so Stripe's receipts reach someone. */
  readonly email: string | null;
}

export interface CompanyCheckout {
  /** The company's ONE Stripe customer: always pass this as the checkout's `customer`. */
  readonly customerId: string;
  /** A subscription Stripe already holds for the company (paid but not yet mirrored, or never finished), if any. */
  readonly existingSubscription: { readonly id: string; readonly status: Stripe.Subscription.Status } | null;
  /** Other open checkouts for the company, now closed so only the new one can be paid. */
  readonly expiredSessions: number;
}

/**
 * Before a company's first plan checkout: its ONE Stripe customer, whether
 * Stripe already holds a subscription for it, and every other unpaid checkout
 * of its closed.
 *
 * WHY STRIPE AND NOT ONLY YOUR TABLES. Your copy of a subscription arrives by
 * webhook, seconds later. In that gap — a second tab, or paying and coming
 * straight back — a check of your own tables says "no plan", a second
 * checkout opens, and both get paid: the company is billed for two plans.
 * Asking Stripe closes the gap, and closing the other open checkouts means
 * two tabs can never both be paid.
 *
 * The customer is found by its `tenantId` metadata, or made once (an
 * idempotency key per company covers the minute before Stripe's search sees a
 * new customer).
 */
export async function prepareCompanyCheckout(client: StripeClient, input: CompanyCheckoutInput): Promise<CompanyCheckout> {
  let customerId = input.knownCustomerId;
  if (customerId === null) {
    const found = await client.stripe.customers.search({
      query: `metadata['tenantId']:'${input.tenantId.replace(/'/g, "")}'`,
      limit: 1,
    });
    customerId = found.data[0]?.id ?? null;
  }
  if (customerId === null) {
    const made = await client.stripe.customers.create(
      { metadata: { tenantId: input.tenantId }, ...(input.email ? { email: input.email } : {}) },
      { idempotencyKey: `company_customer:${input.tenantId}` },
    );
    customerId = made.id;
  }
  const subscriptions = await client.stripe.subscriptions.list({ customer: customerId, status: "all", limit: 20 });
  const live = subscriptions.data.find((sub) => LIVE_AT_STRIPE.includes(sub.status)) ?? null;
  let expiredSessions = 0;
  const open = await client.stripe.checkout.sessions.list({ customer: customerId, status: "open", limit: 20 });
  for (const session of open.data) {
    await client.stripe.checkout.sessions.expire(session.id);
    expiredSessions += 1;
  }
  return {
    customerId,
    existingSubscription: live ? { id: live.id, status: live.status } : null,
    expiredSessions,
  };
}
