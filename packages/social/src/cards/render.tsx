import type { ReactElement } from "react";
import { cardElement, pieceElement } from "./elements.js";
import { layoutCard, type CardLayout, type CardMetrics } from "./layout.js";
import type { CardMotion } from "../card-parts.js";
import { cardDecor, lookedAssets, motionOf } from "./looks.js";
import { parseFontMetrics, type FontMetrics } from "./metrics.js";
import { splitCardLayer, type CardLayer } from "../card-parts.js";
import { parseCardParams, verifyCardParams } from "./params.js";
import { CARD_SIZES, cardAuthor, cardCharacter, type CardAssets, type CardFont, type CardSpec } from "./types.js";

const parsed = new WeakMap<ArrayBuffer, FontMetrics>();

function metricsOf(font: CardFont): FontMetrics {
  let metrics = parsed.get(font.data);
  if (!metrics) {
    metrics = parseFontMetrics(font.data);
    parsed.set(font.data, metrics);
  }
  return metrics;
}

/**
 * The faces a card measures with: the serif's upright, and the sans's
 * heaviest upright (bold is the widest, so a line that fits in it fits).
 */
export function cardMetrics(assets: Pick<CardAssets, "fonts" | "serif" | "sans">): CardMetrics {
  const upright = (family: string) => assets.fonts.filter((f) => f.name === family && f.style === "normal").sort((a, b) => b.weight - a.weight);
  const serif = upright(assets.serif).at(-1);
  const sans = upright(assets.sans)[0];
  if (!serif || !sans) throw new Error(`The cards need upright ${assets.serif} and ${assets.sans} fonts.`);
  return { serif: metricsOf(serif), sans: metricsOf(sans) };
}

/**
 * The assets a card is drawn with: the app's, unless the spec carries its
 * own brand's words (a company's card), which win — its name, address,
 * handle and colours, and its first letter for the mark and the avatar: the
 * app's own art (its characters, its logo, its looks) belongs to the app's
 * own brand.
 */
export function brandedAssets(spec: CardSpec, assets: CardAssets): CardAssets {
  const words = spec.brand;
  if (!words) return assets;
  return {
    ...assets,
    theme: { ...assets.theme, ...(words.accent ? { accent: words.accent } : {}), ...(words.onAccent ? { onAccent: words.onAccent } : {}) },
    brand: { name: words.name, site: words.site },
    author: { name: words.name, handle: words.handle ?? words.site },
    // The app's own characters and their art belong to the app's own brand, never a company's card.
    authors: undefined,
    characters: undefined,
    looks: undefined,
  };
}

/** What a card is drawn with: its brand's (`brandedAssets`), then its look's colours. */
export function drawnAssets(spec: CardSpec, assets: CardAssets): CardAssets {
  return lookedAssets(spec, brandedAssets(spec, assets));
}

/** The card's motion sheet (./looks.ts): what a video needs to move its parts. */
export function cardMotion(spec: CardSpec, assets: CardAssets): CardMotion {
  return motionOf(spec, drawnAssets(spec, assets));
}

/** Where everything on this card goes (the words sized to fit), without drawing it. */
export function cardLayout(spec: CardSpec, assets: CardAssets): CardLayout {
  const drawn = brandedAssets(spec, assets);
  const author = cardAuthor(spec, drawn);
  return layoutCard(spec, cardMetrics(drawn), { name: drawn.brand.name, site: drawn.brand.site, handle: author.handle, author: author.name }, cardCharacter(spec, drawn));
}

/** The card's pixel size. */
export function cardSize(spec: Pick<CardSpec, "size">): { width: number; height: number } {
  return { ...CARD_SIZES[spec.size] };
}

/**
 * What paints a card into a PNG response. In a Next.js app it's next/og's
 * ImageResponse (satori lays the card out, resvg paints it); the app passes it
 * in, so the package itself needs no Next.js and moves to any app that has
 * something of the same shape (@vercel/og, a satori wrapper).
 */
export type CardPainter = new (
  element: ReactElement,
  options: {
    width: number;
    height: number;
    fonts: { name: string; data: ArrayBuffer; weight?: CardFont["weight"]; style?: CardFont["style"] }[];
    headers?: Record<string, string>;
  },
) => Response;

/** A part of a card the painter draws: all but the motion sheet, which is words, not a picture. */
export type CardPicturePart = Exclude<CardLayer, "motion">;

/**
 * The card as a PNG response, painted by the app's painter (next/og's
 * ImageResponse in a Next.js app): the whole card, or one of its parts for a
 * video (social 0.5): its ground, its words on nothing, or one piece of its
 * look in that piece's own box. A piece the look doesn't have is an error.
 */
export function renderCard(spec: CardSpec, assets: CardAssets, paint: CardPainter, options: { readonly headers?: Record<string, string>; readonly layer?: CardPicturePart | null } = {}): Response {
  const drawn = drawnAssets(spec, assets);
  const fonts = drawn.fonts.map((f) => ({ name: f.name, data: f.data, weight: f.weight, style: f.style }));
  const headers = options.headers ? { headers: options.headers } : {};
  const layer = options.layer ?? null;
  if (layer?.startsWith("piece-")) {
    const index = Number(layer.slice("piece-".length));
    const piece = cardDecor(spec, drawn)[index];
    if (!piece) throw new RangeError(`This card's look has no piece ${index}.`);
    const { element, width, height } = pieceElement(piece, drawn);
    return new paint(element, { width, height, fonts, ...headers });
  }
  const { width, height } = CARD_SIZES[spec.size];
  const part = layer === "ground" || layer === "words" ? layer : "card";
  return new paint(cardElement(spec, cardLayout(spec, assets), drawn, part), { width, height, fonts, ...headers });
}

/**
 * Next's own cache headers on an ImageResponse say "check again every time"
 * (max-age=0). A card here can't change: its words are in its signed
 * address. So browsers keep it a day and the CDN until the next deploy
 * (which empties it, so a redesign shows).
 */
export const CARD_CACHE_CONTROL = "public, max-age=86400, s-maxage=31536000, stale-while-revalidate=86400";

export interface CardRouteOptions {
  /** The key the addresses were signed with. Read per request, so a rotated key takes effect without a restart. */
  readonly secret: () => string;
  /** The look and fonts: the app's brand (a company's card brings its own words in its address). */
  readonly assets: () => CardAssets | Promise<CardAssets>;
  readonly paint: CardPainter;
  readonly cacheControl?: string;
}

function refuse(status: number, message: string): Response {
  return new Response(`${message}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

/**
 * THE CARD ROUTE (GET /api/social/card?kind=…&sig=…, or wherever the app
 * mounts it): one card as a PNG. Public, so a platform can fetch the
 * picture, and signed, so nobody can make a card say something the business
 * didn't: a query whose signature doesn't match its words is a 403, one that
 * names no card (or a picture the app doesn't have) a 400.
 *
 * `&layer=` (social 0.5, outside the signature: it only ever draws less of
 * the signed card) asks for one part, for a video: `ground`, `words`,
 * `piece-N`, or `motion`, the motion sheet as JSON. A look the app no longer
 * has draws the plain card, so an old post's pictures still work.
 */
export function createCardRoute(options: CardRouteOptions): (req: Request) => Promise<Response> {
  return async (req) => {
    const split = splitCardLayer(new URL(req.url).searchParams);
    if (!split.ok) return refuse(400, `Not a card: ${split.error}`);
    const { params, layer } = split;
    if (!verifyCardParams(params, options.secret())) return refuse(403, "This card's signature doesn't match its words.");
    const parsedSpec = parseCardParams(params);
    if (!parsedSpec.ok) return refuse(400, `Not a card: ${parsedSpec.error}`);
    const { spec } = parsedSpec;
    const assets = await options.assets();
    if ("character" in spec && spec.character && !assets.characters?.[spec.character]) {
      return refuse(400, `Not a card: no picture called "${spec.character}".`);
    }
    const cacheControl = options.cacheControl ?? CARD_CACHE_CONTROL;
    if (layer === "motion") {
      return new Response(JSON.stringify(cardMotion(spec, assets)), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": cacheControl } });
    }
    if (layer?.startsWith("piece-") && !cardDecor(spec, drawnAssets(spec, assets))[Number(layer.slice("piece-".length))]) {
      return refuse(400, `Not a card: its look has no ${layer}.`);
    }
    return renderCard(spec, assets, options.paint, { headers: { "cache-control": cacheControl }, layer });
  };
}
