import { buildPlatformAssistantHandlers } from "@/server/assistant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * THIS SITE'S OWN assistant (its staff's): /admin/assistant/chat calls
 * /api/admin/assistant/v1/… — the chat, its history, "Yes, do it" on a change
 * it offers, and its answers to common questions.
 *
 * On the staff ladder (staff.assistant.use to ask, staff.assistant.manage for
 * its settings), asked on every call; never a company's assistant. Never
 * cross-origin. Without a model (--ai) the chat says it isn't switched on.
 */
const { handle } = buildPlatformAssistantHandlers();

export const GET = handle;
export const POST = handle;
