import { domToCanvas } from "modern-screenshot";
import type { ScreenshotData } from "./types.js";

/**
 * Ported from Ask Lou's proven capture path. Strategy: render the full page
 * to a canvas with scroll positions restored (so a table scrolled sideways
 * shows its right-hand columns), then crop to the viewport rect — the
 * screenshot is exactly what the reporter was looking at.
 *
 * THE POSITION:FIXED PROBLEM, AND WHY THIS FILE IS MORE THAN ONE CALL.
 * `domToCanvas` clones the DOM to rasterise it, and a clone loses the fixed
 * positioning context — so `position: fixed` overlays (a modal, a dialog, an
 * open AI chat panel) DO NOT APPEAR in a full-page capture. A reporter with a
 * modal open who submits feedback about that modal would get a screenshot of
 * the page BEHIND it, which is the one thing they were not looking at. This cost
 * real work to diagnose the first time.
 *
 * The fix, kept here so it cannot be lost in a port again: capture each fixed
 * overlay INDIVIDUALLY (where it is the capture root, so fixed positioning is
 * moot), record its viewport rect, then STITCH the overlays back onto the
 * full-page screenshot at those rects. `captureScreenshot` does the page;
 * `captureOverlays` does the overlays; `stitchOverlays` composites them. The
 * caller runs `captureOverlays` BEFORE opening its own UI (so the reporter's
 * modal is still on screen) and stitches after.
 */

export interface ScreenshotOptions {
  scale?: number;
  quality?: number;
  redactSensitiveFields?: boolean;
  excludeSelectors?: string[];
}

/**
 * What makes an element an "overlay" worth capturing separately. Accessible
 * modals and dialogs announce themselves with these roles, so most are caught
 * with no work from the host app; anything else — a bespoke chat panel, a
 * command palette — opts in with `data-feedback-overlay`. Matches Ask Lou's
 * opt-in-plus-roles approach rather than guessing from computed styles.
 */
export const DEFAULT_OVERLAY_SELECTORS = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  "[data-feedback-overlay]",
];

/** A captured overlay and where it sat in the viewport, for stitching. */
export interface OverlayShot {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
  readonly rect: { left: number; top: number; width: number; height: number };
}

/**
 * Values in these fields are swapped for bullets before capture and restored
 * in a `finally` — a feedback tool that screenshots passwords is a breach,
 * not a feature.
 */
const SENSITIVE_SELECTORS = [
  'input[type="password"]',
  'input[name*="password"]',
  'input[name*="ssn"]',
  'input[name*="social"]',
  'input[name*="credit"]',
  'input[name*="card"]',
  'input[name*="cvv"]',
  'input[name*="cvc"]',
  'input[name*="secret"]',
  'input[name*="token"]',
  'input[name*="api_key"]',
  'input[name*="apikey"]',
  '[data-sensitive="true"]',
];

function redactSensitiveFields(root: HTMLElement): void {
  for (const selector of SENSITIVE_SELECTORS) {
    root.querySelectorAll<HTMLInputElement>(selector).forEach((el) => {
      if (el.value) {
        el.dataset.aifOriginalValue = el.value;
        el.value = "••••••••";
      }
    });
  }
}

function restoreSensitiveFields(root: HTMLElement): void {
  for (const selector of SENSITIVE_SELECTORS) {
    root.querySelectorAll<HTMLInputElement>(selector).forEach((el) => {
      if (el.dataset.aifOriginalValue !== undefined) {
        el.value = el.dataset.aifOriginalValue;
        delete el.dataset.aifOriginalValue;
      }
    });
  }
}

function cropToViewport(
  source: HTMLCanvasElement,
  scrollX: number,
  scrollY: number,
  viewportWidth: number,
  viewportHeight: number,
  scale: number,
): HTMLCanvasElement {
  const cropped = document.createElement("canvas");
  cropped.width = Math.round(viewportWidth * scale);
  cropped.height = Math.round(viewportHeight * scale);
  const ctx = cropped.getContext("2d");
  if (ctx) {
    // White underlay first: content shorter than the viewport leaves
    // transparent regions in the source that would export as black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, cropped.width, cropped.height);
    ctx.drawImage(
      source,
      Math.round(scrollX * scale),
      Math.round(scrollY * scale),
      cropped.width,
      cropped.height,
      0,
      0,
      cropped.width,
      cropped.height,
    );
  }
  return cropped;
}

export async function captureScreenshot(options: ScreenshotOptions = {}): Promise<ScreenshotData> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("screenshot capture only runs in the browser");
  }
  const scale = options.scale ?? Math.min(window.devicePixelRatio || 1, 2);
  const quality = options.quality ?? 0.92;
  const redact = options.redactSensitiveFields ?? true;
  const excludeSelectors = [
    "[data-aif-modal]",
    "[role='tooltip']",
    // Radix (and libraries that follow its shape) portal popovers/menus into
    // this wrapper; they are position:fixed and would stitch wrong if half-drawn.
    "[data-radix-popper-content-wrapper]",
    ...(options.excludeSelectors ?? []),
  ];
  const element = document.documentElement;

  // Snapshot scroll and viewport before any async work moves them.
  const scrollX = window.scrollX || 0;
  const scrollY = window.scrollY || 0;
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;

  try {
    if (redact) redactSensitiveFields(element);

    const fullCanvas = await domToCanvas(element, {
      scale,
      backgroundColor: "#ffffff",
      timeout: 15000,
      features: { restoreScrollPosition: true },
      filter: (node: Node) => {
        if (!(node instanceof HTMLElement)) return true;
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

    const cropped = cropToViewport(fullCanvas, scrollX, scrollY, viewportW, viewportH, scale);
    return {
      dataUrl: cropped.toDataURL("image/jpeg", quality),
      width: cropped.width,
      height: cropped.height,
      capturedAt: Date.now(),
    };
  } finally {
    if (redact) restoreSensitiveFields(element);
  }
}

/**
 * Capture a single element as its own screenshot — the escape hatch for a
 * `position: fixed` overlay the full-page capture drops. Here the element IS the
 * capture root, so its fixed positioning never enters the equation. Returns null
 * on failure so a broken overlay never fails the whole report.
 */
export async function captureElement(
  element: HTMLElement,
  options: { scale?: number; quality?: number } = {},
): Promise<ScreenshotData | null> {
  if (typeof window === "undefined") return null;
  const scale = options.scale ?? Math.min(window.devicePixelRatio || 1, 2);
  const quality = options.quality ?? 0.92;
  try {
    const canvas = await domToCanvas(element, {
      scale,
      backgroundColor: "#ffffff",
      timeout: 8000,
    });
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    if (!dataUrl || dataUrl.length < 100) return null;
    return { dataUrl, width: canvas.width, height: canvas.height, capturedAt: Date.now() };
  } catch {
    return null;
  }
}

/**
 * Find the open `position: fixed` overlays and capture each one, with its
 * viewport rect, so they can be stitched back onto the page screenshot.
 *
 * MUST RUN BEFORE THE FEEDBACK UI OPENS — that is the whole point. Once the
 * widget's own modal is up it can steal focus and close the reporter's dialog,
 * and then there is nothing left to capture. Elements inside the widget's own
 * UI (`[data-aif-modal]`) are skipped, as are ones nested inside another overlay
 * already captured (so a dialog and its close button are not shot twice), and
 * anything too small to be a real panel.
 */
export async function captureOverlays(
  selectors: string[] = DEFAULT_OVERLAY_SELECTORS,
  options: { scale?: number; quality?: number } = {},
): Promise<OverlayShot[]> {
  if (typeof document === "undefined") return [];

  const found = new Set<HTMLElement>();
  for (const selector of selectors) {
    try {
      document.querySelectorAll<HTMLElement>(selector).forEach((el) => found.add(el));
    } catch {
      /* a bad caller selector must not sink the capture */
    }
  }

  const candidates = [...found].filter((el) => {
    // Not the widget's own surface.
    if (el.closest("[data-aif-modal]")) return false;
    // Real, visible panels only.
    if (el.offsetWidth < 20 || el.offsetHeight < 20) return false;
    // Skip a match nested inside another match — capture the outermost so the
    // stitched overlay is the whole panel, drawn once.
    for (const other of found) {
      if (other !== el && other.contains(el)) return false;
    }
    return true;
  });

  const shots: OverlayShot[] = [];
  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    const shot = await captureElement(el, options);
    if (shot) {
      shots.push({
        dataUrl: shot.dataUrl,
        width: shot.width,
        height: shot.height,
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      });
    }
  }
  return shots;
}

/**
 * Draw the captured overlays back onto the page screenshot at their viewport
 * positions. A semi-transparent tint goes down first when there is at least one
 * overlay, standing in for the backdrop the page capture could not see — so the
 * result reads as "a modal, over a dimmed page", which is what the reporter saw.
 * Rects are viewport-relative and the main screenshot is already cropped to the
 * viewport, so the coordinates line up directly.
 */
export async function stitchOverlays(
  main: ScreenshotData,
  overlays: OverlayShot[],
  scale = Math.min((typeof window !== "undefined" && window.devicePixelRatio) || 1, 2),
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
    // The backdrop the fixed-overlay capture skipped.
    ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (const overlay of overlays) {
      const img = await loadImage(overlay.dataUrl);
      ctx.drawImage(
        img,
        Math.round(overlay.rect.left * scale),
        Math.round(overlay.rect.top * scale),
        Math.round(overlay.rect.width * scale),
        Math.round(overlay.rect.height * scale),
      );
    }

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
