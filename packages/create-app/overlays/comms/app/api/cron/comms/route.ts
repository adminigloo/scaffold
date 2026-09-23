import { NextResponse } from "next/server";
import { runDueMessages } from "__SCOPE__/comms";
import { db } from "@/db";
import { env } from "@/env";
import { commsSenders } from "@/server/comms-senders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The platform kills the function at this limit. The drain below stops
// claiming new rows well before it (timeBudgetMs), so a big backlog ends the
// run cleanly and the next tick picks up the rest — a row killed mid-send is
// reclaimed after ten minutes, but only a clean stop avoids that wait.
export const maxDuration = 60;
const TIME_BUDGET_MS = 45_000;

/**
 * Drains the scheduled-message queue — booking reminders, follow-ups. Point a
 * scheduler at it (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`) or
 * call it with `x-cron-secret`. Refuses everything when CRON_SECRET is unset, so
 * an unconfigured deployment can't have its queue drained by a stranger.
 *
 * SCHEDULED IN vercel.json, which the generator writes with this route in its
 * `crons` — once a day, the only schedule Vercel's Hobby plan accepts. On Pro,
 * tighten it (every 15 minutes is a good reminder resolution), or point any
 * external scheduler at this URL with the secret. Set CRON_SECRET in the Vercel
 * project: until it is set, every call is refused and reminders wait.
 *
 * NOT FOR IMMEDIATE MESSAGES. A booking confirmation must go out in the
 * request that made the booking — call `sendNow(db, {...}, commsSenders)`
 * there. Enqueueing it with sendAt = now makes it wait for the next tick
 * (minutes, or a day on Hobby), which a customer reads as "didn't work".
 *
 * Re-checking at send time: pass `beforeSend` to skip a row whose subject has
 * moved on since it was queued — `(row) => bookingStillOn(row.refId) ? "send"
 * : "skip"` — or to return fresh `{ vars }`. Cancelling when the thing changes
 * (`cancelScheduled(db, { tenantId, refType, refId })`) is better still;
 * beforeSend is the backstop.
 */
async function handle(request: Request): Promise<Response> {
  const secret = env.CRON_SECRET;
  const provided =
    request.headers.get("x-cron-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await runDueMessages(db, commsSenders, { timeBudgetMs: TIME_BUDGET_MS });
  return NextResponse.json(result);
}

export const GET = handle;
export const POST = handle;
