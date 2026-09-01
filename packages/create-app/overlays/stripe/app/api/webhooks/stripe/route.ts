import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { mapStripeSubscriptionStatus } from "__SCOPE__/billing";
import {
  claimStatements,
  createEventRegistry,
  decideClaim,
  DEFAULT_CLAIM_LEASE_MS,
  subscriptionIdFromInvoice,
  subscriptionSnapshot,
  SUBSCRIPTION_EVENT_TYPES,
  tenantIdFromEvent,
  verifyStripeSignature,
  assertEventLivemode,
} from "__SCOPE__/stripe";
import { stripeEvents } from "__SCOPE__/stripe/schema";
import {
  createLogger,
  rateLimitHeaders,
  RATE_LIMIT_POLICIES,
} from "__SCOPE__/observability";
import { resolveRequestId } from "__SCOPE__/observability/request";
import { resolveAppEnv } from "__SCOPE__/env";
import { db } from "@/db";
import { env } from "@/env";
import { reportError } from "@/server/error-reporter";
import { limiter } from "@/server/rate-limit";
import { fulfilPurchase } from "@/server/fulfilment";
import { stripe } from "@/server/stripe";
import {
  applySubscription,
  resolvePlanForSubscription,
  PLAN_METADATA_KEY,
} from "@/server/subscription";

/**
 * Deliveries this route decided not to act on go to the same structured sink as
 * everything else. They are not errors — a recurring shop product's
 * subscription and a renewal PaymentIntent are both perfectly ordinary events
 * that another mechanism owns — but "why did nothing happen" is a question
 * somebody asks with a customer on the phone, and it has to be answerable from
 * the logs rather than from this file.
 */
const logger = createLogger({ level: env.LOG_LEVEL });

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

  /**
   * A PaymentIntent with NO METADATA AT ALL was not created by this
   * application, and the only thing that creates one here is Stripe itself:
   * every renewal of a subscription opens an invoice and collects it through a
   * fresh PaymentIntent, which inherits nothing. Booking an order for it is
   * impossible — there is no variant and no quantity — and throwing would be
   * worse than impossible: every renewal, of every subscription, for ever,
   * would fail this handler, Stripe would retry each one for three days and
   * then disable the endpoint, taking the events that DO matter with it.
   *
   * So it is recorded and skipped, and the skip is safe because another
   * mechanism owns it. A renewal's money is accounted for by the subscription
   * mirror below, which moves the period and keeps the entitlements alive off
   * `invoice.paid` and `customer.subscription.updated`.
   *
   * THE STRICT PATH BELOW IS UNCHANGED, and the distinction is exact: an intent
   * carrying SOME of the metadata and not the rest is one this application
   * created and mis-stamped, money moved, and nothing can say what for. That is
   * still loud.
   */
  if (!tenantId && !variantId && !rawQuantity) {
    logger.info(
      { paymentIntentId: intent.id, eventId: event.id },
      "payment_intent.succeeded carries none of our metadata — a subscription " +
        "renewal collected by Stripe. The subscription mirror owns it; no order " +
        "is booked.",
    );
    return;
  }

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
 * THE SUBSCRIPTION MIRROR.
 *
 * Five events, one writer. `customer.subscription.created`, `.updated` and
 * `.deleted` carry the subscription itself; `invoice.paid` and
 * `invoice.payment_failed` carry the renewal and the payment failure, and both
 * re-read the subscription rather than writing anything of their own. Every one
 * of them ends in the same `applySubscription` call the "Simulate a
 * subscription" button makes, which is the property that lets the whole
 * mechanism be exercised on a laptop with no Stripe account.
 *
 * *** OUT OF ORDER IS THE NORMAL CASE, NOT THE EDGE CASE. *** Stripe delivers
 * concurrently and redelivers for three days, so a `customer.subscription.
 * updated` describing a state the customer left ten seconds ago routinely
 * arrives after the one that replaced it. `event.created` is carried into
 * `applySubscription` as `observedAt` and compared against the watermark on the
 * row — see `decideSubscriptionWrite`, which explains why that timestamp and
 * not the other two Stripe offers. A stale delivery writes nothing and answers
 * 200: it is not a failure, and asking Stripe to send it again would only
 * repeat the no-op.
 *
 * WHY THE INVOICE EVENTS RE-READ THE SUBSCRIPTION rather than writing the
 * period off the invoice. An invoice knows its own period and nothing else —
 * not the status, not whether a cancellation is scheduled — so a handler that
 * wrote from it would be a SECOND writer with a partial view, and the two would
 * disagree the first time a renewal and a cancellation happened in the same
 * minute. One `subscriptions.retrieve` buys the whole state, and the retrieve
 * is authoritative by construction: it returns what Stripe holds right now.
 */
async function mirrorSubscription(
  subscription: Stripe.Subscription,
  event: Stripe.Event,
): Promise<void> {
  const snapshot = subscriptionSnapshot(subscription);
  const resolution = await resolvePlanForSubscription({
    planMetadata: snapshot.metadata[PLAN_METADATA_KEY],
    variantMetadata: snapshot.metadata["variantId"],
    priceId: snapshot.priceId,
    interval: snapshot.interval,
    currency: snapshot.currency,
  });

  if (resolution.kind !== "plan") {
    // Recorded and skipped, never thrown. A recurring PRODUCT is somebody
    // else's mechanism and an unattributable subscription is somebody's
    // dashboard experiment; failing either would retry for three days and cost
    // the endpoint. `warn` for the unknown one because it is the one that might
    // be a mistake worth chasing.
    const line = {
      subscriptionId: snapshot.subscriptionId,
      eventId: event.id,
      eventType: event.type,
      why: resolution.why,
    };
    if (resolution.kind === "product") {
      logger.info(line, "Not a plan subscription — the order path owns it.");
    } else {
      logger.warn(line, "A subscription this application cannot attribute.");
    }
    return;
  }

  /**
   * THE TENANT IS THE ONE THING THAT CANNOT BE RECOVERED, so its absence is
   * loud — the same call `payment_intent.succeeded` makes two handlers up, for
   * the same reason. Stripe has no concept of our tenants: the only source is
   * the metadata `withTenantMetadata` stamps onto the Subscription at creation,
   * which it does precisely because a Session's metadata does NOT propagate to
   * the object it creates. A subscription that resolves to a plan and names no
   * tenant is money arriving for a customer this application cannot identify,
   * and swallowing it would leave the firm's own billing table silently short a
   * paying subscriber.
   *
   * The cost is honest: the delivery fails, Stripe retries, and the event sits
   * in the dashboard's failed queue until a human either fixes the metadata or
   * mirrors it by hand from the resync screen. That is the intended outcome.
   */
  const tenantId = snapshot.metadata["tenantId"];
  if (!tenantId) {
    throw new Error(
      `${event.type} for ${snapshot.subscriptionId} resolves to plan ` +
        `"${resolution.planKey}" and carries no tenantId, so there is nobody to ` +
        `record it against. It was not created by subscribeToPlan — reconcile ` +
        `it by hand before the customer notices.`,
    );
  }

  const result = await applySubscription({
    tenantId,
    tierKey: resolution.tierKey,
    planKey: resolution.planKey,
    stripeSubscriptionId: snapshot.subscriptionId,
    stripeCustomerId: snapshot.customerId,
    // Mapped, never copied. `mapStripeSubscriptionStatus` is total over every
    // string Stripe can send, including the ones it has not invented yet, and
    // its default DENIES service rather than granting it.
    status: mapStripeSubscriptionStatus(snapshot.status),
    currentPeriodStart: snapshot.currentPeriodStart,
    currentPeriodEnd: snapshot.currentPeriodEnd,
    cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
    canceledAt: snapshot.canceledAt,
    trialEndsAt: snapshot.trialEndsAt,
    // THE WATERMARK. Seconds since the epoch, as Stripe stamped the event.
    observedAt: new Date(event.created * 1000),
    observedBy: event.id,
    source: "stripe",
  });

  if (!result.applied) {
    logger.info(
      { subscriptionId: snapshot.subscriptionId, eventId: event.id, why: result.why },
      "Stale subscription event ignored — the row already holds a newer state.",
    );
  }
}

/**
 * The subscription's own lifecycle. One handler, registered three times.
 *
 * The three events differ only in which state they carry, and the writer reads
 * the state off the object rather than off the event type — so `deleted` needs
 * no special case here: it arrives with `status: "canceled"`, and the window
 * function is what turns that into "remove the plan's entitlement rows".
 * Branching on the type would put the same decision in two places, and the
 * second copy is the one that forgets `cancel_at_period_end`.
 */
for (const type of [
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
] as const) {
  registry.on(type, async (event) => {
    await mirrorSubscription(event.data.object, event);
  });
}

/**
 * The renewal, and the failed payment.
 *
 * `invoice.paid` is the moment the period moves and `invoice.payment_failed` is
 * the moment dunning begins, and both matter enough to be handled even though
 * `customer.subscription.updated` fires alongside them. They are a second
 * chance at the same truth rather than a second opinion about it: each one
 * re-reads the subscription and goes through the one writer, so an update that
 * was lost, delayed or delivered out of order is repaired by the invoice event
 * that follows it.
 *
 * A one-off invoice has no subscription and is skipped — `parent` is null on
 * one, and returning is correct rather than defensive.
 */
for (const type of ["invoice.paid", "invoice.payment_failed"] as const) {
  registry.on(type, async (event) => {
    const subscriptionId = subscriptionIdFromInvoice(event.data.object);
    if (subscriptionId === null) return;

    // Unreachable: POST refuses with 503 before dispatching when the client is
    // absent. Written out because the alternative is a non-null assertion on a
    // value that really can be null in this module's type.
    if (!stripe) return;

    // A plain retrieve is enough. The period lives on the ITEM now and the
    // items come back inline, and `SubscriptionItem.price` is a full Price
    // object rather than an expandable id — which is what
    // `resolvePlanForSubscription` matches on when a subscription carries no
    // metadata of ours.
    const subscription = await stripe.stripe.subscriptions.retrieve(subscriptionId);
    await mirrorSubscription(subscription, event);
  });
}

/**
 * Every subscription event this route answers for, checked against the list the
 * package publishes.
 *
 * An event enabled on the Stripe endpoint with no handler is delivered,
 * ledgered and discarded in silence; a handler for an event nobody sends is
 * dead code that reads like coverage. Asserting at module load rather than in a
 * test is the same choice `assertPermissionScopes` makes: the cost is one array
 * comparison on cold start, and the failure it prevents is invisible.
 */
{
  const handled = new Set(registry.handledTypes());
  const missing = SUBSCRIPTION_EVENT_TYPES.filter((type) => !handled.has(type));
  if (missing.length > 0) {
    throw new Error(
      `The Stripe webhook registers no handler for ${missing.join(", ")}. ` +
        `@__SCOPE_NAME__/stripe publishes SUBSCRIPTION_EVENT_TYPES as the list a ` +
        `subscription mirror must cover, and a gap in it is a subscription that ` +
        `keeps billing while this application's own tables say something else.`,
    );
  }
}

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
   * The mode check `assertKeyMode` cannot make, and the reason this route calls
   * it rather than trusting the signature.
   *
   * A signature only proves the body came from Stripe. It says nothing about
   * WHICH Stripe: a test-mode endpoint secret pasted into a production
   * deployment verifies perfectly, and so does a live-mode one pasted into
   * staging. The second is the dangerous direction — every real payment made
   * against the live account would be fulfilled by a deployment holding test
   * keys, booking real orders, issuing real licence keys and granting real
   * entitlements from a database nobody treats as authoritative.
   *
   * `assertKeyMode` cannot see this, because a `whsec_` carries no mode in its
   * prefix; the only place the mode is legible is `livemode` on the delivered
   * event. `@adminigloo/stripe` has exported `assertEventLivemode` for exactly
   * this since it was written, documented as the gap it closes, and this route
   * never called it — so the guarantee existed in a package and nowhere a
   * request passed through.
   *
   * 400, not 500. A mismatched event is a configuration error at the OTHER end,
   * and Stripe should stop retrying it rather than queue it for days.
   */
  try {
    assertEventLivemode(event, resolveAppEnv());
  } catch (error) {
    logger.error(
      { eventId: event.id, eventType: event.type, livemode: event.livemode },
      "refused a Stripe event whose mode does not match this environment",
    );
    void reportError({
      error,
      source: "webhook",
      requestId: resolveRequestId(req.headers),
      context: { provider: "stripe", eventId: event.id, eventType: event.type },
    });
    return new NextResponse("livemode mismatch", { status: 400 });
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
