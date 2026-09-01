import type Stripe from "stripe";

/**
 * Reading a Stripe subscription, in the one place that knows where its fields
 * actually live.
 *
 * WHY THIS IS A PACKAGE MODULE AND NOT THREE LINES IN A WEBHOOK ROUTE. Two of
 * the five values a mirror needs moved between API versions, and both moves are
 * silent: reading a field Stripe has removed yields `undefined`, not an error,
 * so the subscription mirrors with no period at all and the billing page says
 * "renews on a date we do not hold" while the customer is charged every month.
 * This deployment pins `2026-08-26.dahlia`, and against that version:
 *
 *   `subscription.current_period_start` / `current_period_end` ARE GONE. The
 *   period is per ITEM now — `items.data[0].current_period_*` — because one
 *   subscription can bill several items on different cycles. The scaffold sells
 *   one item per subscription, so the first item IS the subscription's period;
 *   `subscriptionSnapshot` says so once, here, instead of in the route, the
 *   resync and whatever comes third.
 *
 *   `invoice.subscription` IS GONE, replaced by
 *   `invoice.parent.subscription_details.subscription`, which is also where the
 *   subscription's metadata is copied at invoice time. The scaffold has already
 *   been bitten by the sibling of this change — `invoice.payment_intent` was
 *   removed in 2025-03-31.basil and the subscription checkout simply stopped
 *   producing a client secret.
 *
 * NOTHING HERE DECIDES ANYTHING. It maps Stripe's shape onto a flat record with
 * no Stripe types in it, which is what lets the writer that consumes it — the
 * one both a webhook and a simulated subscription go through — never import
 * Stripe at all.
 */

/**
 * The event types a subscription mirror must be subscribed to.
 *
 * EXPORTED SO A TEST CAN ASSERT IT AGAINST `registry.handledTypes()`. An event
 * enabled on the Stripe endpoint with no handler is delivered, ledgered and
 * discarded in silence; a handler for an event the endpoint does not send is
 * dead code that reads like coverage. The list is the contract between the two.
 *
 * WHY THE INVOICE EVENTS ARE HERE AT ALL, given that
 * `customer.subscription.updated` fires on the same transitions. Because it
 * does not always arrive, and because these two carry the transitions that
 * matter most: `invoice.paid` is the renewal — the moment the period moves —
 * and `invoice.payment_failed` is the moment dunning starts. Both handlers
 * re-read the subscription and go through the same writer, so they are a second
 * chance at the same truth rather than a second opinion about it.
 */
export const SUBSCRIPTION_EVENT_TYPES = [
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
] as const satisfies readonly Stripe.Event["type"][];

/** One Stripe subscription, flattened, with no Stripe types left in it. */
export interface StripeSubscriptionSnapshot {
  readonly subscriptionId: string;
  readonly customerId: string | null;
  /**
   * Stripe's own status string, UNMAPPED.
   *
   * Deliberately not narrowed here: `mapStripeSubscriptionStatus` in
   * @adminigloo/billing is the one place that decides what an unrecognised
   * status means, and it takes `string` precisely so a value Stripe invents
   * next year has an answer. Narrowing it in this package would make that
   * function's default branch look dead.
   */
  readonly status: string;
  readonly currentPeriodStart: Date | null;
  readonly currentPeriodEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly canceledAt: Date | null;
  readonly trialEndsAt: Date | null;
  /** The Price the subscription bills against. NULL for a subscription with no items. */
  readonly priceId: string | null;
  /** `month` / `year`. NULL for any other cadence, which this scaffold does not sell. */
  readonly interval: "month" | "year" | null;
  readonly currency: string | null;
  readonly quantity: number;
  /**
   * The metadata written at creation time. `withTenantMetadata` puts `tenantId`
   * on the Subscription as well as the Session, because a Session's metadata
   * does NOT propagate to the object it creates — which is the whole reason a
   * subscription event can be attributed to a tenant at all.
   */
  readonly metadata: Readonly<Record<string, string>>;
}

/** Stripe's epoch seconds as a Date. NULL stays NULL; 0 is not a date. */
function fromUnix(seconds: number | null | undefined): Date | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return new Date(seconds * 1000);
}

/** An expandable field as an id, whether it came back expanded or not. */
function idOf(value: string | { readonly id: string } | null | undefined): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (value && typeof value === "object" && typeof value.id === "string") return value.id;
  return null;
}

/**
 * Flatten a Stripe subscription into the record the mirror writes from.
 *
 * THE FIRST ITEM IS THE SUBSCRIPTION'S PERIOD, and that is an assumption worth
 * naming rather than hiding. Stripe moved `current_period_*` onto the item
 * because a subscription may bill several items on different cycles; every
 * subscription this scaffold creates has exactly one item, so the first one's
 * period is the subscription's. A project that starts selling multi-item
 * subscriptions has to revisit this function — and it is one function, which is
 * the point of it existing.
 *
 * `canceled_at` is carried as Stripe sets it, which for a scheduled
 * cancellation is the time of the REQUEST rather than the end of the period.
 * That distinction is why `subscriptions` has both `canceled_at` and
 * `cancel_at_period_end`: collapsing them is how a customer who scheduled a
 * cancellation gets locked out mid-period having paid for the rest of it.
 */
export function subscriptionSnapshot(
  subscription: Stripe.Subscription,
): StripeSubscriptionSnapshot {
  const item = subscription.items.data[0];
  const price = item?.price;
  const recurring = price?.recurring?.interval;

  return {
    subscriptionId: subscription.id,
    customerId: idOf(subscription.customer),
    status: subscription.status,
    currentPeriodStart: fromUnix(item?.current_period_start),
    currentPeriodEnd: fromUnix(item?.current_period_end),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    canceledAt: fromUnix(subscription.canceled_at),
    trialEndsAt: fromUnix(subscription.trial_end),
    priceId: price?.id ?? null,
    // Written as two literal branches rather than as a narrowed passthrough.
    // Stripe types the interval as `'day' | 'week' | 'month' | 'year' |
    // OtherString`, and `OtherString` is `string & {}` — which overlaps every
    // literal, so narrowing by comparison hands back the open type and a
    // cadence this scaffold cannot sell would flow into the column.
    interval: recurring === "month" ? "month" : recurring === "year" ? "year" : null,
    currency: price?.currency ?? subscription.currency ?? null,
    // Stripe omits `quantity` on metered items. One is the honest default for a
    // plan subscription, which is always a single seat of a single tier.
    quantity: item?.quantity ?? 1,
    metadata: subscription.metadata,
  };
}

/**
 * The subscription an invoice belongs to, or NULL for a one-off invoice.
 *
 * `invoice.subscription` was removed; the link now hangs off `parent`, which
 * also distinguishes a subscription invoice from a quote's. Returning NULL
 * rather than throwing is correct: invoices genuinely exist with no
 * subscription behind them, and a handler that threw on one would wedge the
 * endpoint over an event it was never meant to act on.
 */
export function subscriptionIdFromInvoice(invoice: Stripe.Invoice): string | null {
  return idOf(invoice.parent?.subscription_details?.subscription);
}
