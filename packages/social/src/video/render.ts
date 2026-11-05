import { cardLayerUrl, type CardLayer, type CardMotion, type CardMotionPiece } from "../card-parts.js";
import { DEFAULT_MOTION, groundScale, motionFrames, motionLayers, motionSeconds, pieceAt, wordsAt, type MotionLayer, type MotionSpec } from "./motion.js";
import { DEFAULT_SLIDESHOW, frameLayers, slideshowFrames, type FrameLayer, type SlideshowSpec } from "./timeline.js";

/**
 * A DRAFT'S SLIDES AS A SHORT VERTICAL VIDEO, MADE IN THE BROWSER (social 0.3).
 *
 * The 9:16 slides a TikTok, Reels or Shorts draft already has become an MP4:
 * H.264, 1080 × 1920, 30 frames a second, the moov atom first so it starts
 * playing while it loads, and no sound track. The platforms want a sound
 * picked in their own app (their sounds reach further than any file's), so
 * the person adds one there. Timing and motion come from ./timeline.ts.
 *
 * MADE ON THE DEVICE THAT POSTS IT. The browser's own encoder (WebCodecs)
 * does the work, so there's no server to pay for or wait on, and a phone can
 * make the clip and hand it straight to the app. The MP4 container comes from
 * Mediabunny (MPL-2.0, unmodified), loaded only when a clip is made.
 *
 * Browser-only: it needs fetch, createImageBitmap, a canvas and WebCodecs.
 *
 * A CARD VIDEO (social 0.5, `makeCardVideo`) moves each card's parts: the
 * route draws its ground, its words and each piece of its look as layers of
 * their own, and ./motion.ts says where each one is at each frame. The clip
 * is the cards' own size (a 4:5 post makes a 4:5 video). A card route from
 * before 0.5 has no parts, and the clip falls back to the slideshow.
 */

export interface MakeVideoOptions extends Partial<Omit<SlideshowSpec, "slides">> {
  /** The frame's size. Default 1080 × 1920 (9:16), what TikTok, Reels and Shorts show full screen. */
  readonly width?: number;
  readonly height?: number;
  /** Called after each frame with how much is done, 0 to 1. */
  readonly onProgress?: (done: number) => void;
  /** Stops the work; the promise rejects with an AbortError. */
  readonly signal?: AbortSignal;
  readonly fetcher?: typeof fetch;
}

/** The clip as made, and how long it runs. */
export interface MadeVideo {
  readonly blob: Blob;
  readonly seconds: number;
  readonly width: number;
  readonly height: number;
}

const WIDTH = 1080;
const HEIGHT = 1920;

/** Can this browser make the clip? False wherever it can't say (no WebCodecs, no H.264 encoder at this size). */
export async function canMakeVideo(width = WIDTH, height = HEIGHT): Promise<boolean> {
  if (typeof VideoEncoder === "undefined" || typeof createImageBitmap === "undefined") return false;
  try {
    const { canEncodeVideo } = await import("mediabunny");
    return await canEncodeVideo("avc", { width, height });
  } catch {
    return false;
  }
}

/** A canvas to draw frames on: offscreen where the browser has one. */
function canvasOf(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** One frame: black underneath, then each layer covering the frame, scaled and drifted, at its opacity. */
export function drawFrame(ctx: Context2D, slides: readonly ImageBitmap[], layers: readonly FrameLayer[], width: number, height: number): void {
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  for (const layer of layers) {
    const slide = slides[layer.slide];
    if (!slide) continue;
    const cover = Math.max(width / slide.width, height / slide.height) * layer.scale;
    const w = slide.width * cover;
    const h = slide.height * cover;
    ctx.globalAlpha = layer.opacity;
    ctx.drawImage(slide, (width - w) / 2 + layer.offsetX * width, (height - h) / 2 + layer.offsetY * height, w, h);
  }
  ctx.globalAlpha = 1;
}

/** H.264 encodes in 2×2 blocks of colour: an odd side is refused (Safari) or padded. */
function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/** Draws frame `f` onto the canvas. */
type DrawFrame = (ctx: Context2D, frame: number) => void;

/** Every frame, drawn and encoded: H.264 in an MP4, the moov atom first, no sound. */
async function encodeFrames(width: number, height: number, fps: number, frames: number, draw: DrawFrame, options: Pick<MakeVideoOptions, "onProgress" | "signal">): Promise<MadeVideo> {
  const stop = () => {
    if (options.signal?.aborted) throw new DOMException("The video was cancelled.", "AbortError");
  };
  stop();
  const { BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH } = await import("mediabunny");
  const canvas = canvasOf(width, height);
  const ctx = canvas.getContext("2d") as Context2D | null;
  if (!ctx) throw new Error("This browser has no canvas to draw the video on.");
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
  // A key frame every two seconds: a platform can start or trim it anywhere.
  const source = new CanvasSource(canvas, { codec: "avc", bitrate: QUALITY_HIGH, keyFrameInterval: 2 });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();
  try {
    for (let f = 0; f < frames; f++) {
      stop();
      draw(ctx, f);
      await source.add(f / fps, 1 / fps);
      options.onProgress?.((f + 1) / frames);
    }
    await output.finalize();
  } catch (error) {
    await output.cancel().catch(() => undefined);
    throw error;
  }
  const buffer = output.target.buffer;
  if (!buffer) throw new Error("The video came out empty.");
  return { blob: new Blob([buffer], { type: "video/mp4" }), seconds: frames / fps, width, height };
}

/** The slides (their image addresses, in order) as an MP4 clip. */
export async function makeSlideshowVideo(imageUrls: readonly string[], options: MakeVideoOptions = {}): Promise<MadeVideo> {
  if (!imageUrls.length) throw new Error("A video needs at least one slide.");
  const width = even(options.width ?? WIDTH);
  const height = even(options.height ?? HEIGHT);
  const spec: SlideshowSpec = {
    fps: options.fps ?? DEFAULT_SLIDESHOW.fps,
    secondsPerSlide: options.secondsPerSlide ?? DEFAULT_SLIDESHOW.secondsPerSlide,
    transitionSeconds: options.transitionSeconds ?? DEFAULT_SLIDESHOW.transitionSeconds,
    zoom: options.zoom ?? DEFAULT_SLIDESHOW.zoom,
    lastHoldSeconds: options.lastHoldSeconds ?? DEFAULT_SLIDESHOW.lastHoldSeconds,
    loop: options.loop ?? DEFAULT_SLIDESHOW.loop,
    slides: imageUrls.length,
  };
  const fetcher = options.fetcher ?? fetch;
  const stop = () => {
    if (options.signal?.aborted) throw new DOMException("The video was cancelled.", "AbortError");
  };

  const slides = await Promise.all(
    imageUrls.map(async (url, i) => {
      const res = await fetcher(url, options.signal ? { signal: options.signal } : undefined);
      if (!res.ok) throw new Error(`slide ${i + 1} didn't load (${res.status})`);
      return createImageBitmap(await res.blob());
    }),
  );
  try {
    stop();
    return await encodeFrames(width, height, spec.fps, slideshowFrames(spec), (ctx, f) => drawFrame(ctx, slides, frameLayers(f, spec), width, height), options);
  } finally {
    for (const slide of slides) slide.close();
  }
}

export interface MakeCardVideoOptions extends Partial<Omit<MotionSpec, "slides">> {
  /** Called after each frame with how much is done, 0 to 1. */
  readonly onProgress?: (done: number) => void;
  /** Stops the work; the promise rejects with an AbortError. */
  readonly signal?: AbortSignal;
  readonly fetcher?: typeof fetch;
}

/** A card as the video needs it: its signed address and its size. */
export interface VideoCard {
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

/** One slide's parts, loaded. */
interface LoadedSlide {
  readonly sheet: CardMotion;
  readonly ground: ImageBitmap;
  readonly words: ImageBitmap;
  /** Its moving pieces' pictures, by their index in the look. */
  readonly pieces: ReadonlyMap<number, ImageBitmap>;
}

/** Thrown when the card route has no parts (a route from before social 0.5): the slideshow takes over. */
class NoParts extends Error {}

/**
 * Paint sprayed out from its nozzle as far as `reach`: the piece drawn onto
 * a scratch canvas, then cut to a soft-edged circle around the nozzle.
 */
function drawSprayed(ctx: Context2D, picture: ImageBitmap, piece: CardMotionPiece, reach: number, scratch: OffscreenCanvas | HTMLCanvasElement): void {
  if (reach <= 0) return;
  if (scratch.width !== piece.width || scratch.height !== piece.height) {
    scratch.width = piece.width;
    scratch.height = piece.height;
  }
  const s = scratch.getContext("2d") as Context2D | null;
  if (!s) return;
  s.globalCompositeOperation = "source-over";
  s.clearRect(0, 0, piece.width, piece.height);
  s.drawImage(picture, 0, 0, piece.width, piece.height);
  const cx = piece.from.x - piece.left;
  const cy = piece.from.y - piece.top;
  const edge = s.createRadialGradient(cx, cy, reach * 0.62, cx, cy, reach);
  edge.addColorStop(0, "rgba(0,0,0,1)");
  edge.addColorStop(1, "rgba(0,0,0,0)");
  s.globalCompositeOperation = "destination-in";
  s.fillStyle = edge;
  s.fillRect(0, 0, piece.width, piece.height);
  s.globalCompositeOperation = "source-over";
  ctx.drawImage(scratch, piece.left, piece.top, piece.width, piece.height);
}

/** One piece at one moment, where its frame puts it. */
function drawPiece(ctx: Context2D, picture: ImageBitmap, piece: CardMotionPiece, at: ReturnType<typeof pieceAt>, scratch: OffscreenCanvas | HTMLCanvasElement): void {
  if (at.alpha <= 0 || at.scale <= 0) return;
  ctx.save();
  ctx.globalAlpha = at.alpha;
  ctx.translate(piece.x + at.dx, piece.y + at.dy);
  if (at.rotate) ctx.rotate((at.rotate * Math.PI) / 180);
  if (at.scale !== 1) ctx.scale(at.scale, at.scale);
  ctx.translate(-piece.x, -piece.y);
  if (at.reach === null) ctx.drawImage(picture, piece.left, piece.top, piece.width, piece.height);
  else drawSprayed(ctx, picture, piece, at.reach, scratch);
  ctx.restore();
}

/** One slide at one moment: the ground and its pieces pushing in, the rain over them, then the words. */
function drawSlide(ctx: Context2D, slide: LoadedSlide, layer: MotionLayer, spec: MotionSpec, width: number, height: number, scratch: OffscreenCanvas | HTMLCanvasElement): void {
  const { sheet } = slide;
  ctx.save();
  const zoom = groundScale(layer.progress, spec.zoom);
  ctx.translate(width / 2, height / 2);
  ctx.scale(zoom, zoom);
  ctx.translate(-width / 2, -height / 2);
  ctx.drawImage(slide.ground, 0, 0, width, height);
  sheet.pieces.forEach((piece, i) => {
    const picture = slide.pieces.get(piece.index);
    if (!picture || piece.enter === "rain") return;
    // Paint that stays goes by the clip's time, so every slide draws it the same; a ball pops up again on each.
    drawPiece(ctx, picture, piece, pieceAt(piece, piece.stays ? layer.clip : layer.t, i), scratch);
  });
  ctx.restore();
  // Rain falls on the clip's own clock and outside the push-in, so a cross between two cards draws it once.
  const clip = { seconds: motionSeconds(spec), height };
  sheet.pieces.forEach((piece, i) => {
    const picture = slide.pieces.get(piece.index);
    if (!picture || piece.enter !== "rain") return;
    drawPiece(ctx, picture, piece, pieceAt(piece, layer.time, i, clip), scratch);
  });
  const words = wordsAt(sheet.words, layer.t, layer.slide === 0);
  if (words.alpha <= 0) return;
  ctx.globalAlpha = words.alpha;
  ctx.drawImage(slide.words, words.dx * width, words.dy * height, width, height);
  ctx.globalAlpha = 1;
}

/**
 * The cards (a draft's pictures, in order, all one size) as an MP4 clip at
 * their own size, each card's parts moving their own way (./motion.ts). Falls
 * back to the slideshow (`makeSlideshowVideo`) where the card route has no
 * parts to give.
 */
export async function makeCardVideo(cards: readonly VideoCard[], options: MakeCardVideoOptions = {}): Promise<MadeVideo> {
  const first = cards[0];
  if (!first) throw new Error("A video needs at least one picture.");
  if (cards.some((c) => c.width !== first.width || c.height !== first.height)) throw new Error("A video's pictures must all be one size.");
  const width = even(first.width);
  const height = even(first.height);
  const spec: MotionSpec = {
    fps: options.fps ?? DEFAULT_MOTION.fps,
    secondsPerSlide: options.secondsPerSlide ?? DEFAULT_MOTION.secondsPerSlide,
    transitionSeconds: options.transitionSeconds ?? DEFAULT_MOTION.transitionSeconds,
    lastHoldSeconds: options.lastHoldSeconds ?? DEFAULT_MOTION.lastHoldSeconds,
    loop: options.loop ?? DEFAULT_MOTION.loop,
    zoom: options.zoom ?? DEFAULT_MOTION.zoom,
    slides: cards.length,
  };
  const fetcher = options.fetcher ?? fetch;
  const init = options.signal ? { signal: options.signal } : undefined;
  const opened: ImageBitmap[] = [];
  const picture = async (url: string, layer: CardLayer): Promise<ImageBitmap> => {
    const res = await fetcher(cardLayerUrl(url, layer), init);
    if (!res.ok) throw new Error(`a card's ${layer} didn't load (${res.status})`);
    const bitmap = await createImageBitmap(await res.blob());
    opened.push(bitmap);
    return bitmap;
  };

  try {
    // The motion sheets first: no sheet, no parts (a card route from before 0.5).
    const sheets = await Promise.all(
      cards.map(async (card) => {
        const res = await fetcher(cardLayerUrl(card.url, "motion"), init);
        const type = res.headers.get("content-type") ?? "";
        if (!res.ok || !type.includes("json")) throw new NoParts(`no motion sheet (${res.status})`);
        return (await res.json()) as CardMotion;
      }),
    );
    // A look's pieces are the same on every card of its size: fetch each once.
    const shared = new Map<string, Promise<Map<number, ImageBitmap>>>();
    const piecesOf = (card: VideoCard, sheet: CardMotion) => {
      const key = `${sheet.look ?? ""}:${sheet.width}x${sheet.height}`;
      let loading = shared.get(key);
      if (!loading) {
        loading = Promise.all(sheet.pieces.map(async (p) => [p.index, await picture(card.url, `piece-${p.index}`)] as const)).then((list) => new Map(list));
        shared.set(key, loading);
      }
      return loading;
    };
    const slides: LoadedSlide[] = await Promise.all(
      cards.map(async (card, i) => {
        const sheet = sheets[i]!;
        const [ground, words, pieces] = await Promise.all([picture(card.url, "ground"), picture(card.url, "words"), piecesOf(card, sheet)]);
        return { sheet, ground, words, pieces };
      }),
    );
    const next = canvasOf(width, height);
    const nextCtx = next.getContext("2d") as Context2D | null;
    const scratch = canvasOf(2, 2);
    return await encodeFrames(
      width,
      height,
      spec.fps,
      motionFrames(spec),
      (ctx, f) => {
        const [base, incoming] = motionLayers(f, spec);
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, width, height);
        if (base) drawSlide(ctx, slides[base.slide]!, base, spec, width, height, scratch);
        if (incoming && nextCtx) {
          // The incoming slide is drawn whole on its own, then laid over at its opacity, so its parts don't blend into the outgoing one's.
          nextCtx.globalAlpha = 1;
          nextCtx.clearRect(0, 0, width, height);
          drawSlide(nextCtx, slides[incoming.slide]!, incoming, spec, width, height, scratch);
          ctx.globalAlpha = incoming.opacity;
          ctx.drawImage(next, 0, 0, width, height);
          ctx.globalAlpha = 1;
        }
      },
      options,
    );
  } catch (error) {
    if (error instanceof NoParts) {
      return makeSlideshowVideo(
        cards.map((c) => c.url),
        { ...options, width, height },
      );
    }
    throw error;
  } finally {
    for (const bitmap of opened) bitmap.close();
  }
}
