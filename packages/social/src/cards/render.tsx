import type { ReactElement } from "react";
import { cardElement } from "./elements.js";
import { layoutCard, type CardLayout, type CardMetrics } from "./layout.js";
import { parseFontMetrics, type FontMetrics } from "./metrics.js";
import { parseCardParams, verifyCardParams } from "./params.js";
import { CARD_SIZES, type CardAssets, type CardFont, type CardSpec } from "./types.js";

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
 * app's own art belongs to the app's own brand.
 */
export function brandedAssets(spec: CardSpec, assets: CardAssets): CardAssets {
  const words = spec.brand;
  if (!words) return assets;
  return {
    ...assets,
    theme: { ...assets.theme, ...(words.accent ? { accent: words.accent } : {}), ...(words.onAccent ? { onAccent: words.onAccent } : {}) },
    brand: { name: words.name, site: words.site },
    author: { name: words.name, handle: words.handle ?? words.site },
  };
}

/** Where everything on this card goes (the words sized to fit), without drawing it. */
export function cardLayout(spec: CardSpec, assets: CardAssets): CardLayout {
  const drawn = brandedAssets(spec, assets);
  return layoutCard(spec, cardMetrics(drawn), { name: drawn.brand.name, site: drawn.brand.site, handle: drawn.author.handle, author: drawn.author.name });
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

/** The card as a PNG response, painted by the app's painter (next/og's ImageResponse in a Next.js app). */
export function renderCard(spec: CardSpec, assets: CardAssets, paint: CardPainter, options: { readonly headers?: Record<string, string> } = {}): Response {
  const { width, height } = CARD_SIZES[spec.size];
  const drawn = brandedAssets(spec, assets);
  return new paint(cardElement(spec, cardLayout(spec, assets), drawn), {
    width,
    height,
    fonts: drawn.fonts.map((f) => ({ name: f.name, data: f.data, weight: f.weight, style: f.style })),
    ...(options.headers ? { headers: options.headers } : {}),
  });
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
 */
export function createCardRoute(options: CardRouteOptions): (req: Request) => Promise<Response> {
  return async (req) => {
    const params = new URL(req.url).searchParams;
    if (!verifyCardParams(params, options.secret())) return refuse(403, "This card's signature doesn't match its words.");
    const parsedSpec = parseCardParams(params);
    if (!parsedSpec.ok) return refuse(400, `Not a card: ${parsedSpec.error}`);
    const { spec } = parsedSpec;
    const assets = await options.assets();
    if ("character" in spec && spec.character && !assets.characters?.[spec.character]) {
      return refuse(400, `Not a card: no picture called "${spec.character}".`);
    }
    return renderCard(spec, assets, options.paint, { headers: { "cache-control": options.cacheControl ?? CARD_CACHE_CONTROL } });
  };
}
