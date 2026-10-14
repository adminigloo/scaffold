import { and, eq, sql } from "drizzle-orm";
import {
  clientIpKey,
  estimatorSettings,
  type EstimatorPermission,
  type EstimatorRateLimitBucket,
} from "__SCOPE__/estimator";
import { FIRM_WIDE } from "__SCOPE__/permissions";
import { roleTemplate, roleTemplateGrant } from "__SCOPE__/permissions/schema";
import { db as sharedDb } from "@/db";
import { env } from "@/env";
import { staffCatalog } from "@/permissions/catalog";
import { currentPrincipal } from "@/server/auth";
import { reportError } from "@/server/error-reporter";
import {
  ESTIMATOR_FAIL_CLOSED_BUCKETS,
  ESTIMATOR_RATE_LIMITS,
  estimatorLinks,
  firstEstimatorTimeZone,
} from "@/server/estimator-config";
import { ensureEstimatorEmailTemplates } from "@/server/estimator-notify";
import { ESTIMATOR_TIME_ZONE_HINTS } from "@/server/estimator-services";
import { ESTIMATOR_STAFF_KEYS, ESTIMATOR_STAFF_KEY_LIST, ESTIMATOR_TENANT } from "@/server/estimator-staff";
import { log } from "@/server/logger";
import { loadStaffPermissions } from "@/server/permissions";
import { failClosedLimiter, limiter } from "@/server/rate-limit";

/**
 * The app's side of __SCOPE__/estimator: which business, who may use the staff
 * screens, the first-boot setup, the throttle, and where an unexpected error
 * is recorded. The three route handlers (app/api/estimator,
 * app/api/admin/estimator and the cron) are the package's handlers with these
 * injected; the widgets on /estimate, /quote/[token] and /admin/estimates speak
 * to them.
 *
 * What the estimator is GLUED TO — where a photo is kept, what reads it, who is
 * emailed, what an accepted quote becomes — depends on what else this project
 * installed, so it lives in two generated modules beside this one:
 * src/server/estimator-notify.ts and src/server/estimator-services.ts.
 */

/** Links on this deployment: the estimate page, a customer's quote page, the staff screens, the embed's base. */
export const estimatorUrls = estimatorLinks(env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000");

let setup: Promise<void> | null = null;
let setupRan = false;

/**
 * The business's starting zone, staff access and the email templates — once
 * per process, before the first estimator request is answered.
 *
 * WHAT IT DOES, in order, the first two under one advisory lock so two cold
 * starts can't both do them:
 *
 *   1. The ZONE quotes are dated in, written as an UNSAVED settings row —
 *      only when this business has no row at all. `saved_at` stays empty, so
 *      the admin keeps asking the owner for the business's name, tax rate and
 *      quote rules until they save them; after that the row is the owner's.
 *      See `firstEstimatorTimeZone` for why the zone and nothing else.
 *   2. Staff access (`ensureEstimatorAccess`): the estimator staff keys on the
 *      seeded staff roles.
 *   3. The seven estimate emails, so the owner can read and edit them in
 *      Messages before the first lead arrives (with --comms).
 *
 * NO CATALOG. The price book starts empty and nothing on a public page fills
 * it: a business that never built one shows "not set up yet", never a sample
 * price list a customer could mistake for the business's own. The owner loads
 * the sample on purpose, from the price book.
 *
 * Memoised as a promise, and forgotten on failure: with no DATABASE_URL yet
 * every call fails the same way and the next request tries again, rather than
 * the first failure being cached for the life of the process.
 */
export function ensureEstimatorSetup(db = sharedDb): Promise<void> {
  if (!setup) {
    setup = runSetup(db)
      .then(() => {
        setupRan = true;
      })
      .catch((error: unknown) => {
        setup = null;
        throw error;
      });
  }
  return setup;
}

async function runSetup(db: typeof sharedDb): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`estimator-setup:${ESTIMATOR_TENANT}`}))`);
    await tx
      .insert(estimatorSettings)
      .values({ tenantId: ESTIMATOR_TENANT, timeZone: firstEstimatorTimeZone(ESTIMATOR_TIME_ZONE_HINTS) })
      .onConflictDoNothing({ target: estimatorSettings.tenantId });
    await ensureEstimatorAccess(tx);
  });
  try {
    await ensureEstimatorEmailTemplates();
  } catch (error) {
    // Logged, never fatal: a missing comms table must not take the estimate
    // page down with it. The listener says so again on the first email.
    log.error({ err: error }, "estimator: the estimate email templates couldn't be added");
  }
}

type Tx = Parameters<Parameters<typeof sharedDb.transaction>[0]>[0];

/**
 * The estimator staff keys on the staff roles that should hold them — the same
 * `defaultFor` the catalog declares, applied the way `pnpm db:seed` applies it:
 * insert-only, and only to SYSTEM templates (one a client customised is never
 * touched).
 *
 * WHY HERE AND NOT ONLY IN THE SEED. A project generated today, or one that
 * added the estimator later, has staff roles seeded before these keys
 * existed; without this the administrator would be refused their own price
 * book until somebody re-ran the seed. It runs once per process and grants
 * nothing the catalog doesn't already say the role holds.
 */
async function ensureEstimatorAccess(tx: Tx): Promise<void> {
  const templates = await tx
    .select({ id: roleTemplate.id, key: roleTemplate.key, isSystem: roleTemplate.isSystem })
    .from(roleTemplate)
    .where(and(eq(roleTemplate.scope, "staff"), eq(roleTemplate.tenantId, FIRM_WIDE)));
  for (const template of templates) {
    if (!template.isSystem) continue;
    const keys = staffCatalog.defaultsFor(template.key).filter((key) => ESTIMATOR_STAFF_KEY_LIST.includes(key));
    for (const permission of keys) {
      await tx.insert(roleTemplateGrant).values({ templateId: template.id, permission, effect: "allow" }).onConflictDoNothing();
    }
  }
}

/**
 * The tenant seam the PUBLIC handler takes. It is also where the first-boot
 * setup runs, because it is the first thing every customer request does — so
 * no deploy step, seed command or migration hook has to remember it.
 *
 * The staff handler resolves the same tenant without it (`ESTIMATOR_TENANT`,
 * in its route) and runs the setup inside `authorizeEstimatorStaff` instead,
 * once the caller is known to be staff: the handler resolves the tenant BEFORE
 * it authorizes, and a signed-out request should get its 401 without touching
 * the database.
 */
export async function resolveEstimatorTenant(): Promise<string> {
  await ensureEstimatorSetup();
  return ESTIMATOR_TENANT;
}

/**
 * The public API's throttle, on the app's shared limiters (Upstash when
 * configured, this process's memory when not). Photo READING counts on the
 * limiter that fails closed — it spends money — and everything else on the
 * one that fails open (ESTIMATOR_FAIL_CLOSED_BUCKETS).
 *
 * Keyed on the caller's IP as the nearest proxy saw it (`clientIpKey`: the
 * last X-Forwarded-For entry — on Vercel, the caller). A request with no
 * forwarded IP — a laptop with no proxy in front of it — is not limited here
 * at all, the rule the tRPC ladder's anonymous floor follows. The package's
 * own daily photo budget and per-visitor count still apply to it.
 */
export async function estimatorRateLimit(req: Request, bucket: EstimatorRateLimitBucket): Promise<boolean> {
  const caller = clientIpKey(req);
  if (!caller) return true;
  const store = ESTIMATOR_FAIL_CLOSED_BUCKETS.has(bucket) ? failClosedLimiter : limiter;
  const result = await store.limit({
    key: `estimator:${bucket}:${caller}`,
    policy: ESTIMATOR_RATE_LIMITS[bucket],
  });
  return result.allowed;
}

/**
 * Who may use the staff screens: the same ladder the admin shell climbs.
 *
 * A verified principal, then staff permissions resolved from THIS project's
 * tables (never from a session claim), then the staff key the estimator
 * permission maps to (ESTIMATOR_STAFF_KEYS). Nobody signed in is a 401 the
 * widget shows as "signed out"; signed in but not staff, or staff without the
 * key, is a 403 — and for `estimator.costs.view`, asked beside every route that
 * could carry a cost, a "no" strips the costs and margins instead.
 *
 * The first-boot setup runs once the caller is known to be staff, and the
 * permissions are read again after it the first time: the setup is what gives
 * the seeded staff roles their estimator keys.
 *
 * The returned `userId` is who the estimate's history says acted.
 */
export async function authorizeEstimatorStaff(
  _req: Request,
  permission: EstimatorPermission,
): Promise<{ userId: string } | Response | false> {
  const principal = await currentPrincipal();
  if (!principal) {
    return Response.json(
      { error: { code: "unauthorized", message: "Sign in to see estimates." } },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }
  let can = await loadStaffPermissions({ principal });
  if (!can) return false;
  if (!setupRan) {
    // Staff only from here: the first-boot setup before anything reads — then
    // the grants it may have added.
    await ensureEstimatorSetup();
    can = await loadStaffPermissions({ principal });
    if (!can) return false;
  }
  if (!can.can(ESTIMATOR_STAFF_KEYS[permission])) return false;
  return { userId: principal.userId };
}

/**
 * An error neither handler expected: a 500 with a fixed message for the
 * caller, and the error itself in the app's error log (/admin/errors), never
 * in the response.
 */
export function reportEstimatorError(error: unknown, context: { tenantId: string | null; route: string }): void {
  void reportError({
    error,
    source: "route",
    tenantId: context.tenantId,
    context: { feature: "estimator", route: context.route },
  });
}
