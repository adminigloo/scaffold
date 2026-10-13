import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { isResurrection, shouldApplyEvent, verifyIdentityWebhook } from "__SCOPE__/auth";
import { identityWebhookEvents, users } from "__SCOPE__/auth/schema";
import {
  rateLimitHeaders,
  RATE_LIMIT_POLICIES,
} from "__SCOPE__/observability";
import { resolveRequestId } from "__SCOPE__/observability/request";
import { db } from "@/db";
import { env } from "@/env";
import { reportError } from "@/server/error-reporter";
import { limiter } from "@/server/rate-limit";
import { tenancy } from "@/server/tenancy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Identity mirror webhook — and, since Tenancy 1, one of the two places a new
 * person is set up and the one place a deleted person loses their access.
 *
 * MUST read the raw body. Calling req.json() here breaks signature
 * verification, and the failure looks like a wrong secret rather than a wrong
 * read, which is a long afternoon.
 *
 * THE ORDER OF THE SAFETY CHECKS is deliberate and unchanged: the signature
 * first (a stranger can't spend anything), then the rate limit (only once we
 * know it's Clerk), then the work, with any failure of OURS reported and
 * answered 500 so Clerk redelivers.
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
    /**
     * CLAIM THE EVENT FIRST, IN THE LEDGER (PC-20). Clerk retries, and a
     * retry of an event that already ran must not run it again — setting a
     * person up twice, or deprovisioning someone a second time after a
     * re-sign-up. The row is keyed on Clerk's own event id; `processed_at` is
     * stamped only once the work committed, so an attempt that crashed halfway
     * is run again on the next delivery instead of being mistaken for done.
     */
    await db
      .insert(identityWebhookEvents)
      .values({ eventId: event.id, type: event.type, payload: body })
      .onConflictDoNothing();
    const [ledger] = await db
      .select({ processedAt: identityWebhookEvents.processedAt })
      .from(identityWebhookEvents)
      .where(eq(identityWebhookEvents.eventId, event.id));
    if (ledger?.processedAt) {
      return NextResponse.json({ received: true, skipped: "duplicate" });
    }

    const outcome = await applyEvent(event);

    await db
      .update(identityWebhookEvents)
      .set({ processedAt: new Date() })
      .where(eq(identityWebhookEvents.eventId, event.id));

    return NextResponse.json(outcome === "applied" ? { received: true } : { received: true, skipped: outcome });
  } catch (error) {
    // Recorded on the ledger row too, so "why does this person have nothing"
    // is answerable from the database: the attempts count and the last error,
    // the message only (no payload, no address).
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    try {
      await db
        .update(identityWebhookEvents)
        .set({
          attempts: sql`((${identityWebhookEvents.attempts})::int + 1)::text`,
          lastError: message,
        })
        .where(eq(identityWebhookEvents.eventId, event.id));
    } catch {
      // The database being down is usually why we're here; the report below
      // still goes to the log.
    }
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

type IdentityEvent = NonNullable<ReturnType<typeof verifyIdentityWebhook>>;

/**
 * Apply one verified event to the users table, then set the person up or
 * take their access away.
 */
async function applyEvent(event: IdentityEvent): Promise<"applied" | "stale" | "deleted"> {
  const existing = await db.query.users.findFirst({
    where: eq(users.externalId, event.externalId),
  });

  // Delivery is not ordered and Clerk retries. Applying an event older than
  // what the row already reflects overwrites newer data with stale data, and
  // nothing about the result looks wrong afterwards. A deletion always
  // applies — Clerk sends it with no timestamp, and it is final.
  if (existing && !shouldApplyEvent(event, existing.providerUpdatedAt)) return "stale";

  // A late or retried create/update after the account was deleted must not
  // bring it back: its access was taken away, and a resurrected row would
  // quietly sign it back in.
  if (isResurrection(event, existing)) return "deleted";

  if (event.type === "user.deleted") {
    let target = existing;
    if (!target) {
      // A DELETION FOR SOMEONE WE HAVE NO ROW FOR IS STILL RECORDED (review
      // R2 SEC-T1-G). Delivery is unordered and retried: a user.created that
      // failed (a deploy mid-migration) is redelivered AFTER the account's
      // deletion. With nothing written here, that late create found no row,
      // made a LIVE one for an account that no longer exists, provisioned it —
      // and if its address was BOOTSTRAP_ADMIN_EMAIL, made it the
      // administrator, locking the founder's real account out. A tombstone
      // (deleted, stamped now) makes isResurrection refuse every later
      // create or update for this Clerk user.
      const [tombstone] = await db
        .insert(users)
        .values({
          externalId: event.externalId,
          deletedAt: new Date(),
          providerUpdatedAt: event.providerUpdatedAt ?? new Date(),
        })
        .onConflictDoNothing({ target: [users.identityProvider, users.externalId] })
        .returning();
      if (tombstone) return "applied";
      // The first page request mirrored the row a moment ago: delete that one.
      target = await db.query.users.findFirst({ where: eq(users.externalId, event.externalId) });
    }
    if (target) {
      // Soft delete. A hard delete makes a late user.updated unreconcilable,
      // and the row comes back as a duplicate. Stamped with when we RECEIVED
      // it when Clerk sent no time, so the row never reads as undated.
      await db
        .update(users)
        .set({ deletedAt: new Date(), providerUpdatedAt: event.providerUpdatedAt ?? new Date() })
        .where(eq(users.id, target.id));
      // THE ACCESS GOES WITH THE ACCOUNT: staff roles removed, memberships
      // suspended, the operator console told the owner's account is gone. A
      // company is never handed over automatically; staff do that from the
      // company's page.
      await tenancy.deprovisionUser({ userId: target.id });
    }
    return "applied";
  }

  const values = {
    externalId: event.externalId,
    // Only ever a VERIFIED address (see @__SCOPE_NAME__/auth), because this
    // column decides who becomes the first administrator and whom an
    // invitation is for.
    email: event.email,
    displayName: event.displayName,
    imageUrl: event.imageUrl,
    providerUpdatedAt: event.providerUpdatedAt,
  };

  let row;
  if (existing) {
    [row] = await db.update(users).set(values).where(eq(users.id, existing.id)).returning();
  } else {
    [row] = await db
      .insert(users)
      .values(values)
      // The first page request may have mirrored the row a moment ago.
      .onConflictDoNothing({ target: [users.identityProvider, users.externalId] })
      .returning();
    row ??= await db.query.users.findFirst({ where: eq(users.externalId, event.externalId) });
  }

  // SET THE PERSON UP, if the page hasn't already (Tenancy 1). The same call
  // the first page request makes; whichever arrives first does it, the other
  // finds the stamp. Re-running it after a user.updated is cheap and also
  // gives a freshly verified BOOTSTRAP_ADMIN_EMAIL its administrator role.
  if (row && row.deletedAt === null) {
    await tenancy.provisionUser({ userId: row.id, email: row.email });
  }
  return "applied";
}
