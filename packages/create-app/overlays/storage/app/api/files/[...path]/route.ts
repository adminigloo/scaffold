import { buildFileLinkHandlers } from "@/server/files-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Signed links and public files, in both modes (Tenancy 2b-1, 6.8):
 *
 *   /api/files/v1/f/{token}   a short-lived link to a PRIVATE file. Opened
 *                             only while its signature, its expiry (an hour
 *                             at most), its company and the person who made
 *                             it all still check out — a removed member's
 *                             copied link stops working on the next open.
 *   /api/files/v1/p/{random}  a PUBLIC file (the company logo), by the
 *                             unguessable part of its key. A private file is
 *                             never served here, whatever is asked.
 *
 * Every file is streamed by this route, never a redirect to the store, so a
 * private file's storage address never leaves the server. GET and HEAD only.
 */
const { handle } = buildFileLinkHandlers();

export const GET = handle;
export const HEAD = handle;
