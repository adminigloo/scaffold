import { buildAnalyticsAdminHandlers } from "@/server/website";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A __TENANT_LABEL_LOWER__'s numbers and websites: /app/website calls
 * /api/app/{__TENANT_LABEL_LOWER__ id}/website/v1/… — the report, its websites, adding
 * and removing one, "leave this device out".
 *
 * THE __TENANT_LABEL_LOWER__ IS THE ONE IN THE PATH, asked on every call (analytics.view
 * to look, analytics.manage to change); another __TENANT_LABEL_LOWER__'s website is "not
 * found". Never cross-origin.
 */
const { handle } = buildAnalyticsAdminHandlers();

export const GET = handle;
export const POST = handle;
