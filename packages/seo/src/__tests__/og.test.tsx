import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearFontCache, loadFont, SHARE_IMAGE_SIZE, ShareImage, shareImageResponse } from "../og.js";

afterEach(() => {
  clearFontCache();
});

function fontFetch(responses: Array<Response | Error>) {
  let i = 0;
  return vi.fn(async () => {
    const next = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch & { mock: { calls: unknown[] } };
}

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe("loadFont: cached, with a fallback", () => {
  it("fetches a font once per URL and reuses it", async () => {
    const fetch = fontFetch([new Response(new Uint8Array([1, 2, 3]))]);
    const source = { name: "Display", url: "https://fonts.example.com/display.ttf", weight: 700 as const };
    const [a, b] = await Promise.all([loadFont(source, { fetch }), loadFont(source, { fetch })]);
    const c = await loadFont(source, { fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(a?.data.byteLength).toBe(3);
    expect(b?.data).toBe(a?.data);
    expect(c).toEqual({ name: "Display", data: a!.data, weight: 700 });
  });

  it("resolves null on a failed fetch or a bad status, and tries again next time (a failure is not cached)", async () => {
    const fetch = fontFetch([new Error("offline"), new Response("nope", { status: 404 }), new Response(new Uint8Array([9]))]);
    const source = { name: "Display", url: "https://fonts.example.com/flaky.ttf" };
    expect(await loadFont(source, { fetch })).toBeNull();
    expect(await loadFont(source, { fetch })).toBeNull();
    expect((await loadFont(source, { fetch }))?.data.byteLength).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("gives up on a slow font", async () => {
    const hang = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted")))),
    ) as unknown as typeof fetch;
    expect(await loadFont({ name: "X", url: "https://fonts.example.com/slow.ttf" }, { fetch: hang, timeoutMs: 20 })).toBeNull();
  });
});

describe("ShareImage", () => {
  it("is a satori-shaped tree: every box with several children is display:flex", () => {
    const element = ShareImage({ title: "Bridal shower hunt", brand: "Riddler Go", eyebrow: "Template", badge: "12 PUZZLES", description: "A themed hunt.", footer: "riddlergo.com/templates/bridal", image: null });
    const offenders: string[] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const el = node as { type?: unknown; props?: { style?: { display?: string }; children?: unknown } };
      const kids = ([] as unknown[]).concat(el.props?.children ?? []).filter((k) => k !== null && k !== undefined && k !== false && k !== "");
      if (el.type === "div" && kids.length > 1 && el.props?.style?.display !== "flex") offenders.push(JSON.stringify(el.props?.style));
      kids.forEach(walk);
    };
    walk(element);
    expect(offenders).toEqual([]);
  });
});

describe("shareImageResponse: a real PNG through next/og", () => {
  it("renders 1200×630 with the default font when the font cannot be loaded", async () => {
    const fetch = fontFetch([new Error("offline")]);
    const response = await shareImageResponse(
      { title: "Puzzle events for any occasion", brand: "Riddler Go", description: "Guests join with a QR code.", footer: "riddlergo.com" },
      { fonts: [{ name: "Display", url: "https://fonts.example.com/display.ttf" }], fetch },
    );
    expect(response.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(pngSize(bytes)).toEqual(SHARE_IMAGE_SIZE);
  });

  it("takes a font as bytes the app already has (a local OTF/TTF), with no fetch, and a gradient background", async () => {
    const bytes = readFileSync(fileURLToPath(new URL("../../node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf", import.meta.url)));
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const fetch = fontFetch([new Error("must not be called")]);
    const gradient = "linear-gradient(135deg, #101418 0%, #1d2a33 100%)";
    const response = await shareImageResponse(
      { title: "Puzzle events for any occasion", brand: "Riddler Go", theme: { backgroundImage: gradient } },
      { fonts: [{ name: "Geist", data, weight: 400 }], fetch },
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(pngSize(new Uint8Array(await response.arrayBuffer()))).toEqual(SHARE_IMAGE_SIZE);
    const root = ShareImage({ title: "T", theme: { backgroundImage: gradient } }) as { props: { style: Record<string, string> } };
    expect(root.props.style.backgroundImage).toBe(gradient);
    expect((ShareImage({ title: "T" }) as { props: { style: Record<string, string> } }).props.style).not.toHaveProperty("backgroundImage");
  });

  it("renders the split layout with its lettered panel", async () => {
    const response = await shareImageResponse({ title: "Delicate Arch", brand: "Traildek", badge: "3 MILES", image: null, theme: { background: "#f7f4ed", foreground: "#2f2a22" } });
    expect(pngSize(new Uint8Array(await response.arrayBuffer()))).toEqual(SHARE_IMAGE_SIZE);
  });
});
