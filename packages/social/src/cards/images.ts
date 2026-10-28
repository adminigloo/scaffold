import type { DraftImage } from "../types.js";
import { clip } from "./carousels.js";
import { cardParams, signCardParams } from "./params.js";
import { CARD_SIZES, type CardBrandWords, type CardSpec } from "./types.js";

/**
 * A CARD AS A DRAFT'S IMAGE: its signed, absolute address (the platform
 * fetches it from there), what it shows in words (alt text, which Bluesky
 * asks for), and its pixel size. Built once, when the draft is written, and
 * stored as built.
 */

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * A company's brand words, made safe for a card's address: each cut to what
 * the card route accepts (a name of 60 characters, an address of 80, a handle
 * of 40) and a colour kept only when it is "#rrggbb".
 */
export function cardBrand(input: { readonly name: string; readonly site: string; readonly handle?: string | null; readonly accent?: string | null; readonly onAccent?: string | null }): CardBrandWords {
  const name = clip(input.name, 60) || "•";
  const site = clip(input.site.replace(/^https?:\/\//, "").replace(/\/+$/, ""), 80) || name;
  const handle = input.handle ? clip(input.handle, 40) : "";
  return {
    name,
    site,
    ...(handle ? { handle } : {}),
    ...(input.accent && HEX.test(input.accent) ? { accent: input.accent.toLowerCase() } : {}),
    ...(input.onAccent && HEX.test(input.onAccent) ? { onAccent: input.onAccent.toLowerCase() } : {}),
  };
}

/** Whose card it is, in words, when the spec doesn't say: the app's own brand. */
export interface CardByline {
  readonly name: string;
  readonly handle: string;
  readonly site: string;
}

/** What a screen reader says for a card: the same words, in order. */
export function cardAlt(spec: CardSpec, byline: CardByline): string {
  const who = spec.brand ? { name: spec.brand.name, handle: spec.brand.handle ?? spec.brand.site, site: spec.brand.site } : byline;
  const lead = (eyebrow: string | undefined) => (eyebrow ? `${eyebrow}: ` : "");
  switch (spec.kind) {
    case "quote":
      return `${who.name} (${who.handle}): ${spec.text}`;
    case "cover":
      return `${lead(spec.eyebrow)}${spec.text}`;
    case "stat":
      return `${lead(spec.eyebrow)}${spec.value}. ${spec.text}${spec.note ? ` ${spec.note}` : ""}`;
    case "list":
      return `${lead(spec.eyebrow)}${spec.text}. ${spec.rows.map((r, i) => [spec.ranked ? `${i + 1}. ${r.label}` : r.label, r.detail, r.value].filter(Boolean).join(", ")).join("; ")}.${spec.note ? ` ${spec.note}` : ""}`;
    case "cta":
      return `${who.site}. ${spec.text}.`;
  }
}

export interface CardSigning {
  /** Where the card route is, absolute or a path: "https://example.com/api/social/card". */
  readonly base: string;
  /** The key the route checks (the app's, never shipped to a browser). */
  readonly secret: string;
  /** The app's own brand, for the alt text of a card that carries none. */
  readonly byline: CardByline;
}

/** The card's signed address. */
export function signedCardUrl(spec: CardSpec, signing: Pick<CardSigning, "base" | "secret">): string {
  return `${signing.base}?${signCardParams(cardParams(spec), signing.secret).toString()}`;
}

/** A card as a draft keeps it: the signed address, the alt text, the size. */
export function cardImage(spec: CardSpec, signing: CardSigning): DraftImage {
  return { url: signedCardUrl(spec, signing), alt: cardAlt(spec, signing.byline), ...CARD_SIZES[spec.size] };
}
