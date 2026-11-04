import { describe, expect, it } from "vitest";
import { PLATFORMS } from "../platforms.js";
import { smell } from "../smell.js";
import { launchSource } from "../sources.js";
import type { Platform } from "../types.js";
import { writePost } from "../writer.js";

/**
 * A TYPED POST SAYS EACH THING ONCE (social 0.2.2). With the real model
 * (Nov 4, 2026), LinkedIn read "Starting Nov 8, we're open Saturdays, 9 to 1."
 * then "From Nov 8 we're open Saturdays, 9 to 1. …": the AI's hook, then the
 * person's own first sentence. A platform that opens with the hook now opens
 * with the person's first sentence and goes on with the rest; the hook stays
 * on the images.
 */
const FACTS = "From Nov 8 we're open Saturdays, 9 to 1. Sourdough, rye and cinnamon rolls, baked that morning.";
const source = launchSource({
  key: "launch:saturdays",
  facts: FACTS,
  author: "Maple & Rye",
  voice: "You write Maple & Rye's posts.",
  day: "2026-11-04",
  link: "https://example.com/hours",
  hashtags: [],
  images: () => [],
});
const answer = JSON.stringify({ hook: "Starting Nov 8, we're open Saturdays, 9 to 1.", asides: [{ text: "One more reason to get out of bed.", probability: 0.1 }] });
const count = (text: string, part: string) => text.split(part).length - 1;

describe("a typed post's opening line", () => {
  it("opens each hook-first platform with the person's first sentence, once, and the AI's hook stays on the images", async () => {
    const written = await writePost(source, { complete: async () => answer, mode: "aside" });
    for (const w of written) {
      const rule = PLATFORMS[w.platform as Platform];
      expect(count(w.text, "open Saturdays, 9 to 1"), w.platform).toBe(1);
      if (rule.hookFirst && !rule.captionOnly) expect(w.text.startsWith("From Nov 8 we're open Saturdays, 9 to 1.\n\nSourdough"), w.platform).toBe(true);
      expect(w.hook).toBe("Starting Nov 8, we're open Saturdays, 9 to 1.");
    }
    // X doesn't open with the hook: the person's words whole.
    expect(written.find((w) => w.platform === "x")!.text.startsWith(FACTS)).toBe(true);
  });

  it("opens with the sentence alone when that's all there is", async () => {
    const one = launchSource({ ...source, facts: "We're open Saturdays now, 9 to 1.", key: "launch:one", voice: null, link: null, images: () => [] });
    const written = await writePost(one, { complete: null });
    expect(written.find((w) => w.platform === "linkedin")!.text).toBe("We're open Saturdays now, 9 to 1.");
  });
});

describe("the AI-smell check, from the real model's lines", () => {
  it("refuses a model's turn of phrase it wrote on Nov 4", () => {
    expect(smell("Rye has a way of bringing out the best in simple things.")).not.toBeNull();
    expect(smell("One more reason to get out of bed.")).toBeNull();
  });
});
