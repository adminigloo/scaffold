import { TenancyError, TENANCY_ERROR_STATUS, defaultMessage, type Noun } from "./errors.js";
import type { RequestFacts } from "./types.js";
import type { TenancyErrorCode, WireErrorBody } from "../wire.js";

/**
 * What both handler factories share: the same-origin check, body reading,
 * route matching and the error envelope.
 */

function hostOf(value: string): string | null {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Was this POST sent by a browser from anywhere but THIS origin?
 *
 * STRICT ON PURPOSE (review T1-12). Scheduling's check once let
 * `Sec-Fetch-Site: same-site` through (since Tenancy 2b-1 review SEC-04 it,
 * and its copies, are as strict as this); here a sibling subdomain is NOT
 * trusted. Tenancy 2 is expected to serve company pages under per-company
 * subdomains, and a page on one company's subdomain is same-site with the app:
 * a logged-in owner visiting it would carry their cookies into a POST here —
 * an invitation as admin, a removal, a hand-over (whose typed confirmation is
 * only the company's public name). So:
 *
 *   1. Sec-Fetch-Site, when present (every current browser), must be
 *      `same-origin`. A page can't set it.
 *   2. Otherwise the Origin (or Referer) must name exactly this host (or the
 *      proxy's X-Forwarded-Host). `Origin: null` is cross-site by definition.
 *   3. With neither, it's allowed only if it carries no Sec-Fetch-* header at
 *      all — not a browser (a server, a test, curl). A non-browser caller can
 *      forge anything; CSRF is about a visitor's browser being driven by
 *      another site, and that browser can't.
 *
 * Together with requiring `content-type: application/json` on every JSON
 * route, bodyless ones included (review R2 SEC-T1-H) — a plain HTML form
 * can't send that type without a CORS preflight, which this handler fails —
 * a forged cross-site form post can't reach those routes. The logo upload is
 * multipart by nature, so it rests on this check alone, like any upload.
 */
/**
 * Wait for the company events a POST just emitted before answering it
 * (Tenancy 2b-1, 8.1): bounded by the service (5 s), and never throwing. A
 * service object without `settleEvents` (a host's own 0.5-shaped double) is
 * answered at once, as before.
 *
 * WHY. On a serverless platform a promise still running after the response
 * is often frozen. The listener that got cut off was the one that mattered:
 * "Cam joined the team" in the owner's bell, or a removed member's alerts
 * being forgotten. A listener's write is visible as soon as the answer is.
 */
export async function settleBeforeAnswering(tenancy: { readonly settleEvents?: (timeoutMs?: number) => Promise<void> }): Promise<void> {
  if (typeof tenancy.settleEvents !== "function") return;
  try {
    await tenancy.settleEvents();
  } catch {
    /* settleEvents never throws; a host's double might, and must not change the answer */
  }
}

export function isCrossOriginRequest(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null) return site.trim().toLowerCase() !== "same-origin";
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

export const JSON_BODY_MAX_BYTES = 16 * 1024;
export const LOGO_BODY_MAX_BYTES = Math.round(1.2 * 1024 * 1024);

/**
 * COPIED FROM @adminigloo/storage's body.ts (`readBodyCapped`, review G10);
 * change all or none.
 *
 * The body's bytes, or `tooLarge()` thrown the moment more than `cap` have
 * arrived (Tenancy 2b-1 review SEC-01). WHY COUNT THE BYTES AS THEY STREAM:
 * `Content-Length` is a promise the client makes, and a chunked request
 * makes none. A platform with a body cap (Vercel's 4.5 MB) stops a big body
 * before the code runs; a self-hosted Node server (`next start`, a host's
 * own) has no cap at all, so `await req.formData()` on a 2 GB chunked
 * upload holds 2 GB in memory before anything can say no. So a declared
 * length over the cap is refused before a byte is read, the rest is counted
 * as it streams, and the stream is cancelled at the cap.
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
 * The logo upload's form, read through `readBodyCapped` at
 * `LOGO_BODY_MAX_BYTES` FIRST (review SEC-01) and only then parsed. Too
 * big → `logo_invalid` (the sentence the widget shows); not a form →
 * invalid "Send the logo as a file upload."
 */
export async function readLogoForm(req: Request): Promise<FormData> {
  const bytes = await readBodyCapped(req, LOGO_BODY_MAX_BYTES, () => new TenancyError("logo_invalid", "Use a PNG, JPG or WebP image under 1 MB."));
  try {
    return await new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData();
  } catch {
    throw new TenancyError("invalid", "Send the logo as a file upload.");
  }
}

/**
 * A JSON object body. Too big, not JSON, or not an object → invalid. An EMPTY
 * body reads as {}, but only while it is still labelled `application/json`
 * (review R2 SEC-T1-H): the type is checked FIRST, so the bodyless routes
 * (remove, leave, revoke, reactivate…) get the same second defence as every
 * other JSON POST. The widget always sends `{}` as JSON.
 */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") ?? "";
  const length = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > JSON_BODY_MAX_BYTES) {
    throw new TenancyError("invalid", "That request is too large.");
  }
  if (!/^application\/json\b/i.test(type.trim())) {
    throw new TenancyError("invalid", "Send the request as JSON.");
  }
  // Counted as it streams (review SEC-01): a chunked body declares no length.
  const text = new TextDecoder().decode(await readBodyCapped(req, JSON_BODY_MAX_BYTES, () => new TenancyError("invalid", "That request is too large.")));
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TenancyError("invalid", "Send the request as JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TenancyError("invalid", "Send the request as JSON.");
  return parsed as Record<string, unknown>;
}

/** Path params: 1–128 characters of [A-Za-z0-9_-]. Anything else is not found. */
const PARAM = /^[A-Za-z0-9_.-]{1,128}$/;

export interface MatchedRoute<K extends string> {
  readonly kind: K;
  readonly params: Readonly<Record<string, string>>;
}

export interface RouteSpec<K extends string> {
  readonly kind: K;
  readonly method: "GET" | "POST";
  readonly path: string;
}

/**
 * Route by the path suffix after the `/v1/` segment, so the handler works
 * wherever it's mounted (`/api/tenancy/[...path]`, `/api/admin/tenancy/…`).
 * Literal segments win over parameters at the same position.
 */
export function matchRoute<K extends string>(
  routes: readonly RouteSpec<K>[],
  req: Request,
): { found: MatchedRoute<K> } | { status: 404 } | { status: 405; allow: string[] } | { status: 400 } {
  const pathname = new URL(req.url).pathname;
  const at = pathname.indexOf("/v1/");
  if (at < 0) return { status: 404 };
  const parts = pathname.slice(at + 1).split("/").filter((p) => p !== "");
  let decoded: string[];
  try {
    decoded = parts.map((p) => decodeURIComponent(p));
  } catch {
    return { status: 404 };
  }
  const candidates: { route: RouteSpec<K>; params: Record<string, string>; literals: number }[] = [];
  for (const route of routes) {
    const segs = route.path.split("?")[0]!.split("/");
    if (segs.length !== decoded.length) continue;
    const params: Record<string, string> = {};
    let literals = 0;
    let ok = true;
    for (let i = 0; i < segs.length; i += 1) {
      const seg = segs[i]!;
      const value = decoded[i]!;
      if (seg.startsWith(":")) {
        params[seg.slice(1)] = value;
      } else if (seg === value) {
        literals += 1;
      } else {
        ok = false;
        break;
      }
    }
    if (ok) candidates.push({ route, params, literals });
  }
  if (candidates.length === 0) return { status: 404 };
  const best = Math.max(...candidates.map((c) => c.literals));
  const top = candidates.filter((c) => c.literals === best);
  const method = req.method.toUpperCase();
  const hit = top.find((c) => c.route.method === method);
  if (!hit) return { status: 405, allow: [...new Set(top.map((c) => c.route.method))] };
  for (const value of Object.values(hit.params)) if (!PARAM.test(value)) return { status: 404 };
  return { found: { kind: hit.route.kind, params: hit.params } };
}

const BASE_HEADERS = { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" } as const;

export function jsonResponse(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...extra } });
}

export function errorResponse(
  code: TenancyErrorCode,
  message: string,
  details: TenancyError["details"] = undefined,
  extra: Record<string, string> = {},
): Response {
  const body: WireErrorBody = {
    error: {
      code,
      message,
      ...(details?.issues ? { issues: details.issues.map((i) => ({ path: [...i.path], message: i.message })) } : {}),
      ...(details?.suggestion ? { suggestion: details.suggestion } : {}),
      ...(details?.upgradeHref ? { upgradeHref: details.upgradeHref } : {}),
    },
  };
  return jsonResponse(TENANCY_ERROR_STATUS[code], body, extra);
}

export function codeResponse(code: TenancyErrorCode, noun: Noun, extra: Record<string, string> = {}): Response {
  return errorResponse(code, defaultMessage(code, noun), undefined, extra);
}

/** The default request facts for the audit: the first X-Forwarded-For hop (or X-Real-IP), and the user agent. */
export function defaultRequestFacts(req: Request): RequestFacts {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || req.headers.get("x-real-ip")?.trim() || null;
  return { ipAddress: ip, userAgent: req.headers.get("user-agent")?.slice(0, 500) ?? null };
}

/** Zod issues → plain `{ path, message }`, never echoing the values sent. */
export function issuesOf(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }) {
  return error.issues.map((issue) => ({
    path: issue.path.filter((p): p is string | number => typeof p === "string" || typeof p === "number"),
    message: issue.message,
  }));
}
