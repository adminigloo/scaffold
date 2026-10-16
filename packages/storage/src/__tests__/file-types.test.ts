import { describe, expect, it } from "vitest";
import { cleanFilename, contentDisposition, sanitizeFilename, withTypeExtension } from "../filenames.js";
import { FILE_TYPES, formatBytes, imageSize, sniffFileType, typesInWords, uploadRuleInWords } from "../file-types.js";
import { jpeg, PNG, pdf } from "./pglite.js";

/**
 * What a file IS (6.3): from its bytes, never from what the browser said.
 * SVG and HTML are never accepted (they can carry script), and a JPEG that
 * calls itself a PDF is a JPEG.
 */

const ascii = (text: string) => new TextEncoder().encode(text);

function webpLossy(width: number, height: number): Uint8Array {
  const b = new Uint8Array(30);
  b.set(ascii("RIFF"), 0);
  b.set(ascii("WEBP"), 8);
  b.set(ascii("VP8 "), 12);
  b[23] = 0x9d;
  b[24] = 0x01;
  b[25] = 0x2a;
  b[26] = width & 0xff;
  b[27] = (width >> 8) & 0x3f;
  b[28] = height & 0xff;
  b[29] = (height >> 8) & 0x3f;
  return b;
}

function gif(width: number, height: number): Uint8Array {
  const b = new Uint8Array(13);
  b.set(ascii("GIF89a"), 0);
  b[6] = width & 0xff;
  b[7] = width >> 8;
  b[8] = height & 0xff;
  b[9] = height >> 8;
  return b;
}

function heic(brand: string): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0, 0, 0, 24], 0);
  b.set(ascii("ftyp"), 4);
  b.set(ascii(brand), 8);
  return b;
}

describe("sniffFileType", () => {
  it("names each type from its magic number", () => {
    expect(sniffFileType(jpeg())).toBe("jpeg");
    expect(sniffFileType(PNG)).toBe("png");
    expect(sniffFileType(webpLossy(10, 10))).toBe("webp");
    expect(sniffFileType(gif(4, 4))).toBe("gif");
    expect(sniffFileType(ascii("GIF87a......"))).toBe("gif");
    for (const brand of ["heic", "heix", "hevc", "hevx", "mif1", "msf1"]) expect(sniffFileType(heic(brand)), brand).toBe("heic");
    expect(sniffFileType(pdf())).toBe("pdf");
  });

  it("is null for SVG, HTML, an EXE, an empty file and anything else", () => {
    expect(sniffFileType(ascii('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(sniffFileType(ascii('<?xml version="1.0"?><svg/>'))).toBeNull();
    expect(sniffFileType(ascii("<!doctype html><html><script>alert(1)</script>"))).toBeNull();
    expect(sniffFileType(new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]))).toBeNull(); // MZ: a Windows program
    expect(sniffFileType(new Uint8Array(0))).toBeNull();
    expect(sniffFileType(heic("avif"))).toBeNull(); // ftyp, but not a brand 0.2 keeps
    expect(sniffFileType(ascii("RIFF....WAVE"))).toBeNull();
  });

  it("a JPEG declared as a PDF is a JPEG: the declared type is never asked", () => {
    expect(sniffFileType(jpeg())).toBe("jpeg");
    expect(FILE_TYPES[sniffFileType(jpeg()) ?? "pdf"].contentType).toBe("image/jpeg");
  });
});

describe("imageSize", () => {
  it("reads each image type's header", () => {
    expect(imageSize(jpeg(640, 480), "jpeg")).toEqual({ width: 640, height: 480 });
    expect(imageSize(PNG, "png")).toEqual({ width: 1, height: 1 });
    expect(imageSize(webpLossy(320, 200), "webp")).toEqual({ width: 320, height: 200 });
    expect(imageSize(gif(16, 9), "gif")).toEqual({ width: 16, height: 9 });
  });
  it("is null for a type without a header reading, or a broken header", () => {
    expect(imageSize(heic("heic"), "heic")).toBeNull();
    expect(imageSize(pdf(), "pdf")).toBeNull();
    expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff]), "jpeg")).toBeNull();
  });
});

describe("words", () => {
  it("formatBytes", () => {
    expect(formatBytes(0)).toBe("0 bytes");
    expect(formatBytes(1)).toBe("1 byte");
    expect(formatBytes(412 * 1024, "en-US")).toBe("412 KB");
    expect(formatBytes(Math.round(3.1 * 1024 * 1024), "en-US")).toBe("3.1 MB");
    expect(formatBytes(120 * 1024 * 1024, "en-US")).toBe("120 MB");
    expect(formatBytes(4 * 1024 * 1024, "en-US")).toBe("4 MB");
    expect(formatBytes(1024 ** 3, "en-US")).toBe("1 GB");
    expect(formatBytes(5120 * 1024 * 1024, "en-US")).toBe("5 GB");
  });
  it("a refusal and a rule say the types in words", () => {
    expect(typesInWords(["jpeg", "png", "webp", "gif", "heic", "pdf"])).toBe("a photo (JPEG, PNG, WebP, GIF or HEIC) or a PDF");
    expect(typesInWords(["png", "jpeg", "webp"])).toBe("a photo (PNG, JPEG or WebP)");
    expect(uploadRuleInWords(["jpeg", "png", "webp", "heic", "pdf"], 4 * 1024 * 1024, "en-US")).toBe("Photos (JPEG, PNG, WebP, HEIC) or PDFs, up to 4 MB");
  });
});

describe("file names (review G18)", () => {
  it("0.1's sanitizer, unchanged", () => {
    expect(sanitizeFilename("invoice-2026.final.pdf")).toBe("invoice-2026.final.pdf");
    const backslash = String.fromCharCode(92);
    const cleaned = sanitizeFilename(`a/b${backslash}c: d*e?.png`);
    expect(cleaned).not.toMatch(/[/\\ ]/);
    expect(sanitizeFilename("..htaccess").startsWith(".")).toBe(false);
    expect(sanitizeFilename("   ")).toBe("file");
  });
  it("0.2 keeps a person's spaces, drops control characters, never a dotfile", () => {
    expect(cleanFilename("  Q3   report.pdf ")).toBe("Q3 report.pdf");
    expect(cleanFilename("a/b\u0000c\u0007.png")).toBe("a_bc.png");
    expect(cleanFilename(".env")).toBe("_env");
  });
  it("the stored name takes the sniffed type's extension", () => {
    expect(withTypeExtension("report.html", "pdf")).toBe("report.pdf");
    expect(withTypeExtension("photo", "jpeg")).toBe("photo.jpg");
    expect(withTypeExtension("IMG_1.JPEG", "jpeg")).toBe("IMG_1.JPEG");
    expect(withTypeExtension("x.jpg", "png")).toBe("x.png");
    expect(withTypeExtension("Q3.report", "pdf")).toBe("Q3.report.pdf");
    expect(withTypeExtension("a".repeat(250), "pdf").length).toBeLessThanOrEqual(200);
  });
  it("the download header carries the real name, encoded", () => {
    expect(contentDisposition("attachment", 'Q3 "final" report.pdf')).toBe(
      `attachment; filename="Q3 _final_ report.pdf"; filename*=UTF-8''Q3%20%22final%22%20report.pdf`,
    );
    expect(contentDisposition("inline", "café.png")).toContain("filename*=UTF-8''caf%C3%A9.png");
  });
});
