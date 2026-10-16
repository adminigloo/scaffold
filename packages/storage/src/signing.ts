import { z } from "zod";
import { base64url, fromBase64url } from "./keys.js";

/**
 * Signed links (D10, review G2): "a short-lived link to one private file".
 *
 *   v1.{base64url(JSON { t, f, u, i, e })}.{base64url(HMAC-SHA256(secret, "v1." + payload))}
 *
 * `t` the company, `f` the file, `u` the person who made the link, `i` when
 * it was made and `e` when it expires (seconds; `e − i <= 3600`).
 *
 * WHY THE MAKER IS IN THE TOKEN. A link is a capability anyone holding it can
 * use. Without the maker, a member removed from the company keeps every link
 * they ever copied for its lifetime; with it, every open asks the host
 * (`stillValid`) whether the company is active AND the maker is still an
 * active member, so a removed member's links, and every link of a suspended
 * company, stop on the next open.
 *
 * WHY AT MOST AN HOUR. "Short-lived" is the promise; a link pasted into a
 * text message is the realistic leak, and an hour covers "open this on your
 * phone" without becoming a standing door. The package checks `e − i` itself,
 * so a token signed with a longer life (a bug, a hand-made one) is refused
 * whatever the host passed.
 *
 * Web Crypto (crypto.subtle), so the root entry runs anywhere a Request does.
 */

export const LINK_MAX_TTL_SECONDS = 3600;
export const LINK_MIN_TTL_SECONDS = 60;
/** A token issued further than this in the future is refused: a clock the host moved, or a forgery. */
const FUTURE_SKEW_SECONDS = 300;
const TOKEN_PATTERN = /^v1\.([A-Za-z0-9_-]{1,2000})\.([A-Za-z0-9_-]{43})$/;

const payloadSchema = z.object({
  t: z.string().min(1).max(200),
  f: z.string().min(1).max(200),
  u: z.string().min(1).max(200),
  i: z.number().int().nonnegative(),
  e: z.number().int().positive(),
});

export interface LinkPayload {
  readonly tenantId: string;
  readonly fileId: string;
  readonly userId: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export interface LinkSigner {
  sign(input: { readonly tenantId: string; readonly fileId: string; readonly userId: string; readonly now: Date; readonly ttlSeconds: number }): Promise<string>;
  /** The payload of a token whose shape, MAC and times are good, or null (the same null for every cause). */
  verify(token: string, now: Date): Promise<LinkPayload | null>;
}

function equalStrings(a: string, b: string): boolean {
  // Constant time over the longer length: the comparison mustn't tell an
  // attacker how many characters of a forged MAC were right.
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i += 1) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export function createLinkSigner(secret: string): LinkSigner {
  const encoder = new TextEncoder();
  let key: Promise<CryptoKey> | null = null;
  const hmacKey = () =>
    (key ??= globalThis.crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]));
  const mac = async (payload: string) =>
    base64url(new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", await hmacKey(), encoder.encode(`v1.${payload}`))));

  return {
    async sign({ tenantId, fileId, userId, now, ttlSeconds }) {
      const i = Math.floor(now.getTime() / 1000);
      const payload = base64url(encoder.encode(JSON.stringify({ t: tenantId, f: fileId, u: userId, i, e: i + ttlSeconds })));
      return `v1.${payload}.${await mac(payload)}`;
    },
    async verify(token, now) {
      if (typeof token !== "string" || token.length > 2100) return null;
      const match = TOKEN_PATTERN.exec(token);
      if (!match) return null;
      const payload = match[1] as string;
      const given = match[2] as string;
      if (!equalStrings(await mac(payload), given)) return null;
      const raw = fromBase64url(payload);
      if (!raw) return null;
      let parsed: z.infer<typeof payloadSchema>;
      try {
        const result = payloadSchema.safeParse(JSON.parse(new TextDecoder().decode(raw)));
        if (!result.success) return null;
        parsed = result.data;
      } catch {
        return null;
      }
      const nowSeconds = Math.floor(now.getTime() / 1000);
      if (!(parsed.e > nowSeconds)) return null;
      if (parsed.e - parsed.i > LINK_MAX_TTL_SECONDS || parsed.e <= parsed.i) return null;
      if (parsed.i > nowSeconds + FUTURE_SKEW_SECONDS) return null;
      return {
        tenantId: parsed.t,
        fileId: parsed.f,
        userId: parsed.u,
        issuedAt: new Date(parsed.i * 1000),
        expiresAt: new Date(parsed.e * 1000),
      };
    },
  };
}
