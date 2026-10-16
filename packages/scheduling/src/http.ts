import { z } from "zod";
import { BookingNotBookableError, BookingStatusTransitionError } from "./types.js";
import type { WireErrorCode, WireIssue } from "./wire.js";

/**
 * What both handler factories share: the CSRF check, body parsing, the error
 * vocabulary and its HTTP statuses.
 */

function hostOf(value: string): string | null {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * FIRST COPIED FROM @adminigloo/booking's handlers.ts. Since Tenancy 2b-1
 * (review SEC-04) it is stricter than booking's: same-site is refused here.
 * The estimator, invoicing and comms copies follow this one; change them all
 * or none.
 *
 * Was this request sent by a browser from anywhere but THIS origin? The CSRF
 * check every POST passes before any work (unless `cors` is configured).
 *
 *  1. Sec-Fetch-Site, when present, is the browser's own verdict and cannot
 *     be set by a page: same-origin and none (typed, bookmarked) pass;
 *     cross-site does not, and NEITHER DOES same-site: that is another
 *     origin on the same registrable domain (the business's www site on a
 *     CMS, a taken-over sibling subdomain), and its requests carry the
 *     SameSite=Lax session cookie, so a page there could move a signed-in
 *     owner's schedule. Tenancy's check has always been this strict. A
 *     business whose own website posts the booking form names that origin
 *     in `cors`. Every current browser sends it.
 *  2. Otherwise (an older browser) the Origin header — or, failing that, the
 *     Referer — must name the same host as the request URL. `Origin: null`
 *     (a sandboxed iframe, a file: page, a data: URL) is cross-site by
 *     definition. X-Forwarded-Host also counts as "this host", for apps
 *     behind a proxy that rewrites Host: a page cannot add that header to a
 *     cross-site request without a CORS preflight, which this handler fails.
 *  3. With neither header, the request is allowed only if it carries no
 *     Sec-Fetch-* header at all — i.e. it is not from a browser (a server, a
 *     test, curl). A browser that sends Sec-Fetch-Mode but no Sec-Fetch-Site
 *     or Origin is not one we can vouch for, so it is refused. A non-browser
 *     caller can of course forge any header; CSRF is about a visitor's
 *     browser being driven by another site, and that browser cannot.
 */
export function isCrossSiteRequest(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null) {
    const verdict = site.trim().toLowerCase();
    // same-site is ANOTHER origin on this domain (a sibling subdomain): refused (review SEC-04).
    return !(verdict === "same-origin" || verdict === "none");
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

/** The HTTP status for each wire error code (section 4 of the contract). */
export const WIRE_ERROR_STATUS: Record<WireErrorCode, number> = {
  invalid: 400,
  spam_suspected: 400,
  too_soon: 400,
  too_far: 400,
  invalid_duration: 400,
  unknown_service: 400,
  address_unresolved: 400,
  outside_hours: 400,
  invalid_window: 400,
  resource_unavailable: 400,
  not_found: 404,
  slot_unavailable: 409,
  too_late: 409,
  not_changeable: 409,
  transition_not_allowed: 409,
  forbidden: 403,
  booking_closed: 403,
  rate_limited: 429,
  too_many_requests: 429,
  internal: 500,
};

/** An error a handler answers as is: code, message, and `issues` for a form. */
export class HttpError extends Error {
  readonly name = "HttpError";
  constructor(
    readonly code: WireErrorCode,
    message: string,
    readonly issues?: WireIssue[],
  ) {
    super(message);
  }
}

export const NOT_FOUND_MESSAGE = "Not found.";
export const INTERNAL_MESSAGE = "Something went wrong. Please try again.";

/**
 * Zod issues → the wire's `issues`, WITHOUT the input values (a form echoes
 * nothing it was sent back to whoever is listening), with the server's field
 * names mapped to the wire's (`customerName` → `name`, say).
 */
export function wireIssues(error: z.ZodError, rename: Readonly<Record<string, string>> = {}): WireIssue[] {
  return error.issues.map((issue) => {
    const path = issue.path
      .filter((part): part is string | number => typeof part !== "symbol")
      .map((part, index) => (index === 0 && typeof part === "string" && rename[part] ? rename[part] : part));
    return { path, message: issue.message, ...(typeof issue.code === "string" ? { code: issue.code } : {}) };
  });
}

/** Any thrown value → the wire error, never echoing an unknown error's own text. */
export function toWireError(
  error: unknown,
  rename: Readonly<Record<string, string>> = {},
): { status: number; code: WireErrorCode; message: string; issues?: WireIssue[] } {
  if (error instanceof HttpError) {
    return {
      status: WIRE_ERROR_STATUS[error.code],
      code: error.code,
      message: error.message,
      ...(error.issues ? { issues: error.issues } : {}),
    };
  }
  if (error instanceof BookingNotBookableError) {
    return { status: WIRE_ERROR_STATUS[error.code], code: error.code, message: error.message };
  }
  if (error instanceof BookingStatusTransitionError) {
    return { status: 409, code: "transition_not_allowed", message: error.message };
  }
  if (error instanceof z.ZodError) {
    return { status: 400, code: "invalid", message: "Some details need another look.", issues: wireIssues(error, rename) };
  }
  return { status: 500, code: "internal", message: INTERNAL_MESSAGE };
}

export const MAX_BODY_CHARS = 20_000;
/** UTF-8 takes at most 3 bytes for one UTF-16 character: the byte cap never refuses a body the character rule accepts. */
export const MAX_BODY_BYTES = MAX_BODY_CHARS * 3;

const TOO_LARGE = "Request body is too large.";

/**
 * COPIED FROM @adminigloo/storage's body.ts (`readBodyCapped`, review G10);
 * change all or none.
 *
 * The body's bytes, or `tooLarge()` thrown the moment more than `cap` have
 * arrived (Tenancy 2b-1 review SEC-01). WHY COUNT THE BYTES AS THEY STREAM:
 * `Content-Length` is a promise the client makes, and a chunked request
 * makes none. A platform with a body cap (Vercel's 4.5 MB) stops a big body
 * before the code runs; a self-hosted Node server (`next start`, a host's
 * own) has no cap at all, so `await req.text()` on a 2 GB chunked body
 * holds 2 GB in memory before anything can say no, and the public request,
 * move and cancel routes need no sign-in. So a declared length over the cap
 * is refused before a byte is read, the rest is counted as it streams, and
 * the stream is cancelled at the cap.
 */
export async function readBodyCapped(req: Request, cap: number, tooLarge: () => Error): Promise<Uint8Array> {
  const declared = req.headers.get("content-length");
  if (declared !== null && /^\s*\d+\s*$/.test(declared) && Number(declared) > cap) throw tooLarge();
  const body = req.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > cap) {
        // Stop pulling: the rest of the body is never read into memory.
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released by cancel */
    }
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/**
 * A JSON object body, tolerant of `text/plain` (sendBeacon). Missing → {}.
 * At most 20 000 characters, read through `readBodyCapped` (review SEC-01),
 * so an oversized body is refused without being held in memory first.
 */
export async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  const text = new TextDecoder().decode(await readBodyCapped(req, MAX_BODY_BYTES, () => new HttpError("invalid", TOO_LARGE)));
  if (text.length > MAX_BODY_CHARS) throw new HttpError("invalid", TOO_LARGE);
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError("invalid", "Expected a JSON body.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError("invalid", "Expected a JSON object.");
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

/** Run `work` at most once per `intervalMs` per key, in this process. Errors are swallowed. */
export function createThrottle(intervalMs: number) {
  const last = new Map<string, number>();
  return async (key: string, nowMs: number, work: () => Promise<unknown>): Promise<boolean> => {
    const previous = last.get(key);
    if (previous !== undefined && nowMs - previous < intervalMs && nowMs >= previous) return false;
    last.set(key, nowMs);
    if (last.size > 1000) {
      // Bounded: tenants come from requests, and an unbounded map is a slow leak.
      for (const stale of [...last.keys()].slice(0, 500)) last.delete(stale);
    }
    try {
      await work();
    } catch {
      /* a failed sweep must not fail the request that triggered it; the next one retries */
    }
    return true;
  };
}
