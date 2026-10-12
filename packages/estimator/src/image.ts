/**
 * The photo rules on the server (section 5.2 of the 0.3 contract). Pure: no
 * image library, no native code — the headers are read by hand.
 *
 * NEVER TRUST THE CLIENT. The widget shrinks every photo to ≤ 768 px on the
 * long edge before upload (≈ 600 image tokens, a tenth of a cent a reading).
 * A bypassed widget could send a 4,800-token photo on every request, so the
 * server reads the TYPE from the magic bytes and the SIZE from the header, and
 * refuses anything over `acceptEdgePx` or `maxBytes` before it reaches the
 * model or the store.
 */

export const PHOTO_LIMITS = {
  /** What the browser targets (echoed in the public config). */
  maxEdgePx: 768,
  /** The server refuses a longer edge: a bypassed widget can't buy a 4,800-token photo. */
  acceptEdgePx: 1024,
  /** Decoded bytes. */
  maxBytes: 600_000,
  jpegQuality: 0.8,
  mediaTypes: ["image/jpeg", "image/png", "image/webp"],
} as const;

export type PhotoMediaTypeName = (typeof PHOTO_LIMITS.mediaTypes)[number];

export type ImageRefusal =
  | "not_an_image"
  | "unsupported_type"
  | "type_mismatch"
  | "too_large"
  | "too_many_pixels"
  | "unreadable_size";

export type InspectedImage =
  | { ok: true; mediaType: PhotoMediaTypeName; width: number; height: number }
  | { ok: false; reason: ImageRefusal };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return "";
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/** The type the bytes ARE: JPEG `FF D8 FF`, PNG's eight-byte signature, `RIFF????WEBP`. */
function sniff(bytes: Uint8Array): PhotoMediaTypeName | "gif" | "heic" | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, PNG_SIGNATURE)) return "image/png";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  if (ascii(bytes, 0, 4) === "GIF8") return "gif";
  if (ascii(bytes, 4, 4) === "ftyp") return "heic";
  return null;
}

const be16 = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const be32 = (b: Uint8Array, i: number) => ((b[i] ?? 0) * 0x1000000 + (((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0))) >>> 0;
const le16 = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const le24 = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16);

/** PNG: the IHDR chunk's width and height (bytes 16–23, big-endian). */
function pngSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 24 || ascii(b, 12, 4) !== "IHDR") return null;
  return { width: be32(b, 16), height: be32(b, 20) };
}

/**
 * JPEG: walk the markers to the first start-of-frame — SOF0 to SOF15 other
 * than C4 (Huffman tables), C8 (reserved) and CC (arithmetic conditioning) —
 * whose payload is precision, then height and width, big-endian. Standalone
 * markers (RSTn, TEM) carry no length.
 */
function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    let marker = b[i + 1] as number;
    // Fill bytes: any number of FF before the marker byte.
    while (marker === 0xff && i + 2 < b.length) {
      i += 1;
      marker = b[i + 1] as number;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan before a frame
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const length = be16(b, i + 2);
    if (length < 2) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (i + 9 > b.length) return null;
      return { height: be16(b, i + 5), width: be16(b, i + 7) };
    }
    i += 2 + length;
  }
  return null;
}

/**
 * WebP: the first chunk after `WEBP`. `VP8 ` (lossy) has 14-bit width and
 * height at 26 and 28 behind the 9D 01 2A start code; `VP8L` (lossless) packs
 * width−1 and height−1 into 14 bits each after its 0x2F signature byte;
 * `VP8X` (extended) has a 24-bit canvas width−1 at 24 and height−1 at 27.
 */
function webpSize(b: Uint8Array): { width: number; height: number } | null {
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 ") {
    if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (b.length < 25 || b[20] !== 0x2f) return null;
    const b0 = b[21] as number;
    const b1 = b[22] as number;
    const b2 = b[23] as number;
    const b3 = b[24] as number;
    return {
      width: 1 + (b0 | ((b1 & 0x3f) << 8)),
      height: 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)),
    };
  }
  if (chunk === "VP8X") {
    if (b.length < 30) return null;
    return { width: 1 + le24(b, 24), height: 1 + le24(b, 27) };
  }
  return null;
}

/**
 * Check one uploaded photo: its real type (from the bytes; a declared type
 * that disagrees is `type_mismatch`; GIF, HEIC and anything else are
 * `unsupported_type`), its size in bytes, and its dimensions from the header.
 */
export function inspectImage(bytes: Uint8Array, declaredType: string): InspectedImage {
  const declared = declaredType.trim().toLowerCase();
  if (bytes.length === 0 || !declared.startsWith("image/")) return { ok: false, reason: "not_an_image" };
  if (bytes.length > PHOTO_LIMITS.maxBytes) return { ok: false, reason: "too_large" };
  const kind = sniff(bytes);
  if (kind === null || kind === "gif" || kind === "heic") return { ok: false, reason: "unsupported_type" };
  const declaredAs = declared === "image/jpg" ? "image/jpeg" : declared;
  if (declaredAs !== kind) return { ok: false, reason: "type_mismatch" };
  const size = kind === "image/jpeg" ? jpegSize(bytes) : kind === "image/png" ? pngSize(bytes) : webpSize(bytes);
  if (!size || !(size.width > 0) || !(size.height > 0)) return { ok: false, reason: "unreadable_size" };
  if (Math.max(size.width, size.height) > PHOTO_LIMITS.acceptEdgePx) return { ok: false, reason: "too_many_pixels" };
  return { ok: true, mediaType: kind, width: size.width, height: size.height };
}

/** The longest base64 a photo of `maxBytes` can be (4 characters per 3 bytes, padded). */
export const MAX_BASE64_CHARS = Math.ceil(PHOTO_LIMITS.maxBytes / 3) * 4 + 4;

/**
 * Strict base64 → bytes, or null. Only the standard alphabet with correct
 * padding, no `data:` prefix, no whitespace, and no longer than a photo of
 * `maxBytes` can be — checked BEFORE decoding, so a 50 MB string costs a
 * length comparison.
 */
export function decodeBase64Strict(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_BASE64_CHARS) return null;
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Bytes → base64 (for the model call). */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Hex SHA-256 of the bytes (Web Crypto): the photo's identity — the cache key and the stored copy's `sha256`. */
export async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The wire refusal for a photo that couldn't be used (5.2). */
export function photoRefusalMessage(reason: ImageRefusal | "bad_base64"): string {
  const base = "That photo couldn't be used. Please try another one; the page shrinks photos before sending.";
  return reason === "too_many_pixels" || reason === "too_large" ? `${base} This one is too large.` : base;
}
