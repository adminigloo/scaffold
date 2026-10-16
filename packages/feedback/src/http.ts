import { z } from "zod";

/**
 * What both handler factories share: the same-site check every staff POST
 * passes, body parsing, and the error vocabulary with its HTTP statuses.
 */

function hostOf(value: string): string | null {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * COPIED FROM @adminigloo/scheduling's http.ts (2a's copy rule: never imported
 * across packages). Change them all or none.
 *
 * Was this request sent by a browser from anywhere but THIS origin? The CSRF
 * check every staff POST passes before any work:
 *
 *  1. Sec-Fetch-Site, when present, is the browser's own verdict and cannot
 *     be set by a page: same-origin and none (typed, bookmarked) pass;
 *     cross-site does not, and NEITHER DOES same-site (another origin on the
 *     same registrable domain, whose requests carry the session cookie).
 *  2. Otherwise (an older browser) the Origin header — or, failing that, the
 *     Referer — must name the same host as the request URL. `Origin: null`
 *     is cross-site by definition. X-Forwarded-Host also counts as "this
 *     host", for apps behind a proxy that rewrites Host.
 *  3. With neither header, the request is allowed only if it carries no
 *     Sec-Fetch-* header at all — i.e. it is not from a browser (a server, a
 *     test, curl).
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

/** The staff handlers' error codes, with their statuses. */
export type FeedbackErrorCode = "invalid" | "not_found" | "forbidden" | "conflict" | "too_many_requests" | "internal";

export const FEEDBACK_ERROR_STATUS: Readonly<Record<FeedbackErrorCode, number>> = Object.freeze({
  invalid: 400,
  not_found: 404,
  forbidden: 403,
  conflict: 409,
  too_many_requests: 429,
  internal: 500,
});

export interface FeedbackWireIssue {
  readonly path: ReadonlyArray<string | number>;
  readonly message: string;
}

/** An error a handler answers as is: code, a plain sentence, and `issues` for a form. */
export class FeedbackHttpError extends Error {
  readonly name = "FeedbackHttpError";
  constructor(
    readonly code: FeedbackErrorCode,
    message: string,
    readonly issues?: FeedbackWireIssue[],
  ) {
    super(message);
  }
}

export const NOT_FOUND_MESSAGE = "That isn't here. It may have been removed.";
export const INTERNAL_MESSAGE = "Something went wrong. Please try again.";

/** Zod issues without the input values (a form echoes nothing back). */
export function wireIssues(error: z.ZodError): FeedbackWireIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.filter((part): part is string | number => typeof part !== "symbol"),
    message: issue.message,
  }));
}

/** The most a staff JSON body may be: a 5000-character reply with room to spare. */
const MAX_JSON_BYTES = 64 * 1024;

/** Read a JSON body and parse it; a bad one is a 400 with a plain sentence. */
export async function readJson<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  const text = await req.text().catch(() => "");
  if (text.length > MAX_JSON_BYTES) throw new FeedbackHttpError("invalid", "That's more than can be sent at once.");
  let raw: unknown;
  try {
    raw = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    throw new FeedbackHttpError("invalid", "That request couldn't be read. Please try again.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new FeedbackHttpError("invalid", parsed.error.issues[0]?.message ?? "Check the form and try again.", wireIssues(parsed.error));
  }
  return parsed.data;
}

export function safeDecode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return "";
  }
}

/** Anything with an @ between two non-spaces: never shown as a person's name (0.10.0). */
export function looksLikeAddress(value: string): boolean {
  return /\S@\S/.test(value);
}
