import { describe, expect, it } from "vitest";
import { fits, PLATFORMS } from "../platforms.js";
import type { Platform, PostSource } from "../types.js";
import { writePost } from "../writer.js";

/**
 * HASHTAGS AND LINK CARDS (social 0.2). The founder, Nov 3, 2026: Almanac's
 * posts went out with no hashtags, because 0.1 switched them off everywhere
 * but Instagram and TikTok, and a small account needs them to reach the
 * people who follow a topic. Each platform now takes up to its own count, and
 * where the text runs long they go one at a time: after the aside and the
 * banter, before any fact. Bluesky's link is a link card, so the address no
 * longer eats its 300.
 */
const LINK = "https://example.com/hours";
const TAGS = ["#bakery", "#smallbusiness", "#bread", "#local", "#weekend", "#sixth"];
const ALL: readonly Platform[] = ["x", "threads", "bluesky", "telegram", "discord", "linkedin", "facebook", "instagram", "tiktok", "reddit"];

const sourceWith = (over: Partial<PostSource> = {}): PostSource => ({
  key: "launch:saturdays",
  kind: "launch",
  author: "Maple & Rye",
  voice: null,
  day: "2026-11-03",
  facts: { title: "Open on Saturdays", lines: ["We're open on Saturdays now, 9 to 1."] },
  platforms: ALL,
  hook: "Saturdays, 9 to 1.",
  linkUrl: LINK,
  linkLabel: "Our hours",
  hashtags: TAGS,
  template: (p) => (p === "reddit" ? ["Open on Saturdays\n\nWe're open on Saturdays now, 9 to 1."] : ["We're open on Saturdays now, 9 to 1."]),
  images: () => [],
  ...over,
});

const of = (written: Awaited<ReturnType<typeof writePost>>, p: Platform) => written.find((w) => w.platform === p)!;
const lastLine = (text: string) => text.split("\n\n").at(-1)!;

describe("hashtags, each platform's own count", () => {
  it("ends each text with the first of the post's hashtags, as many as its platform takes", async () => {
    const written = await writePost(sourceWith(), { complete: null });
    expect(lastLine(of(written, "x").text)).toBe("#bakery #smallbusiness");
    expect(lastLine(of(written, "threads").text)).toBe("#bakery");
    expect(lastLine(of(written, "bluesky").text)).toBe("#bakery #smallbusiness #bread");
    expect(lastLine(of(written, "linkedin").text)).toBe("#bakery #smallbusiness #bread #local #weekend");
    expect(lastLine(of(written, "facebook").text)).toBe("#bakery #smallbusiness");
    expect(lastLine(of(written, "instagram").text)).toBe("#bakery #smallbusiness #bread #local #weekend");
    for (const p of ["telegram", "discord", "reddit"] as const) expect(of(written, p).text).not.toContain("#");
    for (const w of written) expect(fits(w.platform, w.text)).toBe(true);
    expect(PLATFORMS.x.hashtags).toBe(2);
  });

  it("takes the post's own hashtags only, fewer where it has fewer", async () => {
    const written = await writePost(sourceWith({ hashtags: ["#bakery"] }), { complete: null });
    expect(lastLine(of(written, "linkedin").text)).toBe("#bakery");
    const none = await writePost(sourceWith({ hashtags: [] }), { complete: null });
    for (const w of none) expect(w.text).not.toContain("#");
  });

  it("gives up a hashtag before a fact: the longest words with fewer hashtags beat shorter words with more", async () => {
    // X's 280 by characters: words that leave room for one hashtag and not two.
    const long = `${"We bake every loaf by hand, before dawn, in the old brick oven on Mill Street. ".repeat(4)}Saturdays now too.`.slice(0, 280 - " #bakery".length - 2 - 1).trimEnd();
    const written = await writePost(sourceWith({ template: () => [long, "Saturdays now too."] }), { complete: null });
    expect(of(written, "x").text).toBe(`${long}\n\n#bakery`);
  });

  it("gives up the sign-off before a hashtag", async () => {
    const words = "x".repeat(280 - "\n\n#bakery #smallbusiness".length - 10);
    const written = await writePost(sourceWith({ template: () => [words], voice: "You are the baker.", fallbackAsides: { full: "Flour everywhere, as usual.", short: "Flour everywhere." } }), { complete: null, mode: "aside" });
    // The aside doesn't fit beside the words and two hashtags: the aside goes, the hashtags stay.
    expect(of(written, "x").text).toBe(`${words}\n\n#bakery #smallbusiness`);
  });
});

describe("Bluesky's link card", () => {
  it("keeps the address out of the text and on the draft, for the card", async () => {
    const written = await writePost(sourceWith(), { complete: null, tagLinks: true });
    const bluesky = of(written, "bluesky");
    expect(PLATFORMS.bluesky.linkIn).toBe("card");
    expect(bluesky.text).not.toContain("https://");
    expect(bluesky.firstComment).toBeNull();
    expect(bluesky.linkUrl).toBe(`${LINK}?utm_source=bluesky&utm_medium=social&utm_campaign=launch&utm_content=launch%3Asaturdays`);
  });
});
