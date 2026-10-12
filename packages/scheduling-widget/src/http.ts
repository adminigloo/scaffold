import type { WireErrorCode, WireIssue } from "./types.js";

/**
 * The one place both transports talk HTTP, and the narrow shape checks they
 * share.
 *
 * Every call RETURNS its failure instead of throwing. A picker that throws
 * takes the business's marketing page down with it, and a calendar that
 * throws mid-drag leaves staff staring at a blank panel. So: a fetch that
 * throws becomes `network` (status 0), a non-2xx with the contract's error
 * body becomes that code, and anything else the server (or a proxy, or a
 * half-deployed build) sends — an HTML error page, an empty body, a shape we
 * don't recognise — becomes `bad_response`. Never a TypeError mid-render.
 *
 * GETs send no custom headers (only the ones a host passes explicitly), so a
 * same-origin page never pays for a CORS preflight on the hot path: config and
 * slots on every view of the booking page.
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
  /** Where the handlers are mounted, e.g. "/api/schedule" or "https://example.com/api/schedule". */
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
  "forbidden",
  "rate_limited",
  "too_many_requests",
  "booking_closed",
  "slot_unavailable",
  "too_soon",
  "too_far",
  "invalid_duration",
  "unknown_service",
  "address_unresolved",
  "too_late",
  "outside_hours",
  "invalid_window",
  "resource_unavailable",
  "not_changeable",
  "transition_not_allowed",
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;

export function isDateString(value: unknown): value is string {
  return typeof value === "string" && DATE_RE.test(value);
}

export function isTimeOfDay(value: unknown): value is string {
  return typeof value === "string" && TIME_RE.test(value);
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

/**
 * A non-2xx answer as an error value. Tolerates bodies that are not the
 * contract's.
 *
 * A 401 is ALWAYS "signed out", whatever the body: a host's sign-in check
 * answers with its own plain text ("Sign in") or its own JSON, and a
 * dispatcher whose session expired mid-day used to see "Unexpected answer
 * from the server (401)." as their drag snapped back.
 */
export function toClientError(status: number, body: unknown): ClientError {
  if (status === 401) return { code: "forbidden", message: SIGNED_OUT_MESSAGE, status: 401 };
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
  return { code: "bad_response", message: `Unexpected answer from the server (${status}).`, status };
}

/** What a staff screen says when the session behind it has ended. */
export const SIGNED_OUT_MESSAGE = "You've been signed out. Sign in again to keep working.";

export function networkError(message = "Couldn't reach the server."): ClientError {
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
        // Times change by the minute; a cached copy offers one that's gone.
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
        return { ok: false, error: { code: "forbidden", message: SIGNED_OUT_MESSAGE, status: 401 } };
      }
      const data = parse(parsed);
      if (data === null) {
        return { ok: false, error: { code: "bad_response", message: "The server's answer wasn't in the expected shape.", status: res.status } };
      }
      return { ok: true, data };
    } catch {
      // A fake or broken Response object (no .text, no .status): still an answer, never a throw.
      return { ok: false, error: { code: "bad_response", message: "The server's answer couldn't be read.", status: 0 } };
    }
  };

  return {
    url: (path) => joinUrl(options.baseUrl, path),
    get: (path, parse) => send("GET", path, undefined, parse),
    post: (path, body, parse) => send("POST", path, body, parse),
  };
}
