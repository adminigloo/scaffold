/**
 * @adminigloo/social/cards — SOCIAL CARDS: the images that go with a post,
 * in the shapes each platform rewards (Oct 2026). A quote card (a post's
 * screenshot: the mark, the name, the handle, the words in a big serif; or
 * the brand's whole logo and the handle, when it has one) at
 * 1:1 and 4:5, and carousel slides (cover, one big number, a short list, the
 * call) at 4:5 and 9:16, the 9:16 ones inside TikTok's safe zone. A card
 * may wear one of the app's looks (social 0.5): its colours and the pieces
 * around its words, which a video brings on one by one (the route's layers).
 *
 * Server-side (it signs with node:crypto). Nothing here imports the app
 * around it: the app passes the words (a CardSpec), its look and any art
 * (CardAssets), a key to sign addresses with, and the painter (next/og's
 * ImageResponse in a Next.js app). The fonts are their own entry
 * (@adminigloo/social/fonts), for the card route alone.
 */
export * from "./types.js";
export { renderCard, cardLayout, cardMetrics, cardMotion, cardSize, brandedAssets, drawnAssets, createCardRoute, CARD_CACHE_CONTROL, type CardPainter, type CardPicturePart, type CardRouteOptions } from "./render.js";
export { CARD_FONT_FILES, CARD_SANS, CARD_SERIF, loadCardFonts } from "./font-files.js";
export { cardParams, canonicalCardQuery, parseCardParams, signCardParams, verifyCardParams } from "./params.js";
export { cardLayerUrl, isCardLayer, splitCardLayer, type CardLayer, type CardMotion, type CardMotionPiece } from "../card-parts.js";
export { bitSize, cardDecor, cardLook, decorBox, decorSize, entranceOf, lookedAssets } from "./looks.js";
export { fitLine, fitText, parseFontMetrics, textWidth, wrapLines, FIT_SLACK, type FitBox, type Fitted, type FontMetrics } from "./metrics.js";
export { layoutCard, frameOf, slideBody, logoSize, LOGO, type CardLayout, type CardMetrics, type LineBlock, type TextBlock, type SlideChrome } from "./layout.js";
export { ASPECT_CARD_SIZE, clip, draftCards, launchCarousel, paged, quoteCard, releaseCarousel, storyCarousel, type LaunchCarouselInput, type ReleaseCarouselInput, type StoryCarouselInput } from "./carousels.js";
export { cardAlt, cardBrand, cardImage, signedCardUrl, type CardByline, type CardSigning } from "./images.js";
export { cardFormatSets, sampleCardSets, type CardFormatImage, type CardFormatSet, type CardSampleLook, type CardSampleSet } from "./samples.js";
export { initialOf } from "./elements.js";
