import type { CardMotionPiece, CardWordsEntrance } from "../card-parts.js";

/**
 * A CARD VIDEO'S MOTION (social 0.5): the slideshow's timing (./timeline.ts)
 * with each slide drawn from its parts, the route's layers (its ground, each
 * piece of its look, its words), so the parts move on their own. Pure, so
 * the encoder (./render.ts `makeCardVideo`) only draws what this says.
 *
 * - The first slide's words are whole at the first frame, as in the
 *   slideshow: the hook reads before anything moves. Its pieces come on
 *   around it from the first moments.
 * - A later slide's words come on as it crosses in: up from a little below,
 *   in from the left, or a fade, as its look says.
 * - Each piece comes on its own way, in turn (its `delay`): a ball pops up
 *   from nothing and settles, the paint sprays out from its corner, a bit of
 *   confetti falls in spinning, or it fades in. A piece that bobs keeps
 *   moving once it's on, so the frame is never still. Paint (`stays`) comes
 *   on once, with the first slide, and stays; a ball pops up again on each.
 * - The ground (and the pieces on it) push in slowly while the words hold
 *   still, so the words stay sharp and the picture has depth.
 * - The last slide holds longer, then crosses into the first as it opens
 *   (its words whole, its pieces not yet on), so a replay has no seam. A
 *   single card loops into itself the same way.
 * - Rain (social 0.6) falls the whole clip long, behind the words, on the
 *   clip's own clock: every card draws it the same, a cross never doubles it,
 *   and each piece's fall, sway and spin repeat a whole number of times in
 *   the clip, so the replay picks it up where it left off.
 */

export interface MotionSpec {
  /** How many slides, in order. */
  readonly slides: number;
  /** Frames a second: TikTok and Instagram refuse video under 23. */
  readonly fps: number;
  /** How long each slide holds, crossing included: long enough for its pieces to come on and its line to be read. */
  readonly secondsPerSlide: number;
  /** How long two slides cross. */
  readonly transitionSeconds: number;
  /** How much longer the last slide holds, to read the call. */
  readonly lastHoldSeconds: number;
  /** Cross back into the first slide at the end, so the clip loops without a seam. */
  readonly loop: boolean;
  /** How much the ground pushes in over a slide's time: 0.04 is four percent. The words hold still. */
  readonly zoom: number;
}

export const DEFAULT_MOTION: Omit<MotionSpec, "slides"> = { fps: 30, secondsPerSlide: 3.2, transitionSeconds: 0.4, lastHoldSeconds: 1, loop: true, zoom: 0.04 };

/**
 * One slide as one frame draws it: its opacity in a cross, its seconds on
 * screen, how far through its time it is (0 to 1), the clip's seconds (what a
 * piece that stays goes by: the first slide coming back in as the clip loops
 * is at 0, as the clip opens), and the frame's own time in the clip (what
 * rain goes by, so it never stops).
 */
export interface MotionLayer {
  readonly slide: number;
  readonly opacity: number;
  readonly t: number;
  readonly progress: number;
  readonly clip: number;
  readonly time: number;
}

/** Where each slide starts and how long it's on screen, in frames. */
function spans(spec: MotionSpec): { start: number; length: number }[] {
  const per = Math.max(1, Math.round(spec.secondsPerSlide * spec.fps));
  const last = Math.max(1, Math.round((spec.secondsPerSlide + spec.lastHoldSeconds) * spec.fps));
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
export function motionFrames(spec: MotionSpec): number {
  if (spec.slides < 1) return 0;
  const s = spans(spec);
  return s[s.length - 1]!.start + s[s.length - 1]!.length;
}

/** The clip's length in seconds. */
export function motionSeconds(spec: MotionSpec): number {
  return motionFrames(spec) / spec.fps;
}

export const clamp01 = (t: number): number => Math.min(1, Math.max(0, t));
/** -0 as 0, so a settled piece reads as plainly still. */
const z = (n: number): number => n + 0;
const smooth = (t: number) => t * t * (3 - 2 * t);
const outCubic = (t: number) => 1 - (1 - t) ** 3;
/** Overshoots a little past 1 and settles back: a pop. */
const outBack = (t: number) => {
  const c1 = 2.2;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
};

/** What a frame draws, bottom layer first: one slide, or two while they cross. */
export function motionLayers(frame: number, spec: MotionSpec): MotionLayer[] {
  if (spec.slides < 1) return [];
  const s = spans(spec);
  const total = motionFrames(spec);
  const f = Math.min(Math.max(0, Math.trunc(frame)), total - 1);
  const cross = Math.max(1, Math.round(spec.transitionSeconds * spec.fps));
  // A slide is on screen from the frame it starts to cross in (the first slide: the clip's first frame).
  const shownFrom = (k: number) => (k === 0 ? 0 : s[k]!.start - cross);
  const layerOf = (k: number, at: number, opacity: number): MotionLayer => {
    const from = shownFrom(k);
    const end = s[k]!.start + s[k]!.length;
    return { slide: k, opacity, t: (at - from) / spec.fps, progress: clamp01((at - from) / Math.max(1, end - from)), clip: at / spec.fps, time: at / spec.fps };
  };
  const i = s.findIndex((span) => f >= span.start && f < span.start + span.length);
  const span = s[i]!;
  const base = layerOf(i, f, 1);
  const intoNext = span.start + span.length - f;
  const next = i + 1 < spec.slides ? i + 1 : spec.loop ? 0 : -1;
  if (next < 0 || intoNext > cross) return [base];
  const mix = smooth(clamp01(1 - (intoNext - 1) / cross));
  // Looping back, the first slide comes in exactly as the clip opens: still, its words whole, its pieces not yet on.
  const incoming = next === 0 ? { slide: 0, opacity: mix, t: 0, progress: 0, clip: 0, time: f / spec.fps } : layerOf(next, f, mix);
  return [base, incoming];
}

/** A piece's state at one frame: drawn at its place, faded, grown about its centre, moved, turned, and (paint) sprayed so far. */
export interface PieceFrame {
  /** 0 to 1, over the piece's own opacity (which its layer already has). */
  readonly alpha: number;
  /** About its centre. */
  readonly scale: number;
  /** In the card's pixels. */
  readonly dx: number;
  readonly dy: number;
  /** Degrees, about its centre, on top of its own turn. */
  readonly rotate: number;
  /** Paint: how far it has reached from its nozzle, in the card's pixels. Null: all of it shows. */
  readonly reach: number | null;
}

/** How long each entrance takes, in seconds (rain has none: it's falling from the first frame). */
export const ENTRANCE_SECONDS: Readonly<Record<CardMotionPiece["enter"], number>> = { pop: 0.55, spray: 0.9, fall: 0.9, fade: 0.5, rain: 0 };

/** The clip a piece of rain falls through: its length in seconds and the card's height. */
export interface RainClip {
  readonly seconds: number;
  readonly height: number;
}

/**
 * A piece of rain at `time` seconds into the clip: from its place on the card
 * at the first frame (so the first frame is the card as posted), falling and
 * wrapping from just below the card to just above it, swaying, and spinning
 * (or, with no spin, wobbling like a ball). Its fall, sway and spin are each
 * rounded to a whole number of times in the clip, so the clip's last frame
 * leads straight back into its first.
 */
export function rainAt(piece: CardMotionPiece, time: number, index: number, clip: RainClip): PieceFrame {
  const T = clip.seconds;
  if (!(T > 0) || !(clip.height > 0)) return { alpha: 1, scale: 1, dx: 0, dy: 0, rotate: 0, reach: null };
  // From just above the card to just below it: a piece leaves the bottom whole before it comes back in at the top.
  const span = clip.height + piece.height * 2;
  const falls = Math.max(1, Math.round(T / Math.max(0.5, piece.fall || 4)));
  const travel = ((time % T) / T) * falls * span;
  const from = piece.top + piece.height;
  const top = (((from + travel) % span) + span) % span - piece.height;
  const swings = Math.max(1, Math.round(T / 2.4));
  const phase = index * 1.7;
  const dx = z((piece.sway || 0) * Math.sin((2 * Math.PI * swings * time) / T + phase) - (piece.sway || 0) * Math.sin(phase));
  const turns = Math.round(((piece.spin || 0) * T) / 360);
  // A ball wobbles from where the card has it (and back), never far enough to turn its word over.
  const rotate = z(turns ? (360 * turns * (time % T)) / T : 10 * (Math.sin((2 * Math.PI * swings * time) / T + phase) - Math.sin(phase)));
  return { alpha: 1, scale: 1, dx, dy: z(top - piece.top), rotate, reach: null };
}

/** The farthest corner of a piece's box from its nozzle: how far its paint has to reach. */
function reachOf(piece: CardMotionPiece): number {
  const xs = [piece.left, piece.left + piece.width];
  const ys = [piece.top, piece.top + piece.height];
  let far = 0;
  for (const x of xs) for (const y of ys) far = Math.max(far, Math.hypot(x - piece.from.x, y - piece.from.y));
  return far;
}

/**
 * A piece at `t` seconds into its slide. `index` is its place in the look,
 * which sets its bob's phase (so the balls don't bob in step).
 */
export function pieceAt(piece: CardMotionPiece, t: number, index: number, clip?: RainClip): PieceFrame {
  if (piece.enter === "rain") return clip ? rainAt(piece, t, index, clip) : { alpha: 1, scale: 1, dx: 0, dy: 0, rotate: 0, reach: null };
  const seconds = ENTRANCE_SECONDS[piece.enter];
  const u = clamp01((t - piece.delay) / seconds);
  let frame: PieceFrame;
  switch (piece.enter) {
    case "pop":
      frame = { alpha: clamp01(u * 5), scale: Math.max(0, outBack(u)), dx: 0, dy: z((1 - outCubic(u)) * piece.height * 0.5), rotate: z((1 - outCubic(u)) * -14), reach: null };
      break;
    case "spray":
      frame = { alpha: clamp01(u * 3), scale: 0.96 + 0.04 * outCubic(u), dx: 0, dy: 0, rotate: 0, reach: u >= 1 ? null : outCubic(u) * reachOf(piece) * 1.08 };
      break;
    case "fall":
      frame = { alpha: u > 0 ? 1 : 0, scale: 1, dx: 0, dy: z(-(1 - outCubic(u)) * (piece.y + piece.height)), rotate: z((1 - outCubic(u)) * 200), reach: null };
      break;
    case "fade":
      frame = { alpha: smooth(u), scale: 1, dx: 0, dy: 0, rotate: 0, reach: null };
      break;
  }
  if (!piece.bob) return frame;
  // Once it's on, a gentle bob and sway, eased in so nothing jumps.
  const settled = clamp01((t - piece.delay - seconds) / 0.5);
  if (settled <= 0) return frame;
  const phase = index * 1.37;
  const amp = Math.min(10, piece.height * 0.07);
  return {
    ...frame,
    dy: frame.dy + Math.sin(Math.PI * 2 * 0.55 * t + phase) * amp * settled,
    rotate: frame.rotate + Math.sin(Math.PI * 2 * 0.4 * t + phase * 0.7) * 3 * settled,
  };
}

/** The words' state at one frame: their opacity, and how far they're still to travel, as shares of the card's width and height. */
export interface WordsFrame {
  readonly alpha: number;
  readonly dx: number;
  readonly dy: number;
}

/** When a later slide's words start coming on (as the last slide's are nearly gone), and how long they take, in seconds. */
export const WORDS_AT = { start: 0.25, seconds: 0.55 } as const;

/** A slide's words at `t` seconds into it. The first slide's are whole from the first frame. */
export function wordsAt(entrance: CardWordsEntrance, t: number, first: boolean): WordsFrame {
  if (first) return { alpha: 1, dx: 0, dy: 0 };
  const u = clamp01((t - WORDS_AT.start) / WORDS_AT.seconds);
  const left = 1 - outCubic(u);
  switch (entrance) {
    case "rise":
      return { alpha: clamp01(u * 1.6), dx: 0, dy: z(left * 0.035) };
    case "slide":
      return { alpha: clamp01(u * 1.6), dx: z(-left * 0.08), dy: 0 };
    case "fade":
      return { alpha: smooth(u), dx: 0, dy: 0 };
  }
}

/** The ground's push-in at a point in its slide's time. */
export function groundScale(progress: number, zoom: number): number {
  return 1 + zoom * smooth(clamp01(progress));
}
