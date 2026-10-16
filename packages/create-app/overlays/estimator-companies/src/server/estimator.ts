import { sql } from "drizzle-orm";
import {
  clientIpKey,
  createEstimatorAdminHandlers,
  createEstimatorHandlers,
  estimatorSettings,
  type EstimatorCompany,
  type EstimatorRateLimitBucket,
} from "__SCOPE__/estimator";
import { db } from "@/db";
import { env } from "@/env";
import { companyLinks } from "@/server/company-links";
import {
  admitPublic,
  companyAuthorizer,
  companyRoutes,
  resolvePublicTenant,
  type FeatureHandlerOverrides,
} from "@/server/company-routes";
import { ALERTS_SETTINGS_HREF } from "@/server/alerts-links";
import { reportError } from "@/server/error-reporter";
import { estimateQuota } from "@/server/plan-gate";
import {
  ESTIMATOR_AI_CEILING_CENTS,
  ESTIMATOR_AI_SITE_CEILING_CENTS,
  ESTIMATOR_FAIL_CLOSED_BUCKETS,
  ESTIMATOR_RATE_LIMITS,
  PUBLIC_ESTIMATOR_API_PATH,
  firstEstimatorTimeZone,
} from "@/server/estimator-config";
import { ESTIMATOR_EMAILS_ENABLED, ensureEstimatorEmailTemplates, estimatorDelivery, onEstimatorEvent } from "@/server/estimator-notify";
import {
  ESTIMATOR_TIME_ZONE_HINTS,
  convertEstimateToInvoice,
  estimatorInvoiceAccess,
  estimatorLinkSeams,
  estimatorPhotoReadingOff,
  estimatorPhotoStore,
  estimatorStaffPhotoStore,
  estimatorTakeoff,
} from "@/server/estimator-services";
import { log } from "@/server/logger";
import { failClosedLimiter, limiter } from "@/server/rate-limit";
import { tenancy } from "@/server/tenancy";
import { COMPANY_DETAILS_HREF } from "@/tenancy";

/**
 * The app's side of __SCOPE__/estimator in a COMPANIES project (Tenancy 2a):
 * every company runs its own price book, leads and quotes, under its own id.
 * Nothing here names a business.
 *
 *   /app/estimates, /app/price-book …   the company's own screens, over
 *   /api/app/{company id}/estimator     the staff handler
 *   /t/{web address}/estimate, quote …  its public pages, over
 *   /api/t/{web address}/estimator      the public handler
 *   /api/estimator (and /embed)         the estimate on the company's OWN
 *                                       website, by its embed key only
 *
 * WHICH COMPANY is never read from a session or a body: the staff routes name
 * the company id in their path and ask the company's own permissions for it
 * on every call; the public routes name the company's web address; the embed
 * knows its company from the key and nothing else. A suspended company is
 * closed on both public paths (`admitPublic`).
 *
 * The company's name, contact, zone, logo and colour come from the company
 * profile (`estimatorCompany`) — Estimate settings shows them read-only — and
 * every company's photo reading is held under the site's ceiling
 * (ESTIMATOR_AI_CEILING_CENTS), because every company spends YOUR AI key.
 */

/** The company as its customers know it, read per request from the company profile (D5). */
export const estimatorCompany = (tenantId: string): Promise<EstimatorCompany | null> => tenancy.companyProfile(tenantId);

/** The address the embed snippet in Estimate settings points another website at. */
const estimatorEmbedBase = new URL(
  PUBLIC_ESTIMATOR_API_PATH.slice(1),
  (env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/?$/, "/"),
).toString();

/**
 * An error neither handler expected: a 500 with a fixed message for the
 * caller, and the error itself in the app's error log (/admin/errors), with
 * the company it happened to.
 */
export function reportEstimatorError(error: unknown, context: { tenantId: string | null; route: string }): void {
  void reportError({
    error,
    source: "route",
    tenantId: context.tenantId,
    context: { feature: "estimator", route: context.route },
  });
}

/**
 * The public API's throttle, PER COMPANY (one company's busy day never spends
 * another's budget), on the app's shared limiters. Photo READING counts on the
 * limiter that fails closed — it spends money — and everything else on the one
 * that fails open. A request with no forwarded IP is not limited here (the
 * package's own daily budget and per-visitor count still apply).
 */
export async function estimatorRateLimit(
  req: Request,
  bucket: EstimatorRateLimitBucket,
  context: { tenantId: string; keyId: string | null },
): Promise<boolean> {
  const caller = clientIpKey(req);
  if (!caller) return true;
  const store = ESTIMATOR_FAIL_CLOSED_BUCKETS.has(bucket) ? failClosedLimiter : limiter;
  const result = await store.limit({
    key: `estimator:${context.tenantId}:${bucket}:${caller}`,
    policy: ESTIMATOR_RATE_LIMITS[bucket],
  });
  return result.allowed;
}

/**
 * The staff side, for one company per request: what /app/estimates, an
 * estimate's page, the price book and Estimate settings talk to.
 * `overrides.principal` is how the project's isolation proof calls it as
 * somebody else.
 *
 * A route that could show a cost asks `estimator.costs.view` as well, and
 * without it every cost and margin is stripped: a member who quotes sees
 * prices; owners and admins see what the job costs.
 */
export function buildEstimatorAdminHandlers(overrides: FeatureHandlerOverrides = {}) {
  return createEstimatorAdminHandlers({
    db,
    resolveTenant: companyRoutes.resolveTenant,
    authorize: companyAuthorizer(overrides),
    company: estimatorCompany,
    companySettingsHref: COMPANY_DETAILS_HREF,
    aiBudgetCeilingCents: ESTIMATOR_AI_CEILING_CENTS,
    photoStore: estimatorPhotoStore,
    // Staff's own photos, apart from customers' (review SEC-02): never refused
    // because strangers filled the customers' share. Undefined without file
    // storage, and the package then keeps 0.4's single store.
    staffPhotoStore: estimatorStaffPhotoStore,
    photoReading: Boolean(estimatorTakeoff),
    photoReadingOff: estimatorPhotoReadingOff,
    // The site's own setup gaps (no AI key, no file storage) in a company's
    // words — "isn't available on this site yet" — never an environment
    // variable a company can't set (review T2A-BO-05). You see them, with
    // their fixes, on /setup.
    siteNotices: "company",
    onEvent: onEstimatorEvent,
    quoteUrl: async (token, tenantId) => (await companyLinks(tenantId)).quote(token),
    delivery: (tenantId) => estimatorDelivery(tenantId),
    links: estimatorLinkSeams,
    convertToInvoice: convertEstimateToInvoice,
    // "Turn into an invoice" asks invoices.manage too (review SEC-2A-02).
    invoiceAccess: estimatorInvoiceAccess(overrides),
    embedBaseUrl: estimatorEmbedBase,
    // Who hears about new leads is chosen in Alert settings when this
    // project has alerts (Tenancy 2b-1, D6): the settings screen links there
    // instead of offering its own list. ALERTS_SETTINGS_HREF is generated —
    // null without alerts, and the package keeps 2a's list.
    alertsHref: ALERTS_SETTINGS_HREF,
    onError: reportEstimatorError,
  });
}

/**
 * A NEW online estimate request: the photo, its reading and the submit (review
 * H3). Never a quote the business already sent: its customer can always open,
 * accept or decline it, whatever this month's count is.
 */
function isNewEstimateRequest(req: Request): boolean {
  if (req.method !== "POST") return false;
  let pathname: string;
  try {
    pathname = new URL(req.url).pathname;
  } catch {
    return false;
  }
  return /\/v1\/(photo|takeoff|submit)\/?$/.test(pathname);
}

/**
 * A customer's estimate request, admitted: the company is taking requests
 * (active, and its plan open — `admitPublic`), AND it hasn't had its plan's
 * online estimate requests for this month (billing 0.3, `estimateQuota`;
 * always open in a project that doesn't sell plans). Staff can still make
 * estimates themselves.
 */
async function admitEstimateRequest(
  tenantId: string,
  req: Request,
): Promise<{ readonly open: true } | { readonly open: false; readonly message: string }> {
  const admitted = await admitPublic(tenantId, req);
  if (!admitted.open || !isNewEstimateRequest(req)) return admitted;
  return estimateQuota(tenantId);
}

/**
 * The customer side, for the company whose web address the path names: what
 * /t/{web address}/estimate and its quote pages talk to. A quote token is read
 * inside that company only.
 */
export function buildEstimatorPublicHandlers() {
  return createEstimatorHandlers({
    db,
    resolveTenant: resolvePublicTenant,
    admit: admitEstimateRequest,
    company: estimatorCompany,
    aiBudgetCeilingCents: ESTIMATOR_AI_CEILING_CENTS,
    // Every company's readings together, under one daily ceiling for the
    // whole site (review SEC-2A-07): anyone can sign up a company here.
    aiSiteBudgetCents: ESTIMATOR_AI_SITE_CEILING_CENTS,
    photoStore: estimatorPhotoStore,
    takeoff: estimatorTakeoff,
    onEvent: onEstimatorEvent,
    emailsEnabled: ESTIMATOR_EMAILS_ENABLED,
    requesterKey: clientIpKey,
    rateLimit: estimatorRateLimit,
    onError: reportEstimatorError,
  });
}

/**
 * The estimate on a company's OWN website: /api/estimator, by embed key ONLY.
 *
 * No `tenantId` and no `resolveTenant`, on purpose: in a companies project
 * there is no "the business" for a keyless request to fall back to, so one
 * without a key is told it needs one. The key names its company; the key's
 * allowed websites get CORS; a suspended company's key is closed like its
 * pages (`admitPublic`, asked for the key's company).
 */
export function buildEstimatorEmbedHandlers() {
  return createEstimatorHandlers({
    db,
    admit: admitEstimateRequest,
    company: estimatorCompany,
    aiBudgetCeilingCents: ESTIMATOR_AI_CEILING_CENTS,
    // Every company's readings together, under one daily ceiling for the
    // whole site (review SEC-2A-07): anyone can sign up a company here.
    aiSiteBudgetCents: ESTIMATOR_AI_SITE_CEILING_CENTS,
    photoStore: estimatorPhotoStore,
    takeoff: estimatorTakeoff,
    onEvent: onEstimatorEvent,
    emailsEnabled: ESTIMATOR_EMAILS_ENABLED,
    requesterKey: clientIpKey,
    rateLimit: estimatorRateLimit,
    onError: reportEstimatorError,
  });
}

/**
 * A company's first estimator setup, ONCE (src/server/company-setup.ts):
 *
 *   1. The zone its quotes are dated in, as an UNSAVED settings row — the
 *      company's zone, else ESTIMATOR_TIME_ZONE, else Mountain Time — only
 *      when it has no row at all. `saved_at` stays empty, so instant estimates
 *      stay closed until the owner saves their tax rate and quote rules once.
 *   2. The estimate emails, so the owner can read and edit them in Messages
 *      before the first lead. Logged, never fatal.
 *
 * NO PRICE BOOK. It starts empty; the owner builds it or loads the sample on
 * purpose. A company whose public page priced from a catalog it never wrote
 * would be quoting a stranger's prices under its own name.
 */
export async function setupEstimatorFor(tenantId: string): Promise<void> {
  const profile = await tenancy.companyProfile(tenantId);
  if (!profile) return;
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`estimator-setup:${tenantId}`}))`);
    await tx
      .insert(estimatorSettings)
      .values({ tenantId, timeZone: firstEstimatorTimeZone([profile.timeZone, ...ESTIMATOR_TIME_ZONE_HINTS]) })
      .onConflictDoNothing({ target: estimatorSettings.tenantId });
  });
  try {
    await ensureEstimatorEmailTemplates(tenantId);
  } catch (error) {
    log.error({ err: error, tenantId }, "estimator: a company's estimate email templates couldn't be added");
  }
}
