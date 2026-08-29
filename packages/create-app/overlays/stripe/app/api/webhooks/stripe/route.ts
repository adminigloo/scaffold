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
import { db } from "@/db";
import { env } from "@/env";
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

registry.on("payment_intent.succeeded", async (event) => {
  // Your effect here. It runs at most once per event id, and if it throws the
  // claim is released so the next delivery retries it — see below.
  void event;
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
