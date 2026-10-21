import type { TenancyErrorCode, WireIssue } from "./types.js";
import { BAD_RESPONSE_MESSAGE, codeFallback, NETWORK_MESSAGE, SIGNED_OUT_MESSAGE } from "./words.js";

export { SIGNED_OUT_MESSAGE };

/**
 * The one place both transports talk HTTP, and the narrow shape checks they
 * share (scheduling-widget's http.ts, copied and re-coded for tenancy; never
 * imported, so a fix there can't silently change this widget's wire).
 *
 * Every call RETURNS its failure instead of throwing. A header switcher that
 * throws takes every company page down with it, and a team page that throws
 * mid-removal leaves an owner staring at a blank panel, unsure whether the
 * person is gone. So: a fetch that throws becomes `network` (status 0), a
 * non-2xx with the contract's error body becomes that code, and anything else
 * the server (or a proxy, or a half-deployed build) sends (an HTML error
 * page, an empty body, a shape we don't recognise) becomes `bad_response`.
 * Never a TypeError mid-render.
 *
 * GETs send no custom headers (only the ones a host passes explicitly), so a
 * same-origin page never pays for a CORS preflight on the hot path: the
 * session on every page view, the checklist on the dashboard.
 */

export type Result<T> = { ok: true; data: T } | { ok: false; error: ClientError };

export interface ClientError {
  code: TenancyErrorCode | "network" | "bad_response";
  /** The server's plain sentence, or ours. */
  message: string;
  /** HTTP status; 0 when the request never got an answer. */
  status: number;
  issues?: WireIssue[];
  /** A free web address to offer instead (slug_taken / slug_reserved / slug_invalid). */
  suggestion?: string;
  /** Where "Upgrade" goes beside a seats-full refusal. */
  upgradeHref?: string;
}

export interface TransportOptions {
  /** Where the handlers are mounted, e.g. "/api/tenancy" or "https://example.com/api/tenancy". */
  baseUrl: string;
  /** For tests and unusual runtimes; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Extra headers on every request (an auth header for a cross-origin admin, say). */
  headers?: Record<string, string>;
}

/** `base` + `path` with exactly one slash between them. */
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

/** One path segment, encoded: ids and keys never change the route they sit in. */
export function seg(value: string): string {
  return encodeURIComponent(value);
}

/** Every `TenancyErrorCode` (contract 6.1). A code outside this set is a bad answer, not a refusal. */
export const WIRE_ERROR_CODES: ReadonlySet<TenancyErrorCode> = new Set<TenancyErrorCode>([
  "invalid",
  "signed_out",
  "forbidden",
  "not_a_member",
  "company_suspended",
  "not_staff",
  "cross_site",
  "not_found",
  "unavailable",
  "name_invalid",
  "slug_invalid",
  "slug_reserved",
  "slug_taken",
  "rank",
  "owner_protected",
  "owner_must_transfer",
  "self",
  "last_owner",
  "last_admin",
  "already_member",
  "personal_workspace",
  "seats_full",
  "confirmation_mismatch",
  "logo_storage_off",
  "logo_invalid",
  "rate_limited",
  "internal",
  "still_paying",
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

/** A non-empty string. Ids, keys and names are never "". */
export function isId(value: unknown): value is string {
  return typeof value === "string" && value !== "";
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

/** Only an explicit `true` is true: a missing permission flag never grants anything. */
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

/** One of `allowed`, else null. */
export function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function parseIssue(raw: unknown): WireIssue | null {
  if (!isObject(raw)) return null;
  const path = Array.isArray(raw.path)
    ? raw.path.filter((part): part is string | number => typeof part === "string" || typeof part === "number")
    : [];
  return { path, message: str(raw.message, "Check this field.") || "Check this field." };
}

/**
 * A non-2xx answer as an error value. Tolerates bodies that are not the
 * contract's.
 *
 * A 401 is ALWAYS "signed out", whatever the body: a host's sign-in wall
 * answers with its own plain text or its own JSON, and an owner whose
 * session expired mid-edit should read "sign in again", not "Unexpected
 * answer from the server (401)."
 *
 * `suggestion` and `upgradeHref` are kept from the error body: the slug
 * refusals carry a free address to offer in one click, and seats_full carries
 * where "Upgrade" goes.
 */
export function toClientError(status: number, body: unknown): ClientError {
  if (status === 401) return { code: "signed_out", message: SIGNED_OUT_MESSAGE, status: 401 };
  const error = isObject(body) && isObject(body.error) ? body.error : null;
  if (error && isString(error.code) && WIRE_ERROR_CODES.has(error.code as TenancyErrorCode)) {
    const issues = listOf(error.issues, parseIssue);
    const suggestion = strOrNull(error.suggestion);
    const upgradeHref = strOrNull(error.upgradeHref);
    return {
      code: error.code as TenancyErrorCode,
      // The server's sentence; a host transport that sent only a code gets ours.
      message: str(error.message).trim() || codeFallback(error.code as TenancyErrorCode),
      status,
      ...(issues.length > 0 ? { issues } : {}),
      ...(suggestion ? { suggestion } : {}),
      ...(upgradeHref ? { upgradeHref } : {}),
    };
  }
  return { code: "bad_response", message: BAD_RESPONSE_MESSAGE, status };
}

export function networkError(): ClientError {
  return { code: "network", message: NETWORK_MESSAGE, status: 0 };
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

export interface Requester {
  url(path: string): string;
  get<T>(path: string, parse: (body: unknown) => T | null): Promise<Result<T>>;
  post<T>(path: string, body: unknown, parse: (body: unknown) => T | null): Promise<Result<T>>;
  /** A multipart POST: the FormData sets its own content-type (with the boundary), so none is set by hand. */
  postForm<T>(path: string, form: FormData, parse: (body: unknown) => T | null): Promise<Result<T>>;
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
    body: { kind: "none" } | { kind: "json"; value: unknown } | { kind: "form"; value: FormData },
    parse: (body: unknown) => T | null,
  ): Promise<Result<T>> => {
    let res: Response;
    try {
      const headers: Record<string, string> = { ...extra };
      if (body.kind === "json") headers["content-type"] = "application/json";
      res = await doFetch(joinUrl(options.baseUrl, path), {
        method,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(body.kind === "json" ? { body: JSON.stringify(body.value ?? {}) } : {}),
        ...(body.kind === "form" ? { body: body.value } : {}),
        // Membership changes by the request: a cached team list shows someone
        // who was removed a second ago.
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
        return { ok: false, error: { code: "signed_out", message: SIGNED_OUT_MESSAGE, status: 401 } };
      }
      const data = parse(parsed);
      if (data === null) return { ok: false, error: { code: "bad_response", message: BAD_RESPONSE_MESSAGE, status: res.status } };
      return { ok: true, data };
    } catch {
      // A fake or broken Response object (no .text, no .status): still an answer, never a throw.
      return { ok: false, error: { code: "bad_response", message: BAD_RESPONSE_MESSAGE, status: 0 } };
    }
  };

  return {
    url: (path) => joinUrl(options.baseUrl, path),
    get: (path, parse) => send("GET", path, { kind: "none" }, parse),
    post: (path, body, parse) => send("POST", path, { kind: "json", value: body }, parse),
    postForm: (path, form, parse) => send("POST", path, { kind: "form", value: form }, parse),
  };
}
