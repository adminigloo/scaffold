import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createdAt } from "@adminigloo/db";

/**
 * Every webhook Stripe has delivered to us, keyed on Stripe's own event id.
 *
 * THE LEDGER IS THE IDEMPOTENCY MECHANISM, not a debugging aid. riddler-go
 * tracks "did I just insert this event" in a process-local `Set`, which cannot
 * survive a cold serverless instance and — worse — returns the wrong answer on
 * the FIRST delivery of every event, because the Set is empty on a fresh
 * instance. Its route still answers 200, so Stripe records the delivery as
 * successful, never retries, and the event is gone. A row in Postgres is the
 * only shared memory a serverless fleet actually has.
 *
 * trailcards has no ledger at all and infers duplicates from business keys,
 * with BOTH `checkout.session.completed` and `payment_intent.succeeded`
 * creating orders and cross-checking each other. Two writers for one invariant;
 * the interleaving that produces two orders is rare enough to reach production
 * and common enough to reach a customer.
 */
export const stripeEvents = pgTable(
  "stripe_events",
  {
    /**
     * Stripe's `evt_…` id, used directly as the primary key.
     *
     * Not a UUID with the Stripe id beside it: the primary key IS the
     * uniqueness claim we need, and `INSERT … ON CONFLICT (event_id) DO NOTHING`
     * only works if the database enforces it. A surrogate key would let two
     * concurrent deliveries of the same event both insert.
     */
    eventId: text("event_id").primaryKey(),
    type: text("type").notNull(),
    /**
     * Which tenant the event belongs to, read out of the metadata we set at
     * session creation. Nullable because Stripe knows nothing about our
     * tenants: account-level events (`payout.paid`, `charge.dispute.created`)
     * genuinely have no tenant, and inventing one would be a lie in the audit
     * trail.
     */
    tenantId: text("tenant_id"),
    /**
     * The verified event exactly as Stripe sent it.
     *
     * Deliberately left untyped rather than `$type<Stripe.Event>()`. A row
     * written a year ago was rendered at that day's API version and the shape
     * is frozen at write time; typing the column as today's union would invite
     * a replay job to destructure fields the stored payload never had.
     */
    payload: jsonb("payload").notNull(),
    receivedAt: createdAt(),
    /**
     * Set ONLY after the handler has returned successfully.
     *
     * Separate from `received_at` because `received_at` alone cannot
     * distinguish "in flight" from "done". With one timestamp, a handler that
     * crashed halfway is indistinguishable from one that finished, so the
     * retry Stripe is about to send gets skipped as a duplicate and the work is
     * silently lost — which makes an event log worse than no event log, because
     * it looks like coverage.
     */
    processedAt: timestamp("processed_at", { withTimezone: true }),
    /**
     * When the current attempt took ownership of this row. NULL means the row
     * is unclaimed and the next delivery may take it.
     *
     * WITHOUT THIS COLUMN THE LEDGER WEDGES. Claim the row, run the handler,
     * handler throws, answer 500 so Stripe retries — and the retry now finds a
     * row that exists with `processed_at` still null. "Someone else is
     * mid-flight" and "the instance that owned this died an hour ago" are the
     * same observation, so the retry defers, and so does every retry after it.
     * Stripe gives up after ~3 days and disables the endpoint, taking every
     * other event type with it. The ledger would have reintroduced the exact
     * silent loss it exists to prevent.
     *
     * Two mechanisms clear it. A handler that throws releases the claim
     * immediately, so the next delivery re-claims within seconds. A process
     * that dies mid-handler releases nothing, so the claim ages out against
     * `DEFAULT_CLAIM_LEASE_MS`.
     */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    /**
     * Incremented on each delivery that reaches the handler. Stripe retries a
     * failing endpoint for up to three days; a row sitting at attempts 12 with
     * `processed_at` still null is the alert, and there is nowhere else to see
     * it — Stripe's dashboard shows the delivery, not our failure.
     *
     * Written by `claimStatements.insert` and `claimStatements.reclaim`. A
     * column nothing increments is a promise of an alert that can never fire.
     */
    attempts: integer("attempts").notNull().default(0),
    /** Written by `claimStatements.release` when a handler throws. */
    lastError: text("last_error"),
  },
  (t) => [
    index("stripe_events_tenant_received_idx").on(t.tenantId, t.receivedAt),
    /**
     * The stuck-events query: unprocessed rows, oldest first. Partial, because
     * the healthy case is that almost every row has `processed_at` set and an
     * index over all of them would be mostly dead weight.
     */
    index("stripe_events_unprocessed_idx")
      .on(t.receivedAt)
      .where(sql`${t.processedAt} is null`),
  ],
);

export const stripeSchema = { stripeEvents };
