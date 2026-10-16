import { buildFeedbackAdminHandlers } from "@/server/feedback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A company's feedback board: /app/feedback calls
 * /api/app/{company id}/feedback/v1/admin/… — the board, a ticket's report
 * and conversation, replies, moves, assignments, archive, and the board's
 * columns, categories and website keys.
 *
 * THE COMPANY IS THE ONE IN THE PATH, asked on every call (feedback.view to
 * look, feedback.manage to work tickets, feedback.settings.manage to change
 * the board). Another company's ticket, column, category or key is "not
 * found" here. Never cross-origin.
 */
const { handle } = buildFeedbackAdminHandlers();

export const GET = handle;
export const POST = handle;
