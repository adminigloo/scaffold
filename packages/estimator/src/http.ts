import { z } from "zod";
import { EstimatorInputError } from "./types.js";
import type { WireErrorCode, WireIssue } from "./wire.js";

/**
 * COPIED FROM @adminigloo/scheduling's http.ts (`isCrossSiteRequest`,
 * `HttpError`, `wireIssues`, `toWireError`, `readJsonBody`, `safeDecode`,
 * `createThrottle`); change both or neither. The error-code table and the
 * estimator's own refusal class are this package's.
 *
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
 * Was this request sent by a browser from ANOTHER site? The CSRF check every
 * unkeyed public POST and every staff POST passes before any work.
 *
 *  1. Sec-Fetch-Site, when present, is the browser's own verdict and cannot
 *     be set by a page: same-origin, same-site (a sibling subdomain of the
 *     same registrable domain) and none (typed, bookmarked) pass; cross-site
 *     does not. Every current browser sends it.
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

/** The HTTP status for each wire error code (section 8.3 of the contract), both factories. */
export const WIRE_ERROR_STATUS: Readonly<Record<WireErrorCode, number>> = {
  invalid: 400,
  spam_suspected: 400,
  photo_invalid: 400,
  photo_limit: 400,
  product_unavailable: 400,
  product_not_estimatable: 400,
  invalid_measurement: 400,
  invalid_options: 400,
  invalid_supply_basis: 400,
  invalid_recipe_config: 400,
  invalid_price_range: 400,
  discount_exceeds_subtotal: 400,
  empty_estimate: 400,
  no_customer_email: 400,
  unpriced_lines: 400,
  photo_unavailable: 400,
  takeoff_unavailable: 400,
  item_unavailable: 400,
  option_unavailable: 400,
  option_value_unavailable: 400,
  component_unavailable: 400,
  not_found: 404,
  unauthorized: 401,
  forbidden: 403,
  origin_not_allowed: 403,
  estimates_closed: 403,
  photos_disabled: 403,
  not_changeable: 409,
  transition_not_allowed: 409,
  quote_expired: 409,
  already_answered: 409,
  sample_already_loaded: 409,
  settings_incomplete: 409,
  quote_changed: 409,
  managed_externally: 409,
  rate_limited: 429,
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

/** The parts of a wire error a handler answers with. */
export interface WireError {
  status: number;
  code: WireErrorCode;
  message: string;
  issues?: WireIssue[];
  /** True for an error the handler did not expect: reported to `onError`, its text never sent. */
  unexpected: boolean;
}

/** Any thrown value → the wire error, never echoing an unknown error's own text. */
export function toWireError(error: unknown, rename: Readonly<Record<string, string>> = {}): WireError {
  if (error instanceof HttpError) {
    return {
      status: WIRE_ERROR_STATUS[error.code],
      code: error.code,
      message: error.message,
      ...(error.issues ? { issues: error.issues } : {}),
      unexpected: error.code === "internal",
    };
  }
  if (error instanceof EstimatorInputError) {
    const code = error.code as WireErrorCode;
    const status = WIRE_ERROR_STATUS[code];
    if (status !== undefined) return { status, code, message: error.message, unexpected: false };
  }
  if (error instanceof z.ZodError) {
    return {
      status: 400,
      code: "invalid",
      message: "Some details need another look.",
      issues: wireIssues(error, rename),
      unexpected: false,
    };
  }
  return { status: 500, code: "internal", message: INTERNAL_MESSAGE, unexpected: true };
}

/** Body limits: a JSON body of at most 20 000 characters; a photo route takes 900 000. */
export const MAX_BODY_CHARS = 20_000;
export const MAX_PHOTO_BODY_CHARS = 900_000;

/** A JSON object body, tolerant of `text/plain` (sendBeacon). Missing → {}. */
export async function readJsonBody(req: Request, maxChars = MAX_BODY_CHARS): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > maxChars) throw new HttpError("invalid", "Request body is too large.");
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
