import { NextResponse } from "next/server";
import { expirePendingRequests } from "__SCOPE__/scheduling";
import { db } from "@/db";
import { env } from "@/env";
import { resolveSchedulingTenant } from "@/server/scheduling";
import { onSchedulingEvent } from "@/server/scheduling-notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Releases booking requests nobody answered in time.
 *
 * A request waits `pendingExpiryHours` (Schedule settings, 48 by default) for
 * somebody to accept or decline it. Past that it already holds no time — the
 * package stops counting it the moment its deadline passes — so this run is
 * about TELLING people: each one becomes "expired" and the customer is
 * emailed that it lapsed, with a link to pick another time.
 *
 * Also swept, at most once a minute, whenever a customer sends a new request
 * or staff open the calendar — so a busy business rarely waits for this. The
 * cron is for the quiet week.
 *
 * SCHEDULED IN vercel.json, once a day — the only schedule Vercel's Hobby plan
 * accepts. On Pro, tighten it to every 15 minutes (DEPLOYMENT.md has the line)
 * so a customer hears within minutes rather than by tomorrow. Any scheduler can
 * call it with the secret: Vercel Cron sends `Authorization: Bearer
 * $CRON_SECRET`; anything else can send `x-cron-secret`. Refuses every call
 * while CRON_SECRET is unset, so an unconfigured deployment can't be poked by
 * a stranger.
 *
 * One call releases up to 100; the next run takes the rest.
 */
async function handle(request: Request): Promise<Response> {
  const secret = env.CRON_SECRET;
  const provided =
    request.headers.get("x-cron-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const tenantId = await resolveSchedulingTenant();
  const result = await expirePendingRequests(db, tenantId, { onEvent: onSchedulingEvent });
  return NextResponse.json({ expired: result.expired });
}

export const GET = handle;
export const POST = handle;
