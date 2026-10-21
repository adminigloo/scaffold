import type { WireErrorCode, WireIssue } from "./types.js";

/**
 * The one place both transports talk HTTP, and the narrow shape checks they
 * share. Copied from @adminigloo/scheduling-widget's `http.ts`; change both or
 * neither. (What differs: the estimator's error codes, a 401 that keeps the
 * server's `unauthorized` — a bad embed key, not a signed-out session — and
 * the embed key header, which the public client adds to every request.)
 *
 * Every call RETURNS its failure instead of throwing. An estimator that
 * throws takes the contractor's marketing page down with it (ES-14: 0.1
 * swallowed every failure into an endless "Loading…"). So: a fetch that
 * throws becomes `network` (status 0), a non-2xx with the contract's error
 * body becomes that code, and anything else the server (or a proxy, or a
 * half-deployed build) sends — an HTML error page, an empty body, a shape we
 * don't recognise — becomes `bad_response`. Never a TypeError mid-render.
 *
 * GETs send no custom headers unless the host passed some (or an embed key
 * is in play — a keyed embed is cross-origin anyway), so a same-origin page
 * never pays for a CORS preflight on the config read every visitor makes.
 */

export type Result<T> = { ok: true; data: T } | { ok: false; error: ClientError };

export interface ClientError {
  code: WireErrorCode | "network" | "bad_response";
  /** The server's message (or ours). Shown as-is for staff refusals; customers see `friendlyError`. */
  message: string;
  /** HTTP status; 0 when the request never got an answer. */
  status: number;
  issues?: WireIssue[];
}

export interface TransportOptions {
  /** Where the handlers are mounted, e.g. "/api/estimator" or "https://summitramps.com/api/estimator". */
  baseUrl: string;
  /** For tests and unusual runtimes; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Extra headers on every request (an auth header for a cross-origin admin, say). */
  headers?: Record<string, string>;
}

/** `base` + `path` with exactly one slash between them. Copied from booking-widget's client. */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

/** A query string from the defined, non-empty values only, with a leading "?" (or ""). */
export function queryString(values: Record<string, string | number | boolean | undefined | null>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

export const WIRE_ERROR_CODES: ReadonlySet<WireErrorCode> = new Set<WireErrorCode>([
  "invalid",
  "spam_suspected",
  "not_found",
  "unauthorized",
  "forbidden",
  "origin_not_allowed",
  "rate_limited",
  "estimates_closed",
  "photos_disabled",
  "photo_invalid",
  "photo_limit",
  "photo_unavailable",
  "takeoff_unavailable",
  "product_unavailable",
  "product_not_estimatable",
  "invalid_measurement",
  "invalid_options",
  "invalid_supply_basis",
  "invalid_recipe_config",
  "invalid_price_range",
  "discount_exceeds_subtotal",
  "empty_estimate",
  "no_customer_email",
  "unpriced_lines",
  "item_unavailable",
  "option_unavailable",
  "option_value_unavailable",
  "component_unavailable",
  "not_changeable",
  "transition_not_allowed",
  "quote_expired",
  "already_answered",
  "sample_already_loaded",
  "internal",
]);

// ---------------------------------------------------------------------------
// Narrow shape checks
// ---------------------------------------------------------------------------

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** A string, else `fallback`. */
export function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** A string, or null for anything else (an empty string included: "not given"). */
export function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** A finite number, else `fallback`. */
export function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** A finite number, or null. */
export function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Only an explicit `true` is true. */
export function isTrue(value: unknown): boolean {
  return value === true;
}

/** The array's items that `parse` accepts; `[]` for a non-array. */
export function listOf<T>(value: unknown, parse: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const item of value) {
    const parsed = parse(item);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

export function stringList(value: unknown): string[] {
  return listOf(value, (item) => (typeof item === "string" ? item : null));
}

/** One of `allowed`, else `fallback`. */
export function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** A `{ key: number | null }` map (customer inputs, a suggestion); other values dropped. */
export function numberMap(value: unknown): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  if (!isObject(value)) return out;
  for (const [key, raw] of Object.entries(value)) {
    if (raw === null) out[key] = null;
    else if (typeof raw === "number" && Number.isFinite(raw)) out[key] = raw;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function parseIssue(raw: unknown): WireIssue | null {
  if (!isObject(raw)) return null;
  const path = Array.isArray(raw.path)
    ? raw.path.filter((part): part is string | number => typeof part === "string" || typeof part === "number")
    : [];
  return {
    path,
    message: str(raw.message, "Check this field."),
    ...(isString(raw.code) ? { code: raw.code } : {}),
  };
}

/** What a staff screen says when the session behind it has ended. */
export const SIGNED_OUT_MESSAGE = "You've been signed out. Sign in again to keep working.";

/**
 * A non-2xx answer as an error value. Tolerates bodies that are not the
 * contract's.
 *
 * A 401 is `unauthorized` whatever the body. With the contract's body it is
 * the server refusing an embed key ("This estimator key isn't valid…"), and
 * the customer sees "isn't set up for this website yet". Without it, it is a
 * host's sign-in check answering a staff screen with its own text, and the
 * staff screens say "You've been signed out" (they read the status, 401).
 */
export function toClientError(status: number, body: unknown): ClientError {
  const error = isObject(body) && isObject(body.error) ? body.error : null;
  if (error && isString(error.code) && WIRE_ERROR_CODES.has(error.code as WireErrorCode)) {
    const issues = listOf(error.issues, parseIssue);
    return {
      code: error.code as WireErrorCode,
      message: str(error.message) || error.code,
      status,
      ...(issues.length > 0 ? { issues } : {}),
    };
  }
  if (status === 401) return { code: "unauthorized", message: SIGNED_OUT_MESSAGE, status: 401 };
  return { code: "bad_response", message: statusWords(status), status };
}

export function networkError(message = "Couldn't reach the server. Check your internet connection and try again."): ClientError {
  return { code: "network", message, status: 0 };
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

export interface Requester {
  url(path: string): string;
  get<T>(path: string, parse: (body: unknown) => T | null): Promise<Result<T>>;
  post<T>(path: string, body: unknown, parse: (body: unknown) => T | null): Promise<Result<T>>;
}

/**
 * The fetch wrapper both clients are built on. The global fetch is looked up
 * at CALL time and called as a plain function: a reference taken at module
 * load misses a polyfill installed later, and calling it as a method of
 * another object throws "Illegal invocation" in some browsers.
 */
export function createRequester(options: TransportOptions): Requester {
  const extra = options.headers ?? {};
  const doFetch = (input: string, init: RequestInit): Promise<Response> => {
    if (options.fetch) return options.fetch(input, init);
    if (typeof globalThis.fetch !== "function") return Promise.reject(new Error("fetch is not available"));
    return globalThis.fetch(input, init);
  };

  const send = async <T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    parse: (body: unknown) => T | null,
  ): Promise<Result<T>> => {
    let res: Response;
    try {
      const headers: Record<string, string> = { ...extra };
      if (method === "POST") headers["content-type"] = "application/json";
      res = await doFetch(joinUrl(options.baseUrl, path), {
        method,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
        // A price, a quote's status, a queue: a cached copy is a wrong one.
        cache: "no-store",
      });
    } catch {
      return { ok: false, error: networkError() };
    }
    try {
      let parsed: unknown = null;
      try {
        const text = await res.text();
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (!res.ok) return { ok: false, error: toClientError(res.status, parsed) };
      // A sign-in wall that REDIRECTS (middleware sending an expired session
      // to the login page) answers 200 with that page's HTML, after the
      // browser followed the redirect: signed out, not "a bad shape".
      if (parsed === null && res.redirected && /text\/html/i.test(res.headers?.get?.("content-type") ?? "")) {
        return { ok: false, error: { code: "unauthorized", message: SIGNED_OUT_MESSAGE, status: 401 } };
      }
      const data = parse(parsed);
      if (data === null) {
        return { ok: false, error: { code: "bad_response", message: "This screen and the server don't match. Reload the page to get the latest version.", status: res.status } };
      }
      return { ok: true, data };
    } catch {
      // A fake or broken Response object (no .text, no .status): still an answer, never a throw.
      return { ok: false, error: { code: "bad_response", message: "The server's answer couldn't be read. Reload the page and try again.", status: 0 } };
    }
  };

  return {
    url: (path) => joinUrl(options.baseUrl, path),
    get: (path, parse) => send("GET", path, undefined, parse),
    post: (path, body, parse) => send("POST", path, body, parse),
  };
}

/**
 * An answer that wasn't the package's own (a platform's error page, a proxy,
 * a timeout): what its HTTP status says, in plain words. The generic sentence
 * only when the status says nothing more (polish 3: no "Something went wrong"
 * where the cause is knowable).
 */
export function statusWords(status: number, fallback = "Something went wrong. Please try again."): string {
  switch (status) {
    case 401:
      return "You've been signed out. Sign in again to keep working.";
    case 403:
      return "You don't have permission to do that.";
    case 404:
      return "That isn't here any more. Reload the page.";
    case 408:
    case 504:
      return "The site took too long to answer. Please try again in a minute.";
    case 413:
      return "That's too big to send.";
    case 429:
      return "That's a lot of tries in a short time. Wait a minute, then try again.";
    case 502:
    case 503:
      return "The site isn't answering right now. Please try again in a minute.";
    default:
      return fallback;
  }
}
