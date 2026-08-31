import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { shouldApplyEvent, verifyIdentityWebhook } from "__SCOPE__/auth";
import { users } from "__SCOPE__/auth/schema";
import {
  rateLimitHeaders,
  RATE_LIMIT_POLICIES,
} from "__SCOPE__/observability";
import { resolveRequestId } from "__SCOPE__/observability/request";
import { db } from "@/db";
import { env } from "@/env";
import { reportError } from "@/server/error-reporter";
import { limiter } from "@/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Identity mirror webhook.
 *
 * MUST read the raw body. Calling req.json() here breaks signature
 * verification, and the failure looks like a wrong secret rather than a wrong
 * read, which is a long afternoon.
 */
export async function POST(req: Request): Promise<Response> {
  // No signing secret configured yet. 503, not 500: this is a deployment that
  // has not finished being set up, not a request that went wrong. Returning 200
  // would be worse — Clerk would record the delivery as successful and never
  // retry it once the secret is actually set.
  if (!env.CLERK_WEBHOOK_SIGNING_SECRET) {
    return new NextResponse("identity webhook not configured", { status: 503 });
  }

  const body = await req.text();
  const headers = Object.fromEntries(req.headers.entries());

  let event;
  try {
    event = verifyIdentityWebhook(body, headers, env.CLERK_WEBHOOK_SIGNING_SECRET);
  } catch {
    // NOT REPORTED, deliberately. A bad signature is an unauthenticated caller
    // — anyone on the internet can produce one — so recording it would let a
    // stranger write rows into the error log at will. A rejected signature is a
    // security event, not a bug in this application.
    return new NextResponse("bad signature", { status: 400 });
  }

  // An event type we do not handle. 200, so Clerk stops retrying it.
  if (!event) return NextResponse.json({ received: true });

  /**
   * Bounded, and bounded AFTER the signature check on purpose.
   *
   * The budget is keyed by provider rather than by caller, because Clerk
   * delivers from a pool of addresses and a per-address limit would bound
   * nothing. That only works once the caller is known to be Clerk: limiting
   * ahead of verification would let anyone on the internet spend the budget and
   * have genuine events refused, which is a denial of service with a 429 in
   * front of it.
   *
   * What is being bounded is not abuse. It is a redelivery storm after an
   * outage — Clerk queues, the queue drains all at once, and several hundred
   * mirror writes a second arrive at a database that has just come back.
   * Refusing with a 429 is the right answer to that: Clerk retries with
   * backoff, so the events are not lost, they are spread out.
   */
  const verdict = await limiter.limit({
    key: "webhook:clerk",
    policy: RATE_LIMIT_POLICIES.webhook,
  });
  if (!verdict.allowed) {
    return new NextResponse("slow down", {
      status: 429,
      headers: rateLimitHeaders(verdict, RATE_LIMIT_POLICIES.webhook),
    });
  }

  /**
   * Everything past verification is OUR code failing, not the caller's.
   *
   * The webhook is how a user rename, an email change or a deletion reaches
   * this application, and a throw in here previously escaped as an unhandled
   * 500: Clerk retried a few times, gave up, and the local row stayed stale
   * for ever with nothing recorded anywhere. Now the failure is a row in the
   * error log with the event on it, and the 500 is deliberate so Clerk keeps
   * redelivering while somebody looks at it.
   */
  try {
    const existing = await db.query.users.findFirst({
      where: eq(users.externalId, event.externalId),
    });

    // Delivery is not ordered and Clerk retries. Applying an event older than
    // what the row already reflects overwrites newer data with stale data, and
    // nothing about the result looks wrong afterwards.
    if (existing && !shouldApplyEvent(event, existing.providerUpdatedAt)) {
      return NextResponse.json({ received: true, skipped: "stale" });
    }

    if (event.type === "user.deleted") {
      if (existing) {
        // Soft delete. A hard delete makes a late user.updated unreconcilable,
        // and the row comes back as a duplicate.
        await db
          .update(users)
          .set({ deletedAt: new Date(), providerUpdatedAt: event.providerUpdatedAt })
          .where(eq(users.id, existing.id));
      }
      return NextResponse.json({ received: true });
    }

    const values = {
      externalId: event.externalId,
      email: event.email,
      displayName: event.displayName,
      imageUrl: event.imageUrl,
      providerUpdatedAt: event.providerUpdatedAt,
      deletedAt: null,
    };

    if (existing) {
      await db.update(users).set(values).where(eq(users.id, existing.id));
    } else {
      await db.insert(users).values(values);
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    // Awaited rather than left floating: this handler is about to answer 500
    // and the platform may freeze the invocation the moment it does, which
    // would drop the report for the failure that caused it.
    await reportError({
      error,
      source: "webhook",
      url: req.url,
      requestId: resolveRequestId(req.headers),
      // No email and no name. The context column is kept for a year and this
      // is the identity provider's payload; the external id is enough to find
      // the person again in Clerk.
      context: {
        provider: "clerk",
        eventType: event.type,
        externalId: event.externalId,
      },
    });
    return new NextResponse("identity webhook failed", { status: 500 });
  }
}
