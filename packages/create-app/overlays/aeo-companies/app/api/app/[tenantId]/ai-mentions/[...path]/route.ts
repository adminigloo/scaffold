import { buildAiMentionsHandlers } from "@/server/ai-mentions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Check now asks every question, a few at a time, inside 45 seconds.
export const maxDuration = 60;

/**
 * A __TENANT_LABEL_LOWER__'s AI mentions: /app/website calls
 * /api/app/{__TENANT_LABEL_LOWER__ id}/ai-mentions/v1/… — its questions, who it is, the
 * answers, Check now.
 *
 * THE __TENANT_LABEL_LOWER__ IS THE ONE IN THE PATH, asked on every call (aeo.view to read,
 * aeo.manage to change and check); another __TENANT_LABEL_LOWER__'s question is "not found".
 * Every answer is held against this __TENANT_LABEL_LOWER__'s month of AI first. Never cross-origin.
 */
const { handle } = buildAiMentionsHandlers();

export const GET = handle;
export const POST = handle;
