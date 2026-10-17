import { buildSearchCheckHandlers } from "@/server/search-check";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A check reads up to 50 pages in up to 45 seconds.
export const maxDuration = 60;

/**
 * A __TENANT_LABEL_LOWER__'s search check: /app/website calls
 * /api/app/{__TENANT_LABEL_LOWER__ id}/search-check/v1/… — its reports, one report, Check now.
 *
 * THE __TENANT_LABEL_LOWER__ IS THE ONE IN THE PATH, asked on every call (seo_reports.view
 * to read, seo_reports.run to check); another __TENANT_LABEL_LOWER__'s report is "not
 * found", and a check reads only this __TENANT_LABEL_LOWER__'s own addresses. Never cross-origin.
 */
const { handle } = buildSearchCheckHandlers();

export const GET = handle;
export const POST = handle;
