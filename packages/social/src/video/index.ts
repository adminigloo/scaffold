/**
 * @adminigloo/social/video — a draft's 9:16 slides as a short MP4, made in
 * the browser (social 0.3): the timing (./timeline.ts) and the encoder
 * (./render.ts). Browser-only. The posts screen's "Make a video" uses it; an
 * app can call it for its own screens.
 */
export { DEFAULT_SLIDESHOW, frameLayers, slideshowFrames, slideshowSeconds, type FrameLayer, type SlideshowSpec } from "./timeline.js";
export { canMakeVideo, drawFrame, makeSlideshowVideo, type MadeVideo, type MakeVideoOptions } from "./render.js";
