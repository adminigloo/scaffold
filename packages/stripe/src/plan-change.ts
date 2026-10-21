import { createHash } from "node:crypto";
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
 *
 * PRODUCT LINES (stripe 0.6). A tenant holding Weather Pro and Sports Basic
 * holds ONE subscription with TWO items (one customer, one invoice, one 30¢).
 * So a plan change names the ITEM it swaps (`itemId`: the line's item), a
 * second line is an item ADDED to the subscription (`previewAddLine` /
 * `addLine`, prorated, charged now), and dropping one line REMOVES its item
 * (`removeLine`, the unused part invoiced at once as a credit on the
 * customer's balance) while the others keep renewing. Without an `itemId` a change still demands a subscription of
 * exactly one item, as before.
 */

/** Stripe's customer id on a subscription, whether expanded or not. */
function customerIdOf(subscription: Stripe.Subscription): string {
  const c = subscription.customer;
  return typeof c === "string" ? c : c.id;
}

/**
 * The priced item a change targets: the named one, or — with no name — the one
 * item a single-line subscription carries.
 */
function planItemOf(subscription: Stripe.Subscription, itemId?: string): Stripe.SubscriptionItem {
  const items = subscription.items?.data ?? [];
  if (itemId !== undefined) {
    const found = items.find((item) => item.id === itemId);
    if (!found) {
      throw new PlanChangeError(
        "no_such_item",
        `Subscription ${subscription.id} no longer has item ${itemId}: that plan was changed somewhere else. Reload and try again.`,
      );
    }
    return found;
  }
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
    readonly code: "not_one_item" | "not_changeable" | "stale_preview" | "no_such_item" | "last_item" | "already_on_price" | "not_added",
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
  /**
   * The item to swap (stripe 0.6): the product line's own item, so a change
   * to Weather never touches Sports. Omitted: the subscription must have
   * exactly one item.
   */
  readonly itemId?: string;
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
  const item = planItemOf(subscription, input.itemId);
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

/** Refuse a proration date that isn't the one a preview just quoted (review H1). Before any Stripe call. */
function assertFreshProrationDate(prorationDate: number | undefined): void {
  if (prorationDate === undefined) return;
  const now = Math.floor(Date.now() / 1000);
  if (prorationDate > now + 60 || prorationDate < now - PRORATION_DATE_MAX_AGE_SECONDS) {
    throw new PlanChangeError(
      "stale_preview",
      "That price was worked out too long ago. Look at the plan again to see today's price, then confirm.",
    );
  }
}

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
 *     is recognised from step 1's own event.) With several items the metadata
 *     goes on the ITEM that changed — the subscription's own metadata can only
 *     ever describe one line.
 */
export async function changePlan(client: StripeClient, input: ChangePlanInput): Promise<ChangePlanResult> {
  assertFreshProrationDate(input.prorationDate);
  const subscription = await changeableSubscription(client, input.subscriptionId);
  const item = planItemOf(subscription, input.itemId);
  const single = (subscription.items?.data ?? []).length === 1;
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
  let stamped = changed;
  if (single) {
    stamped = await client.stripe.subscriptions.update(
      subscription.id,
      { metadata: input.metadata },
      { idempotencyKey: `${input.idempotencyKey}:metadata` },
    );
  }
  if (input.itemId !== undefined) {
    await client.stripe.subscriptionItems.update(
      item.id,
      { metadata: input.metadata },
      { idempotencyKey: `${input.idempotencyKey}:item-metadata` },
    );
  }
  return { subscription: stamped, applied: true };
}

// ---------------------------------------------------------------------------
// Product lines: adding one, and dropping one (stripe 0.6)
// ---------------------------------------------------------------------------

export interface AddLineInput {
  readonly subscriptionId: string;
  /** The Stripe price of the new line's tier. */
  readonly newPriceId: string;
  /** Unix seconds. The preview's own, so the charge is what was shown. */
  readonly prorationDate?: number;
}

/**
 * What adding a line costs today: the new item, prorated to the rest of the
 * subscription's period and charged now (one subscription, one billing date).
 */
export async function previewAddLine(client: StripeClient, input: AddLineInput): Promise<PlanChangePreview> {
  const subscription = await changeableSubscription(client, input.subscriptionId);
  const prorationDate = input.prorationDate ?? Math.floor(Date.now() / 1000);
  const already = (subscription.items?.data ?? []).find((item) => item.price.id === input.newPriceId);
  if (already) {
    return { samePrice: true, dueNowMinor: 0, currency: already.price.currency, prorationDate };
  }
  const invoice = await client.stripe.invoices.createPreview({
    customer: customerIdOf(subscription),
    subscription: subscription.id,
    subscription_details: {
      // An item with no id is a NEW item; the ones not listed stay as they are.
      items: [{ price: input.newPriceId, quantity: 1 }],
      proration_behavior: "always_invoice",
      proration_date: prorationDate,
    },
  });
  return { samePrice: false, dueNowMinor: invoice.total, currency: invoice.currency, prorationDate };
}

export interface AddLineCallInput extends AddLineInput {
  /** Stamped on the NEW item once it is paid for (e.g. `{ planKey: "sports", planLine: "sports" }`). */
  readonly itemMetadata: Record<string, string>;
  /**
   * Derive it with `addLineIdempotencyKey` (the subscription, the line, the
   * items it holds now, its latest invoice and the items this line held
   * before): two tabs adding the same line from the same state share it, so
   * Stripe adds ONE item — a second, different tier collides with the first
   * and is refused rather than billed twice.
   */
  readonly idempotencyKey: string;
}

export interface AddLineResult {
  /** The subscription as a FRESH read shows it after the add — never the update's own (possibly replayed) answer. */
  readonly subscription: Stripe.Subscription;
  /** FALSE: the prorated charge failed and Stripe added nothing (the change is pending until paid). */
  readonly applied: boolean;
  /** The new item's id, once applied: always one the fresh read holds. */
  readonly itemId: string | null;
}

export interface AddLineKeyOptions {
  /**
   * The items this line has held on this subscription before (your own rows'
   * `stripe_item_id` for it, ended ones included). Every add makes a new item,
   * so after a drop this is what tells the next add from the last one.
   */
  readonly previousItemIds?: readonly (string | null | undefined)[];
}

/**
 * The idempotency key for adding `line` to a subscription — the same add from
 * the same state is ONE add, and adding the line again after dropping it is
 * ALWAYS a new one (review: re-adding a dropped line).
 *
 * WHY THE ITEMS ALONE WERE NOT ENOUGH. Add Sports, drop it, and the
 * subscription holds exactly the items it held before the add — so a key of
 * the items alone came round again. Stripe keeps a key for 24 hours: sent with
 * the same parameters it REPLAYED the first add's stored answer and did
 * nothing (a free line, granted from the cached response), and sent with a
 * new proration date it was refused as a different request. So the key also
 * carries what an add or a drop always moves on: the subscription's latest
 * invoice (an add is invoiced at once, and so is a drop), and the items this
 * line held before (every add makes a new item, and our row keeps its id).
 *
 * The state is hashed, so a subscription with many items still makes a key
 * Stripe accepts (255 characters at most); the subscription and the line stay
 * readable in the dashboard's request log.
 */
export function addLineIdempotencyKey(
  subscription: {
    readonly id: string;
    readonly items?: { readonly data?: readonly { readonly id: string }[] };
    readonly latest_invoice?: string | { readonly id?: string | null } | null;
  },
  line: string,
  options: AddLineKeyOptions = {},
): string {
  const items = (subscription.items?.data ?? []).map((item) => item.id).sort();
  const invoice = subscription.latest_invoice;
  const invoiceId = typeof invoice === "string" ? invoice : (invoice?.id ?? "");
  const previous = [
    ...new Set((options.previousItemIds ?? []).filter((id): id is string => typeof id === "string" && id.length > 0)),
  ].sort();
  const state = createHash("sha256")
    .update(JSON.stringify({ items, invoice: invoiceId, previous }))
    .digest("hex")
    .slice(0, 32);
  return `plan_line_add:${subscription.id}:${line}:${state}`;
}

/**
 * Add a product line to the tenant's ONE subscription: a new item, prorated
 * and charged now, on the same invoice and billing date as the rest. Never a
 * second subscription.
 *
 * `pending_if_incomplete`, as `changePlan`: if the charge fails, nothing is
 * added. The item's metadata is stamped only once it is paid for.
 *
 * NEVER TRUSTS THE UPDATE'S OWN ANSWER. A reused idempotency key makes Stripe
 * replay the answer it gave the first time — an item that may have been
 * dropped since — without adding or charging anything. So the subscription is
 * read again after the update, and the new item must be in THAT read: if it
 * isn't, nothing was added and this refuses (`not_added`) rather than report
 * a line nobody paid for.
 */
export async function addLine(client: StripeClient, input: AddLineCallInput): Promise<AddLineResult> {
  assertFreshProrationDate(input.prorationDate);
  const subscription = await changeableSubscription(client, input.subscriptionId);
  const before = new Set((subscription.items?.data ?? []).map((item) => item.id));
  if ((subscription.items?.data ?? []).some((item) => item.price.id === input.newPriceId)) {
    throw new PlanChangeError("already_on_price", `Subscription ${subscription.id} already bills this price.`);
  }
  const changed = await client.stripe.subscriptions.update(
    subscription.id,
    {
      items: [{ price: input.newPriceId, quantity: 1 }],
      proration_behavior: "always_invoice",
      ...(input.prorationDate === undefined ? {} : { proration_date: input.prorationDate }),
      payment_behavior: "pending_if_incomplete",
    },
    { idempotencyKey: input.idempotencyKey },
  );
  if (changed.pending_update) return { subscription: changed, applied: false, itemId: null };
  // A FRESH READ, never `changed`: a replayed answer can name an item that is
  // no longer there. The line exists only if Stripe holds its item now.
  const fresh = await client.stripe.subscriptions.retrieve(subscription.id);
  const added = (fresh.items?.data ?? []).find((item) => !before.has(item.id) && item.price.id === input.newPriceId) ?? null;
  if (added === null) {
    throw new PlanChangeError(
      "not_added",
      `Stripe added nothing to subscription ${subscription.id} (no new item on price ${input.newPriceId} after the update): ` +
        `the request was probably answered from an earlier one with the same idempotency key. Reload and try again.`,
    );
  }
  await client.stripe.subscriptionItems.update(
    added.id,
    { metadata: input.itemMetadata },
    { idempotencyKey: `${input.idempotencyKey}:metadata` },
  );
  return { subscription: fresh, applied: true, itemId: added.id };
}

export interface RemoveLineInput {
  readonly subscriptionId: string;
  /** The line's item. */
  readonly itemId: string;
  readonly idempotencyKey: string;
}

/**
 * Drop ONE product line, keeping the others: its item comes off the
 * subscription now, and the unused part of the period is INVOICED AT ONCE
 * (`always_invoice`): an invoice with a negative total, which Stripe puts on
 * the customer's balance, where it comes off their next bill. Never charged
 * again, never lost.
 *
 * NOT `create_prorations` (review): that leaves the credit as pending items
 * for the subscription's NEXT invoice — and if the remaining line is then
 * cancelled at the period's end there is no next invoice, so the credit was
 * never used or refunded. A credit on the balance stays with the customer
 * either way. The other lines renew as before.
 *
 * The LAST item is refused (`last_item`): ending the whole subscription is a
 * cancellation, which keeps access to the end of the period that was paid for
 * — `cancel_at_period_end` — rather than ending it today.
 */
export async function removeLine(client: StripeClient, input: RemoveLineInput): Promise<Stripe.Subscription> {
  const subscription = await changeableSubscription(client, input.subscriptionId);
  planItemOf(subscription, input.itemId);
  if ((subscription.items?.data ?? []).length <= 1) {
    throw new PlanChangeError(
      "last_item",
      `Item ${input.itemId} is the only one on subscription ${subscription.id}: cancel the subscription at the end of its period instead.`,
    );
  }
  return client.stripe.subscriptions.update(
    subscription.id,
    {
      items: [{ id: input.itemId, deleted: true }],
      proration_behavior: "always_invoice",
    },
    { idempotencyKey: input.idempotencyKey },
  );
}

// ---------------------------------------------------------------------------
// One Stripe customer per tenant (stripe 0.6)
// ---------------------------------------------------------------------------

export interface ResolveCustomerInput {
  readonly tenantId: string;
  /**
   * The person whose OWN personal workspace this tenant is (our users.id) —
   * pass it ONLY then. A product checkout from before 0.6 made a customer per
   * person, and that customer is adopted as their workspace's. Never for a
   * company: a member's own customer (their card, their invoices, their own
   * subscriptions) must not become the company's, nor the company's billing
   * go to that member's email (review). Omitted, nothing personal is adopted
   * and a new customer names only the tenant.
   */
  readonly userId?: string | null;
  /** The Stripe customer this tenant paid with before, from your own records, if any. */
  readonly knownCustomerId: string | null;
  /** Put on a newly made customer, so Stripe's receipts reach someone. */
  readonly email: string | null;
  /**
   * When false, NOTHING IS WRITTEN — no customer made, none stamped: null when
   * the tenant has no customer yet (a portal must not open on an empty one,
   * and a read never changes Stripe). Default true.
   */
  readonly create?: boolean;
}

/** The metadata key the product checkout has always stamped on a person's customer. */
export const APP_USER_METADATA_KEY = "appUserId";

/** Our ids only ever contain these; anything else would be query injection into Stripe's search. */
const SEARCHABLE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * THE TENANT'S ONE STRIPE CUSTOMER, for every checkout that charges it — a
 * plan, a second product line, a product from the shop (stripe 0.6, review
 * B5). Two customers for one person meant two portals, two invoice lists and
 * two saved cards.
 *
 *   1. the customer your own rows already name for the tenant;
 *   2. the customer carrying `metadata.tenantId` (what plan checkouts make);
 *   3. ONLY for a person's own workspace (`userId` given): their customer
 *      from before 0.6 (`metadata.appUserId`, what the shop made) that belongs
 *      to no tenant yet — adopted, and stamped with the tenant so the next
 *      search finds it by step 2;
 *   4. otherwise one is made, once (an idempotency key per tenant covers the
 *      minute before Stripe's search sees a new customer).
 *
 * A person's customer already stamped with ANOTHER tenant is never adopted:
 * that is the other company's card and invoices.
 */
export async function resolveStripeCustomer(client: StripeClient, input: ResolveCustomerInput): Promise<string | null> {
  if (input.knownCustomerId !== null) return input.knownCustomerId;
  const byTenant = await client.stripe.customers.search({
    // Quotes and backslashes can't appear in our ids; stripped all the same,
    // so nothing can close the quoted value early.
    query: `metadata['tenantId']:'${input.tenantId.replace(/['\\]/g, "")}'`,
    limit: 1,
  });
  const tenantCustomer = byTenant.data[0]?.id ?? null;
  if (tenantCustomer !== null) return tenantCustomer;

  const userId = input.userId ?? null;
  if (userId !== null && SEARCHABLE_ID.test(userId)) {
    const byUser = await client.stripe.customers.search({
      query: `metadata['${APP_USER_METADATA_KEY}']:'${userId}'`,
      limit: 5,
    });
    const adoptable = byUser.data.find((customer) => !customer.metadata?.["tenantId"]);
    if (adoptable) {
      if (input.create !== false) await client.stripe.customers.update(adoptable.id, { metadata: { tenantId: input.tenantId } });
      return adoptable.id;
    }
  }

  if (input.create === false) return null;
  const made = await client.stripe.customers.create(
    {
      metadata: { tenantId: input.tenantId, ...(userId !== null ? { [APP_USER_METADATA_KEY]: userId } : {}) },
      ...(input.email ? { email: input.email } : {}),
    },
    { idempotencyKey: `company_customer:${input.tenantId}` },
  );
  return made.id;
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
  /**
   * The person checking out — ONLY when the tenant is their own personal
   * workspace, so a customer the shop made for them is reused (stripe 0.6).
   * Never for a company (see `ResolveCustomerInput.userId`).
   */
  readonly userId?: string | null;
}

export interface CompanyCheckout {
  /** The company's ONE Stripe customer: always pass this as the checkout's `customer`. */
  readonly customerId: string;
  /**
   * A PLAN subscription Stripe already holds for the company (paid but not
   * yet mirrored, or never finished), if any. A recurring product from the
   * shop on the same customer is not one (`isPlanSubscriptionFor`).
   */
  readonly existingSubscription: { readonly id: string; readonly status: Stripe.Subscription.Status } | null;
  /** Other open checkouts for the company, now closed so only the new one can be paid. */
  readonly expiredSessions: number;
  /**
   * Has this customer EVER had a PLAN subscription, ended ones included
   * (stripe 0.6)? A free trial is for someone who never had one: a cancelled
   * subscriber who comes back pays from the first day. A box from the shop
   * doesn't count.
   */
  readonly hadSubscription: boolean;
}

/**
 * Is this subscription one of THIS tenant's plans, rather than something else
 * on the same customer (review: one customer per tenant)?
 *
 * With one Stripe customer per tenant, a recurring PRODUCT bought in the shop
 * sits on the customer a plan checkout uses. Counting it as "already pays for
 * a plan" shut that person out of every plan for good. So:
 *
 *   - the shop's subscriptions carry `metadata.variantId` — never a plan;
 *   - a subscription stamped with ANOTHER tenant is not this tenant's plan;
 *   - everything else counts, including one with no metadata of ours (made in
 *     the dashboard): refusing a checkout there costs a support email, and
 *     opening one could bill a plan twice.
 */
export function isPlanSubscriptionFor(
  subscription: { readonly metadata?: Readonly<Record<string, string>> | null },
  tenantId: string,
): boolean {
  const metadata = subscription.metadata ?? {};
  if ((metadata["variantId"] ?? "").length > 0) return false;
  const owner = metadata["tenantId"] ?? "";
  return owner.length === 0 || owner === tenantId;
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
 * The customer is `resolveStripeCustomer`'s — the same one the shop's
 * checkout uses (stripe 0.6), so a person has one card on file and one list
 * of invoices.
 */
export async function prepareCompanyCheckout(client: StripeClient, input: CompanyCheckoutInput): Promise<CompanyCheckout> {
  const customerId = await resolveStripeCustomer(client, {
    tenantId: input.tenantId,
    userId: input.userId ?? null,
    knownCustomerId: input.knownCustomerId,
    email: input.email,
  });
  if (customerId === null) throw new Error("prepareCompanyCheckout: no Stripe customer was found or made.");
  const subscriptions = await client.stripe.subscriptions.list({ customer: customerId, status: "all", limit: 20 });
  // PLANS ONLY: a shop subscription on this customer is neither "already
  // paying" nor a used-up free trial.
  const planSubscriptions = subscriptions.data.filter((sub) => isPlanSubscriptionFor(sub, input.tenantId));
  const live = planSubscriptions.find((sub) => LIVE_AT_STRIPE.includes(sub.status)) ?? null;
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
    hadSubscription: planSubscriptions.length > 0,
  };
}
