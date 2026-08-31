import { checkEntitlement, resolveEntitlements } from "__SCOPE__/billing";
import type {
  EntitlementSource,
  ResolvedEntitlement,
  SubscriptionStatus,
} from "__SCOPE__/billing";

/**
 * WHAT THE CUSTOMER ACCOUNT AREA DECIDES, with no database in the room.
 *
 * Every screen under `/account` is a read of rows `fulfilPurchase` was already
 * writing, so almost nothing here is machinery — it is judgement about what
 * those rows MEAN, and judgement is exactly where this goes wrong quietly. A
 * subscription that says "renews" to somebody who cancelled, an unlimited
 * allowance rendered as zero, a shipment row with three NULLs in it presented
 * as a parcel in transit: each is one wrong branch, each is invisible to a type
 * checker, and each reaches a paying customer.
 *
 * SEPARATED FROM `src/server/account.ts` FOR THAT REASON AND ONLY THAT REASON.
 * That module holds the three queries; this one holds the decisions, so they
 * can be exercised without a Postgres connection, a Stripe key or a request
 * context — which is what lets them run in the workspace's own suite rather
 * than only inside a generated project. The same division `src/storefront.ts`
 * has against `src/server/fulfilment.ts`.
 *
 * The module ships only with the account overlay, which is to say only in
 * projects that sell something.
 */

// ---------------------------------------------------------------------------
// Where one order lives
// ---------------------------------------------------------------------------

/**
 * One order's URL, built from the number on its receipt.
 *
 * A FUNCTION FOR THE DYNAMIC ROUTE AND NOTHING FOR THE STATIC ONES. `/account`,
 * `/account/orders` and `/account/billing` are written out literally wherever
 * they are linked, because a constant would hide them from the two guards that
 * keep this project's links honest: both walk the emitted source for a literal
 * `href`, and a route reachable only through an imported identifier is
 * invisible to them. The scaffold has already shipped a live storefront that
 * nothing linked to, and a sidebar with two dead links in it.
 *
 * `encodeURIComponent` rather than raw interpolation. `formatOrderNumber`
 * produces `ORD-20260831-000001-42`, which needs no encoding today — and that
 * is exactly the reason to encode it: `ORDER_NUMBER_PREFIX` is a constant a
 * project is invited to change, and the first prefix carrying a slash or a
 * space would split the value across path segments and 404 the receipt it
 * named. That failure reads as a lost order rather than as a mislinked one.
 */
export function accountOrderHref(orderNumber: string): string {
  return `/account/orders/${encodeURIComponent(orderNumber)}`;
}

// ---------------------------------------------------------------------------
// Allowances
// ---------------------------------------------------------------------------

/** One `entitlements` row as the account area renders it. */
export interface GrantedEntitlement {
  readonly feature: string;
  /** NULL is unlimited. Not unknown, and not zero. */
  readonly limitValue: number | null;
  readonly usedValue: number;
  readonly source: EntitlementSource;
  /** NULL never expires. */
  readonly expiresAt: Date | null;
  /** The fulfilment reference that paid for it, recovered from `source_ref`. */
  readonly reference: string;
}

/** One feature, summed across every grant this person holds. */
export interface AccountMeter {
  readonly feature: string;
  readonly resolved: ResolvedEntitlement;
  /** True once the resolver says there is nothing left to spend. */
  readonly exhausted: boolean;
}

/**
 * Collapse a person's grant rows into one figure per feature.
 *
 * THROUGH `resolveEntitlements` AND `checkEntitlement`, not through arithmetic
 * written here. Two grants can name the same feature — a base allowance and a
 * bonus — and the rules for adding them up are not obvious: an unlimited row
 * wins the feature outright, an expired row drops out whole INCLUDING its
 * usage, and `remaining` clamps at zero while `used` deliberately does not, so
 * an overage stays visible instead of tidying itself away. Every one of those
 * is a decision @__SCOPE_NAME__/billing already made and tests, and a page that
 * summed `limitValue` itself would be a second, quieter answer that disagrees
 * with the one the server enforces at the moment of spending.
 *
 * Those two functions had ZERO CALLERS in this scaffold before this overlay.
 * The resolver, its expiry boundary and its overage rules were written, tested
 * and never asked a question by anything.
 *
 * `now` is a parameter for the same reason the resolver takes one: every meter
 * on the page must be measured against a single instant, or a grant can expire
 * halfway down a render.
 */
export function metersFor(
  grants: readonly GrantedEntitlement[],
  now: Date = new Date(),
): readonly AccountMeter[] {
  const resolved = resolveEntitlements(grants, now);
  return [...resolved.entries()]
    .map(([feature, value]) => ({
      feature,
      resolved: value,
      // The same predicate the write path is gated on, asked of the same map.
      // Rendering "nothing left" from `remaining === 0` would be a third
      // opinion about a question two other places already answer.
      exhausted: checkEntitlement(resolved, feature).reason === "limit-reached",
    }))
    .sort((a, b) => a.feature.localeCompare(b.feature));
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export type DeliveryStage = "preparing" | "despatched" | "delivered";

export interface Delivery {
  readonly stage: DeliveryStage;
  readonly carrier: string | null;
  readonly trackingNumber: string | null;
  readonly shippedAt: Date | null;
  readonly deliveredAt: Date | null;
}

/**
 * What an `order_shipments` row means, as three states rather than four nulls.
 *
 * The row is inserted by the `ship` grant with carrier, tracking and
 * `shipped_at` all NULL, and @__SCOPE_NAME__/commerce is explicit about why:
 * the row exists so a warehouse queue has something to pick up, not to claim
 * anything moved. Rendering those NULLs directly would tell a customer their
 * carrier is "—", which reads as missing information about a parcel in transit
 * rather than as a parcel that has not been packed. Naming the state is the
 * whole job.
 *
 * `delivered_at` outranks `shipped_at` rather than requiring both. They are
 * written by two different processes, a delivery confirmation can land without
 * a despatch one, and "being prepared" for a parcel already in somebody's hands
 * is the worse of the two errors.
 */
export function deliveryStageOf(row: {
  readonly shippedAt: Date | null;
  readonly deliveredAt: Date | null;
}): DeliveryStage {
  if (row.deliveredAt !== null) return "delivered";
  if (row.shippedAt !== null) return "despatched";
  return "preparing";
}

// ---------------------------------------------------------------------------
// What a subscription's state means, in one sentence
// ---------------------------------------------------------------------------

export type SubscriptionTone = "info" | "warn" | "danger";

export interface SubscriptionBanner {
  readonly tone: SubscriptionTone;
  readonly title: string;
  readonly body: string;
}

/** The five columns that all modify the same sentence. */
export interface SubscriptionState {
  readonly status: SubscriptionStatus;
  readonly currentPeriodEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly canceledAt: Date | null;
  readonly trialEndsAt: Date | null;
}

/**
 * ONE BANNER, CHOSEN BY STATE. Never two, and never a badge per column.
 *
 * `subscriptions` carries five fields that each modify the same sentence —
 * `status`, `current_period_end`, `cancel_at_period_end`, `canceled_at` and
 * `trial_ends_at` — and a page that renders one control per field asks the
 * reader to combine them. They will combine them wrongly, because the
 * interesting combinations are the rare ones: a trialling subscription already
 * scheduled to cancel, a past-due subscription still inside its paid period.
 * Collapsing the five into a single ordered decision is what makes the screen
 * readable, and putting that decision in a pure function is what makes it
 * testable without a database.
 *
 * ORDER IS THE ENTIRE LOGIC. `cancel_at_period_end` is checked before the
 * ordinary renewal line, because "renews on the 3rd" and "ends on the 3rd" are
 * the same date and opposite facts — and a customer who scheduled a
 * cancellation and is then told their subscription renews will cancel their
 * card instead, which turns a clean exit into a failed payment and a dunning
 * email. Payment failure outranks both, because it is the only state with
 * something for the customer to do.
 *
 * `now` is a parameter, and the boundary is closed the same way the entitlement
 * resolver closes its expiry: a trial is over at the instant it ends. The open
 * form leaves a state that is unreachable in production and permanently flaky
 * in tests.
 */
export function describeSubscription(
  subscription: SubscriptionState,
  now: Date = new Date(),
): SubscriptionBanner {
  // Never a bare interpolation. All five columns are nullable — a subscription
  // that has not completed its first payment has no period at all — and a
  // template literal over one of them prints "null" onto a billing page.
  const on = (date: Date | null): string =>
    date === null ? "a date we do not hold" : formatDay(date);

  if (subscription.status === "canceled") {
    return {
      tone: "info",
      title: "This subscription has ended",
      body:
        `It stopped on ${on(subscription.canceledAt ?? subscription.currentPeriodEnd)}. ` +
        "Nothing further will be charged, and starting again begins a new billing period.",
    };
  }

  if (subscription.status === "past_due") {
    return {
      tone: "danger",
      title: "A payment did not go through",
      body:
        "The card on file was declined. Update it and the outstanding invoice " +
        "is retried automatically — access continues in the meantime, and " +
        "stops if the retries run out.",
    };
  }

  if (subscription.status === "unpaid") {
    return {
      tone: "danger",
      title: "Collection has stopped on this subscription",
      body:
        "Every retry on the outstanding invoice has failed, so nothing further " +
        "will be attempted automatically. Settling it from the billing portal " +
        "restarts the subscription.",
    };
  }

  if (subscription.status === "incomplete") {
    return {
      tone: "warn",
      title: "This subscription has not started yet",
      body:
        "Its first payment has not completed, so nothing has been charged and " +
        "nothing has been granted. Finishing the checkout starts it.",
    };
  }

  // Scheduled cancellation, whether trialling or paid. BEFORE the trial and
  // renewal lines below: the same date means the opposite thing here.
  if (subscription.cancelAtPeriodEnd) {
    return {
      tone: "warn",
      title: `This subscription ends on ${on(subscription.currentPeriodEnd)}`,
      body:
        "It will not renew. Everything it grants keeps working until that date, " +
        "and resuming before then leaves the billing period untouched.",
    };
  }

  if (
    subscription.status === "trialing" &&
    subscription.trialEndsAt !== null &&
    subscription.trialEndsAt.getTime() > now.getTime()
  ) {
    return {
      tone: "info",
      title: `The trial ends on ${on(subscription.trialEndsAt)}`,
      body:
        "The card on file is charged when it does, unless the subscription is " +
        "cancelled first. Cancelling during a trial costs nothing.",
    };
  }

  return {
    tone: "info",
    title: `Renews on ${on(subscription.currentPeriodEnd)}`,
    body:
      "The card on file is charged automatically on that date. Payment methods, " +
      "past invoices and cancellation are all in the billing portal.",
  };
}

/**
 * A date a customer can read, in UTC.
 *
 * `en-GB` and an explicit UTC zone rather than the host's locale, for the
 * reason `formatOrderNumber` gives about `utcDay`: this renders on whichever
 * serverless region happened to be warm, and a renewal date that reads 2 March
 * from one region and 3 March from another is a support ticket about a charge
 * on the wrong day. The customer's own timezone would be better still and
 * cannot be known on the server — which is precisely why it is not guessed.
 */
export function formatDay(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}
