import type { CardFont } from "./types.js";

/**
 * THE CARDS' TYPE: DM Serif Display for the big words (a display serif with
 * real weight, and lining figures, so "71°" and "$45" read as numbers) and
 * Inter for the small ones. Both are SIL Open Font License. Each file is
 * Google Fonts' static instance cut to Latin (ASCII, Latin-1, Latin
 * Extended-A and the punctuation posts use: °, ¢, curly quotes, dashes,
 * arrows), about 60 KB apiece, in the package's fonts/ folder.
 *
 * No file I/O here: the card route reads the bytes through `cardFonts()`
 * (@adminigloo/social/fonts, embedded), and `loadCardFonts(dir)`
 * (./font-files.ts) reads the same names from a folder of the app's own.
 */
export const CARD_FONT_FILES: readonly { readonly file: string; readonly name: string; readonly weight: CardFont["weight"]; readonly style: CardFont["style"] }[] = [
  { file: "dm-serif-display-400.ttf", name: "DM Serif Display", weight: 400, style: "normal" },
  { file: "inter-500.ttf", name: "Inter", weight: 500, style: "normal" },
  { file: "inter-600.ttf", name: "Inter", weight: 600, style: "normal" },
  { file: "inter-700.ttf", name: "Inter", weight: 700, style: "normal" },
];

export const CARD_SERIF = "DM Serif Display";
export const CARD_SANS = "Inter";
