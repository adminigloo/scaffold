import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import {
  claimStatements,
  createEventRegistry,
  decideClaim,
  DEFAULT_CLAIM_LEASE_MS,
  tenantIdFromEvent,
  verifyStripeSignature,
} from "__SCOPE__/stripe";
import { stripeEvents } from "__SCOPE__/stripe/schema";
import {
  rateLimitHeaders,
  RATE_LIMIT_POLICIES,
} from "__SCOPE__/observability";
import { resolveRequestId } from "__SCOPE__/observability/request";
import { db } from "@/db";
import { env } from "@/env";
import { reportError } from "@/server/error-reporter";
import { limiter } from "@/server/rate-limit";
import { fulfilPurchase } from "@/server/fulfilment";
import { stripe } from "@/server/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Register one handler per event type.
 *
 * ONE canonical writer per invariant. trailcards creates orders from BOTH
 * checkout.session.completed AND payment_intent.succeeded, with each handler
 * checking whether the other already ran — two writers racing on one row. Pick
 * the event that is authoritative for each effect and let the other be a
 * reconciliation signal that may repair a record but never create one.
 */
const registry = createEventRegistry();

/**
 * The money arrived. Book the order.
 *
 * THIS HANDLER OWNS NO LOGIC. Every decision — the price, the order number, the
 * grants, the audit row, the idempotency — lives in `fulfilPurchase`, and the
 * "Simulate purchase" button on the checkout page calls the identical function
 * with `source: "simulated"`. That shared call site is the whole design: a
 * deployment with no Stripe keys exercises the real fulfilment path every day,
 * so the first real payment runs code that has already worked a hundred times.
 *
 * Anything that reads the PaymentIntent and writes its own order row breaks
 * that, however small it looks. Extend `fulfilPurchase`, not this function.
 *
 * WHY THE THROWS BELOW ARE CORRECT. A malformed or missing metadata field means
 * money moved and this application cannot say what for. Throwing releases the
 * claim (see the protocol under POST) and answers 500, so Stripe redelivers and
 * the event sits visibly in the dashboard's failed queue until a human looks.
 * Swallowing it would return 200, Stripe would stop retrying, and the customer
 * would be charged for an order that was never recorded and never will be.
 */
registry.on("payment_intent.succeeded", async (event) => {
  const intent = event.data.object;
  const metadata = intent.metadata;

  const tenantId = metadata["tenantId"];
  const variantId = metadata["variantId"];
  const rawQuantity = metadata["quantity"];

  if (!tenantId || !variantId || !rawQuantity) {
    throw new Error(
      `payment_intent.succeeded ${intent.id} is missing the metadata needed to ` +
        `book an order (tenantId, variantId, quantity). It was not created by ` +
        `checkout.createIntent — reconcile it by hand before refunding.`,
    );
  }

  // Stripe stringifies every metadata value, so this is always a string on the
  // way back out and always needs parsing. Base 10 explicitly: a quantity that
  // somehow arrived as "0x10" must not silently become sixteen.
  const quantity = Number.parseInt(rawQuantity, 10);
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error(
      `payment_intent.succeeded ${intent.id} carries quantity "${rawQuantity}", ` +
        `which is not a positive integer.`,
    );
  }

  await fulfilPurchase({
    variantId,
    quantity,
    // NULL is a supported value: `orders.user_id` is nullable for guest
    // checkout. An empty-string metadata field is not the same thing, so it is
    // normalised here rather than written as a user id nothing can join to.
    userId: metadata["userId"] || null,
    tenantId,
    // THE PAYMENT INTENT ID IS THE REFERENCE. It is the one identifier that is
    // stable across every redelivery of this event, which is what makes the
    // unique index on `(tenant_id, idempotency_key)` do its job. The event id
    // would not: Stripe can emit more than one event for one payment, and each
    // carries a different id, so keying on it would book the same sale twice.
    reference: intent.id,
    source: "stripe",
  });
});

/**
 * Stripe webhook receiver.
 *
 * MUST read the raw body: req.json() breaks signature verification, and the
 * failure presents as a wrong secret rather than a wrong read.
 *
 * The claim protocol, in full, because getting it wrong is silent:
 *
 *   1. INSERT ... ON CONFLICT DO NOTHING RETURNING  — a returned row means WE
 *      claimed it. No in-process memory, no race.
 *   2. If nothing came back, read processed_at and claimed_at to tell "already
 *      done" from "in flight" from "abandoned by a dead instance".
 *   3. Run the handler. On success stamp processed_at. On failure RELEASE the
 *      claim and answer 500 so Stripe redelivers within seconds.
 *
 * Step 3's release is what stops a thrown handler from wedging the event
 * forever. Without it every retry sees an unfinished row, defers, and Stripe
 * disables the endpoint after three days — taking every other event with it.
 */
export async function POST(req: Request): Promise<Response> {
  if (!stripe || !env.STRIPE_WEBHOOK_SECRET) {
    return new NextResponse("billing not configured", { status: 503 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) return new NextResponse("missing signature", { status: 400 });

  const body = await req.text();

  let event;
  try {
    // `stripe.stripe` is the raw SDK; the wrapper carries appUrl and the pinned
    // API version alongside it.
    event = verifyStripeSignature(body, signature, env.STRIPE_WEBHOOK_SECRET, stripe.stripe);
  } catch {
    return new NextResponse("bad signature", { status: 400 });
  }

  /**
   * Bounded, and bounded AFTER the signature check on purpose.
   *
   * Keyed by provider, not by caller: Stripe delivers from a pool of addresses
   * and a per-address limit would bound nothing. That only works once the
   * caller is known to be Stripe — limiting ahead of verification would let
   * anyone on the internet spend the budget and have genuine payment events
   * refused, which is a denial of service with a 429 in front of it.
   *
   * What is bounded is a redelivery storm, not abuse. Stripe queues while an
   * endpoint is down and drains the queue all at once, and every event in it is
   * a claim insert plus a fulfilment transaction. A 429 is the correct answer:
   * Stripe retries with exponential backoff for three days, so nothing is lost,
   * it is spread out. Answering 200 to shed load would be the version of this
   * that loses money — the event never comes back.
   */
  const verdict = await limiter.limit({
    key: "webhook:stripe",
    policy: RATE_LIMIT_POLICIES.webhook,
  });
  if (!verdict.allowed) {
    return new NextResponse("slow down", {
      status: 429,
      headers: rateLimitHeaders(verdict, RATE_LIMIT_POLICIES.webhook),
    });
  }

  const tenantId = tenantIdFromEvent(event);

  // Step 1 — claim atomically. Written inline rather than through
  // `claimStatements.insert` because Drizzle parameterises its own template;
  // the exported SQL is the canonical reference for what this must do, and any
  // divergence between the two is a bug in this file.
  const inserted = await db.execute(
    sql`INSERT INTO stripe_events (event_id, type, tenant_id, payload, claimed_at, attempts)
        VALUES (${event.id}, ${event.type}, ${tenantId}, ${JSON.stringify(event)}::jsonb, now(), 1)
        ON CONFLICT (event_id) DO NOTHING
        RETURNING event_id`,
  );

  const insertedRow = (inserted as unknown as { rows: unknown[] }).rows.length === 1;

  let existingProcessedAt: Date | null = null;
  let existingClaimedAt: Date | null = null;
  if (!insertedRow) {
    const [row] = await db
      .select({
        processedAt: stripeEvents.processedAt,
        claimedAt: stripeEvents.claimedAt,
      })
      .from(stripeEvents)
      .where(eq(stripeEvents.eventId, event.id))
      .limit(1);
    existingProcessedAt = row?.processedAt ?? null;
    existingClaimedAt = row?.claimedAt ?? null;
  }

  const outcome = decideClaim({
    insertedRow,
    existingProcessedAt,
    existingClaimedAt,
    leaseMs: DEFAULT_CLAIM_LEASE_MS,
  });

  if (outcome.action === "skip-duplicate") {
    return NextResponse.json({ received: true, duplicate: true });
  }

  if (outcome.action === "retry-later") {
    // 500, deliberately. Another instance owns this row and is still inside
    // its lease; a 200 here would tell Stripe the work succeeded.
    return new NextResponse("in flight", { status: 500 });
  }

  if (outcome.reclaimed) {
    // Take over an abandoned claim. The `processed_at IS NULL` guard makes us
    // lose the race to an owner who finished between our read and this write,
    // which is the correct outcome — better a skipped takeover than a handler
    // run twice against a paid event.
    const retaken = await db.execute(
      sql`UPDATE stripe_events
          SET claimed_at = now(), attempts = attempts + 1
          WHERE event_id = ${event.id} AND processed_at IS NULL
          RETURNING event_id`,
    );
    if ((retaken as unknown as { rows: unknown[] }).rows.length === 0) {
      return NextResponse.json({ received: true, duplicate: true });
    }
  }

  try {
    await registry.dispatch(event);
    await db
      .update(stripeEvents)
      .set({ processedAt: new Date(), claimedAt: null, lastError: null })
      .where(eq(stripeEvents.eventId, event.id));
    return NextResponse.json({ received: true });
  } catch (error) {
    // REPORTED BEFORE THE RELEASE, because the release itself is a database
    // write and the reason a handler failed is very often that the database is
    // unreachable. Reporting second would lose exactly the errors that matter
    // most. `reportError` never throws, so it cannot displace the 500 below.
    //
    // `stripe_events.last_error` keeps the message for the operator staring at
    // one stuck event; this keeps the fingerprint, the count and the stack for
    // whoever is asking why fulfilment has been failing all afternoon. They
    // answer different questions and neither replaces the other.
    await reportError({
      error,
      source: "webhook",
      url: req.url,
      tenantId,
      requestId: resolveRequestId(req.headers),
      context: { provider: "stripe", eventType: event.type, eventId: event.id },
    });

    // Release the claim so the very next delivery re-claims immediately,
    // rather than waiting out the lease.
    await db
      .update(stripeEvents)
      .set({
        claimedAt: null,
        lastError: error instanceof Error ? error.message : String(error),
      })
      .where(eq(stripeEvents.eventId, event.id));
    return new NextResponse("handler failed", { status: 500 });
  }
}
