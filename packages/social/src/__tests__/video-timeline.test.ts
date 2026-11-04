import { describe, expect, it } from "vitest";
import { DEFAULT_SLIDESHOW, frameLayers, slideshowFrames, slideshowSeconds, type SlideshowSpec } from "../video/timeline.js";

/**
 * THE SLIDESHOW CLIP'S TIMING (../video/timeline.ts): the hook on screen at
 * the first frame, each slide's slow push-in never jumping when it takes
 * over, short crossfades, a longer last hold, and a seamless loop.
 */
const four: SlideshowSpec = { ...DEFAULT_SLIDESHOW, slides: 4 };

describe("a slideshow clip's timing", () => {
  it("runs about eleven seconds for four slides: three at 2.6 s and the call held 0.8 s longer", () => {
    expect(slideshowFrames(four)).toBe(3 * 78 + 102);
    expect(slideshowSeconds(four)).toBeCloseTo(11.2, 5);
    expect(slideshowFrames({ ...four, slides: 0 })).toBe(0);
    expect(frameLayers(0, { ...four, slides: 0 })).toEqual([]);
  });

  it("shows the hook, whole and still, at the very first frame", () => {
    expect(frameLayers(0, four)).toEqual([{ slide: 0, opacity: 1, scale: 1, offsetX: 0, offsetY: -0 }]);
  });

  it("crosses each slide into the next over the last frames, the next one fading in", () => {
    const crossing = frameLayers(78 - 6, four);
    expect(crossing.map((l) => l.slide)).toEqual([0, 1]);
    expect(crossing[0]!.opacity).toBe(1);
    expect(crossing[1]!.opacity).toBeGreaterThan(0);
    expect(crossing[1]!.opacity).toBeLessThan(1);
    const later = frameLayers(78 - 2, four);
    expect(later[1]!.opacity).toBeGreaterThan(crossing[1]!.opacity);
    // Well before the crossing, one slide alone.
    expect(frameLayers(30, four).map((l) => l.slide)).toEqual([0]);
  });

  it("never jumps: the incoming slide's push-in carries straight on when it takes over", () => {
    for (const handoff of [78, 156, 234]) {
      const before = frameLayers(handoff - 1, four).at(-1)!;
      const after = frameLayers(handoff, four)[0]!;
      expect(after.slide).toBe(before.slide);
      expect(after.opacity).toBe(1);
      expect(Math.abs(after.scale - before.scale)).toBeLessThan(0.002);
      expect(Math.abs(after.offsetX - before.offsetX)).toBeLessThan(0.001);
    }
  });

  it("pushes in slowly and never past its zoom, drifts alternate slides opposite ways, and never shows an edge", () => {
    for (let f = 0; f < slideshowFrames(four); f++) {
      for (const l of frameLayers(f, four)) {
        // The drift stays inside the room the push-in made, so the slide still covers the frame.
        expect(Math.abs(l.offsetX)).toBeLessThanOrEqual((l.scale - 1) / 2 + 1e-12);
        expect(Math.abs(l.offsetY)).toBeLessThanOrEqual((l.scale - 1) / 2 + 1e-12);
      }
    }
    const scales = Array.from({ length: slideshowFrames(four) }, (_, f) => frameLayers(f, four)[0]!.scale);
    expect(Math.max(...scales)).toBeLessThanOrEqual(1 + DEFAULT_SLIDESHOW.zoom + 1e-9);
    for (let f = 1; f < 78; f++) expect(scales[f]!).toBeGreaterThanOrEqual(scales[f - 1]! - 1e-12);
    const mid0 = frameLayers(70, four)[0]!;
    const mid1 = frameLayers(78 + 70, four)[0]!;
    expect(Math.sign(mid0.offsetX)).toBe(-Math.sign(mid1.offsetX));
  });

  it("loops without a seam: the last frames bring the first slide back exactly as the clip opens", () => {
    const end = frameLayers(slideshowFrames(four) - 1, four);
    expect(end.map((l) => l.slide)).toEqual([3, 0]);
    expect(end[1]!.opacity).toBe(1);
    expect(end[1]).toMatchObject({ scale: 1, offsetX: frameLayers(0, four)[0]!.offsetX, offsetY: frameLayers(0, four)[0]!.offsetY });
    // No loop, or a single slide: nothing crosses at the end.
    expect(frameLayers(slideshowFrames(four) - 1, { ...four, loop: false }).map((l) => l.slide)).toEqual([3]);
    const one = { ...four, slides: 1 };
    expect(frameLayers(slideshowFrames(one) - 1, one).map((l) => l.slide)).toEqual([0]);
  });
});
