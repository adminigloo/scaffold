import { contentHeaders, ifNoneMatch, notModifiedHeaders, withLength } from "./handlers.js";
import { FILE_NOT_FOUND_MESSAGE, json, LINK_NOT_FOUND_MESSAGE, safeDecode } from "./http.js";
import type { Storage } from "./instance.js";
import type { StoredFile } from "./types.js";

/**
 * The public file routes (section 6.8), mounted at `/api/files/` in both
 * modes: a link is not a company page, and a logo's address must survive a
 * change of web address.
 *
 *   GET v1/f/{token}    a signed link to one private file
 *   GET v1/p/{random}   a PUBLIC file (the logo) by the random part of its key
 *
 * ANY FAILURE OF A LINK IS THE SAME 404 (review G2): malformed, altered,
 * expired, removed, another company's, a maker who is no longer a member, a
 * suspended company. A link that says why it failed tells a guesser which
 * part to change.
 *
 * ALWAYS STREAMED (review BO-24): never a redirect to the store, so the
 * headers below (and no store URL) are what a browser sees, and a revoked
 * link stops at once: `private, no-cache` with the row's ETag makes the
 * browser ask again on every open, and every ask re-checks the maker.
 *
 * GET and HEAD only. No CORS needed: an <img> loads cross-origin without it.
 */
export interface CreateStorageLinkHandlersOptions {
  readonly storage: Storage;
  readonly onError?: (error: unknown, context: { readonly route: string }) => void;
}

const LINK_PATH = /\/v1\/f\/([^/]+)\/?$/;
const PUBLIC_PATH = /\/v1\/p\/([^/]+)\/?$/;

export function createStorageLinkHandlers(options: CreateStorageLinkHandlersOptions): { handle(req: Request): Promise<Response> } {
  if (!options?.storage) throw new Error("createStorageLinkHandlers: pass storage (createStorage(…))");
  const storage = options.storage;
  const report = (error: unknown, kind: string) => {
    try {
      options.onError?.(error, { route: kind });
    } catch {
      /* a broken reporter must not turn a handled answer into a crash */
    }
  };
  const notFound = (message: string, extra: Record<string, string> = {}) =>
    json({ error: { code: "not_found", message } }, 404, { "x-robots-tag": "noindex", "referrer-policy": "no-referrer", ...extra });

  async function serve(req: Request, file: StoredFile, extra: Record<string, string>, message: string, kind: string): Promise<Response> {
    const headers = contentHeaders(file, extra);
    if (file.sha256 && ifNoneMatch(req, `"${file.sha256}"`)) return new Response(null, { status: 304, headers: notModifiedHeaders(headers) });
    if (req.method === "HEAD") {
      headers.set("content-length", String(file.sizeBytes));
      return new Response(null, { status: 200, headers });
    }
    const opened = await storage.open({ tenantId: file.tenantId, fileId: file.id });
    if (!opened) {
      report(new Error(`A ${kind} file's bytes couldn't be read.`), kind);
      return notFound(message);
    }
    return new Response(opened.object.body as BodyInit, { status: 200, headers: withLength(headers, opened.object, file) });
  }

  async function handle(req: Request): Promise<Response> {
    const pathname = new URL(req.url).pathname;
    const link = LINK_PATH.exec(pathname);
    const pub = link ? null : PUBLIC_PATH.exec(pathname);
    if (!link && !pub) return notFound(FILE_NOT_FOUND_MESSAGE);
    if (req.method !== "GET" && req.method !== "HEAD") {
      return json({ error: { code: "invalid", message: "Use GET for this address." } }, 405, { allow: "GET, HEAD" });
    }
    const kind = link ? "link" : "public";
    try {
      if (link) {
        const file = await storage.resolveLink(safeDecode(link[1] as string));
        if (!file) return notFound(LINK_NOT_FOUND_MESSAGE, { "cache-control": "private, no-cache" });
        return await serve(
          req,
          file,
          { "cache-control": "private, no-cache", "x-robots-tag": "noindex" },
          LINK_NOT_FOUND_MESSAGE,
          kind,
        );
      }
      const file = await storage.publicFile(safeDecode(pub?.[1] as string));
      if (!file || file.access !== "public") return notFound(FILE_NOT_FOUND_MESSAGE);
      // A public file's address names its random key, which is never reused:
      // it can be cached forever.
      return await serve(req, file, { "cache-control": "public, max-age=31536000, immutable" }, FILE_NOT_FOUND_MESSAGE, kind);
    } catch (error) {
      report(error, kind);
      return json({ error: { code: "internal", message: "Something went wrong. Please try again." } }, 500);
    }
  }

  return { handle };
}
