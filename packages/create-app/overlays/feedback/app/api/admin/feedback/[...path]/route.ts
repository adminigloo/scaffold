import { buildPlatformFeedbackAdminHandlers } from "@/server/feedback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * THIS SITE'S OWN feedback board's routes, for its staff:
 * /api/admin/feedback/v1/admin/… — the board, a ticket's report and
 * conversation, replies, moves, columns, categories and website keys.
 *
 * The board is the site's own (the in-app feedback button's), never a
 * company's: each staff key is asked on every call (staff.feedback.view to
 * look, staff.feedback.manage to work tickets, staff.feedback.settings to
 * change the board). Same-origin only; no CORS.
 */
const { handle } = buildPlatformFeedbackAdminHandlers();

export const GET = handle;
export const POST = handle;
