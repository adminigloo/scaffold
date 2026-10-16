/**
 * Phones shrink photos before upload (D11). A phone photo is 3–8 MB at 4000
 * px; the server takes 4 MB through one request, and a photo at the job must
 * always fit. So, before upload, a photo over `minBytes` (1.5 MB) or longer
 * than `maxSide` (2048 px) on its long side becomes a `maxSide` JPEG: about
 * 0.7 MB, sharp enough to read a meter or see a cracked step.
 *
 * A HEIC the browser can decode is ALWAYS converted to JPEG, whatever its
 * size (review BO-21): an iPhone sends HEIC, and desktop Chrome can't show
 * one, so the office would see a download where the crew took a photo. One
 * the browser can't decode goes as it is (the screens show it as a document,
 * "iPhone photo (HEIC)").
 *
 * NEVER THROWS. A photo it can't read goes as it is: losing the shrink is a
 * slower upload, losing the photo is a second trip to the job.
 *
 * `encode` is injectable so the decisions run in happy-dom (no canvas) in the
 * tests; the default uses `createImageBitmap(file, { imageOrientation:
 * "from-image" })` (so a sideways phone photo comes out upright) and a canvas.
 */

export interface PhotoEncoder {
  /** The photo's size in pixels, or null when this browser can't read it. */
  measure(file: Blob): Promise<{ readonly width: number; readonly height: number } | null>;
  /** The photo drawn at `width`×`height`, as a JPEG at `quality` (0–1), or null. */
  toJpeg(file: Blob, width: number, height: number, quality: number): Promise<Blob | null>;
}

export interface ShrinkOptions {
  /** Default 2048. */
  maxSide?: number;
  /** Default 0.85. */
  quality?: number;
  /** Default 1.5 MB (1,500,000 bytes). */
  minBytes?: number;
  encode?: PhotoEncoder;
}

export const SHRINK_DEFAULTS = Object.freeze({ maxSide: 2048, quality: 0.85, minBytes: 1_500_000 });

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "mif1", "msf1"]);

/** Is this an iPhone photo (HEIC), by its type or by the `ftyp` brand in its first bytes? */
export async function isHeic(file: Blob): Promise<boolean> {
  if (/^image\/hei[cf]/i.test(file.type)) return true;
  try {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const text = String.fromCharCode(...head);
    return text.slice(4, 8) === "ftyp" && HEIC_BRANDS.has(text.slice(8, 12));
  } catch {
    return false;
  }
}

function fileName(file: Blob): string {
  const name = (file as { name?: unknown }).name;
  return typeof name === "string" && name.trim() !== "" ? name : "photo";
}

/** "IMG_0042.HEIC" → "IMG_0042.jpg"; "photo" → "photo.jpg". */
export function jpegName(name: string): string {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 && /^[a-z0-9]{1,5}$/i.test(name.slice(dot + 1)) ? name.slice(0, dot) : name;
  return `${base}.jpg`;
}

/** The browser's own decoder and a canvas. Every failure is null, never a throw. */
export const canvasEncoder: PhotoEncoder = {
  async measure(file) {
    try {
      if (typeof createImageBitmap !== "function") return null;
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close?.();
      return size.width > 0 && size.height > 0 ? size : null;
    } catch {
      return null;
    }
  },
  async toJpeg(file, width, height, quality) {
    try {
      if (typeof createImageBitmap !== "function") return null;
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
      try {
        if (typeof OffscreenCanvas === "function") {
          const canvas = new OffscreenCanvas(width, height);
          const context = canvas.getContext("2d");
          if (!context) return null;
          context.drawImage(bitmap, 0, 0, width, height);
          return await canvas.convertToBlob({ type: "image/jpeg", quality });
        }
        if (typeof document === "undefined") return null;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) return null;
        context.drawImage(bitmap, 0, 0, width, height);
        return await new Promise<Blob | null>((resolve) => canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality));
      } finally {
        bitmap.close?.();
      }
    } catch {
      return null;
    }
  },
};

/** Before upload (D11): a photo over `minBytes` or longer than `maxSide` becomes a `maxSide` JPEG. Anything else, unchanged. Never throws (a photo it can't read goes as it is). */
export async function shrinkPhoto(file: File, options: ShrinkOptions = {}): Promise<{ blob: Blob; name: string; shrunk: boolean }> {
  const name = fileName(file);
  const unchanged = { blob: file as Blob, name, shrunk: false };
  try {
    const maxSide = options.maxSide ?? SHRINK_DEFAULTS.maxSide;
    const quality = options.quality ?? SHRINK_DEFAULTS.quality;
    const minBytes = options.minBytes ?? SHRINK_DEFAULTS.minBytes;
    const encoder = options.encode ?? canvasEncoder;
    const heic = await isHeic(file);
    // Only photos: a PDF goes as it is, and so does a GIF (it may move).
    if (!heic && !/^image\/(jpeg|jpg|png|webp)$/i.test(file.type)) return unchanged;
    const size = await encoder.measure(file).catch(() => null);
    if (!size) return unchanged;
    const longSide = Math.max(size.width, size.height);
    if (!heic && file.size <= minBytes && longSide <= maxSide) return unchanged;
    const scale = longSide > maxSide ? maxSide / longSide : 1;
    const width = Math.max(1, Math.round(size.width * scale));
    const height = Math.max(1, Math.round(size.height * scale));
    const jpeg = await encoder.toJpeg(file, width, height, quality).catch(() => null);
    if (!jpeg || jpeg.size === 0) return unchanged;
    // A re-encode that came out BIGGER, of a photo that was already small
    // enough on its long side, isn't worth sending (a HEIC still converts).
    if (!heic && scale === 1 && jpeg.size >= file.size) return unchanged;
    return { blob: jpeg, name: jpegName(name), shrunk: true };
  } catch {
    return unchanged;
  }
}
