import { describe, expect, it } from "vitest";
import { composeUrl, cutToFit, fits, measure, PLATFORMS, textLength } from "../platforms.js";

/** EACH PLATFORM'S FORMAT AND LIMIT, counted its own way, and cutting the app's words to fit (../platforms.ts). */
const LINK = "https://example.com/news/2026-10-26/saturday-hours";

describe("counting", () => {
  it("counts the way X does: every link 23, an emoji 2", () => {
    expect(textLength("x", `🥇 hi ${LINK}`)).toBe(2 + 1 + 2 + 1 + 23);
    expect(textLength("x", "°¢–’")).toBe(4);
  });

  it("counts Bluesky in graphemes, the link in full", () => {
    expect(textLength("bluesky", "👨‍👩‍👧 ok")).toBe(4);
    expect(textLength("bluesky", LINK)).toBe(LINK.length);
  });

  it("reads Reddit as a title line and a body", () => {
    const m = measure("reddit", `A title\n\nThe body.`);
    expect(m.title).toEqual({ length: 7, max: 300 });
    expect(m.length).toBe(9);
    expect(m.fits).toBe(true);
    expect(fits("reddit", `${"t".repeat(301)}\n\nbody`)).toBe(false);
  });

  it("knows every platform's limit", () => {
    expect(Object.fromEntries(Object.values(PLATFORMS).map((p) => [p.id, p.max]))).toEqual({
      x: 280,
      threads: 500,
      bluesky: 300,
      telegram: 4096,
      discord: 2000,
      linkedin: 3000,
      facebook: 63_206,
      instagram: 2200,
      tiktok: 2200,
      reddit: 40_000,
    });
    expect(PLATFORMS.reddit.titleMax).toBe(300);
  });
});

describe("each platform's format (the founder's list, Oct 27, 2026)", () => {
  const shape = (id: keyof typeof PLATFORMS) => {
    const r = PLATFORMS[id];
    return { link: r.linkIn, hookFirst: r.hookFirst, hashtags: r.hashtags, image: r.image && `${r.image.carousel ? "carousel" : "one"} ${r.image.aspect}` };
  };

  it("puts each link, hook, hashtag and image where that platform wants it", () => {
    expect(shape("x")).toEqual({ link: "comment", hookFirst: false, hashtags: false, image: "one 1:1" });
    expect(shape("linkedin")).toEqual({ link: "comment", hookFirst: true, hashtags: false, image: "one 4:5" });
    expect(shape("instagram")).toEqual({ link: "bio", hookFirst: true, hashtags: true, image: "carousel 4:5" });
    expect(shape("facebook")).toEqual({ link: "text", hookFirst: true, hashtags: false, image: "carousel 4:5" });
    // TikTok: a short caption (the hook, the aside, the hashtags) under slides that carry the facts.
    expect(shape("tiktok")).toEqual({ link: "bio", hookFirst: true, hashtags: true, image: "carousel 9:16" });
    expect(PLATFORMS.tiktok.captionOnly).toBe(true);
    expect(shape("threads")).toEqual({ link: "text", hookFirst: false, hashtags: false, image: "one 1:1" });
    expect(shape("bluesky")).toEqual({ link: "text", hookFirst: false, hashtags: false, image: "one 1:1" });
    expect(shape("telegram")).toEqual({ link: "text", hookFirst: false, hashtags: false, image: "one 1:1" });
    expect(shape("discord")).toEqual({ link: "text", hookFirst: false, hashtags: false, image: "one 1:1" });
    expect(shape("reddit")).toEqual({ link: "text", hookFirst: false, hashtags: false, image: null });
  });
});

describe("cutting the app's words to fit", () => {
  const long = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} says something plain.`).join(" ");
  const under = (n: number) => (text: string) => [...text].length <= n;

  it("leaves words that fit as they are", () => {
    expect(cutToFit(long, under(10_000))).toBe(long);
  });

  it("cuts after a whole sentence when one fits", () => {
    const cut = cutToFit(long, under(200));
    expect(cut.length).toBeLessThanOrEqual(200);
    expect(cut.endsWith("plain.")).toBe(true);
  });

  it("falls back to whole words, with an ellipsis, when one sentence is too long", () => {
    const cut = cutToFit("word ".repeat(80), under(100));
    expect(cut.length).toBeLessThanOrEqual(100);
    expect(cut.endsWith("word…")).toBe(true);
  });

  it("gives back nothing when not even a word fits", () => {
    expect(cutToFit("Supercalifragilistic", under(3))).toBe("");
  });
});

describe("the composer", () => {
  it("opens with the text filled in where the platform has one", () => {
    expect(composeUrl("x", "a b&c")).toBe("https://x.com/intent/post?text=a%20b%26c");
    expect(composeUrl("bluesky", "hi")).toBe("https://bsky.app/intent/compose?text=hi");
    expect(composeUrl("discord", "hi")).toBeNull();
    expect(composeUrl("instagram", "hi")).toBeNull();
  });
});
