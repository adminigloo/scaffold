import { NextResponse } from "next/server";
import { env } from "@/env";
import { reportError } from "@/server/error-reporter";
import { FILES_MOVE_TO_PRIVATE, files, filesStillPublic, privateStoreVerdict } from "@/server/files";
import { log } from "@/server/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** How long one run spends moving older public files, and how many at a time (review BUY-05). */
const MOVE_BUDGET_MS = 20_000;
const MOVE_BATCH = 1000;

/**
 * The files cron (Tenancy 2b-1, 13.8), three steps:
 *
 *   1. DELETED MEANS THE BYTES GO (D13): files whose stored object a store
 *      refused to delete are tried again; after ten tries one is reported to
 *      /admin/errors with what a person needs to clear it by hand.
 *   2. OLD PUBLIC FILES MOVE TO THE PRIVATE STORE (reviews G11, BUY-05):
 *      files kept publicly before 2b-1 (0.1's library files, the estimator's
 *      customer photos) are copied into the private store and deleted from
 *      the public one — same file, same links. In batches of up to 1,000,
 *      one after another until none are left or this run's 20 seconds are
 *      spent, so a site upgraded with thousands of photos is private within
 *      days, not months. A run that didn't finish is reported to
 *      /admin/errors with how many are left (and /setup says so too).
 *      FILES_MOVE_TO_PRIVATE is generated: a list, never an `if`.
 *      CONTRACT: 13.8 calls moveToPrivate once per purpose with a 10-second
 *      budget, which moved 100 a day (review BUY-05).
 *   3. THE PRIVATE STORE REALLY IS PRIVATE (review G9): a "private" store
 *      that anyone can read is reported to /admin/errors. A live check, and
 *      the verdict /setup shows for the next hour (review BUY-06).
 *
 * SCHEDULED IN vercel.json, once a day. Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET`; anything else can send
 * `x-cron-secret`. Refuses every call while CRON_SECRET is unset.
 */
async function handle(request: Request): Promise<Response> {
  const secret = env.CRON_SECRET;
  const provided =
    request.headers.get("x-cron-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const purged = await files.purgeDeleted({ timeBudgetMs: 30_000 });

  const moved: { purpose: string; moved: number; failed: number; stoppedEarly: boolean }[] = [];
  const moveUntil = Date.now() + MOVE_BUDGET_MS;
  for (const purpose of FILES_MOVE_TO_PRIVATE) {
    const total = { purpose, moved: 0, failed: 0, stoppedEarly: false };
    // Batch after batch while there are more and time is left (runtime state).
    for (;;) {
      const left = moveUntil - Date.now();
      if (left <= 0) {
        total.stoppedEarly = true;
        break;
      }
      const batch = await files.moveToPrivate({ purpose, limit: MOVE_BATCH, timeBudgetMs: left });
      total.moved += batch.moved;
      total.failed += batch.failed;
      total.stoppedEarly = batch.stoppedEarly;
      // Done, or a batch where nothing could move (each failure is reported by
      // the files instance): the next run tries again.
      if (!batch.stoppedEarly || batch.moved === 0) break;
    }
    moved.push(total);
  }
  // About this run (runtime state): files still public after it are reported.
  if (moved.some((entry) => entry.stoppedEarly)) {
    const left = await filesStillPublic();
    log.warn({ cron: "files", left }, "files cron: older files are still being moved out of the public store");
    void reportError({
      error: new Error(
        `${left} older photos and files are still at a public address; the files cron moves them a batch each run. Run /api/cron/files more often until none are left (DEPLOYMENT.md).`,
      ),
      source: "route",
      tenantId: null,
      context: { feature: "files", route: "cron:files" },
    });
  }

  const privateStore = await privateStoreVerdict({ fresh: true, storage: files });
  // About this deployment's store (runtime state), not about what is installed.
  if (!privateStore.ok) {
    log.error({ reason: privateStore.reason }, "files cron: the private file store isn't private");
    void reportError({
      error: new Error(`The private file store failed its check: ${privateStore.reason ?? "unknown"}`),
      source: "route",
      tenantId: null,
      context: { feature: "files", route: "cron:files" },
    });
  }

  return NextResponse.json({ purged, moved, privateStore });
}

export const GET = handle;
export const POST = handle;
