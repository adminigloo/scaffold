import { buildAudienceAdminHandlers } from "@/server/website";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Who is left out of a __TENANT_LABEL_LOWER__'s numbers (audience.manage): its rules, a
 * preview of what one would clean out of past numbers, adding and removing
 * one. The __TENANT_LABEL_LOWER__ is the one in the path; another's rule is "not found".
 */
const { handle } = buildAudienceAdminHandlers();

export const GET = handle;
export const POST = handle;
