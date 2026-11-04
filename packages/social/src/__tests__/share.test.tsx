// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftImage } from "../types.js";
import { canShareFiles, imageFileName, imageFiles, ShareImages, shareLabel } from "../ui/share.js";

/**
 * A DRAFT'S IMAGES INTO THE APP (../ui/share.tsx, social 0.3): "Send to
 * TikTok" hands the images to a phone's share sheet in posting order with
 * the text (on the clipboard too); "Download images" everywhere else.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const IMAGES: DraftImage[] = [
  { url: "https://example.com/card/1.png", alt: "Slide 1", width: 1080, height: 1920 },
  { url: "https://example.com/card/2.png", alt: "Slide 2", width: 1080, height: 1920 },
];
const png = () => new Response(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }));

const restore: (() => void)[] = [];
function stub(target: object, key: string, value: unknown) {
  const had = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
  restore.push(() => (had ? Object.defineProperty(target, key, had) : delete (target as Record<string, unknown>)[key]));
}
afterEach(() => {
  while (restore.length) restore.pop()!();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

async function mount(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  // Let the files load (fetch, blob) and the button update.
  for (let i = 0; i < 20; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
  return container;
}

describe("the share helpers", () => {
  it("names the files in posting order, and says Send to TikTok where the app is the way in", () => {
    expect(imageFileName("launch:Saturdays 9-1!", "tiktok", 1, 4)).toBe("launch-saturdays-9-1-tiktok-2-of-4.png");
    expect(imageFileName("launch:one", "x", 0, 1)).toBe("launch-one-x.png");
    expect(imageFileName("", "x", 0, 1)).toBe("post-x.png");
    expect(shareLabel("tiktok")).toBe("Send to TikTok");
    expect(shareLabel("instagram")).toBe("Send to Instagram");
    expect(shareLabel("x")).toBe("Share to X");
  });

  it("knows when a browser can share files, and says no wherever it can't tell", () => {
    expect(canShareFiles(undefined)).toBe(false);
    expect(canShareFiles({ share: undefined as never, canShare: undefined as never })).toBe(false);
    expect(canShareFiles({ share: async () => undefined, canShare: () => true })).toBe(true);
    expect(canShareFiles({ share: async () => undefined, canShare: () => false })).toBe(false);
    expect(
      canShareFiles({
        share: async () => undefined,
        canShare: () => {
          throw new Error("no");
        },
      }),
    ).toBe(false);
  });

  it("fetches each image as a file, in order, and says which one didn't load", async () => {
    const files = await imageFiles(IMAGES, "launch:1", "tiktok", (async () => png()) as unknown as typeof fetch);
    expect(files.map((f) => [f.name, f.type])).toEqual([
      ["launch-1-tiktok-1-of-2.png", "image/png"],
      ["launch-1-tiktok-2-of-2.png", "image/png"],
    ]);
    const missing = (async (url: string) => (url.endsWith("2.png") ? new Response("gone", { status: 404 }) : png())) as unknown as typeof fetch;
    await expect(imageFiles(IMAGES, "launch:1", "tiktok", missing)).rejects.toThrow("image 2 didn't load (404)");
  });
});

describe("the share buttons", () => {
  it("on a phone: Send to TikTok shares both images and the caption, and puts the caption on the clipboard", async () => {
    const share = vi.fn(async () => undefined);
    const writeText = vi.fn(async () => undefined);
    stub(navigator, "share", share);
    stub(navigator, "canShare", () => true);
    stub(navigator, "clipboard", { writeText });
    vi.stubGlobal("fetch", async () => png());
    const container = await mount(<ShareImages postKey="launch:1" platform="tiktok" images={IMAGES} text="Saturdays, 9 to 1. #bakery" />);
    const send = [...container.querySelectorAll("button")].find((b) => b.textContent === "Send to TikTok")!;
    expect(send.disabled).toBe(false);
    await act(async () => send.click());
    expect(writeText).toHaveBeenCalledWith("Saturdays, 9 to 1. #bakery");
    expect(share).toHaveBeenCalledTimes(1);
    const data = (share.mock.calls[0] as unknown as [{ files: File[]; text: string }])[0];
    expect(data.text).toBe("Saturdays, 9 to 1. #bakery");
    expect(data.files.map((f) => f.name)).toEqual(["launch-1-tiktok-1-of-2.png", "launch-1-tiktok-2-of-2.png"]);
    expect(container.textContent).toContain("Download 2 images");
  });

  it("on a computer: only Download images, and nothing at all for a draft with no images", async () => {
    stub(navigator, "share", undefined);
    const container = await mount(<ShareImages postKey="launch:1" platform="tiktok" images={IMAGES} text="t" />);
    expect([...container.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Download 2 images"]);
    const empty = await mount(<ShareImages postKey="launch:1" platform="reddit" images={[]} text="t" />);
    expect(empty.innerHTML).toBe("");
  });

  it("says what to do when the share sheet fails, and nothing when the person closes it", async () => {
    stub(navigator, "canShare", () => true);
    stub(navigator, "clipboard", { writeText: async () => undefined });
    vi.stubGlobal("fetch", async () => png());
    stub(navigator, "share", async () => {
      throw Object.assign(new Error("closed"), { name: "AbortError" });
    });
    const closed = await mount(<ShareImages postKey="launch:1" platform="x" images={IMAGES.slice(0, 1)} text="t" />);
    await act(async () => [...closed.querySelectorAll("button")].find((b) => b.textContent === "Share to X")!.click());
    expect(closed.querySelector('[role="status"]')).toBeNull();
    stub(navigator, "share", async () => {
      throw new Error("not allowed");
    });
    const failed = await mount(<ShareImages postKey="launch:2" platform="x" images={IMAGES.slice(0, 1)} text="t" />);
    await act(async () => [...failed.querySelectorAll("button")].find((b) => b.textContent === "Share to X")!.click());
    expect(failed.querySelector('[role="status"]')?.textContent).toContain("use Download images");
  });
});
