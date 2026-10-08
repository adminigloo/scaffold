import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Everything the package derives from AUDIENCE_SECRET. All of it is
 * HMAC-SHA256 (or AES-GCM under an HMAC-derived key), so a leaked database
 * yields neither a user id from a link row nor a way to mint a device link.
 */

export const MIN_SECRET_LENGTH = 32;
/** A secret must use at least this many different characters ("x" × 40 is not a secret). */
export const MIN_SECRET_DISTINCT = 10;

export function assertSecret(secret: unknown, what = "secret"): asserts secret is string {
  if (typeof secret !== "string" || secret.trim().length < MIN_SECRET_LENGTH) {
    throw new Error(
      `@adminigloo/audience: \`${what}\` must be at least ${MIN_SECRET_LENGTH} characters (set AUDIENCE_SECRET, e.g. \`openssl rand -base64 48\`).`,
    );
  }
  if (new Set(secret.trim()).size < MIN_SECRET_DISTINCT) {
    throw new Error(
      `@adminigloo/audience: \`${what}\` looks like a placeholder (fewer than ${MIN_SECRET_DISTINCT} different characters). Generate one: \`openssl rand -base64 48\`.`,
    );
  }
}

/**
 * What a link row stores instead of the user id: HMAC(secret, tenant ‖ userId),
 * base64url. Deterministic, so the same person always maps to the same key
 * and a rule added later finds their devices. It is PSEUDONYMOUS, not
 * anonymous: whoever holds the secret and the user list can recompute it,
 * which is exactly what `apply()` does.
 */
export function userKeyFor(secret: string, tenantId: string, userId: string): string {
  return createHmac("sha256", secret).update(`user\u0000${tenantId}\u0000${userId}`).digest("base64url");
}

/**
 * The smoke-test header's value when the app sets none: derived from the
 * secret, so it is not a public string anyone can send. A smoke suite reads it
 * from `audience.testHeader` (or computes it with this function from the same
 * AUDIENCE_SECRET).
 */
export function testHeaderValueFor(secret: string, tenantId: string): string {
  return createHmac("sha256", secret).update(`test-header\u0000${tenantId}`).digest("base64url").slice(0, 32);
}

/**
 * A device link: `?internal=<token>` marks whichever browser opens it (the
 * client team's phones, a signed-out laptop). Token:
 *
 *   v2.<exp>.<max>.<linkId>.<who>.<sig>
 *
 *   - `exp`: expiry, seconds since the epoch, base 36.
 *   - `max`: how many browsers it may mark, base 36. Signed, so it cannot be raised.
 *   - `linkId`: random. Every rule a redemption creates carries it, so the
 *     browsers one link marked can be found, counted and removed.
 *   - `who`: who made the link, AES-256-GCM encrypted. A URL travels (browser
 *     history, Referer headers, page-view logs), so it must not carry an email.
 *   - `sig`: HMAC over all of it.
 */
export function signDeviceToken(
  secret: string,
  input: { tenantId: string; by: string; expiresAt: Date; maxDevices: number },
): { token: string; linkId: string } {
  const exp = Math.floor(input.expiresAt.getTime() / 1000).toString(36);
  const max = Math.max(1, Math.floor(input.maxDevices)).toString(36);
  const linkId = randomBytes(9).toString("base64url");
  const who = sealWho(secret, input.tenantId, linkId, input.by);
  const sig = deviceSignature(secret, input.tenantId, [exp, max, linkId, who]);
  return { token: `v2.${exp}.${max}.${linkId}.${who}.${sig}`, linkId };
}

export type DeviceTokenResult =
  | { ok: true; by: string; expiresAt: Date; maxDevices: number; linkId: string }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function verifyDeviceToken(secret: string, tenantId: string, token: string, now: Date): DeviceTokenResult {
  const parts = typeof token === "string" ? token.trim().split(".") : [];
  if (parts.length !== 6 || parts[0] !== "v2") return { ok: false, reason: "malformed" };
  const [, exp, max, linkId, who, sig] = parts as [string, string, string, string, string, string];
  if (!/^[0-9a-z]+$/.test(exp) || !/^[0-9a-z]+$/.test(max) || !linkId || !who || !sig) return { ok: false, reason: "malformed" };
  const expected = Buffer.from(deviceSignature(secret, tenantId, [exp, max, linkId, who]));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: "bad_signature" };
  }
  const by = openWho(secret, tenantId, linkId, who);
  if (by === null) return { ok: false, reason: "bad_signature" };
  const expiresAt = new Date(parseInt(exp, 36) * 1000);
  if (expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  return { ok: true, by, expiresAt, maxDevices: parseInt(max, 36), linkId };
}

function deviceSignature(secret: string, tenantId: string, fields: readonly string[]): string {
  return createHmac("sha256", secret).update(`device\u0000${tenantId}\u0000${fields.join("\u0000")}`).digest("base64url");
}

function whoKey(secret: string, tenantId: string): Buffer {
  return createHmac("sha256", secret).update(`device-who-key\u0000${tenantId}`).digest();
}

function sealWho(secret: string, tenantId: string, linkId: string, by: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", whoKey(secret, tenantId), iv);
  cipher.setAAD(Buffer.from(linkId, "utf8"));
  const body = Buffer.concat([cipher.update(by, "utf8"), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
}

function openWho(secret: string, tenantId: string, linkId: string, sealed: string): string | null {
  try {
    const raw = Buffer.from(sealed, "base64url");
    if (raw.length < 12 + 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", whoKey(secret, tenantId), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(linkId, "utf8"));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
