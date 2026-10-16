import { buildAlertsHandlers } from "@/server/alerts-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The business's alerts: the bell (and, with an admin panel, /admin/alerts
 * and Alert settings) call /api/admin/alerts/v1/admin/… — the count, the
 * list, marking read, each person's choices, and who hears about new work.
 *
 * The package's handlers behind THIS project's sign-in and staff keys:
 * `staff.alerts.view` to get your own alerts, `staff.alerts.manage` to choose
 * who hears about new work (src/server/alerts-routes.ts). Another person's
 * alert is "not found" here. Never cross-origin.
 */
const { handle } = buildAlertsHandlers();

export const GET = handle;
export const POST = handle;
