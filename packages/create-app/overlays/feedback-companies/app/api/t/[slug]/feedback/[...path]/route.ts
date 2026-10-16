import { buildFeedbackPublicHandlers } from "@/server/feedback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A company's feedback page API: /t/{web address}/feedback calls
 * /api/t/{web address}/feedback/v1/{config,upload,submit,thread,reply}.
 *
 * The web address names the company — no website key. A ticket is looked up
 * INSIDE that company by its number and the reporter's own token, so another
 * company's ticket is "not available" here. A suspended company, or one whose
 * plan ended, takes no new ticket (with a sentence saying so); its customers
 * can still read and answer the ones they have.
 */
const { handle } = buildFeedbackPublicHandlers();

export const GET = handle;
export const POST = handle;
export const OPTIONS = handle;
