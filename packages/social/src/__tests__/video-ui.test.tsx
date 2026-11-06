// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftImage } from "../types.js";

/**
 * "MAKE A VIDEO" (../ui/video.tsx): for any draft whose pictures are one size
 * (social 0.5: every platform with pictures, at the pictures' own size), in
 * a browser that can make it at that size; progress while it's made; then a
 * preview, Send video to TikTok (a phone) and Download video. The encoder is
 * faked here (the real one is checked in a real browser).
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const make = vi.fn();
const able = vi.fn(async (_width?: number, _height?: number) => true);
vi.mock("../video/render.js", () => ({ canMakeVideo: (width: number, height: number) => able(width, height), makeCardVideo: (...args: unknown[]) => make(...args) }));
const { MakeVideo, fullScreenSlides, videoFileName, videoSize } = await import("../ui/video.js");

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
  it("names the clip, knows a full-screen one, and takes pictures of one size only", () => {
    expect(videoFileName("launch:Saturdays", "tiktok")).toBe("launch-saturdays-tiktok.mp4");
    expect(videoFileName("sample-look-spray-9x16")).toBe("sample-look-spray-9x16.mp4");
    expect(fullScreenSlides(TALL)).toBe(true);
    expect(fullScreenSlides([{ url: "x", alt: "", width: 1080, height: 1350 }])).toBe(false);
    expect(fullScreenSlides([])).toBe(false);
    expect(videoSize(TALL)).toEqual({ width: 1080, height: 1920 });
    expect(videoSize([...TALL, { url: "x", alt: "", width: 1080, height: 1350 }])).toBeNull();
    expect(videoSize([])).toBeNull();
  });

  it("shows nothing where the browser can't make it at the pictures' size, or they aren't one size", async () => {
    able.mockImplementation(async () => false);
    expect((await mount(<MakeVideo postKey="launch:1" platform="tiktok" images={TALL} text="t" />)).innerHTML).toBe("");
    able.mockImplementation(async () => true);
    expect((await mount(<MakeVideo postKey="launch:1" platform="tiktok" images={[...TALL, { url: "x", alt: "", width: 1080, height: 1350 }]} text="t" />)).innerHTML).toBe("");
  });

  it("offers a 4:5 video for Instagram and a 1:1 one for X (social 0.5), asking the browser about that size", async () => {
    const portrait = await mount(<MakeVideo postKey="launch:1" platform="instagram" images={[{ url: "https://example.com/p.png", alt: "", width: 1080, height: 1350 }]} text="t" />);
    expect(buttons(portrait)).toEqual(["Make a video"]);
    expect(able).toHaveBeenCalledWith(1080, 1350);
    const square = await mount(<MakeVideo postKey="launch:1" platform="x" images={[{ url: "https://example.com/s.png", alt: "", width: 1080, height: 1080 }]} text="t" label="Make a 1:1 video" />);
    expect(buttons(square)).toEqual(["Make a 1:1 video"]);
  });

  it("makes the clip from the slides in order, then offers the preview, Send video to TikTok and Download video", async () => {
    stub(globalThis.URL, "createObjectURL", () => "blob:clip");
    stub(globalThis.URL, "revokeObjectURL", () => undefined);
    stub(navigator, "share", vi.fn(async () => undefined));
    stub(navigator, "canShare", () => true);
    stub(navigator, "clipboard", { writeText: vi.fn(async () => undefined) });
    make.mockImplementation(async (_cards: unknown[], options: { onProgress?: (d: number) => void }) => {
      options.onProgress?.(0.5);
      options.onProgress?.(1);
      return { blob: new Blob(["mp4"], { type: "video/mp4" }), seconds: 5.6, width: 1080, height: 1920 };
    });
    const c = await mount(<MakeVideo postKey="launch:1" platform="tiktok" images={TALL} text="Saturdays. #bakery" />);
    expect(buttons(c)).toEqual(["Make a video"]);
    await act(async () => (c.querySelector("button") as HTMLButtonElement).click());
    for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
    expect(make).toHaveBeenCalledTimes(1);
    expect(make.mock.calls[0]![0]).toEqual([
      { url: "https://example.com/1.png", width: 1080, height: 1920 },
      { url: "https://example.com/2.png", width: 1080, height: 1920 },
    ]);
    expect(c.querySelector("video")?.getAttribute("src")).toBe("blob:clip");
    expect(buttons(c)).toEqual(["Send video to TikTok", "Download video", "Make it again"]);
    expect(c.querySelector("a")?.getAttribute("download")).toBe("launch-1-tiktok.mp4");
    expect(c.textContent).toContain("6 seconds, with no sound: pick one in TikTok");
    await act(async () => [...c.querySelectorAll("button")].find((b) => b.textContent === "Send video to TikTok")!.click());
    const shared = (navigator.share as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { files: File[]; text: string };
    expect(shared.files.map((f) => f.name)).toEqual(["launch-1-tiktok.mp4"]);
    expect(shared.text).toBe("Saturdays. #bakery");
  });

  it("makes a sample's video with no platform: downloaded, never sent", async () => {
    stub(globalThis.URL, "createObjectURL", () => "blob:clip");
    stub(globalThis.URL, "revokeObjectURL", () => undefined);
    stub(navigator, "share", vi.fn(async () => undefined));
    stub(navigator, "canShare", () => true);
    make.mockImplementation(async () => ({ blob: new Blob(["mp4"], { type: "video/mp4" }), seconds: 4.2, width: 1080, height: 1080 }));
    const c = await mount(<MakeVideo postKey="sample-look-confetti-1x1" images={[{ url: "https://example.com/s.png", alt: "", width: 1080, height: 1080 }]} />);
    await act(async () => (c.querySelector("button") as HTMLButtonElement).click());
    for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
    expect(buttons(c)).toEqual(["Download video", "Make it again"]);
    expect(c.querySelector("a")?.getAttribute("download")).toBe("sample-look-confetti-1x1.mp4");
    expect(c.textContent).toContain("4 seconds at 1080×1080, with no sound.");
  });

  it("starts each platform's video afresh: one platform's clip never shows as another's (social 0.7.4)", async () => {
    stub(globalThis.URL, "createObjectURL", () => "blob:clip");
    stub(globalThis.URL, "revokeObjectURL", () => undefined);
    make.mockImplementation(async () => ({ blob: new Blob(["mp4"], { type: "video/mp4" }), seconds: 10.6, width: 1080, height: 1920 }));
    const { PostQueue } = await import("../ui/PostQueue.js");
    const draft = (id: string, platform: "tiktok" | "instagram", height: number) => ({
      id, key: "launch:1", kind: "launch", platform, author: "Maple & Rye", day: "2026-10-27", title: "Open on Saturdays", text: "Saturdays.", hook: "Saturdays.",
      images: [{ url: `https://example.com/${id}.png`, alt: "", width: 1080, height }], firstComment: null, templateText: "Saturdays.", writtenBy: "template" as const,
      note: null, linkUrl: null, status: "draft" as const, postedUrl: null, postedAt: null, expiresAt: null, expiresLabel: null, updatedAt: "2026-10-27T15:00:00.000Z",
    });
    const noop = async () => undefined;
    const c = await mount(<PostQueue posts={[draft("t1", "tiktok", 1920), draft("i1", "instagram", 1350)]} actions={{ save: noop, approve: noop, markPosted: noop, skip: noop }} />);
    const tab = (name: string) => [...c.querySelectorAll('[role="tab"]')].find((t) => t.textContent?.includes(name)) as HTMLButtonElement;
    await act(async () => tab("TikTok").click());
    for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
    await act(async () => ([...c.querySelectorAll(".social-panel button")].find((b) => b.textContent === "Make a video") as HTMLButtonElement).click());
    for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
    expect(c.querySelector(".social-panel video")).not.toBeNull();
    await act(async () => tab("Instagram").click());
    for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
    expect(c.querySelector(".social-panel video")).toBeNull();
    expect([...c.querySelectorAll(".social-panel button")].map((b) => b.textContent)).toContain("Make a video");
  });

  it("starts the card formats' video afresh in another look: never a look's clip under another's cards (social 0.7.5)", async () => {
    stub(globalThis.URL, "createObjectURL", () => "blob:clip");
    stub(globalThis.URL, "revokeObjectURL", () => undefined);
    make.mockImplementation(async () => ({ blob: new Blob(["mp4"], { type: "video/mp4" }), seconds: 4.2, width: 1080, height: 1080 }));
    const { CardFormats } = await import("../ui/CardFormats.js");
    const setIn = (look: string) => [{ key: "quote", title: "Quote card", about: "Samples", images: [{ url: `https://example.com/api/social/card?kind=quote&look=${look}&sig=s`, alt: "A sample", width: 1080, height: 1080, label: "quote · 1:1 · 1080×1080" }] }];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<CardFormats sets={setIn("spray")} />));
    for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
    await act(async () => ([...container.querySelectorAll("button")].find((b) => b.textContent === "Make a 1:1 video") as HTMLButtonElement).click());
    for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
    expect(container.querySelector("video")).not.toBeNull();
    await act(async () => root.render(<CardFormats sets={setIn("dark")} />));
    for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 5)));
    expect(container.querySelector("video")).toBeNull();
    expect([...container.querySelectorAll("button")].map((b) => b.textContent)).toContain("Make a 1:1 video");
    await act(async () => root.unmount());
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
