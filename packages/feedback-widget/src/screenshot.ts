import { domToCanvas } from "modern-screenshot";
import { redactClone } from "./redaction.js";
import type { ScreenshotData } from "./types.js";

/**
 * Ported from Ask Lou's capture path, then corrected in a real browser. The
 * screenshot must be exactly what the reporter was looking at.
 *
 * THE POSITION:FIXED PROBLEM, AND WHY THIS FILE IS MORE THAN ONE CALL.
 * `domToCanvas` clones the DOM to rasterise it, and a clone loses the fixed
 * positioning context — so `position: fixed` layers (a modal, a dialog, an open
 * AI chat panel, a toast, a fixed header) DO NOT APPEAR where they were in a
 * page capture. A reporter with a modal open who submits feedback about that
 * modal would get a screenshot of the page BEHIND it, which is the one thing
 * they were not looking at. This cost real work to diagnose the first time.
 *
 * The fix, kept here so it cannot be lost in a port again: capture each layer
 * INDIVIDUALLY (where it is the capture root, so fixed positioning is moot),
 * record its viewport rect, then STITCH the layers back onto the page capture
 * at those rects, in the order the browser painted them. `captureOverlays` does
 * the layers; `captureScreenshot` does the page (leaving the captured layers
 * out, so nothing is drawn twice); `stitchOverlays` composites them. The caller
 * runs `captureOverlays` BEFORE opening its own UI (so the reporter's modal is
 * still on screen) and stitches after.
 *
 * Ask Lou found layers by opt-in markers (`[data-chat-panel]`, `[data-modal]`),
 * which works in an app whose every modal you wrote. A package a stranger
 * installs cannot know their markers, so layers are found by what actually
 * makes them go missing — computed `position: fixed`, the top layer, and
 * `position: sticky` (which the page clone never "sticks") — whatever library
 * drew them. The markers still work. Every rule below was pinned by a browser
 * test in `scaffold/e2e` after a review found it wrong.
 */

export interface ScreenshotOptions {
  scale?: number;
  quality?: number;
  redactSensitiveFields?: boolean;
  excludeSelectors?: string[];
  /**
   * Elements to leave out of the page capture — the layers `captureOverlays`
   * already captured. On an unscrolled page the capture can render a fixed layer
   * in place, and the stitch would then draw it a SECOND time: invisible for an
   * opaque panel, visibly doubled for a see-through one (a backdrop dims twice).
   */
  excludeElements?: ReadonlySet<Element>;
}

/**
 * Markers that always count as an overlay (when they sit in a layer the page
 * capture drops). Layers are found without them; these keep the opt-in path
 * Ask Lou shipped — `[data-chat-panel]` is its chat window's marker — and let a
 * host tag a bespoke panel explicitly.
 */
export const DEFAULT_OVERLAY_SELECTORS = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  "[data-feedback-overlay]",
  "[data-chat-panel]",
];

/**
 * Never a layer, never in any shot: the widget's own UI, and anything a host
 * opts out with `data-feedback-ignore`.
 */
const NEVER_CAPTURE =
  "[data-aif-modal], [data-aif-button], [data-aif-portal], [data-feedback-ignore]";

/**
 * Hover UI. By the time the reporter has moved the pointer to the feedback
 * button, a tooltip is describing the wrong thing.
 */
const TRANSIENT = "[role='tooltip']";

/** A page can carry any number of layers; capture the topmost this many. */
const MAX_LAYERS = 12;

/**
 * The capture runs BEFORE the feedback UI opens, so every second here is a
 * second the click looks dead. Images a layer is still loading are waited on
 * for this long (the library's default is 30s; a lazy avatar list in a chat
 * held one probe for 8s, two unfinished images for 32s), and a layer that still
 * is not done by the budget is left to the page capture.
 */
const LAYER_RESOURCE_TIMEOUT_MS = 1500;
const LAYER_BUDGET_MS = 4000;

/** One layer to put back on the page screenshot, bottom-most first. */
export interface OverlayShot {
  /** Transparent PNG of the layer (empty for a `fill` layer). */
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
  /** Where it sat in the viewport, in CSS px. */
  readonly rect: { left: number; top: number; width: number; height: number };
  /**
   * A flat colour to paint over `rect` instead of an image — a backdrop/scrim:
   * a full-viewport layer with nothing in it but a translucent background.
   * Painting its real colour reproduces the dimming the reporter saw, whatever
   * shade the host chose.
   */
  readonly fill: string | null;
  /** A native modal `<dialog>`'s `::backdrop` colour, painted before the layer. */
  readonly backdropColor: string | null;
  /** A backdrop/scrim layer (see `fill`). */
  readonly isBackdrop: boolean;
  /**
   * A dialog over a dimmed page (it has a backdrop), rather than a side panel —
   * a chat, a toast. Informational: the dimming itself is the backdrop layer.
   */
  readonly isModal: boolean;
  /**
   * Opacity inherited from ancestors (the layer is its own capture root, so its
   * own opacity is in the image; a wrapper's is not).
   */
  readonly alpha: number;
  /** The live element, so the page capture can leave it out. */
  readonly element: Element;
}

/**
 * The page, exactly the viewport. The capture box IS the viewport and the
 * library's scroll restore translates the document by its scroll offset, so the
 * visible region lands at the origin.
 *
 * Earlier this captured the whole document and then cropped at the scroll
 * offset — but the library had already applied the offset, so every scrolled
 * page came out showing content from TWICE the scroll distance down (or blank
 * white near the bottom), and an app shell whose `<html>` has no height of its
 * own (a fixed inset-0 root) threw outright and lost the screenshot.
 */
export async function captureScreenshot(options: ScreenshotOptions = {}): Promise<ScreenshotData> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("screenshot capture only runs in the browser");
  }
  const scale = options.scale ?? Math.min(window.devicePixelRatio || 1, 2);
  const quality = options.quality ?? 0.92;
  const redact = options.redactSensitiveFields ?? true;
  const excludeElements = options.excludeElements;
  const excludeSelectors = [
    NEVER_CAPTURE,
    TRANSIENT,
    // Radix (and libraries that follow its shape) portal popovers/menus into
    // this wrapper; it is fixed and positioned by a transform, so the page
    // capture would draw it in the wrong place. `captureOverlays` takes it.
    "[data-radix-popper-content-wrapper]",
    ...(options.excludeSelectors ?? []),
  ];

  const canvas = await domToCanvas(document.documentElement, {
    scale,
    width: window.innerWidth,
    height: window.innerHeight,
    backgroundColor: "#ffffff",
    // How long an image still loading is waited on. The library waits on every
    // image in the document — the excluded layers' too — and the reporter is
    // watching a spinner; a picture that has not loaded in 3s is shown blank.
    timeout: 3000,
    features: { restoreScrollPosition: true },
    onCloneEachNode: redact ? redactClone : undefined,
    filter: (node: Node) => {
      if (!(node instanceof Element)) return true;
      if (excludeElements?.has(node)) return false;
      for (const selector of excludeSelectors) {
        try {
          if (node.matches(selector)) return false;
        } catch {
          /* invalid caller selector — skip it, never the capture */
        }
      }
      return true;
    },
  });

  return {
    dataUrl: canvas.toDataURL("image/jpeg", quality),
    width: canvas.width,
    height: canvas.height,
    capturedAt: Date.now(),
  };
}

/**
 * Styles pinned onto the CLONE of a captured layer (never the live element).
 *
 * THE CORNER-ONLY BUG. Nearly every real dialog centres itself with
 * `left:50%; top:50%` plus a -50% shift, and the capture library copies the
 * element's computed styles onto the clone it rasterises. It drops `position`
 * for the root, but NOT the shift — so the panel renders half its own size up
 * and to the left of the capture box, and the screenshot shows only its
 * bottom-right corner. On Tailwind v4 the shift is the independent CSS
 * `translate` property (computed `transform` is literally "none"); on v3 it is
 * `transform`. Neutralising only one of them is the fix that ships a corner
 * anyway — the sibling project (Riddler Go) did exactly that before finding the
 * second — so all four transform-family properties go. Animation is frozen for
 * the same reason: a zoom-in `scale` caught mid-flight is a shift too.
 *
 * Min/max sizes go too: the clone is pinned to the layer's layout size, and a
 * copied `max-width: calc(100% - 2rem)` (stock shadcn DialogContent) would
 * resolve against that box instead of the viewport and squeeze the layer — on
 * a phone every shadcn dialog came out 32px narrow.
 */
const OVERLAY_CLONE_STYLE: Partial<CSSStyleDeclaration> = {
  transform: "none",
  translate: "none",
  rotate: "none",
  scale: "none",
  animation: "none",
  transition: "none",
  margin: "0",
  maxWidth: "none",
  maxHeight: "none",
  minWidth: "0",
  minHeight: "0",
};

/** Layout size of an element (SVG has no offsetWidth). */
function layoutSize(element: Element): { width: number; height: number } {
  if (element instanceof HTMLElement) return { width: element.offsetWidth, height: element.offsetHeight };
  const r = element.getBoundingClientRect();
  return { width: Math.round(r.width), height: Math.round(r.height) };
}

/**
 * Capture a single element as its own screenshot — the escape hatch for a
 * layer the page capture drops. Here the element IS the capture root, so its
 * fixed positioning never enters the equation. Returns null on failure so a
 * broken layer never fails the whole report.
 *
 * - The capture box is the element's LAYOUT size, not its bounding rect: with
 *   the transforms neutralised the clone renders at layout size, and a rect
 *   shrunk by a mid-animation `scale` would crop it. The stitch draws it into
 *   the bounding rect.
 * - Scroll positions inside it are restored — an AI chat panel is scrolled to
 *   its LATEST message, and a capture of its top would show the start of the
 *   conversation instead of what the reporter was reading.
 * - `transparent` keeps the alpha channel (PNG, no fill), so rounded corners and
 *   see-through regions show the page beneath instead of white boxes.
 * - `exclude` leaves out descendants captured as layers of their own (a fixed
 *   menu inside a modal), which the clone would otherwise draw in the wrong
 *   place.
 */
export async function captureElement(
  element: Element,
  options: {
    scale?: number;
    quality?: number;
    transparent?: boolean;
    exclude?: ReadonlySet<Element>;
    resourceTimeoutMs?: number;
  } = {},
): Promise<ScreenshotData | null> {
  if (typeof window === "undefined") return null;
  // The capture library renders an <svg> ROOT as an empty image (it draws the
  // same svg fine as a child), so an SVG layer is captured through a wrapper of
  // our own: a copy of it, pinned in place, in a throwaway container. The host's
  // node is never moved or changed.
  if (element instanceof SVGElement && !(element.parentElement?.hasAttribute("data-aif-svg-wrap"))) {
    const { width, height } = layoutSize(element);
    const wrap = document.createElement("div");
    wrap.setAttribute("data-aif-svg-wrap", "");
    wrap.setAttribute("aria-hidden", "true");
    wrap.style.cssText = `position:fixed;left:-100000px;top:0;width:${width}px;height:${height}px;pointer-events:none`;
    const copy = element.cloneNode(true) as SVGElement;
    copy.style.position = "static";
    copy.style.inset = "auto";
    copy.style.margin = "0";
    copy.setAttribute("width", String(width));
    copy.setAttribute("height", String(height));
    wrap.appendChild(copy);
    document.body.appendChild(wrap);
    try {
      return await captureElement(wrap, options);
    } finally {
      wrap.remove();
    }
  }
  const scale = options.scale ?? Math.min(window.devicePixelRatio || 1, 2);
  const quality = options.quality ?? 0.92;
  const transparent = options.transparent ?? false;
  const exclude = options.exclude;
  try {
    const { width, height } = layoutSize(element);
    const canvas = await domToCanvas(element, {
      scale,
      backgroundColor: transparent ? null : "#ffffff",
      timeout: options.resourceTimeoutMs ?? 8000,
      features: { restoreScrollPosition: true },
      ...(width > 0 && height > 0 ? { width, height } : {}),
      style: OVERLAY_CLONE_STYLE,
      onCloneEachNode: redactClone,
      filter: (node: Node) => {
        if (!(node instanceof Element) || node === element) return true;
        if (exclude?.has(node)) return false;
        return !(node.matches(NEVER_CAPTURE) || node.matches(TRANSIENT));
      },
    });
    const dataUrl = transparent
      ? canvas.toDataURL("image/png")
      : canvas.toDataURL("image/jpeg", quality);
    if (!dataUrl || dataUrl.length < 100) return null;
    return { dataUrl, width: canvas.width, height: canvas.height, capturedAt: Date.now() };
  } catch {
    return null;
  }
}

/** In the browser's top layer: a modal `<dialog>` or an open popover. */
function isTopLayer(el: Element): boolean {
  try {
    if (el.tagName === "DIALOG" && el.matches(":modal")) return true;
  } catch {
    if (el.tagName === "DIALOG" && (el as HTMLDialogElement).open) return true;
  }
  try {
    return el.matches(":popover-open");
  } catch {
    return false;
  }
}

/** Parse `rgb()/rgba()` from computed style; null for anything else. */
function parseColor(value: string): { r: number; g: number; b: number; a: number } | null {
  const m = value.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)/);
  if (!m) return null;
  let a = 1;
  if (m[4] !== undefined) a = m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a };
}

const isNone = (value: string | undefined): boolean => !value || value === "none";

/**
 * Makes `position: fixed` descendants position against THIS element instead of
 * the viewport — then they scroll and clip with it, and the page (or layer)
 * capture already draws them in the right place.
 */
function isContainingBlockForFixed(style: CSSStyleDeclaration): boolean {
  return (
    !isNone(style.transform) ||
    !isNone(style.translate) ||
    !isNone(style.scale) ||
    !isNone(style.rotate) ||
    !isNone(style.filter) ||
    !isNone(style.perspective) ||
    !isNone(style.backdropFilter) ||
    /paint|layout|strict|content/.test(style.contain || "") ||
    /transform|perspective|filter/.test(style.willChange || "")
  );
}

/** The element's children, and those of its open shadow root. */
function childElements(node: Element): Element[] {
  const children = Array.from(node.children);
  if (node.shadowRoot) children.push(...Array.from(node.shadowRoot.children));
  return children;
}

function parentOf(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

interface FoundLayer {
  el: Element;
  /** The layer this one was found inside (a fixed menu in a modal), if any. */
  parent: Element | null;
}

/**
 * The layers a page capture drops, in document order.
 *
 * - Every outermost element with computed `position: fixed` or in the top layer,
 *   unless an ancestor is a containing block for it (a transform, filter, …),
 *   in which case it scrolls and clips with that ancestor and the page capture
 *   draws it right.
 * - Every `position: sticky` element: the page clone never scrolls, so nothing
 *   is ever "stuck" in it, and a scrolled page lost its sticky header.
 * - A fixed element with no box of its own — a toast region whose toasts are
 *   absolutely placed inside it, a `display: contents` wrapper — is looked
 *   THROUGH: its children are in the dropped layer too, and each is a layer.
 * - Inside a layer, the search continues: a fixed menu or a sticky footer inside
 *   a modal cannot be placed by the modal's own capture, so each is a layer of
 *   its own (unless the modal is a containing block for it, when the modal's
 *   capture already positions it relative to the modal).
 * - Open shadow roots are searched; SVG elements count.
 */
function collectLayers(
  parent: Element,
  out: FoundLayer[],
  state: { containing: boolean; inDropped: boolean; within: Element | null },
): void {
  for (const child of childElements(parent)) {
    if (!(child instanceof HTMLElement || child instanceof SVGElement)) continue;
    if (child.matches(NEVER_CAPTURE)) continue;
    const style = getComputedStyle(child);
    if (style.display === "none") continue;

    const topLayer = isTopLayer(child);
    const fixed = style.position === "fixed" && !state.containing;
    const sticky = style.position === "sticky";
    const isLayer = topLayer || fixed || sticky || state.inDropped;

    if (isLayer) {
      const r = child.getBoundingClientRect();
      if (r.width >= 4 && r.height >= 4) {
        out.push({ el: child, parent: state.within });
        collectLayers(child, out, {
          // A fixed descendant positions against this layer if it is a
          // containing block — then its clone places it already.
          containing: topLayer || fixed ? isContainingBlockForFixed(style) : state.containing || isContainingBlockForFixed(style),
          inDropped: false,
          within: child,
        });
        continue;
      }
      if (topLayer || fixed) {
        collectLayers(child, out, { containing: false, inDropped: true, within: state.within });
        continue;
      }
    }
    collectLayers(child, out, {
      containing: state.containing || isContainingBlockForFixed(style),
      inDropped: false,
      within: state.within,
    });
  }
}

/** Opacity inherited from ancestors (0-1). */
function ancestorOpacity(el: Element): number {
  let alpha = 1;
  for (let node = parentOf(el); node && node !== document.documentElement; node = parentOf(node)) {
    alpha *= parseFloat(getComputedStyle(node).opacity) || 0;
    if (alpha < 0.02) return 0;
  }
  return alpha;
}

/** On screen at all: visible, not see-through-to-nothing, and in the viewport. */
function isOnScreen(el: Element): boolean {
  if (el.matches(TRANSIENT)) return false;
  const style = getComputedStyle(el);
  if (style.visibility === "hidden" || (parseFloat(style.opacity) || 0) < 0.02) return false;
  const r = el.getBoundingClientRect();
  return r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight;
}

/** Creates a stacking context (the unit paint order is decided in). */
function createsStackingContext(style: CSSStyleDeclaration, parentStyle: CSSStyleDeclaration | null): boolean {
  if (style.position === "fixed" || style.position === "sticky") return true;
  if (style.zIndex !== "auto" && style.position !== "static") return true;
  if (
    style.zIndex !== "auto" &&
    parentStyle &&
    /flex|grid/.test(parentStyle.display)
  ) {
    return true;
  }
  if ((parseFloat(style.opacity) || 0) < 1) return true;
  if (isContainingBlockForFixed(style)) return true;
  if (style.isolation === "isolate") return true;
  if (style.mixBlendMode && style.mixBlendMode !== "normal") return true;
  if (!isNone(style.clipPath) || !isNone((style as unknown as { mask?: string }).mask)) return true;
  return false;
}

/**
 * Paint order as a path: the z-index of every stacking context from the
 * outermost down to the layer itself. Two layers compare level by level; the
 * first difference decides, and a tie falls back to document order — which is
 * how the browser breaks ties too. A single "outermost z-index" (the first
 * version) stacked Sonner's toasts upside down (they share their region's
 * z-index and are ordered by their own) and ignored `isolation: isolate`. The
 * top layer beats everything.
 */
function stackPath(el: Element): number[] {
  const path: number[] = [];
  for (let node: Element | null = el; node && node !== document.documentElement; node = parentOf(node)) {
    if (isTopLayer(node)) {
      path.unshift(Number.MAX_SAFE_INTEGER);
      break;
    }
    const style = getComputedStyle(node);
    const parent = parentOf(node);
    const parentStyle = parent ? getComputedStyle(parent) : null;
    if (createsStackingContext(style, parentStyle)) {
      path.unshift(style.zIndex === "auto" ? 0 : parseInt(style.zIndex, 10) || 0);
    }
  }
  return path;
}

function comparePaths(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return 0;
}

/**
 * Is this layer painted UNDER some of the page's own content? A fixed full-page
 * background (a gradient, a video) under `position: relative` content is a
 * fixed element too — drawn on top of the page capture it would replace the
 * page. Sampled with the browser's own hit-testing: if page content (not this
 * layer, not another layer) is topmost at ANY sample point, the page paints over
 * this layer there, so drawing it on top would hide that content — it is left
 * to the page capture instead (right where it was on an unscrolled page; a
 * scrolled page loses a background rather than its content). Points where the
 * page is not hit-testable (a Radix modal's `pointer-events: none` body) prove
 * nothing and are skipped.
 */
function isBuriedUnderPage(el: Element, layers: ReadonlyArray<Element>): boolean {
  const r = el.getBoundingClientRect();
  const left = Math.max(0, r.left);
  const top = Math.max(0, r.top);
  const right = Math.min(window.innerWidth, r.right);
  const bottom = Math.min(window.innerHeight, r.bottom);
  if (right - left < 2 || bottom - top < 2) return false;
  const points: Array<[number, number]> = [
    [(left + right) / 2, (top + bottom) / 2],
    [left + (right - left) * 0.25, top + (bottom - top) * 0.25],
    [left + (right - left) * 0.75, top + (bottom - top) * 0.25],
    [left + (right - left) * 0.25, top + (bottom - top) * 0.75],
    [left + (right - left) * 0.75, top + (bottom - top) * 0.75],
  ];
  const root = el.getRootNode() as Document | ShadowRoot;
  for (const [x, y] of points) {
    const hits = (root.elementsFromPoint?.(x, y) ?? document.elementsFromPoint(x, y)).filter(
      (hit) => !hit.closest(NEVER_CAPTURE),
    );
    const top = hits[0];
    if (!top || top === document.documentElement || top === document.body) continue;
    if (top === el || el.contains(top)) continue;
    // Another layer on top is ordered by the stitch; PAGE content on top means
    // this layer is underneath the page.
    if (!layers.some((other) => other !== el && (other === top || other.contains(top)))) return true;
  }
  return false;
}

/**
 * A scrim: covers the viewport, holds nothing, and tints what is behind it.
 * Returns the colour to paint (background alpha × opacity), or null.
 */
function backdropFill(el: Element, alpha: number): string | null {
  if (el.childElementCount > 0 || (el.textContent ?? "").trim() !== "") return null;
  const r = el.getBoundingClientRect();
  if (r.left > 1 || r.top > 1 || r.right < window.innerWidth - 1 || r.bottom < window.innerHeight - 1) {
    return null;
  }
  const style = getComputedStyle(el);
  if (style.backgroundImage !== "none") return null;
  const bg = parseColor(style.backgroundColor);
  if (!bg) return null;
  const a = bg.a * (parseFloat(style.opacity) || 0) * alpha;
  if (a < 0.02) return null;
  return `rgba(${bg.r}, ${bg.g}, ${bg.b}, ${a.toFixed(3)})`;
}

const DIALOG_LIKE = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [data-modal]';

function isDialogLike(el: Element): boolean {
  return el.tagName === "DIALOG" || el.matches(DIALOG_LIKE) || el.querySelector(DIALOG_LIKE) !== null;
}

/** Resolve after `ms` with null — the loser of a race against a slow capture. */
const timeout = (ms: number) => new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));

/**
 * Find the open layers the page capture cannot see and capture each one, with
 * its viewport rect, bottom-most first, so they can be stitched back on.
 *
 * MUST RUN BEFORE THE FEEDBACK UI OPENS — that is the whole point. Once the
 * widget's own modal is up, the reporter's modal can be covered or dismissed,
 * and then there is nothing left to capture.
 *
 * `selectors` adds opt-in markers on top of the computed-style search (Ask
 * Lou's `[data-chat-panel]`, `[data-feedback-overlay]`); they too must sit in a
 * dropped layer. Sensitive content is redacted on each clone (redaction.ts).
 */
export async function captureOverlays(
  selectors: string[] = DEFAULT_OVERLAY_SELECTORS,
  options: { scale?: number } = {},
): Promise<OverlayShot[]> {
  if (typeof document === "undefined" || typeof window === "undefined") return [];

  const found: FoundLayer[] = [];
  collectLayers(document.body, found, { containing: false, inDropped: false, within: null });
  // Opt-in markers inside a fixed layer that no found layer already covers.
  for (const selector of selectors) {
    try {
      document.querySelectorAll(selector).forEach((el) => {
        if (found.some((f) => f.el === el || f.el.contains(el))) return;
        if (el.closest(NEVER_CAPTURE)) return;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return;
        for (let node = parentOf(el); node && node !== document.body; node = parentOf(node)) {
          if (getComputedStyle(node).position === "fixed" || isTopLayer(node)) {
            found.push({ el, parent: null });
            return;
          }
        }
      });
    } catch {
      /* a bad caller selector must not sink the capture */
    }
  }

  const all = found.map((f) => f.el);
  const candidates = found
    .filter((f) => isOnScreen(f.el))
    .map((f, order) => ({ ...f, order, alpha: ancestorOpacity(f.el), path: stackPath(f.el) }))
    // Under the page's own background: never visible, and drawing it on top
    // would cover the page.
    .filter((c) => c.alpha > 0 && (c.path[0] ?? 0) >= 0)
    // Under some of the page's own content (only top-level, non-dialog
    // layers — a nested one is inside its parent's capture anyway, and a
    // dialog is the very thing being reported).
    .filter((c) => c.parent !== null || isTopLayer(c.el) || isDialogLike(c.el) || !isBuriedUnderPage(c.el, all))
    .sort((a, b) => comparePaths(a.path, b.path) || a.order - b.order);

  if (candidates.length > MAX_LAYERS) {
    console.warn(
      `[feedback] ${candidates.length} layers on screen; capturing the top ${MAX_LAYERS}, the rest are left as the page capture draws them`,
    );
    candidates.splice(0, candidates.length - MAX_LAYERS);
  }

  const kept = new Set(candidates.map((c) => c.el));
  const hasBackdrop =
    candidates.some((c) => backdropFill(c.el, c.alpha) !== null) || candidates.some((c) => isTopLayer(c.el));

  const shots = await Promise.all(
    candidates.map(async (c): Promise<OverlayShot | null> => {
      const r = c.el.getBoundingClientRect();
      const rect = { left: r.left, top: r.top, width: r.width, height: r.height };
      const fill = backdropFill(c.el, c.alpha);
      if (fill) {
        return {
          dataUrl: "",
          width: 0,
          height: 0,
          rect,
          fill,
          backdropColor: null,
          isBackdrop: true,
          isModal: false,
          alpha: 1,
          element: c.el,
        };
      }
      let backdropColor: string | null = null;
      if (c.el.tagName === "DIALOG" && isTopLayer(c.el)) {
        const bd = parseColor(getComputedStyle(c.el, "::backdrop").backgroundColor);
        if (bd && bd.a > 0.02) backdropColor = `rgba(${bd.r}, ${bd.g}, ${bd.b}, ${bd.a})`;
      }
      // Nested layers are captured on their own; keep them out of this clone.
      const nested = new Set(candidates.filter((o) => o.parent === c.el && kept.has(o.el)).map((o) => o.el));
      const shot = await Promise.race([
        captureElement(c.el, {
          scale: options.scale,
          transparent: true,
          exclude: nested,
          resourceTimeoutMs: LAYER_RESOURCE_TIMEOUT_MS,
        }),
        timeout(LAYER_BUDGET_MS),
      ]);
      if (!shot) {
        console.warn("[feedback] a layer could not be captured in time; the page capture draws it instead");
        return null;
      }
      return {
        dataUrl: shot.dataUrl,
        width: shot.width,
        height: shot.height,
        rect,
        fill: null,
        backdropColor,
        isBackdrop: false,
        isModal:
          isDialogLike(c.el) &&
          (hasBackdrop || c.el.matches('[aria-modal="true"], [data-modal], [role="alertdialog"]')),
        alpha: c.alpha,
        element: c.el,
      };
    }),
  );
  return shots.filter((s): s is OverlayShot => s !== null);
}

/**
 * Draw the captured layers back onto the page screenshot at their viewport
 * positions, bottom-most first — so a backdrop dims exactly what it dimmed on
 * screen (the page, and a chat panel under it) and a modal sits bright on top.
 * The page screenshot IS the viewport, so viewport rects line up directly; the
 * scale is DERIVED from the canvas actually produced (a recomputed ratio drew
 * layers at the wrong size in the sibling project).
 */
export async function stitchOverlays(
  main: ScreenshotData,
  overlays: OverlayShot[],
  scale?: number,
): Promise<ScreenshotData> {
  if (overlays.length === 0 || typeof document === "undefined") return main;

  const loadImage = (src: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("image failed to decode"));
      img.src = src;
    });

  try {
    const mainImg = await loadImage(main.dataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = mainImg.width;
    canvas.height = mainImg.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return main;

    ctx.drawImage(mainImg, 0, 0);
    const s = scale ?? mainImg.width / window.innerWidth;

    for (const layer of overlays) {
      if (layer.backdropColor) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = layer.backdropColor;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      const x = Math.round(layer.rect.left * s);
      const y = Math.round(layer.rect.top * s);
      const w = Math.round(layer.rect.width * s);
      const h = Math.round(layer.rect.height * s);
      if (layer.fill) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = layer.fill;
        ctx.fillRect(x, y, w, h);
        continue;
      }
      try {
        const img = await loadImage(layer.dataUrl);
        ctx.globalAlpha = layer.alpha ?? 1;
        ctx.drawImage(img, x, y, w, h);
      } catch {
        /* one undecodable layer must not cost the others */
      }
    }
    ctx.globalAlpha = 1;

    return {
      dataUrl: canvas.toDataURL("image/jpeg", 0.92),
      width: canvas.width,
      height: canvas.height,
      capturedAt: Date.now(),
    };
  } catch {
    // Stitching is an enhancement; a failure falls back to the page screenshot.
    return main;
  }
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const parts = dataUrl.split(",");
  const mime = parts[0]?.match(/:(.*?);/)?.[1] ?? "image/jpeg";
  const binary = atob(parts[1] ?? "");
  let n = binary.length;
  const bytes = new Uint8Array(n);
  while (n--) bytes[n] = binary.charCodeAt(n);
  return new Blob([bytes], { type: mime });
}

/** A capture that produced (almost) nothing is a failure, not a screenshot. */
export function isUsableScreenshot(dataUrl: string | undefined): dataUrl is string {
  return !!dataUrl && dataUrl.length > 100 && dataUrl.startsWith("data:image/");
}
