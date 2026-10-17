import { buildAssistantHandlers } from "@/server/assistant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A company's assistant: the button on its pages and /app/assistant call
 * /api/app/{company id}/assistant/v1/… — the chat, the person's own
 * conversations, "Yes, do it" on a change it offers, and the assistant's
 * settings (its profile, answers, house rules, words and month of AI).
 *
 * THE COMPANY IS THE ONE IN THE PATH, asked on every call (assistant.use to
 * ask, assistant.settings.manage for its settings), and every tool is asked
 * for again with the person's own permission there. Another company's
 * conversation, change, rule, word or answer is "not found". Never
 * cross-origin.
 */
const { handle } = buildAssistantHandlers();

export const GET = handle;
export const POST = handle;
