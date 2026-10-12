import { describe, expect, it } from "vitest";
import { decodeBase64Strict, inspectImage, MAX_BASE64_CHARS, PHOTO_LIMITS, sha256Hex } from "../image.js";
import { gif, jpeg, png, toBase64, webpVp8, webpVp8l, webpVp8x } from "./fixtures.js";

/**
 * The server never trusts the client's photo: the type comes from the magic
 * bytes, the size from the header, and anything too big is refused before it
 * reaches the model or the store.
 */

describe("inspectImage on hand-built headers", () => {
  it("a JPEG with SOF0 768×576, behind an APP1 (Exif) segment", () => {
    expect(inspectImage(jpeg(768, 576, { app1: true }), "image/jpeg")).toEqual({ ok: true, mediaType: "image/jpeg", width: 768, height: 576 });
  });

  it("a progressive JPEG (SOF2)", () => {
    expect(inspectImage(jpeg(640, 480, { progressive: true }), "image/jpeg")).toEqual({ ok: true, mediaType: "image/jpeg", width: 640, height: 480 });
  });

  it("PNG IHDR, and WebP VP8 / VP8L / VP8X", () => {
    expect(inspectImage(png(512, 384), "image/png")).toEqual({ ok: true, mediaType: "image/png", width: 512, height: 384 });
    expect(inspectImage(webpVp8(768, 432), "image/webp")).toEqual({ ok: true, mediaType: "image/webp", width: 768, height: 432 });
    expect(inspectImage(webpVp8l(300, 200), "image/webp")).toEqual({ ok: true, mediaType: "image/webp", width: 300, height: 200 });
    expect(inspectImage(webpVp8x(1000, 750), "image/webp")).toEqual({ ok: true, mediaType: "image/webp", width: 1000, height: 750 });
  });

  it("a GIF (or HEIC) is unsupported; a PNG declared as JPEG is a mismatch", () => {
    expect(inspectImage(gif(100, 100), "image/gif")).toEqual({ ok: false, reason: "unsupported_type" });
    const heic = new Uint8Array([0, 0, 0, 24, ...[..."ftypheic"].map((c) => c.charCodeAt(0)), 0, 0, 0, 0]);
    expect(inspectImage(heic, "image/heic")).toEqual({ ok: false, reason: "unsupported_type" });
    expect(inspectImage(png(10, 10), "image/jpeg")).toEqual({ ok: false, reason: "type_mismatch" });
    expect(inspectImage(png(10, 10), "application/pdf")).toEqual({ ok: false, reason: "not_an_image" });
    expect(inspectImage(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), "image/png")).toEqual({ ok: false, reason: "unsupported_type" });
  });

  it("a 2000 px photo is too many pixels; 700 KB is too large", () => {
    expect(inspectImage(jpeg(2000, 1500), "image/jpeg")).toEqual({ ok: false, reason: "too_many_pixels" });
    expect(inspectImage(jpeg(1024, 768), "image/jpeg").ok).toBe(true); // acceptEdgePx itself is fine
    const big = new Uint8Array(700_000);
    big.set(jpeg(768, 576));
    expect(inspectImage(big, "image/jpeg")).toEqual({ ok: false, reason: "too_large" });
    expect(PHOTO_LIMITS).toMatchObject({ maxEdgePx: 768, acceptEdgePx: 1024, maxBytes: 600_000, jpegQuality: 0.8 });
  });

  it("a truncated header is unreadable", () => {
    expect(inspectImage(jpeg(768, 576).slice(0, 14), "image/jpeg")).toEqual({ ok: false, reason: "unreadable_size" });
    expect(inspectImage(png(10, 10).slice(0, 12), "image/png")).toEqual({ ok: false, reason: "unreadable_size" });
    expect(inspectImage(webpVp8(10, 10).slice(0, 24), "image/webp")).toEqual({ ok: false, reason: "unreadable_size" });
  });
});

describe("strict base64", () => {
  it("decodes the standard alphabet with padding, and nothing else", () => {
    const bytes = jpeg(10, 10);
    expect(decodeBase64Strict(toBase64(bytes))).toEqual(bytes);
    expect(decodeBase64Strict(`data:image/jpeg;base64,${toBase64(bytes)}`)).toBeNull();
    expect(decodeBase64Strict("abc")).toBeNull(); // not a multiple of 4
    expect(decodeBase64Strict("ab c")).toBeNull();
    expect(decodeBase64Strict("ab-_")).toBeNull(); // base64url is not this alphabet
    expect(decodeBase64Strict("")).toBeNull();
    expect(decodeBase64Strict(42)).toBeNull();
  });

  it("refuses a string longer than a 600 KB photo can be before decoding it", () => {
    expect(MAX_BASE64_CHARS).toBe(Math.ceil(600_000 / 3) * 4 + 4);
    expect(decodeBase64Strict("A".repeat(MAX_BASE64_CHARS + 4))).toBeNull();
  });

  it("sha256Hex is the photo's identity", async () => {
    const a = await sha256Hex(jpeg(10, 10, { tag: "a" }));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex(jpeg(10, 10, { tag: "a" }))).toBe(a);
    expect(await sha256Hex(jpeg(10, 10, { tag: "b" }))).not.toBe(a);
  });
});
