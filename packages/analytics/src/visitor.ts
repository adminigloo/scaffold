/**
 * The small, pure pieces of a visit: what kind of device, which path (with
 * anything secret removed), whether it counts as engaged, and the cookieless
 * visitor key. No IO beyond Web Crypto, so the ingest stays testable.
 */

// ---------------------------------------------------------------------------
// Device / browser / OS — coarse families only; the User-Agent itself is never stored.
// ---------------------------------------------------------------------------

export type DeviceKind = "mobile" | "tablet" | "desktop";

export interface ParsedUserAgent {
  device: DeviceKind;
  browser: string;
  os: string;
}

export function parseUserAgent(userAgent: string | null | undefined): ParsedUserAgent {
  const ua = userAgent ?? "";
  const tablet = /iPad|Tablet|Nexus (7|9|10)|SM-T\d|Kindle|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua));
  const mobile = !tablet && /Mobi|iPhone|iPod|Android.*Mobile|Windows Phone|Opera Mini/i.test(ua);
  const device: DeviceKind = tablet ? "tablet" : mobile ? "mobile" : "desktop";

  // Order matters: Edge and Opera carry "Chrome", Chrome carries "Safari".
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /SamsungBrowser/.test(ua)
        ? "Samsung Internet"
        : /Firefox|FxiOS/.test(ua)
          ? "Firefox"
          : /Chrome|CriOS|Chromium/.test(ua)
            ? "Chrome"
            : /Safari/.test(ua)
              ? "Safari"
              : "Other";

  const os = /Windows/.test(ua)
    ? "Windows"
    : /iPhone|iPad|iPod/.test(ua)
      ? "iOS"
      : /Mac OS X|Macintosh/.test(ua)
        ? "macOS"
        : /Android/.test(ua)
          ? "Android"
          : /CrOS/.test(ua)
            ? "ChromeOS"
            : /Linux/.test(ua)
              ? "Linux"
              : "Other";

  return { device, browser, os };
}

// ---------------------------------------------------------------------------
// Paths — what is stored and reported, with secrets taken out.
// ---------------------------------------------------------------------------

/** A route shape to collapse, e.g. `{ pattern: /^\/invoice\/[^/]+/, replace: "/invoice/:token" }`. */
export interface PathPattern {
  pattern: RegExp;
  replace: string;
}

const MAX_PATH = 300;

/**
 * Does a path segment look like a capability rather than a page name? Long and
 * random: 20+ characters of base64url/hex, or a uuid. Page slugs are words with
 * hyphens and fail this; invoice, invitation and checkout-session tokens pass it.
 */
export function looksLikeToken(segment: string): boolean {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return true;
  if (segment.length < 20) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return false;
  // A slug is short words joined by separators ("release-notes-2026-09-30");
  // a token has at least one long random run.
  const parts = segment.split(/[-_]/);
  if (parts.length >= 3 && parts.every((part) => part.length <= 12)) return false;
  return /\d/.test(segment) || (/[a-z]/.test(segment) && /[A-Z]/.test(segment));
}

/**
 * The path as stored: query and hash removed (that is where tokens and search
 * terms live), app patterns collapsed first, then any remaining token-shaped
 * segment replaced by `:token`, trailing slash trimmed, length capped.
 */
export function normalizePath(raw: string, patterns: readonly PathPattern[] = []): string {
  let path = raw.split(/[?#]/, 1)[0] ?? "/";
  if (!path.startsWith("/")) {
    try {
      path = new URL(path).pathname;
    } catch {
      path = `/${path}`;
    }
  }
  for (const { pattern, replace } of patterns) {
    if (pattern.test(path)) {
      path = path.replace(pattern, replace);
      break;
    }
  }
  path = path
    .split("/")
    .map((segment) => {
      if (!segment || segment.startsWith(":")) return segment;
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        /* keep the raw segment */
      }
      return looksLikeToken(decoded) ? ":token" : segment;
    })
    .join("/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return (path || "/").slice(0, MAX_PATH);
}

/** A content dimension read from the path, e.g. `{ type: "feature", pattern: /^\/features\/([^/]+)/ }`. */
export interface ContentType {
  type: string;
  pattern: RegExp;
}

export function contentOf(path: string, types: readonly ContentType[]): { type: string; key: string } | null {
  for (const { type, pattern } of types) {
    const match = pattern.exec(path);
    if (match) return { type, key: (match[1] ?? path).slice(0, 120) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Engagement — the GA4 definition, pinned. Benchmarks are only comparable if
// the constant is exactly theirs; Riddler once shipped the wrong one.
// ---------------------------------------------------------------------------

export const ENGAGED_DURATION_MS = 10_000;
export const ENGAGED_PAGE_VIEWS = 2;

export function isEngaged(session: { durationMs?: number | null; pageViewCount?: number | null; converted?: boolean | null }): boolean {
  if ((session.durationMs ?? 0) >= ENGAGED_DURATION_MS) return true;
  if ((session.pageViewCount ?? 0) >= ENGAGED_PAGE_VIEWS) return true;
  return session.converted === true;
}

/** A session ends after this long without a page view, event or leave. */
export const SESSION_INACTIVITY_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// The cookieless visitor key.
// ---------------------------------------------------------------------------

/**
 * HMAC-SHA256 of `message` under `key`, first 16 bytes as 32 hex characters.
 * The visitor key is this over (ip, user agent, tenant) under a random salt
 * that exists for one day (ingest.ts): a person is one visitor within that day
 * and, once the salt is deleted, unlinkable for good.
 */
export async function hmacHex(key: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  return Array.from(new Uint8Array(signature).slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
