/**
 * The photo, shrunk in the browser before it goes anywhere (contract 5.2 /
 * 9.4). A phone photo is 12 MP and 4 MB; read at full size it costs about
 * 4,800 image tokens. Shrunk to 768 px on the long edge it costs about 600,
 * uploads in a second on a poor connection, and is still plenty for staff to
 * see the steps and for the model to count them. The resized JPEG is what the
 * customer sees back, what is uploaded and what is read — one picture.
 *
 * The server checks everything again (`inspectImage`): this is the cheap path
 * for an honest browser, not the gate.
 */

/** The message for a file that isn't a photo the browser can decode. */
export const NOT_A_PHOTO = "That file isn't a photo we can read. Try a JPEG or PNG.";

/**
 * The size that fits inside `maxEdge` on the long edge, keeping the shape.
 * Never upscales (a 600 px photo stays 600 px); whole pixels, at least 1.
 */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const w = Math.max(1, Math.round(Number.isFinite(width) ? width : 1));
  const h = Math.max(1, Math.round(Number.isFinite(height) ? height : 1));
  const edge = Math.max(1, Math.floor(Number.isFinite(maxEdge) ? maxEdge : 1));
  const long = Math.max(w, h);
  if (long <= edge) return { width: w, height: h };
  const scale = edge / long;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

export interface ResizedPhoto {
  blob: Blob;
  /** The JPEG's bytes as base64, with no `data:` prefix (the wire's `imageBase64`). */
  base64: string;
  width: number;
  height: number;
  mediaType: "image/jpeg";
}

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

async function decodeWithBitmap(file: Blob): Promise<Decoded | null> {
  if (typeof createImageBitmap !== "function") return null;
  try {
    // "from-image": a phone photo held sideways is drawn the way it was taken.
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
    return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close?.() };
  } catch {
    return null;
  }
}

/** The file as a `data:` URL (FileReader), or null. */
function readAsDataUrl(file: Blob): Promise<string | null> {
  if (typeof FileReader !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/**
 * The fallback decode, for a browser without `createImageBitmap`: an <img>
 * from a `data:` URL, not a `blob:` one, so it works under the strict
 * Content-Security-Policy the README gives (`img-src 'self' data:`; review RL-05).
 */
async function decodeWithImage(file: Blob): Promise<Decoded | null> {
  if (typeof Image !== "function") return null;
  const url = await readAsDataUrl(file);
  if (!url) return null;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;
      resolve(width && height ? { source: img, width, height, release: () => {} } : null);
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

async function drawToJpeg(decoded: Decoded, size: { width: number; height: number }, quality: number): Promise<Blob | null> {
  if (typeof OffscreenCanvas === "function") {
    try {
      const canvas = new OffscreenCanvas(size.width, size.height);
      const ctx = canvas.getContext("2d");
      if (ctx) {
        // White first, as on the DOM canvas below: a transparent PNG exported as
        // a JPEG is otherwise black, and the AI can't count black steps (review EST-R14).
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, size.width, size.height);
        ctx.drawImage(decoded.source, 0, 0, size.width, size.height);
        return await canvas.convertToBlob({ type: "image/jpeg", quality });
      }
    } catch {
      /* fall through to a DOM canvas */
    }
  }
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // A transparent PNG becomes a JPEG with a white background, not a black one.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.drawImage(decoded.source, 0, 0, size.width, size.height);
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality);
    } catch {
      resolve(null);
    }
  });
}

/** A Blob's bytes as base64 (no prefix), in chunks so a large photo can't overflow the call stack. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Decode `file`, draw it no larger than `maxEdgePx` on the long edge (never
 * upscaled), and export a JPEG at `quality`. `createImageBitmap` with EXIF
 * orientation first, an <img> with an object URL second; OffscreenCanvas
 * where there is one, a DOM canvas otherwise. Rejects with a plain Error
 * (`NOT_A_PHOTO`) when the file isn't an image or won't decode — a PDF, a
 * HEIC on a browser that can't open it, a broken file.
 */
export async function resizePhoto(file: Blob, options: { maxEdgePx: number; quality: number }): Promise<ResizedPhoto> {
  if (file.type && !file.type.startsWith("image/")) throw new Error(NOT_A_PHOTO);
  const decoded = (await decodeWithBitmap(file)) ?? (await decodeWithImage(file));
  if (!decoded) throw new Error(NOT_A_PHOTO);
  try {
    const size = fitWithin(decoded.width, decoded.height, options.maxEdgePx);
    const quality = Math.min(1, Math.max(0.3, options.quality));
    const blob = await drawToJpeg(decoded, size, quality);
    if (!blob || blob.size === 0) throw new Error(NOT_A_PHOTO);
    return { blob, base64: await blobToBase64(blob), width: size.width, height: size.height, mediaType: "image/jpeg" };
  } finally {
    decoded.release();
  }
}
