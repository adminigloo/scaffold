import { z } from "zod";
import type { FilesErrorCode, WireIssue } from "./wire.js";

/**
 * The HTTP mechanics the handlers share with the other feature packages
 * (scheduling's are the original, comms' the closest copy): the same-site
 * check, body parsing, the error vocabulary and its statuses. COPIED, never
 * imported, so storage stays installable without any other AdminIgloo
 * package.
 */

function originOf(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * COPIED FROM @adminigloo/comms's http.ts (itself from scheduling's), and
 * TIGHTENED here for review SEC-04; the other copies should follow.
 *
 * Was this request sent by a browser from anywhere but the app's OWN origin?
 * Every POST passes this before any work: a signed-in session must not be
 * usable from another page to upload into, link out of or delete from a
 * company's files.
 *
 *  1. Sec-Fetch-Site, when present, is the browser's own verdict and cannot
 *     be set by a page: same-origin and none pass. same-site does NOT (review
 *     SEC-04): it is another origin on the same domain (a marketing site on
 *     www., a sibling subdomain somebody else controls), whose requests carry
 *     the SameSite=Lax session cookie all the same. cross-site does not.
 *  2. Otherwise the Origin header (or the Referer) must be the request's own
 *     origin EXACTLY: scheme, host and port. Behind a proxy, X-Forwarded-Host
 *     (with X-Forwarded-Proto when it is sent) names the public origin.
 *     `Origin: null` is refused.
 *  3. With neither header, the request is allowed only if it carries no
 *     Sec-Fetch-* header at all, i.e. it is not from a browser.
 */
export function isCrossSiteRequest(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null) {
    const verdict = site.trim().toLowerCase();
    return !(verdict === "same-origin" || verdict === "none");
  }
  const origin = req.headers.get("origin");
  if (origin !== null && origin.trim().toLowerCase() === "null") return true;
  const source = origin ?? req.headers.get("referer");
  if (source) {
    const from = originOf(source);
    if (!from) return true;
    const own = originOf(req.url);
    if (own && from.origin === own.origin) return false;
    const forwardedHost = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim().toLowerCase();
    if (!forwardedHost) return true;
    const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
    // Without X-Forwarded-Proto the public scheme isn't known (TLS may end at
    // the proxy), so the host alone decides: a sibling subdomain still fails.
    const schemeOk = forwardedProto === "http" || forwardedProto === "https" ? from.protocol === `${forwardedProto}:` : true;
    return !(from.host.toLowerCase() === forwardedHost && schemeOk);
  }
  for (const name of req.headers.keys()) {
    if (name.toLowerCase().startsWith("sec-fetch-")) return true;
  }
  return false;
}

/** Each wire code's status (6.7's errors line). */
export const FILES_ERROR_STATUS: Record<FilesErrorCode, number> = {
  invalid: 400,
  forbidden: 403,
  cross_site: 403,
  not_found: 404,
  rate_limited: 429,
  internal: 500,
  storage_off: 409,
  file_type: 415,
  file_too_big: 413,
  storage_full: 409,
  not_removable: 409,
};

/** An error a handler answers as is: code, message, and `issues` for a form. */
export class FilesHttpError extends Error {
  readonly name = "FilesHttpError";
  constructor(
    readonly code: FilesErrorCode,
    message: string,
    readonly issues?: WireIssue[],
  ) {
    super(message);
  }
}

export const FILE_NOT_FOUND_MESSAGE = "That file isn't here.";
export const NOT_FOUND_MESSAGE = "That isn't here.";
export const INTERNAL_MESSAGE = "Something went wrong. Please try again.";
export const CROSS_SITE_MESSAGE = "This request came from another site, so it was refused.";
export const FORBIDDEN_MESSAGE = "You don't have permission to do that.";
export const LINK_NOT_FOUND_MESSAGE = "This link has expired, or the file was removed.";

/** Zod issues → the wire's `issues`, WITHOUT the input values. */
export function wireIssues(error: z.ZodError): WireIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.filter((part): part is string | number => typeof part !== "symbol"),
    message: issue.message,
  }));
}

/** Any thrown value → the wire error, never echoing an unknown error's own text. */
export function toWireError(error: unknown): { status: number; code: FilesErrorCode; message: string; issues?: WireIssue[] } {
  if (error instanceof FilesHttpError) {
    return {
      status: FILES_ERROR_STATUS[error.code],
      code: error.code,
      message: error.message,
      ...(error.issues ? { issues: error.issues } : {}),
    };
  }
  if (error instanceof z.ZodError) {
    return { status: 400, code: "invalid", message: "Some details need another look.", issues: wireIssues(error) };
  }
  return { status: 500, code: "internal", message: INTERNAL_MESSAGE };
}

/** 16 KB: the JSON routes take `{}` (4.7's mechanics). */
const MAX_JSON_BYTES = 16 * 1024;

/** A JSON object body. Missing → {}. Over 16 KB, not JSON, or not an object → 400 invalid. */
export async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) throw new FilesHttpError("invalid", "That request is too big.");
  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_JSON_BYTES) throw new FilesHttpError("invalid", "That request is too big.");
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new FilesHttpError("invalid", "Expected a JSON body.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new FilesHttpError("invalid", "Expected a JSON object.");
  return parsed as Record<string, unknown>;
}

export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function failure(error: unknown, headers: Record<string, string> = {}): Response {
  const wire = toWireError(error);
  return json({ error: { code: wire.code, message: wire.message, ...(wire.issues ? { issues: wire.issues } : {}) } }, wire.status, headers);
}
