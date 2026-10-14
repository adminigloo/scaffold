import { buildCommsAdminHandlers } from "@/server/comms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Messages console's API: /admin/comms calls /api/admin/comms/v1/admin/….
 *
 * The package's handlers (Tenancy 2a, D3) behind THIS project's sign-in and
 * staff keys: `staff.comms.view` to read, `staff.comms.manage` to edit the
 * wording, switch a message off or send what's due (src/server/comms.ts).
 * "Send what's due now" goes through the same hooks the cron uses. Never
 * cross-origin.
 */
const { handle } = buildCommsAdminHandlers();

export const GET = handle;
export const POST = handle;
