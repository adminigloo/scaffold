import { z } from "zod";
import type { AlertsErrorCode, WireIssue } from "./wire.js";

/**
 * The HTTP mechanics the alerts handlers share with the other feature
 * packages (scheduling's are the original): the same-site check, body
 * parsing, the error vocabulary and its statuses. COPIED from
 * @adminigloo/comms's http.ts, never imported, so notifications stays
 * installable without any other AdminIgloo package (D14).
 */

function urlOf(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** The first value of a forwarded header ("a, b" → "a"), lower case; null when absent or empty. */
function forwardedValue(req: Request, name: string): string | null {
  const value = req.headers.get(name)?.split(",")[0]?.trim().toLowerCase();
  return value ? value : null;
}

/**
 * COPIED FROM @adminigloo/scheduling's http.ts (review SEC-04 tightened this
 * copy: same ORIGIN, not same site); change both or neither.
 *
 * Was this request sent by a browser from ANOTHER ORIGIN? Every POST passes
 * this before any work: a staff session cookie must not be usable from
 * another site, nor from a sibling on the same domain (www.greenacres.com on
 * a CMS, a taken-over subdomain), which carries the SameSite=Lax cookie too
 * and could otherwise add an outside address to the company's lead list.
 *
 *  1. Sec-Fetch-Site, when present, is the browser's own verdict and cannot
 *     be set by a page: same-origin and none pass; same-site and cross-site
 *     do not.
 *  2. Otherwise the Origin header (or the Referer) must name EXACTLY this
 *     origin: the request URL's scheme, host and port, or the X-Forwarded-Host
 *     a proxy put in front (with X-Forwarded-Proto's scheme when it says
 *     one). `Origin: null` is refused.
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
    const from = urlOf(source.trim());
    if (!from) return true;
    const own = urlOf(req.url);
    if (own && from.origin === own.origin) return false;
    const forwardedHost = forwardedValue(req, "x-forwarded-host");
    if (forwardedHost === null || from.host.toLowerCase() !== forwardedHost) return true;
    const forwardedProto = forwardedValue(req, "x-forwarded-proto");
    return forwardedProto !== null && from.protocol !== `${forwardedProto}:`;
  }
  for (const name of req.headers.keys()) {
    if (name.toLowerCase().startsWith("sec-fetch-")) return true;
  }
  return false;
}

export const ALERTS_ERROR_STATUS: Record<AlertsErrorCode, number> = {
  invalid: 400,
  forbidden: 403,
  cross_site: 403,
  not_found: 404,
  rate_limited: 429,
  internal: 500,
};

/** An error a handler answers as is: code, message, and `issues` for a form. */
export class AlertsHttpError extends Error {
  readonly name = "AlertsHttpError";
  constructor(
    readonly code: AlertsErrorCode,
    message: string,
    readonly issues?: WireIssue[],
  ) {
    super(message);
  }
}

export const NOT_FOUND_MESSAGE = "That isn't here.";
export const ALERT_NOT_FOUND_MESSAGE = "That alert isn't here.";
export const INTERNAL_MESSAGE = "Something went wrong. Please try again.";
export const CROSS_SITE_MESSAGE = "This request came from another site, so it was refused.";
export const FORBIDDEN_MESSAGE = "You don't have permission to do that.";
/** 3.6: the alerts handlers need a PERSON. */
export const NO_PERSON_MESSAGE = "Sign in again to see your alerts.";

/** Zod issues → the wire's `issues`, WITHOUT the input values. */
export function wireIssues(error: z.ZodError): WireIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.filter((part): part is string | number => typeof part !== "symbol"),
    message: issue.message,
  }));
}

/** Any thrown value → the wire error, never echoing an unknown error's own text. */
export function toWireError(error: unknown): { status: number; code: AlertsErrorCode; message: string; issues?: WireIssue[] } {
  if (error instanceof AlertsHttpError) {
    return {
      status: ALERTS_ERROR_STATUS[error.code],
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

/** 16 KB (4.7): the largest body is a routing list of 20 people and 5 addresses. */
const MAX_BODY_BYTES = 16 * 1024;

/** A JSON object body. Missing → {}. Over 16 KB, not JSON, or not an object → 400 invalid. */
export async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    throw new AlertsHttpError("invalid", "That's too long to save.");
  }
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AlertsHttpError("invalid", "Expected a JSON body.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AlertsHttpError("invalid", "Expected a JSON object.");
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
