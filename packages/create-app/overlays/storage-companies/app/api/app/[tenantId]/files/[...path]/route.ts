import { buildFilesHandlers } from "@/server/files-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * A company's files: a record's "Photos and files", /app/files and the usage
 * meter call /api/app/{company id}/files/v1/admin/… — list, upload, open,
 * copy a link, remove, and a record's attachments.
 *
 * THE COMPANY IS THE ONE IN THE PATH; THE ROW DECIDES (D12): one file, or a
 * record's files, asks what that record's own permissions grant. Another
 * company's file, or a record the person can't see, is "not found". Uploads
 * are checked for their type (from the bytes) and size, up to 4 MB. Never
 * cross-origin.
 */
const { handle } = buildFilesHandlers();

export const GET = handle;
export const POST = handle;
