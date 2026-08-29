/**
 * The subscription statuses this package stores.
 *
 * A closed union, deliberately smaller than Stripe's. Stripe's list is theirs
 * to extend — `paused` arrived long after the rest — and a column that mirrors
 * it means every value Stripe invents lands in our database before any code
 * knows what it means. Mapping through `mapStripeSubscriptionStatus` is what
 * keeps the set of things `isEntitledStatus` has to reason about finite.
 */
export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "incomplete";

/**
 * The statuses that occupy a tenant's one live-subscription slot.
 *
 * Must match the predicate on `subscriptions_tenant_live_idx` exactly. The
 * database enforces "at most one" over that set; if the query that loads "the
 * current subscription" selects a different set, the invariant is enforced on
 * one list and read through another, and the row the code picks is not
 * necessarily the row the index protected.
 *
 * Everything except `canceled` — including `incomplete`, so a second checkout
 * cannot start while the first is still collecting its first payment.
 */
export const LIVE_SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "incomplete",
] as const satisfies readonly SubscriptionStatus[];

/**
 * Stripe's subscription status, mapped to ours. TOTAL: every input has an
 * answer, including inputs that do not exist yet.
 *
 * Takes `string`, not `Stripe.Subscription.Status`. Typing the parameter as
 * Stripe's union makes the default branch look dead, so the next person tidying
 * up deletes it — precisely when it matters. The value arrives out of a webhook
 * payload rendered at whatever API version that endpoint is pinned to, which is
 * not the version the installed types describe. Taking `string` also keeps this
 * package off the `stripe` peer dependency for a nine-line switch.
 *
 * THE DEFAULT IS NOT `active`. An unrecognised status resolves to `unpaid`,
 * which denies service: defaulting to active hands the product to someone whose
 * payment state we cannot read, and it is the friendly-looking default, so it
 * gets written by accident. `unpaid` rather than `canceled` because canceled is
 * a terminal fact that fires cancellation email and offboarding, while this is
 * "we do not know, so do not serve" — which the next, correct webhook undoes.
 */
export function mapStripeSubscriptionStatus(stripeStatus: string): SubscriptionStatus {
  switch (stripeStatus) {
    case "trialing":
    case "active":
    case "past_due":
    case "canceled":
    case "unpaid":
    case "incomplete":
      return stripeStatus;

    /**
     * The first payment never succeeded and Stripe will not retry it. Dead, not
     * pending: leaving it `incomplete` would keep the row inside the live set
     * the partial unique index protects, and the tenant could never start a new
     * subscription — the failed checkout would block every later one.
     */
    case "incomplete_expired":
      return "canceled";

    /**
     * Collection is paused: a trial ended with no payment method, or someone
     * set `pause_collection`. Not entitled, and deliberately not `past_due` —
     * past_due drives dunning, and telling a customer whose collection WE
     * paused that their payment failed is a lie that arrives by email.
     */
    case "paused":
      return "unpaid";

    default:
      return "unpaid";
  }
}

/**
 * Does this status entitle the tenant to paid features?
 *
 * `trialing` and `active`, nothing else. `past_due` is the one people want to
 * add — the customer is real, the card just bounced, cutting them off feels
 * harsh. That belongs in a dunning policy with an end date, not here: "past due
 * entitles you" has no expiry, so a subscription that never recovers serves
 * forever, and nobody notices because the product keeps working.
 */
export function isEntitledStatus(status: SubscriptionStatus): boolean {
  return status === "trialing" || status === "active";
}

/** Does this status occupy the tenant's one live-subscription slot? */
export function isLiveStatus(status: SubscriptionStatus): boolean {
  // Widened to string[] because the tuple's element type excludes `canceled`,
  // and `includes` would then reject the very argument this asks about.
  return (LIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(status);
}
