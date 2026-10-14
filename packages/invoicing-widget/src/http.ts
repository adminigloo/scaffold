import type { InvoicingErrorCodeWire, WireIssue } from "./types.js";

/**
 * The one place the widget talks HTTP. COPIED from @adminigloo/scheduling-
 * widget (src/http.ts) and trimmed to what the invoice screens need; change
 * both or neither.
 *
 * Every call RETURNS its failure instead of throwing: a fetch that throws
 * becomes `network` (status 0), a non-2xx with the contract's error body
 * becomes that code, and anything else (an HTML error page, an empty body, a
 * shape we don't recognise) becomes `bad_response`. Never a TypeError
 * mid-render.
 */

export type Result<T> = { ok: true; data: T } | { ok: false; error: ClientError };

export interface ClientError {
  code: InvoicingErrorCodeWire | "network" | "bad_response";
  /** The server's message (or ours), shown as is. */
  message: string;
  /** HTTP status; 0 when the request never got an answer. */
  status: number;
  issues?: WireIssue[];
}

export interface TransportOptions {
  /** Where the handlers are mounted, e.g. "/api/app/{companyId}/invoices" or "/api/t/{web-address}/invoices". */
  baseUrl: string;
  /** For tests and unusual runtimes; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
}

/** `base` + `path` with exactly one slash between them. */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

export const WIRE_ERROR_CODES: ReadonlySet<InvoicingErrorCodeWire> = new Set<InvoicingErrorCodeWire>([
  "invalid",
  "not_found",
  "forbidden",
  "cross_site",
  "rate_limited",
  "unavailable",
  "transition_not_allowed",
  "internal",
  "estimate_already_invoiced",
  "estimate_not_convertible",
  "discount_exceeds_subtotal",
  "invoice_not_editable",
  "invoice_has_no_lines",
  "invalid_status_transition",
  "payment_refused",
  "reversal_refused",
  "invoice_number_conflict",
]);

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string, else `fallback`. */
export function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** A string, or null for anything else (an empty string included). */
export function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** A finite number, else `fallback`. */
export function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
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

function parseIssue(raw: unknown): WireIssue | null {
  if (!isObject(raw)) return null;
  const path = Array.isArray(raw.path)
    ? raw.path.filter((part): part is string | number => typeof part === "string" || typeof part === "number")
    : [];
  return { path, message: str(raw.message, "Check this field.") };
}

/** What a staff screen says when the session behind it has ended. */
export const SIGNED_OUT_MESSAGE = "You've been signed out. Sign in again to keep working.";

/**
 * A non-2xx answer as an error value. A 401 is ALWAYS "signed out", whatever
 * the body: a host's sign-in check answers with its own text or JSON.
 */
export function toClientError(status: number, body: unknown): ClientError {
  if (status === 401) return { code: "forbidden", message: SIGNED_OUT_MESSAGE, status: 401 };
  const error = isObject(body) && isObject(body.error) ? body.error : null;
  if (error && typeof error.code === "string" && WIRE_ERROR_CODES.has(error.code as InvoicingErrorCodeWire)) {
    const issues = listOf(error.issues, parseIssue);
    return {
      code: error.code as InvoicingErrorCodeWire,
      message: str(error.message) || error.code,
      status,
      ...(issues.length > 0 ? { issues } : {}),
    };
  }
  return { code: "bad_response", message: `Unexpected answer from the server (${status}).`, status };
}

export function networkError(message = "Couldn't reach the server."): ClientError {
  return { code: "network", message, status: 0 };
}

export interface Requester {
  get<T>(path: string, parse: (body: unknown) => T | null): Promise<Result<T>>;
  post<T>(path: string, body: unknown, parse: (body: unknown) => T | null): Promise<Result<T>>;
}

/**
 * The fetch wrapper. The global fetch is looked up at CALL time and called as
 * a plain function: a reference taken at module load misses a polyfill
 * installed later.
 */
export function createRequester(options: TransportOptions): Requester {
  const extra = options.headers ?? {};
  const doFetch = (input: string, init: RequestInit): Promise<Response> => {
    if (options.fetch) return options.fetch(input, init);
    if (typeof globalThis.fetch !== "function") return Promise.reject(new Error("fetch is not available"));
    return globalThis.fetch(input, init);
  };

  const send = async <T>(method: "GET" | "POST", path: string, body: unknown, parse: (body: unknown) => T | null): Promise<Result<T>> => {
    let res: Response;
    try {
      const headers: Record<string, string> = { ...extra };
      if (method === "POST") headers["content-type"] = "application/json";
      res = await doFetch(joinUrl(options.baseUrl, path), {
        method,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
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
      // A sign-in wall that REDIRECTS answers 200 with the login page's HTML.
      if (parsed === null && res.redirected && /text\/html/i.test(res.headers?.get?.("content-type") ?? "")) {
        return { ok: false, error: { code: "forbidden", message: SIGNED_OUT_MESSAGE, status: 401 } };
      }
      const data = parse(parsed);
      if (data === null) {
        return { ok: false, error: { code: "bad_response", message: "The server's answer wasn't in the expected shape.", status: res.status } };
      }
      return { ok: true, data };
    } catch {
      return { ok: false, error: { code: "bad_response", message: "The server's answer couldn't be read.", status: 0 } };
    }
  };

  return {
    get: (path, parse) => send("GET", path, undefined, parse),
    post: (path, body, parse) => send("POST", path, body, parse),
  };
}
