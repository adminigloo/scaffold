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

/** The slides (their image addresses, in order) as an MP4 clip. */
export async function makeSlideshowVideo(imageUrls: readonly string[], options: MakeVideoOptions = {}): Promise<MadeVideo> {
  if (!imageUrls.length) throw new Error("A video needs at least one slide.");
  const width = options.width ?? WIDTH;
  const height = options.height ?? HEIGHT;
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
    const { BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH } = await import("mediabunny");
    const canvas = canvasOf(width, height);
    const ctx = canvas.getContext("2d") as Context2D | null;
    if (!ctx) throw new Error("This browser has no canvas to draw the video on.");
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
    // A key frame every two seconds: a platform can start or trim it anywhere.
    const source = new CanvasSource(canvas, { codec: "avc", bitrate: QUALITY_HIGH, keyFrameInterval: 2 });
    output.addVideoTrack(source, { frameRate: spec.fps });
    await output.start();
    const frames = slideshowFrames(spec);
    try {
      for (let f = 0; f < frames; f++) {
        stop();
        drawFrame(ctx, slides, frameLayers(f, spec), width, height);
        await source.add(f / spec.fps, 1 / spec.fps);
        options.onProgress?.((f + 1) / frames);
      }
      await output.finalize();
    } catch (error) {
      await output.cancel().catch(() => undefined);
      throw error;
    }
    const buffer = output.target.buffer;
    if (!buffer) throw new Error("The video came out empty.");
    return { blob: new Blob([buffer], { type: "video/mp4" }), seconds: frames / spec.fps, width, height };
  } finally {
    for (const slide of slides) slide.close();
  }
}
