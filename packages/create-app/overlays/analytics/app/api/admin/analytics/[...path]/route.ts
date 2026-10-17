import { buildPlatformAnalyticsHandlers } from "@/server/website";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * THIS SITE'S OWN numbers and websites, for its staff: /admin/analytics calls
 * /api/admin/analytics/v1/… — the report, the websites list, adding and
 * removing one, "leave this device out".
 *
 * On the staff ladder (staff.analytics.view to look, staff.analytics.manage
 * to change), asked on every call; never a company's numbers. Never
 * cross-origin.
 */
const { handle } = buildPlatformAnalyticsHandlers();

export const GET = handle;
export const POST = handle;
