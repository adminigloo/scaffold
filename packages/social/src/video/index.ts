/**
 * @adminigloo/social/video — a draft's 9:16 slides as a short MP4, made in
 * the browser (social 0.3): the timing (./timeline.ts) and the encoder
 * (./render.ts). Since 0.5 a draft's cards at their own size, each card's
 * parts moving their own way (./motion.ts, `makeCardVideo`). Browser-only.
 * The posts screen's "Make a video" uses it; an app can call it for its own
 * screens.
 */
export { DEFAULT_SLIDESHOW, frameLayers, slideshowFrames, slideshowSeconds, type FrameLayer, type SlideshowSpec } from "./timeline.js";
export { canMakeVideo, drawFrame, makeCardVideo, makeSlideshowVideo, type MadeVideo, type MakeCardVideoOptions, type MakeVideoOptions, type VideoCard } from "./render.js";
export { DEFAULT_MOTION, ENTRANCE_SECONDS, groundScale, motionFrames, motionLayers, motionSeconds, pieceAt, wordsAt, WORDS_AT, type MotionLayer, type MotionSpec, type PieceFrame, type WordsFrame } from "./motion.js";
