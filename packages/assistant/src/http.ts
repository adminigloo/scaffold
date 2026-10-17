import type { AssistantErrorCodeWire } from "./wire.js";

/**
 * The HTTP mechanics the company handlers use: the same-site check, a capped
 * JSON body, the error envelope. COPIED, never imported, from
 * @adminigloo/invoicing's http.ts (itself from scheduling), so the assistant
 * installs alone; change them together.
 */

function hostOf(value: string): string | null {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Was this request sent by a browser from anywhere but THIS origin?
 * (Sec-Fetch-Site, then Origin/Referer against the request's host, then "no
 * browser headers at all" for a server or a test.) same-site is refused too:
 * it is another origin on this domain, whose requests carry the session.
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

/** An error a handler answers as is: a status, a code, a plain sentence. */
export class AssistantHttpError extends Error {
  readonly name = "AssistantHttpError";
  constructor(
    readonly code: AssistantErrorCodeWire,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const INTERNAL_MESSAGE = "Something went wrong. Please try again.";
export const CROSS_SITE_MESSAGE = "This request came from another site, so it was refused.";
export const FORBIDDEN_MESSAGE = "You don't have permission to use the assistant here.";
export const SETTINGS_FORBIDDEN_MESSAGE = "You don't have permission to change the assistant's settings.";
export const NOT_HERE = "That isn't here.";

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function errorResponse(code: AssistantErrorCodeWire, status: number, message: string): Response {
  return json({ error: { code, message } }, status);
}

/** 32 KB: far more than a question or a settings save needs. */
const MAX_BODY_BYTES = 32 * 1024;

/**
 * A JSON object body, counted as it streams and refused past the cap (a
 * chunked body declares no length). Missing → {}.
 */
export async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  const tooLarge = () => new AssistantHttpError("invalid", 400, "That's too long to send at once.");
  const declared = req.headers.get("content-length");
  if (declared !== null && /^\s*\d+\s*$/.test(declared) && Number(declared) > MAX_BODY_BYTES) throw tooLarge();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (req.body) {
    const reader = req.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > MAX_BODY_BYTES) {
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
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AssistantHttpError("invalid", 400, "Expected a JSON body.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AssistantHttpError("invalid", 400, "Expected a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

/** The suffix after `marker` split into decoded segments; null when absent or with an empty segment. */
export function segmentsAfter(pathname: string, marker: string): string[] | null {
  const path = pathname.replace(/\/+$/, "");
  const at = path.lastIndexOf(marker);
  if (at < 0) return null;
  const parts = path.slice(at + marker.length).split("/").map(safeDecode);
  return parts.some((part) => part === "") ? null : parts;
}

/**
 * The shape of a row id. Anything else (a NUL byte, a 10 KB string) is "not
 * found" without a query: Postgres refuses NUL in text, and a refusal there
 * would be a 500.
 */
const ID_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;

export function isIdShaped(value: string | undefined): value is string {
  return typeof value === "string" && ID_SHAPE.test(value);
}
