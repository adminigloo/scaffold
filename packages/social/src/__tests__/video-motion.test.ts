import { describe, expect, it } from "vitest";
import type { CardMotionPiece } from "../card-parts.js";
import { DEFAULT_MOTION, ENTRANCE_SECONDS, groundScale, motionFrames, motionLayers, motionSeconds, pieceAt, rainAt, wordsAt, WORDS_AT, type MotionSpec } from "../video/motion.js";

/**
 * A CARD VIDEO'S MOTION (../video/motion.ts, social 0.5): the hook whole at
 * the first frame with its pieces still to come; each piece on its own way
 * and in turn; a later card's words coming on as it crosses in; paint that
 * sprays once and stays; and a loop with no seam, a single card included.
 */
const three: MotionSpec = { ...DEFAULT_MOTION, slides: 3 };
const PER = Math.round(DEFAULT_MOTION.secondsPerSlide * DEFAULT_MOTION.fps);
const LAST = Math.round((DEFAULT_MOTION.secondsPerSlide + DEFAULT_MOTION.lastHoldSeconds) * DEFAULT_MOTION.fps);

function piece(over: Partial<CardMotionPiece> = {}): CardMotionPiece {
  return { index: 0, left: 966, top: 6, width: 108, height: 108, x: 1020, y: 60, from: { x: 1020, y: 60 }, enter: "pop", delay: 0.1, bob: false, stays: false, fall: 0, sway: 0, spin: 0, ...over };
}
/** The piece at many moments through its entrance. */
const through = (p: CardMotionPiece, steps = 40) => Array.from({ length: steps + 1 }, (_, i) => pieceAt(p, p.delay + (ENTRANCE_SECONDS[p.enter] * i) / steps, 0));

describe("a card video's motion", () => {
  it("runs about ten and a half seconds for three cards: 3.2 s each, the call held a second longer", () => {
    expect(motionFrames(three)).toBe(2 * PER + LAST);
    expect(motionSeconds(three)).toBeCloseTo(10.6, 5);
    expect(motionFrames({ ...three, slides: 0 })).toBe(0);
    expect(motionLayers(0, { ...three, slides: 0 })).toEqual([]);
  });

  it("opens on the hook, whole and still, with its pieces still to come", () => {
    expect(motionLayers(0, three)).toEqual([{ slide: 0, opacity: 1, t: 0, progress: 0, clip: 0, time: 0 }]);
    expect(wordsAt("rise", 0, true)).toEqual({ alpha: 1, dx: 0, dy: 0 });
    expect(groundScale(0, three.zoom)).toBe(1);
    expect(pieceAt(piece({ enter: "pop" }), 0, 0).alpha).toBe(0);
    expect(pieceAt(piece({ enter: "spray", delay: 0.05 }), 0, 0)).toMatchObject({ alpha: 0, reach: 0 });
    expect(pieceAt(piece({ enter: "fade" }), 0, 0).alpha).toBe(0);
  });

  it("pops a ball up past its size and settles it where the card has it", () => {
    const frames = through(piece({ enter: "pop" }));
    expect(Math.max(...frames.map((f) => f.scale))).toBeGreaterThan(1.05);
    expect(frames[0]!.dy).toBeGreaterThan(0);
    expect(frames.at(-1)).toEqual({ alpha: 1, scale: 1, dx: 0, dy: 0, rotate: 0, reach: null });
  });

  it("sprays paint out from its nozzle until all of it shows", () => {
    const frames = through(piece({ enter: "spray", from: { x: 1080, y: 0 } }));
    const reaches = frames.slice(0, -1).map((f) => f.reach ?? Infinity);
    for (let i = 1; i < reaches.length; i++) expect(reaches[i]!).toBeGreaterThanOrEqual(reaches[i - 1]!);
    expect(frames.at(-1)?.reach).toBeNull();
    expect(frames.at(-1)?.alpha).toBe(1);
  });

  it("drops a bit of confetti in from above the card, spinning, and lands it", () => {
    const frames = through(piece({ enter: "fall" }));
    expect(frames[0]!.dy).toBeLessThan(-60);
    expect(frames[0]!.rotate).toBeGreaterThan(90);
    expect(frames.at(-1)).toMatchObject({ dy: 0, rotate: 0, alpha: 1 });
  });

  it("bobs a piece once it's on, easing the bob in so nothing jumps", () => {
    const bobbing = piece({ enter: "pop", bob: true });
    const on = bobbing.delay + ENTRANCE_SECONDS.pop;
    expect(pieceAt(bobbing, on, 0).dy).toBe(0);
    const later = Array.from({ length: 60 }, (_, i) => pieceAt(bobbing, on + 1 + i / 30, 0).dy);
    expect(Math.max(...later) - Math.min(...later)).toBeGreaterThan(2);
    expect(Math.max(...later.map(Math.abs))).toBeLessThanOrEqual(Math.min(10, bobbing.height * 0.07) + 1e-9);
    // Two balls don't bob in step.
    expect(pieceAt(bobbing, on + 1.3, 0).dy).not.toBeCloseTo(pieceAt(bobbing, on + 1.3, 1).dy, 3);
  });

  it("brings a later card's words on as it crosses in: up from below, in from the left, or a fade", () => {
    expect(wordsAt("rise", 0, false)).toEqual({ alpha: 0, dx: 0, dy: 0.035 });
    expect(wordsAt("slide", WORDS_AT.start + WORDS_AT.seconds / 2, false).dx).toBeLessThan(0);
    expect(wordsAt("fade", WORDS_AT.start + WORDS_AT.seconds / 2, false)).toMatchObject({ dx: 0, dy: 0 });
    for (const entrance of ["rise", "slide", "fade"] as const) expect(wordsAt(entrance, WORDS_AT.start + WORDS_AT.seconds, false)).toEqual({ alpha: 1, dx: 0, dy: 0 });
  });

  it("crosses each card into the next over its last frames, and keeps paint that stays on the clip's time", () => {
    const cross = Math.round(three.transitionSeconds * three.fps);
    const [out, incoming] = motionLayers(PER - 3, three);
    expect([out?.slide, incoming?.slide]).toEqual([0, 1]);
    expect(out!.opacity).toBe(1);
    expect(incoming!.opacity).toBeGreaterThan(0);
    expect(incoming!.opacity).toBeLessThan(1);
    // The next card has been on screen since its cross began; the clip's time is the same for both.
    expect(incoming!.t).toBeCloseTo((PER - 3 - (PER - cross)) / three.fps, 9);
    expect(incoming!.clip).toBe(out!.clip);
    const paint = piece({ enter: "spray", stays: true });
    expect(pieceAt(paint, incoming!.clip, 0)).toEqual(pieceAt(paint, out!.clip, 0));
  });

  it("loops the first card back in exactly as the clip opens, a single card into itself", () => {
    const total = motionFrames(three);
    const [last, first] = motionLayers(total - 1, three);
    expect(last?.slide).toBe(2);
    expect(first).toMatchObject({ slide: 0, t: 0, progress: 0, clip: 0 });
    expect(first!.opacity).toBeGreaterThan(0.9);
    const one: MotionSpec = { ...three, slides: 1 };
    expect(motionLayers(motionFrames(one) - 1, one).map((l) => [l.slide, l.t])).toEqual([
      [0, (motionFrames(one) - 1) / one.fps],
      [0, 0],
    ]);
    expect(motionLayers(total - 1, { ...three, loop: false }).map((l) => l.slide)).toEqual([2]);
  });

  it("rains a piece the whole clip long from where the card has it, behind the words, and picks the replay up where it left off", () => {
    const clip = { seconds: motionSeconds(three), height: 1920 };
    const drop = piece({ enter: "rain", left: 500, top: 700, width: 40, height: 40, x: 520, y: 720, fall: 4, sway: 24, spin: 200 });
    // The first frame is the card as posted.
    expect(rainAt(drop, 0, 3, clip)).toEqual({ alpha: 1, scale: 1, dx: 0, dy: 0, rotate: 0, reach: null });
    // It falls, comes back in at the top, and spins.
    const path = Array.from({ length: 60 }, (_, i) => rainAt(drop, (clip.seconds * i) / 60, 3, clip));
    expect(path.some((f) => f.dy > 0)).toBe(true);
    expect(path.some((f) => 700 + f.dy < 0)).toBe(true);
    expect(new Set(path.map((f) => Math.round(f.rotate))).size).toBeGreaterThan(20);
    // Its last moment leads straight back into its first: the clip loops with no seam.
    const end = rainAt(drop, clip.seconds - 1e-6, 3, clip);
    expect(end.dy).toBeCloseTo(0, 2);
    expect(end.dx).toBeCloseTo(0, 2);
    expect(((end.rotate % 360) + 360) % 360 > 359 || Math.abs(end.rotate % 360) < 1).toBe(true);
    // A ball doesn't spin: it wobbles, never far enough to turn its word over.
    const ball = piece({ enter: "rain", left: 300, top: 300, x: 354, y: 354, fall: 5, sway: 10, spin: 0 });
    expect(Math.max(...Array.from({ length: 90 }, (_, i) => Math.abs(rainAt(ball, (clip.seconds * i) / 90, 1, clip).rotate)))).toBeLessThanOrEqual(20);
    // Every card draws it on the clip's own clock: the loop's incoming first card included.
    const [last, first] = motionLayers(motionFrames(three) - 2, three);
    expect(first!.clip).toBe(0);
    expect(first!.time).toBe(last!.time);
    // Without the clip, rain stands still where the card has it.
    expect(pieceAt(drop, 2, 0)).toEqual({ alpha: 1, scale: 1, dx: 0, dy: 0, rotate: 0, reach: null });
    expect(pieceAt(drop, 2, 0, clip)).toEqual(rainAt(drop, 2, 0, clip));
  });

  it("pushes the ground in slowly over each card's time", () => {
    expect(groundScale(1, three.zoom)).toBeCloseTo(1 + three.zoom, 9);
    expect(groundScale(0.5, three.zoom)).toBeGreaterThan(1);
    expect(groundScale(0.5, three.zoom)).toBeLessThan(1 + three.zoom);
  });
});
