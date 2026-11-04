/**
 * A SLIDESHOW CLIP'S TIMING (social 0.3): which slides are on screen at each
 * frame, how far each has zoomed and drifted, and how they cross. Pure, so
 * the encoder (./render.ts) only draws what this says.
 *
 * Built to how short vertical video is watched:
 *
 * - The first slide (the hook) is on screen, whole, at the first frame: no
 *   fade in, nothing to wait for.
 * - Each slide holds for about two and a half seconds, long enough to read
 *   its line, with a slow push-in (a few percent) and a small drift, so the
 *   picture is never still.
 * - Slides cross in a short fade, not a cut.
 * - The last slide (the call) holds a little longer, then crosses back into
 *   the first, so the clip loops without a seam (a platform replays it).
 */

export interface SlideshowSpec {
  /** How many slides, in order. */
  readonly slides: number;
  /** Frames a second: TikTok and Instagram refuse video under 23. */
  readonly fps: number;
  /** How long each slide holds, crossing included. */
  readonly secondsPerSlide: number;
  /** How long two slides cross. */
  readonly transitionSeconds: number;
  /** How much a slide pushes in over its time: 0.06 is six percent. */
  readonly zoom: number;
  /** How much longer the last slide holds, to read the call. */
  readonly lastHoldSeconds: number;
  /** Cross back into the first slide at the end, so the clip loops without a seam. */
  readonly loop: boolean;
}

export const DEFAULT_SLIDESHOW: Omit<SlideshowSpec, "slides"> = { fps: 30, secondsPerSlide: 2.6, transitionSeconds: 0.4, zoom: 0.06, lastHoldSeconds: 0.8, loop: true };

/** One slide as one frame draws it: its opacity, its scale and its drift (a share of the frame, from the centre). */
export interface FrameLayer {
  readonly slide: number;
  readonly opacity: number;
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

/** Where each slide starts and how long it's on screen, in frames. */
function spans(spec: SlideshowSpec): { start: number; length: number }[] {
  const per = Math.round(spec.secondsPerSlide * spec.fps);
  const last = Math.round((spec.secondsPerSlide + spec.lastHoldSeconds) * spec.fps);
  const out: { start: number; length: number }[] = [];
  let at = 0;
  for (let i = 0; i < spec.slides; i++) {
    const length = i === spec.slides - 1 ? last : per;
    out.push({ start: at, length });
    at += length;
  }
  return out;
}

/** The clip's length in frames. */
export function slideshowFrames(spec: SlideshowSpec): number {
  if (spec.slides < 1) return 0;
  const s = spans(spec);
  return s[s.length - 1]!.start + s[s.length - 1]!.length;
}

/** The clip's length in seconds. */
export function slideshowSeconds(spec: SlideshowSpec): number {
  return slideshowFrames(spec) / spec.fps;
}

const ease = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/**
 * A slide's push-in and drift at a point in its time (0 to 1): alternate
 * slides drift opposite ways. The drift only ever uses the room the push-in
 * has made (a share of it), so the picture always covers the frame: no edge
 * of black, and still and centred at the start.
 */
function motion(slide: number, t: number, zoom: number): Omit<FrameLayer, "slide" | "opacity"> {
  const p = ease(clamp01(t));
  const scale = 1 + zoom * p;
  const room = (scale - 1) / 2;
  const dir = slide % 2 === 0 ? 1 : -1;
  return { scale, offsetX: dir * room * 0.8, offsetY: -dir * room * 0.5 };
}

/** What a frame draws, bottom layer first: one slide, or two while they cross. */
export function frameLayers(frame: number, spec: SlideshowSpec): FrameLayer[] {
  if (spec.slides < 1) return [];
  const s = spans(spec);
  const total = slideshowFrames(spec);
  const f = Math.min(Math.max(0, Math.trunc(frame)), total - 1);
  const cross = Math.max(1, Math.round(spec.transitionSeconds * spec.fps));
  // A slide moves from the frame it starts to fade in (the first slide: the clip's first frame) until the
  // next one has covered it, so its push-in never jumps when it takes over from the one before.
  const shownFrom = (k: number) => (k === 0 ? 0 : s[k]!.start - cross);
  const timeOf = (k: number, at: number) => (at - shownFrom(k)) / (s[k]!.start + s[k]!.length - shownFrom(k));
  const i = s.findIndex((span) => f >= span.start && f < span.start + span.length);
  const span = s[i]!;
  const base: FrameLayer = { slide: i, opacity: 1, ...motion(i, timeOf(i, f), spec.zoom) };
  const intoNext = span.start + span.length - f;
  const next = i + 1 < spec.slides ? i + 1 : spec.loop && spec.slides > 1 ? 0 : -1;
  if (next < 0 || intoNext > cross) return [base];
  // The next slide fades in over the end of this one. Looping back, the first comes in exactly as the clip
  // opens (still, at its first frame), so the replay has no seam.
  const mix = ease(clamp01(1 - (intoNext - 1) / cross));
  const nextMotion = next === 0 ? motion(0, 0, spec.zoom) : motion(next, timeOf(next, f), spec.zoom);
  return [base, { slide: next, opacity: mix, ...nextMotion }];
}
