import { buildPlatformAudienceHandlers } from "@/server/website";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Who is left out of THIS SITE'S OWN numbers (staff.audience.manage): the
 * rules, a preview of what one would clean out of past numbers, adding one
 * and removing one (the numbers come back exactly).
 */
const { handle } = buildPlatformAudienceHandlers();

export const GET = handle;
export const POST = handle;
