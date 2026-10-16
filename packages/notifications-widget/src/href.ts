/**
 * Where an alert may take the person (Tenancy 2b-1, D18; review G15).
 *
 * An alert's `href` comes from the server, which only stores a same-site path
 * — but a widget that follows whatever it is handed is one bug away from
 * sending a staff member to another site from their own app's bell. So the
 * widget checks again, twice:
 *
 *   1. the href matches D18's pattern (a single leading `/`, no `//`, no `/\`,
 *      no backslash, whitespace or control character anywhere), so `/\evil.com`
 *      (which browsers read as `//evil.com`) is refused before it is parsed;
 *   2. it resolves, against the page's own origin, to that same origin.
 *
 * Anything else is not followed: the alert is only marked read.
 */

export const SAME_SITE_PATH = /^\/(?![\/\\])[^\\\s\u0000-\u001f]{0,499}$/;

/** The href to follow, as an absolute URL on this origin, or null to stay put. */
export function safeHref(href: string | null | undefined, origin?: string): string | null {
  if (typeof href !== "string" || !SAME_SITE_PATH.test(href)) return null;
  const base = origin ?? (typeof location !== "undefined" ? location.origin : null);
  if (!base || base === "null") return null;
  try {
    const url = new URL(href, base);
    return url.origin === new URL(base).origin ? url.href : null;
  } catch {
    return null;
  }
}

/** Go there (a full navigation: the host's router may not own the page the alert names). */
export function go(href: string | null | undefined): boolean {
  const target = safeHref(href);
  if (!target || typeof window === "undefined") return false;
  window.location.assign(target);
  return true;
}
