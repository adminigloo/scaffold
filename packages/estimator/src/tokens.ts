/**
 * Quote tokens. COPIED FROM @adminigloo/scheduling's tokens.ts (itself from
 * @adminigloo/booking: `generateToken`, `hashToken`, `looksLikeToken`); change
 * both or neither.
 *
 * Each token is 32 random bytes from `crypto.getRandomValues`, base64url (43
 * characters, URL-safe, no padding), and only its SHA-256 hex is ever stored
 * (`estimator_quote_tokens.token_hash`).
 *
 * Why capabilities rather than accounts: the customer who asked for a ramp
 * estimate has no identity here and must not need one. The link in their email
 * IS the permission to see, accept or decline that one quote, and nothing
 * else. Why hashed: a database dump, a read replica or an over-broad admin
 * query can't open anybody's quote.
 *
 * Web Crypto only (no node:crypto), so the same code runs in Node, edge
 * runtimes and tests.
 */

const TOKEN_BYTES = 32;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fresh token. The plaintext leaves in one message (or one response) and is never stored. */
export function generateToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

/** SHA-256 hex: what the row keeps. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The shape check that runs before any hashing or query. A token is opaque to
 * callers, but anything outside base64url or absurdly long is not one of
 * ours, and answering it costs nothing.
 */
export function looksLikeToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);
}
