import { buildAlertsHandlers } from "@/server/alerts-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A company's alerts: the bell, /app/alerts and Alert settings call
 * /api/app/{company id}/alerts/v1/admin/… — the count, the list, marking
 * read, each person's choices, and who hears about new work.
 *
 * THE COMPANY IS THE ONE IN THE PATH, asked on every call (`alerts.view`;
 * `alerts.manage` to choose who hears about new work). An alert of another
 * company, or of another person, is "not found" here. Never cross-origin.
 */
const { handle } = buildAlertsHandlers();

export const GET = handle;
export const POST = handle;
