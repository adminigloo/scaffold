import { useEffect, useInsertionEffect, useState, type RefObject } from "react";

/**
 * Light or dark, decided the way the HOST page decided it. COPIED from @adminigloo/notifications-widget (src/theme.ts), itself from comms-widget and scheduling-widget; change them together.
 *
 * A widget that only reads `prefers-color-scheme` paints a dark card on a
 * light site whenever the visitor's OS is dark and the site ignores it, which
 * is most marketing sites. So "auto" asks the page first, in this order, and
 * the first rule that answers wins:
 *
 *   1. `data-theme="dark" | "light"` on the nearest ancestor of the widget
 *      root, then <body>, then <html> (next-themes, daisyUI, most switches);
 *   2. the `dark` / `light` class on <body> or <html> (Tailwind's `class`
 *      strategy);
 *   3. the computed `color-scheme` of <html>, when it is exactly "dark" or
 *      exactly "light" (a site that sets it in CSS);
 *   4. what the widget actually SITS ON: the nearest ancestor (up to <html>)
 *      with a solid background colour — dark under a dark one, light under a
 *      light one;
 *   5. with no background anywhere, the page is the browser's own canvas:
 *      light, unless the page's `color-scheme` lets the browser go dark,
 *      and only then the OS, via `prefers-color-scheme`.
 *
 * Rules 4 and 5 are for the most common host of all: Tailwind's `class`
 * strategy, which says dark with a `dark` class and light by having NO class.
 * Read as "no answer", that fell through to the OS, and every visitor with a
 * dark OS got a dark booking card on a white page. The bell sits in the host's
 * header, so it follows the header's backdrop the same way.
 */

export type ThemeChoice = "auto" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export type MatchMediaLike = (query: string) => { matches: boolean };

function themeAttr(element: Element | null | undefined): ResolvedTheme | null {
  const value = element?.getAttribute("data-theme");
  return value === "dark" || value === "light" ? value : null;
}

function themeClass(element: Element | null | undefined): ResolvedTheme | null {
  if (!element) return null;
  if (element.classList.contains("dark")) return "dark";
  if (element.classList.contains("light")) return "light";
  return null;
}

/**
 * The host's theme for `element` (the widget root, or anything inside the
 * host page). Pure apart from reading the DOM it is given; `matchMedia` is a
 * parameter so a test can pin the OS setting.
 */
export function resolveHostTheme(element: Element | null, matchMedia?: MatchMediaLike | null): ResolvedTheme {
  const doc: Document | null = element?.ownerDocument ?? (typeof document !== "undefined" ? document : null);
  const view = doc?.defaultView ?? null;
  const media: MatchMediaLike | null =
    matchMedia ?? (view && typeof view.matchMedia === "function" ? (query) => view.matchMedia(query) : null);
  const os = (): ResolvedTheme => (media?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  if (!doc) return os();

  // 1. data-theme: the nearest ancestor first (the widget's own attribute is
  // its output, never its input), then <body>, then <html>.
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const found = themeAttr(node);
    if (found) return found;
  }
  const byAttr = themeAttr(doc.body) ?? themeAttr(doc.documentElement);
  if (byAttr) return byAttr;

  // 2. A dark / light class on <body> or <html>.
  const byClass = themeClass(doc.body) ?? themeClass(doc.documentElement);
  if (byClass) return byClass;

  // 3. color-scheme, only when it names exactly one scheme ("light dark" is
  // a site saying "either", which is no answer).
  try {
    const scheme = view?.getComputedStyle(doc.documentElement).colorScheme?.trim();
    if (scheme === "dark" || scheme === "light") return scheme;
  } catch {
    /* a detached document or an old engine: fall through */
  }

  // 4. The nearest solid background the widget sits on.
  const backdrop = backdropTheme(element, doc, view);
  if (backdrop) return backdrop;

  // 5. The bare canvas: light unless the page allows the browser to go dark.
  try {
    const scheme = view?.getComputedStyle(doc.documentElement).colorScheme?.trim() ?? "";
    return /\bdark\b/.test(scheme) ? os() : "light";
  } catch {
    return os();
  }
}

const NAMED: Readonly<Record<string, [number, number, number, number]>> = {
  white: [255, 255, 255, 1],
  black: [0, 0, 0, 1],
  transparent: [0, 0, 0, 0],
};

/**
 * A computed background colour → [r, g, b, a]; null for anything this can't
 * read. Browsers compute "rgb(…)" / "rgba(…)"; a few engines hand back what
 * was written ("#fff", "white"), so those are read too.
 */
function parseColor(value: string | null | undefined): [number, number, number, number] | null {
  const text = value?.trim().toLowerCase() ?? "";
  if (!text) return null;
  const named = NAMED[text];
  if (named) return named;
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text);
  if (hex) {
    const digits = hex[1] as string;
    const full = digits.length <= 4 ? [...digits].map((d) => d + d).join("") : digits;
    const channel = (i: number) => parseInt(full.slice(i * 2, i * 2 + 2), 16);
    return [channel(0), channel(1), channel(2), full.length === 8 ? channel(3) / 255 : 1];
  }
  const match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(value?.trim() ?? "");
  if (!match) return null;
  const alphaText = match[4];
  const alpha = alphaText === undefined ? 1 : alphaText.endsWith("%") ? Number(alphaText.slice(0, -1)) / 100 : Number(alphaText);
  return [Number(match[1]), Number(match[2]), Number(match[3]), alpha];
}

/** Relative luminance (WCAG) of an sRGB colour, 0 (black) … 1 (white). */
function luminance([r, g, b]: [number, number, number, number]): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** The theme of the nearest ancestor with a (mostly) opaque background colour, or null when there is none. */
function backdropTheme(element: Element | null, doc: Document, view: (Window & typeof globalThis) | null): ResolvedTheme | null {
  if (!view || typeof view.getComputedStyle !== "function") return null;
  const start = element?.parentElement ?? doc.body ?? doc.documentElement;
  for (let node: Element | null = start; node; node = node.parentElement) {
    try {
      const color = parseColor(view.getComputedStyle(node).backgroundColor);
      if (color && color[3] >= 0.5) return luminance(color) < 0.4 ? "dark" : "light";
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Insert a stylesheet before the first paint the client does. Insertion
 * effects run before layout effects, so the widget never renders one frame
 * unstyled after hydration. Server renders skip it (no document).
 */
export function useStyles(inject: () => void): void {
  useInsertionEffect(() => {
    inject();
  }, [inject]);
}

/**
 * The theme to write as `data-theme` on the widget root. "light" / "dark" are
 * returned as given (on the server too). "auto" is undefined until mounted —
 * on the server and before hydration the CSS's media query decides, so a page
 * that matches the OS never flashes — and then follows the host live:
 *
 *   - a MutationObserver on <html> and <body> watches `class`, `data-theme`
 *     and `style` (a theme switch, or color-scheme set inline);
 *   - a matchMedia listener watches the OS setting.
 *
 * Both are removed on unmount, and the effect is safe under StrictMode's
 * mount / unmount / mount: each run sets up its own and cleans up its own.
 */
export function useHostTheme(rootRef: RefObject<Element | null>, theme: ThemeChoice = "auto"): ResolvedTheme | undefined {
  const [resolved, setResolved] = useState<ResolvedTheme | undefined>(undefined);
  useEffect(() => {
    if (theme !== "auto" || typeof document === "undefined" || typeof window === "undefined") return;
    const update = () => {
      const next = resolveHostTheme(rootRef.current ?? document.documentElement);
      setResolved((current) => (current === next ? current : next));
    };
    update();
    const observer = typeof MutationObserver === "function" ? new MutationObserver(update) : null;
    const watch = { attributes: true, attributeFilter: ["class", "data-theme", "style"] };
    observer?.observe(document.documentElement, watch);
    if (document.body) observer?.observe(document.body, watch);
    const query = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    if (query) {
      if (typeof query.addEventListener === "function") query.addEventListener("change", update);
      else if (typeof (query as MediaQueryList).addListener === "function") (query as MediaQueryList).addListener(update);
    }
    return () => {
      observer?.disconnect();
      if (query) {
        if (typeof query.removeEventListener === "function") query.removeEventListener("change", update);
        else if (typeof (query as MediaQueryList).removeListener === "function") (query as MediaQueryList).removeListener(update);
      }
    };
  }, [theme, rootRef]);
  return theme === "auto" ? resolved : theme;
}
