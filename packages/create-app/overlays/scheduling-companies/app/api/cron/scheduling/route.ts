import { NextResponse } from "next/server";
import { expirePendingRequests } from "__SCOPE__/scheduling";
import { runForEachCompany } from "__SCOPE__/tenancy/server";
import { db } from "@/db";
import { env } from "@/env";
import { reportError } from "@/server/error-reporter";
import { log } from "@/server/logger";
import { syncSchedulingCompany } from "@/server/scheduling";
import { onSchedulingEvent } from "@/server/scheduling-notify";
import { tenancy } from "@/server/tenancy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Every company's daily scheduling job (Tenancy 2a), two steps per company:
 *
 *   1. Its zone, brought into step with its company profile — the third of
 *      the three moments that keep a company's visits on its own clock (D5;
 *      a no-op unless the owner changed the zone and nothing has run since).
 *   2. Booking requests nobody answered in time are released, and each
 *      customer is emailed that theirs lapsed, with a link to pick another
 *      time.
 *
 * EVERY ACTIVE COMPANY, through `runForEachCompany`: suspended companies are
 * not in the list, so their requests wait untouched; each company runs in its
 * own try/catch, so one company's failure is reported in `failed` and the
 * rest still run; each company expires at most 25 requests a run, so one
 * company's backlog (a burst of spam requests, each emailed on expiry) can't
 * eat the run's time; and the starting company is different every run, so a
 * run that reaches its time budget doesn't leave out the same companies day
 * after day (review SEC-2A-06). Anything left out (`deferred`) is logged as an
 * error, so you see it in the log and /admin/errors (review T2A-BO-13).
 *
 * SCHEDULED IN vercel.json, once a day — the only schedule Vercel's Hobby plan
 * accepts; on Pro tighten it (DEPLOYMENT.md). Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET`; anything else can send
 * `x-cron-secret`. Refuses every call while CRON_SECRET is unset, so an
 * unconfigured deployment can't be poked by a stranger.
 */
async function handle(request: Request): Promise<Response> {
  const secret = env.CRON_SECRET;
  const provided =
    request.headers.get("x-cron-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const report = await runForEachCompany(
    tenancy,
    async (tenantId) => {
      await syncSchedulingCompany(tenantId);
      // At most 25 a run per company: the slot is already free (an overdue
      // request holds no time), so the rest only wait for the next run to be
      // told, and no company's backlog holds up the others'.
      return (await expirePendingRequests(db, tenantId, { onEvent: onSchedulingEvent, limit: 25 })).expired;
    },
    {
      // Inside the 60 s this route may run, with room for the emails the
      // last company's expiries send and for the response.
      timeBudgetMs: 45_000,
      onError: (error, tenantId) => log.error({ err: error, tenantId }, "scheduling cron: a company's run failed"),
    },
  );
  reportDeferred("scheduling", report.deferred);
  return NextResponse.json(report);
}

/**
 * Companies the run had no time left to reach: logged as an error and
 * reported to /admin/errors, so a platform outgrowing its daily run is
 * noticed — they are not promised to go first next time, only not to be the
 * same ones every day.
 */
function reportDeferred(cron: string, deferred: readonly string[]): void {
  if (deferred.length === 0) return;
  log.error({ cron, deferred }, `${cron} cron: ${deferred.length} compan${deferred.length === 1 ? "y was" : "ies were"} not reached before the time ran out`);
  void reportError({
    error: new Error(`The ${cron} cron ran out of time before reaching ${deferred.length} compan${deferred.length === 1 ? "y" : "ies"}. Run it more often (DEPLOYMENT.md).`),
    source: "route",
    tenantId: null,
    context: { feature: cron, route: `cron:${cron}`, deferred: deferred.length },
  });
}

export const GET = handle;
export const POST = handle;
