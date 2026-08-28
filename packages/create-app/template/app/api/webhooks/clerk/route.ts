import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { shouldApplyEvent, verifyIdentityWebhook } from "__SCOPE__/auth";
import { users } from "__SCOPE__/auth/schema";
import { db } from "@/db";
import { env } from "@/env";

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
  const body = await req.text();
  const headers = Object.fromEntries(req.headers.entries());

  let event;
  try {
    event = verifyIdentityWebhook(body, headers, env.CLERK_WEBHOOK_SIGNING_SECRET);
  } catch {
    return new NextResponse("bad signature", { status: 400 });
  }

  // An event type we do not handle. 200, so Clerk stops retrying it.
  if (!event) return NextResponse.json({ received: true });

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
}
