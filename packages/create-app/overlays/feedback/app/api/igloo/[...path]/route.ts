import { buildFeedbackIntakeHandlers } from "@/server/feedback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The feedback widget's intake, by WEBSITE KEY: /api/igloo/v1/{config,upload,
 * submit,thread,reply}.
 *
 * AUTHENTICATED BY THE WIDGET'S KEY, NOT A SIGN-IN — deliberately, and the
 * distinction is the product. Reporters are the people using whichever site
 * mounts the widget; they have no account here and must not need one, or the
 * only people who can report a sign-in problem are the people who got past
 * it. The key is checked against its stored hash and names the board every
 * ticket it sends lands on: this site's own (the in-app button) or, in a
 * project with companies, the company whose website carries it.
 *
 * The handlers (who is closed to new tickets, where screenshots are kept, who
 * hears about a new ticket) are built in src/server/feedback.ts.
 */
const { handle } = buildFeedbackIntakeHandlers();

export const GET = handle;
export const POST = handle;
export const OPTIONS = handle;
