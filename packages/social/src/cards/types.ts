/**
 * What a social card is made of. Plain data in, a PNG out (./render.tsx), so
 * this folder imports nothing from the app around it. The app supplies the
 * words (a spec), its look (a theme, fonts) and, if it has any, its art (data
 * URIs). With no art, the mark and the avatar are the brand's first letter on
 * its accent colour, the way create-app draws a project's icon.
 */

import type { CardEntrance, CardWordsEntrance } from "../card-parts.js";

export type { CardEntrance, CardWordsEntrance };

/** The three canvases the platforms reward (Oct 2026). */
export type CardSize = "square" | "portrait" | "story";

export const CARD_SIZES: Readonly<Record<CardSize, { readonly width: number; readonly height: number }>> = {
  /** 1:1. X, Threads, Bluesky, Telegram, Discord. */
  square: { width: 1080, height: 1080 },
  /** 4:5. LinkedIn, Instagram and Facebook feeds and carousels. */
  portrait: { width: 1080, height: 1350 },
  /** 9:16. TikTok photo mode, Instagram and Facebook Stories. */
  story: { width: 1080, height: 1920 },
};

/**
 * Where nothing important may go, per canvas, in pixels from each edge. On
 * 9:16 TikTok draws its own interface over the picture: the tabs along the
 * top ~10%, the caption and sound across the bottom ~22%, the like, comment
 * and share buttons down the right ~15%.
 */
export const SAFE_AREA: Readonly<Record<CardSize, { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number }>> = {
  square: { top: 88, right: 96, bottom: 80, left: 96 },
  portrait: { top: 88, right: 96, bottom: 84, left: 96 },
  story: { top: 216, right: 184, bottom: 448, left: 88 },
};

/** A picture for a card: a data URI (or URL) and its size, for the aspect ratio. */
export interface CardArt {
  readonly src: string;
  readonly width: number;
  readonly height: number;
}

export interface CardTheme {
  /** The ground colour, and a CSS gradient painted over it. */
  readonly ground: string;
  readonly groundImage?: string;
  readonly text: string;
  readonly muted: string;
  /** Hairlines and quiet fills. */
  readonly faint: string;
  readonly accent: string;
  /** Text on the accent. */
  readonly onAccent: string;
  /** A soft light behind a big number or a picture: a colour with alpha. None when left out. */
  readonly glow?: string;
  /** A ranked list's second and third places (first is the accent). Default: the muted and faint colours. */
  readonly silver?: string;
  readonly bronze?: string;
  /**
   * A night-sky flourish: a faint star field, sparkles and a star badge by
   * the name on a quote card. Off by default (a plain, quiet card); an app
   * whose brand is that look turns it on.
   */
  readonly flourish?: boolean;
  /** The call's button (social 0.5), and its label. Default: the accent and the text on it. */
  readonly button?: string;
  readonly onButton?: string;
}

/** Who "posted" a quote card. */
export interface CardAuthor {
  readonly name: string;
  readonly handle: string;
  /** A square picture; the card crops it round. None: the name's first letter. */
  readonly avatar?: CardArt;
}

export interface CardBrand {
  /** The wordmark beside the mark, top left of a slide. */
  readonly name: string;
  /** The address in every footer, without the scheme ("example.com"). */
  readonly site: string;
  /** The logo tile. None: the name's first letter on the accent. */
  readonly mark?: CardArt;
  /**
   * The brand's whole logo, as its site and emails show it (a wordmark or a
   * lockup, any width). When given, it is the header: a slide shows it top
   * left in place of the mark and the name, and the brand's own quote card
   * shows it in place of the avatar and the name, the handle under it. The
   * mark stays in the footers. A company's card (`brand` words) never shows it.
   */
  readonly logo?: CardArt;
}

interface CardDecorBase {
  /** Its centre, in the card's pixels (it may hang off an edge). */
  readonly x: number;
  readonly y: number;
  /** Degrees, clockwise. */
  readonly rotate?: number;
  readonly opacity?: number;
  /** In a video: how it comes on (default "fade"), and how long after its slide does, in seconds. */
  readonly enter?: CardEntrance;
  readonly delay?: number;
  /** In a video, once it's on: a gentle bob, so the frame is never still. */
  readonly bob?: boolean;
  /**
   * In a video: comes on with the first slide and stays for the rest (paint,
   * once it's sprayed). Left out, it comes on again with every slide (a ball
   * that pops up on each).
   */
  readonly stays?: boolean;
  /**
   * "rain" (social 0.6): how many seconds it takes to fall the card's height
   * (default 4), how far it sways side to side in pixels (default 0), and how
   * fast it spins in degrees a second (default 0: it wobbles instead, the way
   * a ball with a word on it should). The clip rounds each so it repeats a
   * whole number of times, and the loop has no seam.
   */
  readonly fall?: number;
  readonly sway?: number;
  readonly spin?: number;
  /** "spray": where the paint comes from, in the card's pixels (a corner, say). Default: its centre. */
  readonly from?: { readonly x: number; readonly y: number };
}

/** A picture, `width` pixels wide (its height keeps the art's shape). A colour is the art's own: tint it before. */
export interface CardDecorArt extends CardDecorBase {
  readonly kind: "art";
  readonly art: CardArt;
  readonly width: number;
}

/** A ball: a disc in a colour with a face on it, a picture (drawn over the whole disc) or a short word. */
export interface CardDecorBall extends CardDecorBase {
  readonly kind: "ball";
  /** Its diameter, in pixels. */
  readonly size: number;
  readonly color: string;
  readonly face?: CardArt;
  readonly label?: string;
  /** The word's colour. Default: the text on the accent. */
  readonly ink?: string;
}

/** A bit of confetti: `size` is its long side, in pixels. */
export interface CardDecorBit extends CardDecorBase {
  readonly kind: "bit";
  readonly shape: "rect" | "strip" | "dot";
  readonly size: number;
  readonly color: string;
}

/** One piece of a look, under the words. */
export type CardDecor = CardDecorArt | CardDecorBall | CardDecorBit;

/** The card a look is laying out its pieces for. */
export interface CardFrame {
  readonly size: CardSize;
  readonly width: number;
  readonly height: number;
}

/**
 * A LOOK (social 0.5): a card's colours and the pieces around its words,
 * named by the card's `look` (signed with its words). A look is the app's
 * own art, so a company's card (`brand` words) is drawn without one. In a
 * video each piece comes on its own way (`enter`), then the words.
 */
export interface CardLook {
  /** Colours over the app's theme. */
  readonly theme?: Partial<CardTheme>;
  /**
   * The pieces under the words, bottom first, for a card of this size: kept
   * clear of the words (the corners, the bands outside the safe area).
   * Every card of a size gets the same pieces.
   */
  readonly decor?: (frame: CardFrame) => readonly CardDecor[];
  /** A picture behind the small capitals (a brush stroke), stretched to fit them, and their colour on it. */
  readonly eyebrow?: { readonly art: CardArt; readonly color?: string };
  /** In a video, how the words come on (not the first slide's: they're whole from the first frame). Default "rise". */
  readonly words?: CardWordsEntrance;
}

/** A font file the card is drawn with (TTF, OTF or WOFF; satori can't read WOFF2). */
export interface CardFont {
  readonly name: string;
  readonly data: ArrayBuffer;
  readonly weight: 400 | 500 | 600 | 700;
  readonly style: "normal" | "italic";
}

/** Everything a card is drawn with, apart from its words. */
export interface CardAssets {
  readonly fonts: readonly CardFont[];
  /** The family the big words are set in (a display serif). */
  readonly serif: string;
  /** The family of the small words: names, labels, footers. */
  readonly sans: string;
  readonly theme: CardTheme;
  /** Who "posted" a quote card that names nobody. */
  readonly author: CardAuthor;
  /** The other authors a quote card may name, by key ("mercury"): an app with more than one character. */
  readonly authors?: Readonly<Record<string, CardAuthor>>;
  readonly brand: CardBrand;
  /** The pictures a spec can name ("mascot"), if the app has any. */
  readonly characters?: Readonly<Record<string, CardArt>>;
  /** The looks a spec can name ("confetti"), if the app has any (social 0.5). An unknown one draws the plain card. */
  readonly looks?: Readonly<Record<string, CardLook>>;
}

/**
 * WHOSE CARD THIS IS, IN THE SIGNED ADDRESS ITSELF: a company's name, the
 * address its footer shows, its handle, and its own brand colour. A card
 * with these is drawn in that company's name (its first letter for the mark
 * and the avatar, never the site's art), whatever the app's default brand
 * is. Signed with the rest of the words, so nobody can draw a card in a
 * company's name that the app didn't write.
 */
export interface CardBrandWords {
  readonly name: string;
  readonly site: string;
  /** "@greenacres"; the site's address shows when left out. */
  readonly handle?: string;
  /** "#rrggbb": the accent (the big numbers, the button, the mark). */
  readonly accent?: string;
  /** "#rrggbb": text on the accent. */
  readonly onAccent?: string;
}

/** "2 of 5", on a carousel's slides. */
export interface CardPage {
  readonly index: number;
  readonly count: number;
}

interface CardBase {
  readonly size: CardSize;
  readonly page?: CardPage;
  readonly brand?: CardBrandWords;
  /** Which of the app's looks it wears (social 0.5): a key in the assets' looks. */
  readonly look?: string;
}

/** The post-screenshot card: avatar, name, handle, the words. */
export interface QuoteCardSpec extends CardBase {
  readonly kind: "quote";
  readonly text: string;
  /** A date after the handle ("Oct 27"), as a post shows when it was written. */
  readonly date?: string;
  /** Who posted it: a key in the assets' authors. Left out, or unknown: the assets' own author. */
  readonly author?: string;
}

/** A carousel's first slide (or a slide of words): the hook, a picture, "Swipe". */
export interface CoverCardSpec extends CardBase {
  readonly kind: "cover";
  readonly text: string;
  /** The small capitals above the words ("NEW · OCT 26"). */
  readonly eyebrow?: string;
  readonly character?: string;
  /** Who's speaking, in small words under the hook ("— Mercury"). */
  readonly byline?: string;
  /** The swipe cue's word; "Swipe" when left out. */
  readonly cue?: string;
}

/** One big number and one plain line under it. */
export interface StatCardSpec extends CardBase {
  readonly kind: "stat";
  readonly value: string;
  readonly text: string;
  readonly eyebrow?: string;
  /** Small print at the foot: a source, a date. */
  readonly note?: string;
}

export interface CardRow {
  readonly label: string;
  readonly detail?: string;
  readonly value?: string;
}

/** Up to five short rows under a title. */
export interface ListCardSpec extends CardBase {
  readonly kind: "list";
  readonly text: string;
  readonly eyebrow?: string;
  readonly rows: readonly CardRow[];
  /** A podium: each row gets its place (1, 2, 3...) in a medal. */
  readonly ranked?: boolean;
  readonly note?: string;
}

/** The last slide: the address, the one thing to do. */
export interface CtaCardSpec extends CardBase {
  readonly kind: "cta";
  /** The button's words ("See what's new"). */
  readonly text: string;
  readonly eyebrow?: string;
  readonly character?: string;
  readonly note?: string;
}

export type CardSpec = QuoteCardSpec | CoverCardSpec | StatCardSpec | ListCardSpec | CtaCardSpec;
export type CardKind = CardSpec["kind"];

/** The most rows a list slide draws. */
export const MAX_LIST_ROWS = 5;

/** Who a card shows as its poster: the spec's author where the assets have one by that key, else their own. */
export function cardAuthor(spec: CardSpec, assets: Pick<CardAssets, "author" | "authors">): CardAuthor {
  return (spec.kind === "quote" && spec.author ? assets.authors?.[spec.author] : undefined) ?? assets.author;
}

/**
 * The brand's whole logo, when this card shows it: any slide of a brand that
 * has one, and a quote card the brand itself posted (one a named author
 * posted keeps that author's avatar and name).
 */
export function cardLogo(spec: CardSpec, assets: Pick<CardAssets, "author" | "authors" | "brand">): CardArt | undefined {
  const logo = assets.brand.logo;
  if (!logo) return undefined;
  return spec.kind === "quote" && cardAuthor(spec, assets) !== assets.author ? undefined : logo;
}

/** The picture a cover or a call-to-action slide names, if the assets have it. */
export function cardCharacter(spec: CardSpec, assets: Pick<CardAssets, "characters">): CardArt | undefined {
  return (spec.kind === "cover" || spec.kind === "cta") && spec.character ? assets.characters?.[spec.character] : undefined;
}
