import { InvalidKeyError } from "./types.js";

/**
 * Store keys (D10, review G7).
 *
 * NO COMPANY ID IN ANY KEY. A host's company id is whatever its
 * `resolveTenant` returns: `/`, `..` and `%2e%2e` included. 0.1 wrote it
 * straight into the path (`t/{tenantId}/…`), so a company id could walk out
 * of its own folder on a disk store, or name another company's folder on a
 * bucket. 0.2 keys are made only from things this package makes:
 *
 *   private: t/{first 16 hex of sha256(tenantId)}/{YYYY}/{MM}/{32 hex random}.{ext}
 *   public:  p/{32 base64url random}.{ext}
 *
 * The private prefix keeps 0.1's "filing cabinet" grouping (one folder per
 * company when someone browses the bucket by hand) without the id itself.
 * The public key has 192 random bits, no company and no file name: the logo's
 * address is unguessable and says nothing about who it belongs to.
 *
 * ISOLATION NEVER RESTS ON THE KEY. Every lookup is by (tenant_id, id) in the
 * row; the key only says where the bytes are. These checks are belt and
 * braces: every adapter refuses, before any I/O, a key this package didn't
 * make, so even a bug that handed a store a host's string could not read
 * `../../etc/passwd` off a disk or another bucket path.
 */

export const STORAGE_KEY_PATTERN = /^(t\/[0-9a-f]{16}\/\d{4}\/\d{2}\/[0-9a-f]{32}|p\/[A-Za-z0-9_-]{32})\.[a-z]{3,4}$/;

/** The random part of a public key, as the public route takes it (`v1/p/{segment}`). */
export const PUBLIC_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{32}\.[a-z]{3,4}$/;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** 0.1's storeFile (and 2a's estimator photos through it): `{uuid}-{sanitized filename}`. */
const LEGACY_FILE_SEGMENT = new RegExp(`^${UUID}-.+$`, "i");
/** 2a's tenancy logos: `{uuid}.{ext}`. */
const LEGACY_LOGO_SEGMENT = new RegExp(`^${UUID}\\.[a-z0-9]{2,5}$`, "i");

/**
 * The shapes 0.1 and 2a wrote, accepted by `get` and `delete` ONLY (never by
 * `put`: nothing new is ever written under a company id):
 *
 *   t/{tenant id}/{uuid}-{filename}            (0.1's storeFile, 2a's estimator photos)
 *   tenancy/logos/{tenant id}/{uuid}.{ext}     (2a's logos)
 *
 * where no segment is empty, "." or "..", and no character is "\" or a
 * control character. So a legacy key can't climb out of its folder.
 *
 * A PLAIN "%" IS ALLOWED (review BUY-04): 0.1's `sanitizeFilename` kept it,
 * so a 2a file named "May%20invoice.pdf", or "100% done.pdf" (stored as
 * "100%_done.pdf"), has one in its key, and refusing every "%" left such a
 * file impossible to open and impossible to delete (each purge was refused
 * before any I/O). What stays refused is an ENCODED sequence a store or a
 * URL could turn back into something a key may never hold: a run of escapes
 * that decodes to ".", "/", "\", "%" (a second round of encoding) or a
 * control character, or that isn't UTF-8 at all (an overlong "%c0%ae" dot).
 * So a legacy key can't smuggle an encoded `..` either.
 */
export function isLegacyKey(key: string): boolean {
  if (typeof key !== "string" || key.length === 0 || key.length > 1024) return false;
  for (let i = 0; i < key.length; i += 1) {
    const code = key.charCodeAt(i);
    // Control characters, DEL and the backslash (92), by code: a regex class
    // would be mostly escapes, and a dropped one fails silently.
    if (code < 32 || code === 127 || code === 92) return false;
  }
  if (hasUnsafeEscape(key)) return false;
  const segments = key.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  const last = segments[segments.length - 1] ?? "";
  if (segments[0] === "t") return segments.length >= 3 && LEGACY_FILE_SEGMENT.test(last);
  if (segments[0] === "tenancy" && segments[1] === "logos") return segments.length >= 4 && LEGACY_LOGO_SEGMENT.test(last);
  return false;
}

/** Runs of %XX escapes ("%2e%2e", "%c0%ae"). A "%" not followed by two hex digits is a plain character. */
const ESCAPE_RUN = /(?:%[0-9a-fA-F]{2})+/g;

/** Does a run of escapes decode to ".", "/", "\", "%" or a control character, or fail to decode (not UTF-8)? */
function hasUnsafeEscape(key: string): boolean {
  for (const match of key.matchAll(ESCAPE_RUN)) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(match[0]);
    } catch {
      return true;
    }
    for (let i = 0; i < decoded.length; i += 1) {
      const code = decoded.charCodeAt(i);
      // Controls, DEL, "." (46), "/" (47), "\" (92) and "%" (37).
      if (code < 32 || code === 127 || code === 46 || code === 47 || code === 92 || code === 37) return true;
    }
  }
  return false;
}

/** May `op` be done with this key? Throws InvalidKeyError before any I/O otherwise. Every adapter calls it first. */
export function assertStorageKey(key: string, op: "put" | "get" | "delete"): void {
  if (typeof key === "string" && STORAGE_KEY_PATTERN.test(key)) return;
  if (op !== "put" && isLegacyKey(key)) return;
  throw new InvalidKeyError();
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** Hex SHA-256 (Web Crypto, so the root entry runs on any runtime with `crypto.subtle`). */
export async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data as BufferSource);
  return hex(new Uint8Array(digest));
}

/** The company's folder: the first 16 hex of sha256(tenantId). Never the id itself (review G7). */
export async function tenantFolder(tenantId: string): Promise<string> {
  return (await sha256Hex(`${tenantId}`)).slice(0, 16);
}

/** A new private key, filed by the UTC year and month (`now`): 16 random bytes, 128 bits. */
export async function newPrivateKey(tenantId: string, ext: string, now: Date): Promise<string> {
  const year = String(now.getUTCFullYear()).padStart(4, "0");
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `t/${await tenantFolder(tenantId)}/${year}/${month}/${hex(randomBytes(16))}.${ext}`;
}

/** A new public key: 24 random bytes, 192 bits, exactly 32 base64url characters. */
export function newPublicKey(ext: string): string {
  return `p/${base64url(randomBytes(24))}.${ext}`;
}

/** A probe key for `checkPrivate`: private-shaped, under a folder no company hashes to by accident. */
export function probeKey(now: Date): string {
  const year = String(now.getUTCFullYear()).padStart(4, "0");
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `t/0000000000000000/${year}/${month}/${hex(randomBytes(16))}.txt`;
}
