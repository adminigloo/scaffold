import { ImageResponse } from "next/og";
import type { ReactElement } from "react";

/**
 * A share-image (Open Graph / Twitter card) template for `next/og`, generic
 * where trailcards' per-deck image was Traildek-specific: an optional
 * wordmark, eyebrow, title, description, badge and footer on the left, and a
 * hero image (or a lettered fallback panel) on the right. Colours come from
 * `theme`; the font is fetched once per server instance, cached, and the
 * image still renders in the default sans-serif when the fetch fails.
 *
 * This entry is the only one that needs `next` (an optional peer). The core
 * entry has no dependency on it.
 *
 *   // app/opengraph-image.tsx
 *   import { shareImageResponse, SHARE_IMAGE_SIZE } from "@adminigloo/seo/og";
 *   export const size = SHARE_IMAGE_SIZE;
 *   export const contentType = "image/png";
 *   export const alt = "Riddler Go: puzzle events for any occasion";
 *   export default function Image() {
 *     return shareImageResponse({ brand: "Riddler Go", title: "Puzzle events for any occasion" });
 *   }
 */

export const SHARE_IMAGE_SIZE = { width: 1200, height: 630 } as const;

export interface ShareImageTheme {
  background: string;
  foreground: string;
  muted: string;
  accent: string;
  /** Behind the hero image, and the fallback panel. */
  panel: string;
  /** Text on the badge. */
  onAccent: string;
  /**
   * Painted over `background`: a CSS gradient, as satori draws them
   * ("linear-gradient(135deg, #101418 0%, #1d2a33 100%)"), or `url(…)`.
   */
  backgroundImage?: string;
}

export const DEFAULT_SHARE_THEME: ShareImageTheme = {
  background: "#0e161c",
  foreground: "#e8edf1",
  muted: "#93a2ae",
  accent: "#45c4ad",
  panel: "#16222b",
  onAccent: "#0e161c",
};

export interface ShareImageProps {
  title: string;
  /** Wordmark text, top left. */
  brand?: string;
  /** A short label above the title ("TEMPLATE", a collection name). */
  eyebrow?: string;
  description?: string;
  /** A pill under the title ("12 TRAILS", "FREE"). */
  badge?: string;
  /** Bottom left, usually the page's address without the scheme. */
  footer?: string;
  /** An absolute image URL for the right half. Without it the text spans the card. */
  image?: string | null;
  /** With an image: a lettered panel instead of the photo when the image is missing. Default true. */
  panelFallback?: boolean;
  theme?: Partial<ShareImageTheme>;
  /** A font family registered through `fonts` (shareImageResponse sets it to the first loaded font). */
  fontFamily?: string;
  width?: number;
  height?: number;
}

function titleSize(title: string, half: boolean): number {
  const n = title.length;
  const steps = half ? [[22, 64], [36, 54], [56, 46]] : [[24, 76], [40, 64], [64, 54]];
  for (const [limit, size] of steps) if (n <= limit!) return size!;
  return half ? 40 : 46;
}

/** The card as a satori-compatible element (every multi-child box is display:flex). */
export function ShareImage(props: ShareImageProps): ReactElement {
  const theme = { ...DEFAULT_SHARE_THEME, ...props.theme };
  const width = props.width ?? SHARE_IMAGE_SIZE.width;
  const height = props.height ?? SHARE_IMAGE_SIZE.height;
  const split = props.image !== undefined;
  const textWidth = split ? Math.round(width / 2) : width;
  const family = props.fontFamily ? `'${props.fontFamily}', sans-serif` : "sans-serif";
  const initial = (props.brand ?? props.title).trim().charAt(0).toUpperCase() || "•";

  return (
    <div
      style={{
        display: "flex",
        width: `${width}px`,
        height: `${height}px`,
        backgroundColor: theme.background,
        ...(theme.backgroundImage ? { backgroundImage: theme.backgroundImage } : {}),
        color: theme.foreground,
        fontFamily: family,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          width: `${textWidth}px`,
          height: "100%",
          padding: split ? "60px 48px 52px 64px" : "64px 80px 56px 80px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", fontSize: "28px", fontWeight: 700, letterSpacing: "0.08em", color: theme.accent }}>
          {props.brand ?? ""}
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {props.eyebrow ? (
            <div style={{ display: "flex", fontSize: "20px", fontWeight: 600, letterSpacing: "0.2em", textTransform: "uppercase", color: theme.muted, marginBottom: "18px" }}>
              {props.eyebrow}
            </div>
          ) : null}
          <div style={{ display: "flex", fontSize: `${titleSize(props.title, split)}px`, fontWeight: 800, lineHeight: 1.08, letterSpacing: "-0.01em" }}>{props.title}</div>
          {props.badge ? (
            <div
              style={{
                display: "flex",
                alignSelf: "flex-start",
                marginTop: "22px",
                padding: "8px 18px",
                borderRadius: "999px",
                backgroundColor: theme.accent,
                color: theme.onAccent,
                fontSize: "20px",
                fontWeight: 700,
                letterSpacing: "0.14em",
              }}
            >
              {props.badge}
            </div>
          ) : null}
          {props.description ? (
            <div style={{ display: "flex", marginTop: "22px", fontSize: split ? "22px" : "27px", lineHeight: 1.35, color: theme.muted, maxHeight: split ? "60px" : "74px", overflow: "hidden" }}>
              {props.description}
            </div>
          ) : null}
        </div>
        <div style={{ display: "flex", alignItems: "center", fontSize: "18px", color: theme.muted, letterSpacing: "0.04em" }}>
          {props.footer ? <div style={{ display: "flex", width: "28px", height: "2px", backgroundColor: theme.accent, marginRight: "12px" }} /> : null}
          {props.footer ?? ""}
        </div>
      </div>
      {split ? (
        <div style={{ display: "flex", width: `${width - textWidth}px`, height: "100%", backgroundColor: theme.panel, position: "relative", overflow: "hidden" }}>
          {props.image ? (
            // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
            <img src={props.image} width={width - textWidth} height={height} style={{ width: `${width - textWidth}px`, height: `${height}px`, objectFit: "cover" }} />
          ) : props.panelFallback !== false ? (
            <div style={{ display: "flex", width: "100%", height: "100%", alignItems: "center", justifyContent: "center" }}>
              <div
                style={{
                  display: "flex",
                  width: "180px",
                  height: "180px",
                  borderRadius: "50%",
                  border: `4px solid ${theme.accent}`,
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "88px",
                  fontWeight: 800,
                  color: theme.accent,
                }}
              >
                {initial}
              </div>
            </div>
          ) : null}
          <div style={{ display: "flex", position: "absolute", top: 0, left: 0, width: "6px", height: "100%", backgroundColor: theme.accent }} />
        </div>
      ) : null}
    </div>
  );
}

export interface FontSource {
  /** The family name the image refers to. */
  name: string;
  /** A TTF/OTF/WOFF URL (satori does not read WOFF2). */
  url: string;
  weight?: 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
  style?: "normal" | "italic";
}

export interface LoadedFont {
  name: string;
  data: ArrayBuffer;
  weight?: FontSource["weight"];
  style?: FontSource["style"];
}

const fontCache = new Map<string, Promise<ArrayBuffer | null>>();

/**
 * Fetch a font once per server instance and keep it. A failed or slow fetch
 * resolves null (the caller renders in the default font) and is NOT cached,
 * so the next image tries again: trailcards cached the failure for the life
 * of the instance.
 */
export async function loadFont(source: FontSource, options: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<LoadedFont | null> {
  let pending = fontCache.get(source.url);
  if (!pending) {
    const doFetch = options.fetch ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 4000);
    pending = doFetch(source.url, { signal: controller.signal })
      .then((response) => (response.ok ? response.arrayBuffer() : null))
      .catch(() => null)
      .finally(() => clearTimeout(timer));
    fontCache.set(source.url, pending);
    void pending.then((data) => {
      if (data === null && fontCache.get(source.url) === pending) fontCache.delete(source.url);
    });
  }
  const data = await pending;
  if (!data) return null;
  return { name: source.name, data, ...(source.weight ? { weight: source.weight } : {}), ...(source.style ? { style: source.style } : {}) };
}

/** Forget cached fonts (tests). */
export function clearFontCache(): void {
  fontCache.clear();
}

/**
 * The finished `ImageResponse` (a PNG): loads `fonts` (cached, with
 * fallback), renders the template with the first font that loaded. A font
 * is a URL to fetch, or bytes you already have (`{ name, data }`): a local
 * OTF read with `readFile`, as Riddler Go's Nacelle files are.
 */
export async function shareImageResponse(
  props: ShareImageProps,
  options: { fonts?: ReadonlyArray<FontSource | LoadedFont>; fetch?: typeof fetch; headers?: Record<string, string> } = {},
): Promise<ImageResponse> {
  const loaded = (
    await Promise.all((options.fonts ?? []).map((font) => ("data" in font ? Promise.resolve(font.data ? font : null) : loadFont(font, { fetch: options.fetch }))))
  ).filter((font): font is LoadedFont => font !== null);
  const width = props.width ?? SHARE_IMAGE_SIZE.width;
  const height = props.height ?? SHARE_IMAGE_SIZE.height;
  return new ImageResponse(<ShareImage {...props} fontFamily={props.fontFamily ?? loaded[0]?.name} />, {
    width,
    height,
    ...(loaded.length > 0 ? { fonts: loaded.map((font) => ({ name: font.name, data: font.data, weight: font.weight, style: font.style })) } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
  });
}
