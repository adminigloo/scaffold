import { buildPlatformSearchCheckHandlers } from "@/server/search-check";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A check reads up to 50 pages in up to 45 seconds.
export const maxDuration = 60;

/**
 * THIS SITE'S OWN search check, for its staff: /admin/seo calls
 * /api/admin/search-check/v1/… — the reports, one report, Check now.
 *
 * On the staff ladder (staff.seo_reports.view to read, staff.seo_reports.run
 * to check), asked on every call; never a company's. Never cross-origin.
 */
const { handle } = buildPlatformSearchCheckHandlers();

export const GET = handle;
export const POST = handle;
