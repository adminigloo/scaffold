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
 * projects that sell something. What an ORDER means (its link, its delivery)
 * is the shop's, in src/account-orders.ts, in a project with a shop.
 */

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

  // ENDED BY ITS OWN DATE (review): free months, or a cancellation whose
  // period is over before Stripe's closing event has landed. Free months get
  // no closing event at all, so the date is what ends them — and "ends on" a
  // day already gone, with "everything keeps working until that date", is
  // wrong the day after it.
  if (endedByDate(subscription, now)) {
    return {
      tone: "info",
      title: `This subscription ended on ${on(subscription.currentPeriodEnd)}`,
      body: "Nothing further will be charged. Choosing a plan below starts a new one.",
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
 * The ONE thing this screen offers to do about the subscription.
 *
 * `portal` and `settle` are separate kinds even though both open Stripe's
 * hosted portal, because the sentence under the button is the whole value of
 * the control: "your card was declined, update it and the invoice is retried"
 * and "change your card, address or VAT number" send different people to the
 * same place for different reasons, and a single generic label makes the
 * urgent case look optional.
 */
export type SubscriptionActionKind = "cancel" | "resume" | "settle" | "portal" | "none";

export interface SubscriptionAction {
  readonly kind: SubscriptionActionKind;
  /** The button. Empty for `none`, which renders no button at all. */
  readonly label: string;
  /** One sentence under it, saying what pressing it does. */
  readonly hint: string;
  /**
   * Does pressing it change what is charged? Drives the confirm step, and
   * nothing else — the permission is what decides whether it is offered.
   */
  readonly consequential: boolean;
}

/**
 * ONE PRIMARY ACTION, CHOSEN BY STATE. Never a row of buttons that are mostly
 * disabled.
 *
 * The same argument `describeSubscription` makes about the banner, applied to
 * the controls: `subscriptions` carries five fields that all bear on what the
 * customer should do next, and a screen that renders Cancel, Resume, Change
 * plan and Update card together — three of them greyed out — asks the reader to
 * work out which one their situation calls for. They will get it wrong in the
 * rare combinations, which are precisely the ones that matter: a past-due
 * subscription that is also scheduled to cancel, a trial somebody wants to stop
 * before it charges.
 *
 * THE ORDER IS THE LOGIC, and it is the banner's order for the same reasons.
 * Payment failure outranks everything, because it is the only state with money
 * at stake and something the customer can personally fix. A scheduled
 * cancellation outranks the ordinary case, because "resume" and "cancel" on the
 * same screen is how somebody who has already cancelled cancels again and
 * concludes it did not work.
 *
 * A CANCELLED SUBSCRIPTION OFFERS NOTHING HERE, deliberately. Its action is to
 * start a new one, which is choosing a plan rather than pressing a button — so
 * the page renders the plan list instead, and a "Resubscribe" button that
 * scrolled the reader somewhere else would be a control that does nothing.
 */
export function primaryActionFor(
  subscription: SubscriptionState,
  now: Date = new Date(),
  /**
   * Free months an operator gave (billing 0.3): a subscription with no Stripe
   * object, outside simulated mode. They end on their own date; "keep this
   * subscription" would turn them into a plan that never ends and is never
   * paid (review C1), so the way to keep going is choosing a plan.
   */
  options: { readonly freeMonths?: boolean } = {},
): SubscriptionAction {
  if (subscription.status === "canceled") {
    return {
      kind: "none",
      label: "",
      hint:
        "This subscription has ended. Choosing a plan below starts a new one, " +
        "with a new billing period.",
      consequential: false,
    };
  }

  if (subscription.status === "past_due" || subscription.status === "unpaid") {
    return {
      kind: "settle",
      label: "Update payment method",
      hint:
        subscription.status === "past_due"
          ? "The card on file was declined. Updating it retries the outstanding " +
            "invoice straight away, and access continues in the meantime."
          : "Every retry has failed, so nothing further is attempted " +
            "automatically. Settling the invoice from the portal restarts the " +
            "subscription.",
      consequential: false,
    };
  }

  if (subscription.status === "incomplete") {
    return {
      kind: "settle",
      label: "Finish paying",
      hint:
        "The first payment has not completed, so nothing has been charged and " +
        "nothing has been granted. Finishing the checkout starts the subscription.",
      consequential: false,
    };
  }

  // Over by its own date (see `describeSubscription`): nothing to resume or
  // cancel — choosing a plan is the way back, and the page shows the plans.
  if (endedByDate(subscription, now)) {
    return {
      kind: "none",
      label: "",
      hint: "This subscription has ended. Choosing a plan below starts a new one, with a new billing period.",
      consequential: false,
    };
  }

  // Before the ordinary cancel, and before the trial line. Somebody who has
  // already scheduled a cancellation and is offered "Cancel subscription" will
  // press it again and then wonder which of the two took effect.
  if (subscription.cancelAtPeriodEnd && options.freeMonths === true) {
    return {
      kind: "none",
      label: "",
      hint: "These are free months, and they end on their own date. To keep going after that, choose a plan below.",
      consequential: false,
    };
  }

  if (subscription.cancelAtPeriodEnd) {
    return {
      kind: "resume",
      label: "Keep this subscription",
      hint:
        "Cancels the scheduled cancellation. The billing period is untouched, " +
        "so nothing is charged today and the next renewal goes ahead as normal.",
      consequential: true,
    };
  }

  const trialling =
    subscription.status === "trialing" &&
    subscription.trialEndsAt !== null &&
    // Closed boundary, matching the banner and the entitlement resolver: a
    // trial is over at the instant it ends.
    subscription.trialEndsAt.getTime() > now.getTime();

  return {
    kind: "cancel",
    label: "Cancel subscription",
    hint: trialling
      ? "Cancelling during a trial costs nothing and takes effect at the end of " +
        "the trial. Everything keeps working until then."
      : "It stops renewing at the end of the period you have already paid for. " +
        "Nothing is refunded and nothing is cut off early.",
    consequential: true,
  };
}

/**
 * A subscription set to end at its period's end, and that end has come: over,
 * whatever its status still says (free months are never closed by an event;
 * a cancellation's closing event can lag). Closed boundary, as the entitlement
 * resolver's: over AT the instant.
 */
export function endedByDate(subscription: SubscriptionState, now: Date = new Date()): boolean {
  return (
    subscription.cancelAtPeriodEnd &&
    subscription.currentPeriodEnd !== null &&
    subscription.currentPeriodEnd.getTime() <= now.getTime() &&
    (subscription.status === "active" || subscription.status === "trialing")
  );
}

/**
 * A date a customer can read, in UTC.
 *
 * `en-US` ("March 2, 2026") and an explicit UTC zone rather than the host's locale, for the
 * reason `formatOrderNumber` gives about `utcDay`: this renders on whichever
 * serverless region happened to be warm, and a renewal date that reads 2 March
 * from one region and 3 March from another is a support ticket about a charge
 * on the wrong day. The customer's own timezone would be better still and
 * cannot be known on the server — which is precisely why it is not guessed.
 */
export function formatDay(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}
