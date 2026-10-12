import { NextResponse } from "next/server";
import { runDueMessages } from "__SCOPE__/comms";
import { db } from "@/db";
import { env } from "@/env";
import { afterCommsRun, commsBeforeSend } from "@/server/comms-hooks";
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
 * project: until it is set, every call is refused and reminders wait — and a
 * reminder that waits more than 48 hours past its sendAt ends "expired" rather
 * than going out days late (pass `maxLatenessMs` below to change the bound; a
 * row's own `expiresAt` overrides it).
 *
 * NOT FOR IMMEDIATE MESSAGES. A message the customer is waiting for goes out
 * in the request that causes it — the acknowledgement in the request that
 * asked for a visit, the confirmation in the one where staff accept it: call
 * `sendNow(db, {...}, commsSenders)` there. Enqueueing it with sendAt = now
 * makes it wait for the next tick (minutes, or a day on Hobby), which a
 * customer reads as "didn't work".
 *
 * RE-CHECKED AT SEND TIME, through `commsBeforeSend` (src/server/comms-hooks.ts,
 * generated from what this project installed). A feature that queues messages
 * gets a say over its own rows there: scheduling skips a reminder whose visit
 * was moved or cancelled since it was queued, and puts a freshly minted
 * manage link into the one it sends. `afterCommsRun` then scrubs those links
 * out of the delivery log. Cancelling when the thing changes
 * (`cancelScheduled(db, { tenantId, refType, refId })`) is the first line;
 * beforeSend is the backstop.
 *
 * THE SCRUB RUNS IN A `finally`. A drain that throws part-way — a database
 * error on a later row, after some reminders have gone — used to skip it, and
 * the links those reminders carried stayed readable in the delivery log.
 */
async function handle(request: Request): Promise<Response> {
  const secret = env.CRON_SECRET;
  const provided =
    request.headers.get("x-cron-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await runDueMessages(db, commsSenders, {
      timeBudgetMs: TIME_BUDGET_MS,
      beforeSend: commsBeforeSend,
    });
    return NextResponse.json(result);
  } finally {
    await afterCommsRun();
  }
}

export const GET = handle;
export const POST = handle;
