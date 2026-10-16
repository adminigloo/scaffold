import type { FilesErrorCode, WireIssue } from "./types.js";

/**
 * The one place the widget talks HTTP. COPIED from @adminigloo/comms-widget
 * (src/http.ts, itself from scheduling-widget's) and grown by the two upload
 * calls the files screens need; change all or none.
 *
 * Every call RETURNS its failure instead of throwing: a fetch that throws
 * becomes `network` (status 0), a non-2xx with the contract's error body
 * becomes that code, and anything else (an HTML error page, an empty body, a
 * shape we don't recognise) becomes `bad_response`. Never a TypeError
 * mid-render.
 *
 * PLAIN WORDS (review BO-4). A platform's timeout or crash answers HTML,
 * not the package's JSON, and the screen shows `message` as it is: a crew
 * member at the job read "Unexpected answer from the server (500)." Every
 * sentence here is one a business owner or a crew member can act on; the
 * status stays in `status`, for the host's own logs.
 */

export type Result<T> = { ok: true; data: T } | { ok: false; error: ClientError };

export interface ClientError {
  code: FilesErrorCode | "network" | "bad_response";
  /** The server's message (or ours), shown as is. */
  message: string;
  /** HTTP status; 0 when the request never got an answer. */
  status: number;
  issues?: WireIssue[];
}

export interface TransportOptions {
  /** Where the handlers are mounted, e.g. "/api/app/{companyId}/files" or "/api/admin/files". */
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

export const WIRE_ERROR_CODES: ReadonlySet<FilesErrorCode> = new Set<FilesErrorCode>([
  "invalid",
  "not_found",
  "forbidden",
  "cross_site",
  "rate_limited",
  "internal",
  "storage_off",
  "file_type",
  "file_too_big",
  "storage_full",
  "not_removable",
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

/** A finite number, or null. */
export function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
  const path = Array.isArray(raw.path) ? raw.path.filter((part): part is string | number => typeof part === "string" || typeof part === "number") : [];
  return { path, message: str(raw.message, "Check this field.") };
}

/** What a staff screen says when the session behind it has ended. */
export const SIGNED_OUT_MESSAGE = "You've been signed out. Sign in again to keep working.";

/** The sentence for a photo that didn't reach the server (review BO-05). */
export const NO_SIGNAL_MESSAGE = "It didn't send. Check your signal.";

/** Any answer that isn't the package's own (a platform's error page, a timeout, a crash): review BO-4. */
export const SOMETHING_WRONG_MESSAGE = "Something went wrong. Try again in a minute.";

/** No answer at all (the default for `network`). */
export const NO_CONNECTION_MESSAGE = "Couldn't connect. Check your connection and try again.";

/**
 * A non-2xx answer as an error value. A 401 is ALWAYS "signed out", whatever
 * the body: a host's sign-in check answers with its own text or JSON. A 413
 * from a platform's own body limit (no JSON) is still "too big".
 */
export function toClientError(status: number, body: unknown): ClientError {
  if (status === 401) return { code: "forbidden", message: SIGNED_OUT_MESSAGE, status: 401 };
  const error = isObject(body) && isObject(body.error) ? body.error : null;
  if (error && typeof error.code === "string" && WIRE_ERROR_CODES.has(error.code as FilesErrorCode)) {
    const issues = listOf(error.issues, parseIssue);
    return {
      code: error.code as FilesErrorCode,
      message: str(error.message) || error.code,
      status,
      ...(issues.length > 0 ? { issues } : {}),
    };
  }
  if (status === 413) return { code: "file_too_big", message: "That file is too big to send.", status };
  return { code: "bad_response", message: SOMETHING_WRONG_MESSAGE, status };
}

export function networkError(message = NO_CONNECTION_MESSAGE): ClientError {
  return { code: "network", message, status: 0 };
}

function parseText<T>(status: number, ok: boolean, text: string, redirectedHtml: boolean, parse: (body: unknown) => T | null): Result<T> {
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!ok) return { ok: false, error: toClientError(status, parsed) };
  // A sign-in wall that REDIRECTS answers 200 with the login page's HTML.
  if (parsed === null && redirectedHtml) return { ok: false, error: { code: "forbidden", message: SIGNED_OUT_MESSAGE, status: 401 } };
  const data = parse(parsed);
  if (data === null) return { ok: false, error: { code: "bad_response", message: SOMETHING_WRONG_MESSAGE, status } };
  return { ok: true, data };
}

export interface Requester {
  get<T>(path: string, parse: (body: unknown) => T | null): Promise<Result<T>>;
  post<T>(path: string, body: unknown, parse: (body: unknown) => T | null): Promise<Result<T>>;
  /** A multipart upload. With `onProgress`, through XMLHttpRequest (the only way a browser reports upload progress); else fetch. */
  upload<T>(path: string, form: FormData, parse: (body: unknown) => T | null, onProgress?: (fraction: number) => void): Promise<Result<T>>;
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

  const send = async <T>(method: "GET" | "POST", path: string, body: BodyInit | undefined, json: boolean, parse: (body: unknown) => T | null): Promise<Result<T>> => {
    let res: Response;
    try {
      const headers: Record<string, string> = { ...extra };
      if (json) headers["content-type"] = "application/json";
      res = await doFetch(joinUrl(options.baseUrl, path), {
        method,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(body !== undefined ? { body } : {}),
        cache: "no-store",
      });
    } catch {
      return { ok: false, error: networkError() };
    }
    try {
      const text = await res.text();
      const html = res.redirected && /text\/html/i.test(res.headers?.get?.("content-type") ?? "");
      return parseText(res.status, res.ok, text, html, parse);
    } catch {
      return { ok: false, error: { code: "bad_response", message: SOMETHING_WRONG_MESSAGE, status: 0 } };
    }
  };

  const xhrUpload = <T>(path: string, form: FormData, parse: (body: unknown) => T | null, onProgress: (fraction: number) => void): Promise<Result<T>> =>
    new Promise((resolve) => {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", joinUrl(options.baseUrl, path));
        for (const [name, value] of Object.entries(extra)) xhr.setRequestHeader(name, value);
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable && event.total > 0) {
            try {
              onProgress(Math.min(1, event.loaded / event.total));
            } catch {
              /* a host callback must not break the upload */
            }
          }
        };
        xhr.onload = () => {
          // XHR follows a sign-in redirect silently too: an HTML page where
          // JSON was expected is the sign-in wall.
          const html = /text\/html/i.test(xhr.getResponseHeader("content-type") ?? "");
          resolve(parseText(xhr.status, xhr.status >= 200 && xhr.status < 300, String(xhr.responseText ?? ""), html, parse));
        };
        xhr.onerror = () => resolve({ ok: false, error: networkError() });
        xhr.ontimeout = () => resolve({ ok: false, error: networkError() });
        xhr.onabort = () => resolve({ ok: false, error: networkError() });
        xhr.send(form);
      } catch {
        resolve({ ok: false, error: networkError() });
      }
    });

  return {
    get: (path, parse) => send("GET", path, undefined, false, parse),
    post: (path, body, parse) => send("POST", path, JSON.stringify(body ?? {}), true, parse),
    upload: (path, form, parse, onProgress) =>
      onProgress && typeof XMLHttpRequest !== "undefined" ? xhrUpload(path, form, parse, onProgress) : send("POST", path, form, false, parse),
  };
}
