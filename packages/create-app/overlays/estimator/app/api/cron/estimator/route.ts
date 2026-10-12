import { NextResponse } from "next/server";
import { expireQuotes, purgeOrphanPhotos } from "__SCOPE__/estimator";
import { db } from "@/db";
import { env } from "@/env";
import { resolveEstimatorTenant } from "@/server/estimator";
import { onEstimatorEvent } from "@/server/estimator-notify";
import { estimatorPhotoStore } from "@/server/estimator-services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The estimator's daily tidy-up, two jobs:
 *
 *   1. QUOTES PAST THEIR DATE are marked expired. A quote past its validity
 *      already can't be accepted — the package checks the date whenever the
 *      link is opened or answered — so this run is about TELLING people: with
 *      comms, the customer gets a note that it lapsed (and how to get an
 *      updated one) and the office a notice. Also swept, at most once a
 *      minute, whenever staff open the estimates list.
 *   2. PHOTOS NOBODY SENT. A customer who adds a photo and walks away leaves
 *      it in storage, attached to no estimate; after two days it is deleted
 *      (the row, then the file).
 *
 * The follow-up on an unanswered quote is NOT here: it is a queued comms
 * message, sent by /api/cron/comms (and withdrawn the moment the customer
 * answers).
 *
 * SCHEDULED IN vercel.json, once a day — the only schedule Vercel's Hobby plan
 * accepts. Any scheduler can call it with the secret: Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET`; anything else can send
 * `x-cron-secret`. Refuses every call while CRON_SECRET is unset, so an
 * unconfigured deployment can't be poked by a stranger.
 *
 * EACH JOB HAS A TIME BUDGET, and keeps going a batch at a time until its work
 * is done or its time is up — so a backlog (a busy week of unsent photos) is
 * cleared in one run instead of 100 a day, and a run is never cut off by
 * maxDuration part-way through a batch. Every expiry is announced and THEN
 * stamped: one a cut-off run didn't get to email is announced by the next run,
 * so no customer or office goes untold.
 */
async function handle(request: Request): Promise<Response> {
  const secret = env.CRON_SECRET;
  const provided =
    request.headers.get("x-cron-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const tenantId = await resolveEstimatorTenant();
  // 20 s + 20 s of work inside the 60 s this route may run, with room for the
  // emails an expiry sends and the response.
  const expired = await expireQuotes(db, tenantId, { onEvent: onEstimatorEvent, timeBudgetMs: 20_000 });
  const photos = await purgeOrphanPhotos(db, estimatorPhotoStore, { timeBudgetMs: 20_000 });
  return NextResponse.json({
    expired: expired.expired,
    announced: expired.announced,
    photosDeleted: photos.deleted,
    photosNotDeleted: photos.failed,
  });
}

export const GET = handle;
export const POST = handle;
