import { buildEstimatorAdminHandlers } from "@/server/estimator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A company's own estimator, for its screens: /app/estimates, an estimate's
 * page, the price book and Estimate settings call
 * /api/app/{company id}/estimator/v1/admin/….
 *
 * THE COMPANY IS THE ONE IN THE PATH, and every call is asked, for that id,
 * whether the caller is signed in, a member, not suspended and holding the
 * route's permission (src/server/company-routes.ts). Costs and margins are a
 * second ask (`estimator.costs.view`) that only strips them. Never
 * cross-origin.
 */
const { handle } = buildEstimatorAdminHandlers();

export const GET = handle;
export const POST = handle;
