import { NextResponse } from "next/server";
import { expireQuotes, purgeOrphanPhotos } from "__SCOPE__/estimator";
import { runForEachCompany } from "__SCOPE__/tenancy/server";
import { db } from "@/db";
import { env } from "@/env";
import { onEstimatorEvent } from "@/server/estimator-notify";
import { estimatorPhotoStore } from "@/server/estimator-services";
import { reportError } from "@/server/error-reporter";
import { log } from "@/server/logger";
import { tenancy } from "@/server/tenancy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Every company's daily estimator tidy-up (Tenancy 2a), two jobs:
 *
 *   1. QUOTES PAST THEIR DATE, per company: marked expired, and (with comms)
 *      the customer gets a note that it lapsed and the company's office a
 *      notice — from the company, to the company's own addresses.
 *   2. PHOTOS NOBODY SENT, once for the whole site (the package's sweep is
 *      global already): a photo a customer added and walked away from is
 *      deleted after two days, the row and then the file.
 *
 * EVERY ACTIVE COMPANY, through `runForEachCompany`: a suspended company is
 * not in the list, so its quotes wait; each company has its own try/catch, so
 * one company's failure is in `failed` and the rest ran; the starting company
 * is different every run (review SEC-2A-06), so a run that reaches its time
 * budget doesn't leave out the same companies day after day, and any it
 * leaves out (`deferred`) is logged and reported (review T2A-BO-13).
 *
 * The follow-up on an unanswered quote is a queued comms message, sent by
 * /api/cron/comms. SCHEDULED IN vercel.json; refuses every call while
 * CRON_SECRET is unset.
 */
async function handle(request: Request): Promise<Response> {
  const secret = env.CRON_SECRET;
  const provided =
    request.headers.get("x-cron-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // 35 s of companies and 15 s of photos inside the 60 s this route may run,
  // with room for the emails an expiry sends and the response. Each company's
  // own expiry stops after 5 s, so one company's backlog can't eat the rest's.
  const quotes = await runForEachCompany(
    tenancy,
    (tenantId) => expireQuotes(db, tenantId, { onEvent: onEstimatorEvent, timeBudgetMs: 5_000 }),
    {
      timeBudgetMs: 35_000,
      onError: (error, tenantId) => log.error({ err: error, tenantId }, "estimator cron: a company's run failed"),
    },
  );
  const photos = await purgeOrphanPhotos(db, estimatorPhotoStore, { timeBudgetMs: 15_000 });
  // Companies the run had no time left to reach: logged and reported (review
  // T2A-BO-13). The starting company is different every run, so they aren't
  // the same ones day after day.
  if (quotes.deferred.length > 0) {
    log.error({ deferred: quotes.deferred }, `estimator cron: ${quotes.deferred.length} compan${quotes.deferred.length === 1 ? "y was" : "ies were"} not reached before the time ran out`);
    void reportError({
      error: new Error(`The estimator cron ran out of time before reaching ${quotes.deferred.length} compan${quotes.deferred.length === 1 ? "y" : "ies"}. Run it more often (DEPLOYMENT.md).`),
      source: "route",
      tenantId: null,
      context: { feature: "estimator", route: "cron:estimator", deferred: quotes.deferred.length },
    });
  }
  return NextResponse.json({
    ...quotes,
    photosDeleted: photos.deleted,
    photosNotDeleted: photos.failed,
  });
}

export const GET = handle;
export const POST = handle;
