// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { jpegName, shrinkPhoto, type PhotoEncoder } from "../shrink.js";

/**
 * `shrinkPhoto`'s decisions (D11, review BO-21), with an injected encoder so
 * they run without a canvas: big → a 2048 px JPEG; small → untouched; a
 * small HEIC the browser can decode → JPEG; a PDF → untouched; a photo the
 * browser can't read → sent as it is.
 */

function encoder(size: { width: number; height: number } | null, out = 300_000) {
  const drawn: { width: number; height: number; quality: number }[] = [];
  const e: PhotoEncoder = {
    measure: async () => size,
    toJpeg: async (_file, width, height, quality) => {
      drawn.push({ width, height, quality });
      return new Blob([new Uint8Array(out)], { type: "image/jpeg" });
    },
  };
  return { e, drawn };
}

const photo = (name: string, bytes: number, type = "image/jpeg") => new File([new Uint8Array(bytes)], name, { type });

function heicBytes(size = 200): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0, 0, 0, 24]);
  b.set(new TextEncoder().encode("ftypheic"), 4);
  return b;
}

describe("shrinkPhoto", () => {
  it("a big phone photo becomes a 2048 px JPEG", async () => {
    const { e, drawn } = encoder({ width: 4032, height: 3024 });
    const result = await shrinkPhoto(photo("IMG_0042.JPG", 5_000_000), { encode: e });
    expect(result.shrunk).toBe(true);
    expect(result.name).toBe("IMG_0042.jpg");
    expect(result.blob.type).toBe("image/jpeg");
    expect(drawn).toEqual([{ width: 2048, height: 1536, quality: 0.85 }]);
  });

  it("over 1.5 MB but small on its long side: re-encoded at its own size", async () => {
    const { e, drawn } = encoder({ width: 1600, height: 1200 });
    const result = await shrinkPhoto(photo("scan.png", 1_600_000, "image/png"), { encode: e });
    expect(result.shrunk).toBe(true);
    expect(drawn[0]).toMatchObject({ width: 1600, height: 1200 });
  });

  it("a small photo goes untouched", async () => {
    const { e, drawn } = encoder({ width: 1200, height: 900 });
    const file = photo("small.jpg", 400_000);
    const result = await shrinkPhoto(file, { encode: e });
    expect(result).toEqual({ blob: file, name: "small.jpg", shrunk: false });
    expect(drawn).toEqual([]);
  });

  it("a small HEIC the browser can decode is ALWAYS converted to JPEG (by type, or by its ftyp brand)", async () => {
    const { e } = encoder({ width: 1000, height: 750 }, 150_000);
    const byType = await shrinkPhoto(new File([heicBytes() as BlobPart], "IMG_7.HEIC", { type: "image/heic" }), { encode: e });
    expect([byType.shrunk, byType.name, byType.blob.type]).toEqual([true, "IMG_7.jpg", "image/jpeg"]);
    const byBrand = await shrinkPhoto(new File([heicBytes() as BlobPart], "IMG_8.HEIC", { type: "" }), { encode: e });
    expect([byBrand.shrunk, byBrand.name]).toEqual([true, "IMG_8.jpg"]);
  });

  it("a HEIC the browser can't decode goes as it is", async () => {
    const { e } = encoder(null);
    const file = new File([heicBytes() as BlobPart], "IMG_9.HEIC", { type: "image/heic" });
    expect(await shrinkPhoto(file, { encode: e })).toEqual({ blob: file, name: "IMG_9.HEIC", shrunk: false });
  });

  it("a PDF, or a GIF, goes untouched", async () => {
    const { e, drawn } = encoder({ width: 5000, height: 5000 });
    const pdf = photo("quote.pdf", 3_000_000, "application/pdf");
    expect((await shrinkPhoto(pdf, { encode: e })).blob).toBe(pdf);
    const gif = photo("moving.gif", 3_000_000, "image/gif");
    expect((await shrinkPhoto(gif, { encode: e })).blob).toBe(gif);
    expect(drawn).toEqual([]);
  });

  it("never throws: an encoder that throws, or one that makes nothing, sends the photo as it is", async () => {
    const file = photo("IMG.jpg", 5_000_000);
    const throwing: PhotoEncoder = {
      measure: async () => {
        throw new Error("decode failed");
      },
      toJpeg: async () => null,
    };
    expect((await shrinkPhoto(file, { encode: throwing })).blob).toBe(file);
    const empty: PhotoEncoder = { measure: async () => ({ width: 4000, height: 3000 }), toJpeg: async () => null };
    expect((await shrinkPhoto(file, { encode: empty })).shrunk).toBe(false);
    // The default encoder in a browser without createImageBitmap (happy-dom) is "can't read".
    expect((await shrinkPhoto(file)).blob).toBe(file);
  });

  it("names: the extension becomes .jpg", () => {
    expect(jpegName("IMG_0042.HEIC")).toBe("IMG_0042.jpg");
    expect(jpegName("photo")).toBe("photo.jpg");
    expect(jpegName("a.b.png")).toBe("a.b.jpg");
  });
});
