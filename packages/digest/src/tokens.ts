import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The signed part of every unsubscribe link (digest 0.1): WHO and WHICH
 * EMAIL, under the site's secret. A link works without signing in — from a
 * phone's mail app, a work inbox, Gmail's own "Unsubscribe" button — because
 * the signature, not a session, says it is this person's:
 *
 *   {base64url(person + "\n" + kind)}.{base64url(HMAC-SHA256)}
 *
 * Changing either half (another person's id, another email kind) breaks the
 * signature, so a link can only ever stop the one email it came with, for
 * the one person it was sent to. Links don't expire: a person may find last
 * month's email and still expect its link to work. Rotating the secret
 * retires every link sent before (the preferences page still works).
 */

const PURPOSE = "adminigloo:digest:unsubscribe:v1";

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function mac(secret: string, userId: string, kind: string): Buffer {
  return createHmac("sha256", secret).update(`${PURPOSE}\n${userId}\n${kind}`).digest();
}

/** The token for one person and one email kind. */
export function signUnsubscribe(secret: string, userId: string, kind: string): string {
  if (!userId || userId.includes("\n") || !kind || kind.includes("\n")) throw new RangeError("a person and a kind, each on one line");
  return `${base64url(`${userId}\n${kind}`)}.${base64url(mac(secret, userId, kind))}`;
}

/** Who and which email a token names, or null for anything that isn't one of ours, untouched. */
export function readUnsubscribe(secret: string, token: unknown): { readonly userId: string; readonly kind: string } | null {
  if (typeof token !== "string" || token.length > 512) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(signature)) return null;
  const decoded = Buffer.from(payload, "base64url").toString("utf8");
  const parts = decoded.split("\n");
  if (parts.length !== 2) return null;
  const [userId, kind] = parts as [string, string];
  if (!userId || !kind) return null;
  // Re-encoded and compared, so a payload with spare padding or bits can't
  // be a second spelling of the same token.
  if (base64url(decoded) !== payload) return null;
  const expected = mac(secret, userId, kind);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return { userId, kind };
}
