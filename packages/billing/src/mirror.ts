import type { SubscriptionStatus } from "./status.js";

/**
 * The two decisions a subscription mirror has to make before it writes, both as
 * pure functions with no database and no Stripe types in them.
 *
 * THE FIRM OWNS THE `subscriptions` TABLE, which is what makes this module
 * necessary rather than fussy. A table that merely caches a provider can be
 * wrong for a while and repaired by the next read; a table that is
 * AUTHORITATIVE is wrong until somebody notices, and everything downstream —
 * what the customer is told they pay, what they are entitled to, whether the
 * product serves them at all — is wrong with it. So the two ways a mirror
 * corrupts its own table are answered here, where they can be exercised
 * exhaustively:
 *
 *   ORDERING     an event that describes an older state must never overwrite a
 *                newer one that has already been applied.
 *   ACCESS       what each subscription state does to the entitlement rows the
 *                plan granted, including the states where the honest answer is
 *                "keep the rows and stop counting them".
 *
 * Neither belongs in the webhook route. A route is reachable only through a
 * signed request with a live database behind it, so a rule written there is a
 * rule nothing tests — and both of these are rules whose failure is silent.
 */

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

export type SubscriptionWriteDecision =
  | { readonly action: "apply" }
  | { readonly action: "skip"; readonly why: string };

export interface SubscriptionWriteInput {
  /**
   * When the state being described was observed. For a webhook this is
   * `event.created`; for a resync it is the instant the object was fetched.
   *
   * NOT THE INSTANT WE RECEIVED IT, and that is the whole point of the
   * parameter. Stripe delivers out of order and redelivers for three days, so
   * arrival order is the one candidate that is definitely wrong: a
   * `customer.subscription.updated` from ten seconds ago can arrive after the
   * one that superseded it, and a mirror keyed on arrival would take a live
   * subscription back to `trialing` — or take a cancelled one back to `active`
   * and serve somebody who has stopped paying.
   */
  readonly observedAt: Date;
  /**
   * Does this observation say the subscription is over for good?
   *
   * `customer.subscription.deleted` is terminal AT STRIPE: no further event can
   * be emitted for that subscription id, because the object no longer changes.
   * It is carried separately from the timestamp because it is what breaks the
   * one tie `observedAt` cannot — see below.
   */
  readonly observedTerminal: boolean;
  /** `subscriptions.last_event_at`. NULL means this row has never been written. */
  readonly storedAt: Date | null;
  /** Is the row we already hold in that terminal state? */
  readonly storedTerminal: boolean;
}

/**
 * May this observation be written over the one already stored?
 *
 * WHICH TIMESTAMP, AND WHY IT IS NOT THE OBVIOUS ONE. Stripe hands a webhook
 * three candidate clocks and they are not equally trustworthy:
 *
 *   `subscription.created`   the instant the subscription began. Identical on
 *                            every event that subscription will ever emit, so
 *                            it orders nothing at all. It is the one that looks
 *                            like a version and is not.
 *   arrival time (`now()`)   the order the deliveries reached us. This is the
 *                            quantity being defended AGAINST: it is scrambled
 *                            by retries, by redelivery after an outage, and by
 *                            two instances receiving two events at once.
 *   `event.created`          the instant Stripe generated the event, which is
 *                            the instant the change happened. It is the only
 *                            one that moves with the state and is fixed for a
 *                            given change however many times it is redelivered.
 *
 * So the watermark is `event.created`, stored on the row beside the state it
 * justified. An event older than the watermark is dropped, and dropping it is
 * the correct outcome rather than a lost update: whatever it describes has
 * already been superseded by something we have applied.
 *
 * THE RESIDUE, STATED PLAINLY. `event.created` has one-second resolution, so
 * two changes inside the same second are ordered by arrival after all. That is
 * accepted for every pair of states except the one where it matters: a
 * subscription Stripe has DELETED cannot be resurrected by an event of the same
 * second, because there is no state after deletion. Hence `observedTerminal` —
 * a tie is won by the terminal observation and lost by everything else. For the
 * rest, the staff resync is the repair, and it is stamped with the instant it
 * read Stripe so it always wins.
 *
 * REDELIVERY OF THE SAME EVENT NEVER REACHES HERE. `stripe_events` claims each
 * delivery by id and answers a second one with `skip-duplicate`, so equality of
 * timestamps here is always two DIFFERENT events, never the same one twice.
 */
export function decideSubscriptionWrite(
  input: SubscriptionWriteInput,
): SubscriptionWriteDecision {
  // Nothing stored: the first observation of a subscription is always the
  // newest one we have.
  if (input.storedAt === null) return { action: "apply" };

  const observed = input.observedAt.getTime();
  const stored = input.storedAt.getTime();

  if (observed < stored) {
    return {
      action: "skip",
      why:
        `This observation is from ${input.observedAt.toISOString()} and the row ` +
        `already holds one from ${input.storedAt.toISOString()}. Stripe delivers ` +
        `out of order and redelivers for three days; applying it would take the ` +
        `subscription back to a state it has already left.`,
    };
  }

  if (observed === stored && input.storedTerminal && !input.observedTerminal) {
    return {
      action: "skip",
      why:
        `Stripe has deleted this subscription and this observation, from the ` +
        `same second, says it is still running. Deletion is terminal at Stripe ` +
        `— no state follows it — so the tie goes to the delete rather than to ` +
        `whichever delivery happened to arrive second.`,
    };
  }

  return { action: "apply" };
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/**
 * How long access survives a failed payment, when nothing else ends it first.
 *
 * `isEntitledStatus` refuses to call `past_due` entitled, and says why: "past
 * due entitles you" has no expiry, so a subscription that never recovers serves
 * for ever and nobody notices because the product keeps working. It also says
 * where the answer belongs — "a dunning policy with an END DATE" — and this is
 * that date. `entitlements.expires_at` is the column designed to carry it, so
 * the grace is expressed as a real deadline on the real rows rather than as a
 * status the resolver has to be taught to forgive.
 *
 * Fourteen days is sized against Stripe's own retry schedule, which makes four
 * attempts over roughly three weeks before moving the subscription to `unpaid`
 * or cancelling it. The authoritative end of a dunning cycle is therefore
 * Stripe's own transition, which arrives as an event and cuts access at once;
 * this is the backstop for the cycle whose final event never reaches us, which
 * is precisely the failure a firm-owned billing table cannot detect by itself.
 */
export const PAST_DUE_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

export interface EntitlementWindow {
  /**
   * Does the tenant hold the plan's entitlement rows at all?
   *
   * FALSE ONLY FOR A SUBSCRIPTION THAT HAS ENDED. Every other state keeps the
   * rows and moves the deadline, because the rows carry `used_value` — a
   * customer who has spent 400 of 500 exports has still spent 400 while their
   * card is being retried, and deleting the row to withhold access would hand
   * the allowance back the moment the payment succeeded.
   */
  readonly holds: boolean;
  /**
   * What `entitlements.expires_at` becomes on every `plan`-sourced row.
   *
   * NULL means never — the ordinary state of a paid, renewing subscription. A
   * date in the future is access that ends by itself, which is what makes a
   * missed webhook survivable: the tenant stops being served on the day they
   * stopped paying for, with no event required.
   */
  readonly expiresAt: Date | null;
  /** Is the tenant served at `at`? Derived; carried so callers do not re-derive it. */
  readonly serving: boolean;
  /** One sentence for the audit row and the resync log. */
  readonly why: string;
}

export interface EntitlementWindowInput {
  readonly status: SubscriptionStatus;
  readonly cancelAtPeriodEnd: boolean;
  readonly currentPeriodEnd: Date | null;
  /** The instant this state was observed — the same one the watermark carries. */
  readonly at: Date;
  /** Overridable so the dunning window is testable without waiting a fortnight. */
  readonly graceMs?: number;
}

/**
 * What a subscription's state does to the entitlement rows its plan granted.
 *
 * TWO ORTHOGONAL ANSWERS, WHICH IS WHY THIS IS NOT A BOOLEAN. "Which rows
 * should exist" and "are they live right now" are different questions with
 * different consequences, and collapsing them is how a suspended customer loses
 * their usage counters: `planGrantDiff` owns the first, `expires_at` owns the
 * second, and only the first one ever deletes anything.
 *
 * THE STATES, AND WHAT EACH ONE COSTS TO GET WRONG:
 *
 *   trialing / active            served, no deadline. The ordinary case.
 *   …with cancel_at_period_end   served TO THE PERIOD END and no further. This
 *                                is the one the brief calls a support ticket if
 *                                you get it wrong in either direction: cutting
 *                                access the moment somebody schedules a
 *                                cancellation takes away time they have already
 *                                paid for, and leaving it open relies on a
 *                                `deleted` event that may never arrive. A
 *                                deadline on the row does both correctly with
 *                                no event at all.
 *   past_due                     served for the dunning window. The card
 *                                bounced, Stripe is retrying, and the customer
 *                                is real. `describeSubscription` already tells
 *                                them "access continues in the meantime, and
 *                                stops if the retries run out" — so anything
 *                                else here makes the product lie to them.
 *   unpaid                       not served, from now. Every retry has failed
 *                                and Stripe has stopped; there is nothing left
 *                                to wait for. Rows stay, so settling the
 *                                invoice restores the allowance AND its usage.
 *   incomplete                   not served. The first payment never completed,
 *                                so nothing has been paid for. The rows are
 *                                written anyway and expired, which is what
 *                                makes a checkout that is finished an hour
 *                                later a single UPDATE.
 *   canceled                     the rows go. `planGrantDiff(current, null)` is
 *                                what removes them, and it removes only rows
 *                                whose source is `plan` — an add-on the
 *                                customer bought separately survives.
 *
 * THE EARLIER DEADLINE WINS when two apply. A past-due subscription that is
 * also scheduled to cancel is served until the sooner of the two, because both
 * are real bounds and honouring the later one would extend access past a date
 * the customer was already told about.
 */
export function subscriptionEntitlementWindow(
  input: EntitlementWindowInput,
): EntitlementWindow {
  const grace = input.graceMs ?? PAST_DUE_GRACE_MS;
  const at = input.at;

  const served = (expiresAt: Date | null, why: string): EntitlementWindow => ({
    holds: true,
    expiresAt,
    // The same closed boundary `resolveEntitlements` uses: a grant is expired
    // AT the instant it expires. The open form leaves a state that is
    // unreachable in production and permanently flaky in a test.
    serving: expiresAt === null || expiresAt.getTime() > at.getTime(),
    why,
  });

  switch (input.status) {
    case "canceled":
      return {
        holds: false,
        expiresAt: null,
        serving: false,
        why:
          "The subscription has ended, so the rows it granted are removed. " +
          "Anything sourced from an add-on or an admin grant is untouched.",
      };

    case "unpaid":
      return served(
        at,
        "Every retry on the outstanding invoice has failed and Stripe has " +
          "stopped trying, so access ends now. The rows stay — with their " +
          "used_value — so settling the invoice restores the allowance rather " +
          "than resetting it.",
      );

    case "incomplete":
      return served(
        at,
        "The first payment has not completed, so nothing has been paid for " +
          "and nothing is served. The rows exist so that finishing the " +
          "checkout is an update rather than an insert.",
      );

    case "past_due":
    case "trialing":
    case "active": {
      const deadlines: Date[] = [];

      if (input.status === "past_due") {
        deadlines.push(new Date(at.getTime() + grace));
      }

      if (input.cancelAtPeriodEnd) {
        // `?? at` is unreachable for a live subscription — only `incomplete`
        // has no period, and it never gets here — but a missing period must
        // not become "unlimited access". A bound we cannot read is a bound we
        // do not honour, and the safe reading of that is now.
        deadlines.push(input.currentPeriodEnd ?? at);
      }

      if (deadlines.length === 0) {
        return served(
          null,
          input.status === "trialing"
            ? "Trialling and renewing, so the plan's rows are live with no deadline."
            : "Paid and renewing, so the plan's rows are live with no deadline.",
        );
      }

      // Non-null: the array is only reachable non-empty, and the reduce keeps
      // the earlier of two real dates.
      const earliest = deadlines.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));

      if (input.status === "past_due") {
        return served(
          earliest,
          input.cancelAtPeriodEnd
            ? `A payment failed and a cancellation is scheduled. Access runs to ` +
                `${earliest.toISOString()}, the sooner of the dunning window and ` +
                `the end of the paid period.`
            : `A payment failed and Stripe is retrying. Access runs to ` +
                `${earliest.toISOString()}, after which the dunning window is ` +
                `over whether or not the closing event ever reaches us.`,
        );
      }

      return served(
        earliest,
        `This subscription will not renew. Everything it grants keeps working ` +
          `until ${earliest.toISOString()} and then stops by itself, with no ` +
          `further event required.`,
      );
    }
  }
}
