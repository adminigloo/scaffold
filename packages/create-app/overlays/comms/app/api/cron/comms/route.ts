import { NextResponse } from "next/server";
import { runDueMessages } from "__SCOPE__/comms";
import { db } from "@/db";
import { env } from "@/env";
import { commsSenders } from "@/server/comms-senders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Drains the scheduled-message queue — booking reminders, follow-ups. Point a
 * scheduler at it (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`) or
 * call it with `x-cron-secret`. Refuses everything when CRON_SECRET is unset, so
 * an unconfigured deployment can't have its queue drained by a stranger.
 */
async function handle(request: Request): Promise<Response> {
  const secret = env.CRON_SECRET;
  const provided =
    request.headers.get("x-cron-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await runDueMessages(db, commsSenders);
  return NextResponse.json(result);
}

export const GET = handle;
export const POST = handle;
