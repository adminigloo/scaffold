import { buildPlatformAiMentionsHandlers } from "@/server/ai-mentions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Check now asks every question, a few at a time, inside 45 seconds.
export const maxDuration = 60;

/**
 * THIS SITE'S OWN AI mentions, for its staff: /admin/aeo calls
 * /api/admin/ai-mentions/v1/… — the questions, who the site is, Check now.
 *
 * On the staff ladder (staff.aeo.view to read, staff.aeo.manage to change and
 * check), asked on every call. Never cross-origin.
 */
const { handle } = buildPlatformAiMentionsHandlers();

export const GET = handle;
export const POST = handle;
