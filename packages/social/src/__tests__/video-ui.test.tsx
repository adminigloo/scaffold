// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftImage } from "../types.js";

/**
 * "MAKE A VIDEO" (../ui/video.tsx): only for full-screen slides in a browser
 * that can make it; progress while it's made; then a preview, Send video to
 * TikTok (a phone) and Download video. The encoder is faked here (the real
 * one is checked in a real browser).
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const make = vi.fn();
const able = vi.fn(async () => true);
vi.mock("../video/render.js", () => ({ canMakeVideo: () => able(), makeSlideshowVideo: (...args: unknown[]) => make(...args) }));
const { MakeVideo, fullScreenSlides, videoFileName } = await import("../ui/video.js");

const TALL: DraftImage[] = [
  { url: "https://example.com/1.png", alt: "1", width: 1080, height: 1920 },
  { url: "https://example.com/2.png", alt: "2", width: 1080, height: 1920 },
];

const restore: (() => void)[] = [];
function stub(target: object, key: string, value: unknown) {
  const had = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
  restore.push(() => (had ? Object.defineProperty(target, key, had) : delete (target as Record<string, unknown>)[key]));
}
afterEach(() => {
  while (restore.length) restore.pop()!();
  document.body.innerHTML = "";
  make.mockReset();
  able.mockReset();
  able.mockImplementation(async () => true);
});

async function mount(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => createRoot(container).render(element));
  for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
  return container;
}
const buttons = (c: HTMLElement) => [...c.querySelectorAll("button, a")].map((b) => b.textContent?.trim());

describe("make a video", () => {
  it("names the clip and only takes full-screen slides", () => {
    expect(videoFileName("launch:Saturdays", "tiktok")).toBe("launch-saturdays-tiktok.mp4");
    expect(fullScreenSlides(TALL)).toBe(true);
    expect(fullScreenSlides([{ url: "x", alt: "", width: 1080, height: 1350 }])).toBe(false);
    expect(fullScreenSlides([])).toBe(false);
  });

  it("shows nothing where the browser can't make it, or the slides aren't full screen", async () => {
    able.mockImplementation(async () => false);
    expect((await mount(<MakeVideo postKey="launch:1" platform="tiktok" images={TALL} text="t" />)).innerHTML).toBe("");
    able.mockImplementation(async () => true);
    expect((await mount(<MakeVideo postKey="launch:1" platform="instagram" images={[{ url: "x", alt: "", width: 1080, height: 1350 }]} text="t" />)).innerHTML).toBe("");
  });

  it("makes the clip from the slides in order, then offers the preview, Send video to TikTok and Download video", async () => {
    stub(globalThis.URL, "createObjectURL", () => "blob:clip");
    stub(globalThis.URL, "revokeObjectURL", () => undefined);
    stub(navigator, "share", vi.fn(async () => undefined));
    stub(navigator, "canShare", () => true);
    stub(navigator, "clipboard", { writeText: vi.fn(async () => undefined) });
    make.mockImplementation(async (_urls: string[], options: { onProgress?: (d: number) => void }) => {
      options.onProgress?.(0.5);
      options.onProgress?.(1);
      return { blob: new Blob(["mp4"], { type: "video/mp4" }), seconds: 5.6, width: 1080, height: 1920 };
    });
    const c = await mount(<MakeVideo postKey="launch:1" platform="tiktok" images={TALL} text="Saturdays. #bakery" />);
    expect(buttons(c)).toEqual(["Make a video"]);
    await act(async () => (c.querySelector("button") as HTMLButtonElement).click());
    for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
    expect(make).toHaveBeenCalledTimes(1);
    expect(make.mock.calls[0]![0]).toEqual(["https://example.com/1.png", "https://example.com/2.png"]);
    expect(c.querySelector("video")?.getAttribute("src")).toBe("blob:clip");
    expect(buttons(c)).toEqual(["Send video to TikTok", "Download video", "Make it again"]);
    expect(c.querySelector("a")?.getAttribute("download")).toBe("launch-1-tiktok.mp4");
    expect(c.textContent).toContain("6 seconds, with no sound: pick one in TikTok");
    await act(async () => [...c.querySelectorAll("button")].find((b) => b.textContent === "Send video to TikTok")!.click());
    const shared = (navigator.share as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { files: File[]; text: string };
    expect(shared.files.map((f) => f.name)).toEqual(["launch-1-tiktok.mp4"]);
    expect(shared.text).toBe("Saturdays. #bakery");
  });

  it("says plainly when the clip couldn't be made, and the photos still work", async () => {
    make.mockImplementation(async () => {
      throw new Error("slide 2 didn't load (404)");
    });
    const c = await mount(<MakeVideo postKey="launch:1" platform="tiktok" images={TALL} text="t" />);
    await act(async () => (c.querySelector("button") as HTMLButtonElement).click());
    for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
    expect(c.querySelector('[role="alert"]')?.textContent).toContain("slide 2 didn't load (404)");
    expect(buttons(c)).toEqual(["Try the video again"]);
  });
});
