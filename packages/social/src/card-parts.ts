/**
 * A CARD'S PARTS (social 0.5): what a video made in the browser asks the card
 * route for, so it can move a card's pieces on their own. Plain TypeScript,
 * safe in a browser (no node:crypto): the card renderer (./cards) draws the
 * parts, the video (./video) asks for them.
 *
 *   ground      the card's ground alone, with any piece that doesn't move
 *   words       its words (and its header, footer and button) on nothing
 *   piece-N     one piece of its look, alone in that piece's own box
 *   motion      the motion sheet: each moving piece's box and entrance, as JSON
 */

/**
 * How a piece of a look comes on in a video: it pops up from nothing and
 * settles, the paint sprays out from its corner, it falls in from above, it
 * fades in, or it's simply there.
 */
export type CardEntrance = "pop" | "spray" | "fall" | "fade" | "none";

/** How a slide's words come on in a video: up from a little below, in from the left, or a fade. */
export type CardWordsEntrance = "rise" | "slide" | "fade";

/**
 * WHICH PART OF A CARD TO DRAW, for a video that moves its
 * parts: its ground alone, its words alone (on nothing), one piece of its
 * look, or the motion sheet (the pieces' places and how each comes on, as
 * JSON). Never signed: it only ever draws less of the signed card, never
 * different words.
 */
export type CardLayer = "ground" | "words" | "motion" | `piece-${number}`;

const LAYER = /^(?:ground|words|motion|piece-(?:0|[1-9]\d{0,2}))$/;

/** Is this a part of a card the route can draw? */
export function isCardLayer(value: string): value is CardLayer {
  return LAYER.test(value);
}

/** A card's address for one of its parts: its signed address with `layer` added. */
export function cardLayerUrl(url: string, layer: CardLayer): string {
  const at = url.indexOf("?");
  const params = new URLSearchParams(at < 0 ? "" : url.slice(at + 1));
  params.delete("layer");
  params.set("layer", layer);
  return `${at < 0 ? url : url.slice(0, at)}?${params.toString()}`;
}

/**
 * The parameters the signature covers, and the part asked for: `layer` comes
 * off before the signature is checked. A layer that repeats, or isn't one,
 * is an error.
 */
export function splitCardLayer(params: URLSearchParams): { ok: true; params: URLSearchParams; layer: CardLayer | null } | { ok: false; error: string } {
  const layers = params.getAll("layer");
  if (!layers.length) return { ok: true, params, layer: null };
  if (layers.length > 1) return { ok: false, error: "layer: only one part at a time" };
  const layer = layers[0]!;
  if (!isCardLayer(layer)) return { ok: false, error: `layer: no part called "${layer}"` };
  const signed = new URLSearchParams(params);
  signed.delete("layer");
  return { ok: true, params: signed, layer };
}

/** One piece that moves in a video, as the motion sheet gives it: its layer is `piece-${index}`, drawn at its box. */
export interface CardMotionPiece {
  readonly index: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** Its centre, where it pops up from. */
  readonly x: number;
  readonly y: number;
  /** Where its paint sprays from. */
  readonly from: { readonly x: number; readonly y: number };
  readonly enter: Exclude<CardEntrance, "none">;
  readonly delay: number;
  readonly bob: boolean;
  /** Comes on with the first slide and stays (paint), or again with every slide. */
  readonly stays: boolean;
}

/**
 * THE MOTION SHEET (social 0.5): what a video needs to move a card's parts.
 * The card's size, how its words come on, and each moving piece's box and
 * entrance. The ground (with any piece that doesn't move), the words, and
 * each piece are the route's layers.
 */
export interface CardMotion {
  readonly width: number;
  readonly height: number;
  /** The look it wears, or null for a plain card. */
  readonly look: string | null;
  readonly words: CardWordsEntrance;
  readonly pieces: readonly CardMotionPiece[];
}
