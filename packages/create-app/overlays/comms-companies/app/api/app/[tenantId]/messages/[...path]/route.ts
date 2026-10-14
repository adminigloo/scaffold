import { buildCommsAdminHandlers } from "@/server/comms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A company's Messages console: /app/messages calls
 * /api/app/{company id}/messages/v1/admin/… — its email wording, what went to
 * whom, who its emails go out as, and "Send what's due now" for its own rows.
 *
 * THE COMPANY IS THE ONE IN THE PATH, asked on every call (`comms.view` to
 * read, `comms.manage` to edit or send). A template another company has is
 * "not found" here. Never cross-origin.
 */
const { handle } = buildCommsAdminHandlers();

export const GET = handle;
export const POST = handle;
