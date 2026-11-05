import type { CardMotion, CardMotionPiece } from "../card-parts.js";
import { CARD_SIZES, type CardAssets, type CardDecor, type CardDecorBit, type CardEntrance, type CardLook, type CardSpec } from "./types.js";

/**
 * A CARD'S LOOK (social 0.5): the app's colours for it and the pieces around
 * its words (a spray of paint, balls, confetti), named by the card's signed
 * `look`. Pure: where each piece goes and the box it covers, for the card
 * (./elements.tsx draws them) and for a video that brings each one on in
 * turn (the motion sheet, ./render.tsx).
 */

/** The look a card wears, if the assets have it. A company's card has none (`brandedAssets` drops the app's looks). */
export function cardLook(spec: Pick<CardSpec, "look">, assets: Pick<CardAssets, "looks">): CardLook | undefined {
  return spec.look ? assets.looks?.[spec.look] : undefined;
}

/** The assets with the card's look's colours over the theme. */
export function lookedAssets(spec: Pick<CardSpec, "look">, assets: CardAssets): CardAssets {
  const look = cardLook(spec, assets);
  return look?.theme ? { ...assets, theme: { ...assets.theme, ...look.theme } } : assets;
}

/** The look's pieces for a card of this size, bottom first; none without a look. */
export function cardDecor(spec: Pick<CardSpec, "look" | "size">, assets: Pick<CardAssets, "looks">): readonly CardDecor[] {
  const look = cardLook(spec, assets);
  if (!look?.decor) return [];
  const { width, height } = CARD_SIZES[spec.size];
  return look.decor({ size: spec.size, width, height });
}

/** A bit of confetti's own width and height: a card, a thin strip, a dot. */
export function bitSize(shape: CardDecorBit["shape"], size: number): { width: number; height: number } {
  if (shape === "dot") return { width: size, height: size };
  if (shape === "strip") return { width: Math.max(2, Math.round(size * 0.34)), height: size };
  return { width: Math.round(size * 0.6), height: size };
}

/** A piece's own size, before it turns. */
export function decorSize(piece: CardDecor): { width: number; height: number } {
  switch (piece.kind) {
    case "art":
      return { width: piece.width, height: (piece.width * piece.art.height) / piece.art.width };
    case "ball":
      return { width: piece.size, height: piece.size };
    case "bit":
      return bitSize(piece.shape, piece.size);
  }
}

/** The box a piece covers once turned, in whole pixels of the card, with a pixel to spare each side. */
export function decorBox(piece: CardDecor): { left: number; top: number; width: number; height: number } {
  const { width, height } = decorSize(piece);
  const turn = ((piece.rotate ?? 0) * Math.PI) / 180;
  const w = Math.abs(width * Math.cos(turn)) + Math.abs(height * Math.sin(turn));
  const h = Math.abs(width * Math.sin(turn)) + Math.abs(height * Math.cos(turn));
  const left = Math.floor(piece.x - w / 2) - 2;
  const top = Math.floor(piece.y - h / 2) - 2;
  return { left, top, width: Math.ceil(piece.x + w / 2) + 2 - left, height: Math.ceil(piece.y + h / 2) + 2 - top };
}

/** How a piece comes on: "fade" when it doesn't say. */
export function entranceOf(piece: CardDecor): CardEntrance {
  return piece.enter ?? "fade";
}


/** The motion sheet of a card drawn with these assets (already branded: a company's card has no look). */
export function motionOf(spec: CardSpec, drawn: CardAssets): CardMotion {
  const look = cardLook(spec, drawn);
  const { width, height } = CARD_SIZES[spec.size];
  const pieces = cardDecor(spec, drawn).flatMap((piece, index): CardMotionPiece[] => {
    const enter = entranceOf(piece);
    if (enter === "none") return [];
    return [{ index, ...decorBox(piece), x: piece.x, y: piece.y, from: piece.from ?? { x: piece.x, y: piece.y }, enter, delay: Math.max(0, piece.delay ?? 0), bob: piece.bob ?? false, stays: piece.stays ?? false }];
  });
  return { width, height, look: look && spec.look ? spec.look : null, words: look?.words ?? "rise", pieces };
}
