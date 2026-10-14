import { z } from "zod";
import type { CommsErrorCode, WireIssue } from "./wire.js";

/**
 * The HTTP mechanics the staff handlers share with the other feature packages
 * (scheduling's are the original): the same-site check, body parsing, the
 * error vocabulary and its statuses. COPIED, never imported, so comms stays
 * installable without any other AdminIgloo package.
 */

function hostOf(value: string): string | null {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * COPIED FROM @adminigloo/scheduling's http.ts; change both or neither.
 *
 * Was this request sent by a browser from ANOTHER site? Every POST passes
 * this before any work: a staff session cookie must not be usable from
 * another site.
 *
 *  1. Sec-Fetch-Site, when present, is the browser's own verdict and cannot
 *     be set by a page: same-origin, same-site and none pass; cross-site
 *     does not.
 *  2. Otherwise the Origin header (or the Referer) must name the same host as
 *     the request URL (or X-Forwarded-Host). `Origin: null` is cross-site.
 *  3. With neither header, the request is allowed only if it carries no
 *     Sec-Fetch-* header at all, i.e. it is not from a browser.
 */
export function isCrossSiteRequest(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null) {
    const verdict = site.trim().toLowerCase();
    return !(verdict === "same-origin" || verdict === "same-site" || verdict === "none");
  }
  const origin = req.headers.get("origin");
  if (origin !== null && origin.trim().toLowerCase() === "null") return true;
  const source = origin ?? req.headers.get("referer");
  if (source) {
    const from = hostOf(source);
    if (!from) return true;
    const forwarded = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim().toLowerCase();
    return !(from === hostOf(req.url) || (forwarded !== undefined && forwarded !== "" && from === forwarded));
  }
  for (const name of req.headers.keys()) {
    if (name.toLowerCase().startsWith("sec-fetch-")) return true;
  }
  return false;
}

export const COMMS_ERROR_STATUS: Record<CommsErrorCode, number> = {
  invalid: 400,
  forbidden: 403,
  cross_site: 403,
  not_found: 404,
  rate_limited: 429,
  internal: 500,
};

/** An error a handler answers as is: code, message, and `issues` for a form. */
export class CommsHttpError extends Error {
  readonly name = "CommsHttpError";
  constructor(
    readonly code: CommsErrorCode,
    message: string,
    readonly issues?: WireIssue[],
  ) {
    super(message);
  }
}

export const NOT_FOUND_MESSAGE = "That isn't here.";
export const INTERNAL_MESSAGE = "Something went wrong. Please try again.";
export const CROSS_SITE_MESSAGE = "This request came from another site, so it was refused.";
export const FORBIDDEN_MESSAGE = "You don't have permission to do that.";

/** Zod issues → the wire's `issues`, WITHOUT the input values. */
export function wireIssues(error: z.ZodError): WireIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.filter((part): part is string | number => typeof part !== "symbol"),
    message: issue.message,
  }));
}

/** Any thrown value → the wire error, never echoing an unknown error's own text. */
export function toWireError(error: unknown): {
  status: number;
  code: CommsErrorCode;
  message: string;
  issues?: WireIssue[];
} {
  if (error instanceof CommsHttpError) {
    return {
      status: COMMS_ERROR_STATUS[error.code],
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

/** 32 KB: a template body is at most 20,000 characters, plus its subject and the JSON around them. */
const MAX_BODY_BYTES = 32 * 1024;

/** A JSON object body. Missing → {}. Over 32 KB, not JSON, or not an object → 400 invalid. */
export async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    throw new CommsHttpError("invalid", "That's too long to save.");
  }
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CommsHttpError("invalid", "Expected a JSON body.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CommsHttpError("invalid", "Expected a JSON object.");
  }
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

export function failure(error: unknown): Response {
  const wire = toWireError(error);
  return json({ error: { code: wire.code, message: wire.message, ...(wire.issues ? { issues: wire.issues } : {}) } }, wire.status);
}
