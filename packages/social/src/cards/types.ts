/**
 * What a social card is made of. Plain data in, a PNG out (./render.tsx), so
 * this folder imports nothing from the app around it. The app supplies the
 * words (a spec), its look (a theme, fonts) and, if it has any, its art (data
 * URIs). With no art, the mark and the avatar are the brand's first letter on
 * its accent colour, the way create-app draws a project's icon.
 */

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
  readonly author: CardAuthor;
  readonly brand: CardBrand;
  /** The pictures a spec can name ("mascot"), if the app has any. */
  readonly characters?: Readonly<Record<string, CardArt>>;
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
}

/** The post-screenshot card: avatar, name, handle, the words. */
export interface QuoteCardSpec extends CardBase {
  readonly kind: "quote";
  readonly text: string;
  /** A date after the handle ("Oct 27"), as a post shows when it was written. */
  readonly date?: string;
}

/** A carousel's first slide (or a slide of words): the hook, a picture, "Swipe". */
export interface CoverCardSpec extends CardBase {
  readonly kind: "cover";
  readonly text: string;
  /** The small capitals above the words ("NEW · OCT 26"). */
  readonly eyebrow?: string;
  readonly character?: string;
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
