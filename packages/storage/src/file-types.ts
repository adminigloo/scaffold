/**
 * What a file IS, from its bytes (D11, section 6.3). The browser's type is a
 * hint, never the answer: a page can name anything `image/png`. The magic
 * numbers below are the whole list of what 0.2 keeps:
 *
 *   jpeg  FF D8 FF
 *   png   89 50 4E 47 0D 0A 1A 0A
 *   webp  "RIFF" then "WEBP" at 8
 *   gif   "GIF87a" / "GIF89a"
 *   heic  "ftyp" at 4, with a brand at 8 in heic heix hevc hevx mif1 msf1
 *   pdf   "%PDF-"
 *
 * Anything else, SVG and HTML included, is null: both can carry script, and a
 * file the package can't name is a file it can't promise to serve safely.
 *
 * The header reading (imageSize) is COPIED from @adminigloo/estimator's
 * image.ts, never imported (D14: no package imports another's internals).
 */

export type FileTypeKey = "jpeg" | "png" | "webp" | "gif" | "heic" | "pdf";

export interface FileTypeInfo {
  readonly contentType: string;
  readonly ext: string;
  readonly image: boolean;
  /** In words: "JPEG photo", "iPhone photo (HEIC)", "PDF". */
  readonly label: string;
  /** The short name a rule sentence uses: "JPEG", "HEIC", "PDF". */
  readonly short: string;
}

export const FILE_TYPES: Readonly<Record<FileTypeKey, FileTypeInfo>> = Object.freeze({
  jpeg: Object.freeze({ contentType: "image/jpeg", ext: "jpg", image: true, label: "JPEG photo", short: "JPEG" }),
  png: Object.freeze({ contentType: "image/png", ext: "png", image: true, label: "PNG image", short: "PNG" }),
  webp: Object.freeze({ contentType: "image/webp", ext: "webp", image: true, label: "WebP image", short: "WebP" }),
  gif: Object.freeze({ contentType: "image/gif", ext: "gif", image: true, label: "GIF image", short: "GIF" }),
  heic: Object.freeze({ contentType: "image/heic", ext: "heic", image: true, label: "iPhone photo (HEIC)", short: "HEIC" }),
  pdf: Object.freeze({ contentType: "application/pdf", ext: "pdf", image: false, label: "PDF", short: "PDF" }),
});

export const FILE_TYPE_KEYS: readonly FileTypeKey[] = Object.freeze(["jpeg", "png", "webp", "gif", "heic", "pdf"]);

/** The types a browser can draw in an <img> (HEIC is an image, but desktop Chrome can't show one). */
export const PREVIEWABLE_TYPES: ReadonlySet<FileTypeKey> = new Set<FileTypeKey>(["jpeg", "png", "webp", "gif"]);

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "mif1", "msf1"]);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return "";
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/** The type the BYTES are, or null. Never trusts a declared type. */
export function sniffFileType(bytes: Uint8Array): FileTypeKey | null {
  if (!(bytes instanceof Uint8Array) || bytes.length < 3) return null;
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, PNG_SIGNATURE)) return "png";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
  const gif = ascii(bytes, 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") return "gif";
  if (ascii(bytes, 4, 4) === "ftyp" && HEIC_BRANDS.has(ascii(bytes, 8, 4))) return "heic";
  if (ascii(bytes, 0, 5) === "%PDF-") return "pdf";
  return null;
}

/** The type a stored content type names, or null (a 0.1 row may hold anything). */
export function fileTypeOfContentType(contentType: string | null | undefined): FileTypeKey | null {
  const value = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (value === "image/jpg") return "jpeg";
  if (value === "image/heif") return "heic";
  for (const key of FILE_TYPE_KEYS) if (FILE_TYPES[key].contentType === value) return key;
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
    while (marker === 0xff && i + 2 < b.length) {
      i += 1;
      marker = b[i + 1] as number;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
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

/** WebP: `VP8 ` (lossy), `VP8L` (lossless) or `VP8X` (extended) — the estimator's reading. */
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
    return { width: 1 + (b0 | ((b1 & 0x3f) << 8)), height: 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)) };
  }
  if (chunk === "VP8X") {
    if (b.length < 30) return null;
    return { width: 1 + le24(b, 24), height: 1 + le24(b, 27) };
  }
  return null;
}

/** GIF: the logical screen's width and height, little-endian at 6 and 8. */
function gifSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 10) return null;
  return { width: le16(b, 6), height: le16(b, 8) };
}

/** An image's size from its header (jpeg, png, webp, gif); null for anything else or a header that can't be read. */
export function imageSize(bytes: Uint8Array, type: FileTypeKey): { readonly width: number; readonly height: number } | null {
  const size =
    type === "jpeg" ? jpegSize(bytes) : type === "png" ? pngSize(bytes) : type === "webp" ? webpSize(bytes) : type === "gif" ? gifSize(bytes) : null;
  if (!size || !(size.width > 0) || !(size.height > 0)) return null;
  return size;
}

/**
 * Bytes in words: "412 KB", "3.1 MB", "1 GB". Binary units (1 KB = 1024
 * bytes), the way phones and computers show a file's size, so "Using 120 MB"
 * matches what the owner's own computer says about the same files.
 */
export function formatBytes(bytes: number, locale?: string): string {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  const format = (n: number, digits: number) => {
    try {
      return new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(n);
    } catch {
      return String(Math.round(n * 10 ** digits) / 10 ** digits);
    }
  };
  if (value < 1024) return value === 1 ? "1 byte" : `${format(value, 0)} bytes`;
  const kb = value / 1024;
  if (kb < 1024) return `${format(kb < 10 ? Math.round(kb * 10) / 10 : Math.round(kb), kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${format(mb < 100 ? Math.round(mb * 10) / 10 : Math.round(mb), mb < 100 ? 1 : 0)} MB`;
  const gb = mb / 1024;
  return `${format(Math.round(gb * 10) / 10, 1)} GB`;
}

/** "a photo (JPEG, PNG or WebP) or a PDF": what a refusal says to use instead. */
export function typesInWords(types: readonly FileTypeKey[]): string {
  const images = types.filter((t) => FILE_TYPES[t].image).map((t) => FILE_TYPES[t].short);
  const parts: string[] = [];
  if (images.length > 0) parts.push(`a photo (${joinOr(images)})`);
  if (types.includes("pdf")) parts.push("a PDF");
  return joinOr(parts) || "a different file";
}

/** "Photos (JPEG, PNG, WebP, HEIC) or PDFs, up to 4 MB": the upload rule a screen shows. */
export function uploadRuleInWords(types: readonly FileTypeKey[], maxBytes: number, locale?: string): string {
  const images = types.filter((t) => FILE_TYPES[t].image).map((t) => FILE_TYPES[t].short);
  const parts: string[] = [];
  if (images.length > 0) parts.push(`Photos (${images.join(", ")})`);
  if (types.includes("pdf")) parts.push("PDFs");
  return `${parts.join(" or ") || "Files"}, up to ${formatBytes(maxBytes, locale)}`;
}

function joinOr(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}
