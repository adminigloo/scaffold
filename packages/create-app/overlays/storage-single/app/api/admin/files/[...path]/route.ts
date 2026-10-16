import { buildFilesHandlers } from "@/server/files-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * The business's files: a record's "Photos and files", /admin/files and the
 * usage meter call /api/admin/files/v1/admin/… — list, upload, open, copy a
 * link, remove, and a record's attachments.
 *
 * Behind THIS project's sign-in and staff keys; THE ROW DECIDES (D12): one
 * file, or a record's files, asks what that record's own permissions grant,
 * mapped to staff keys (src/server/files-routes.ts). Uploads are checked for
 * their type (from the bytes) and size, up to 4 MB. Never cross-origin.
 */
const { handle } = buildFilesHandlers();

export const GET = handle;
export const POST = handle;
