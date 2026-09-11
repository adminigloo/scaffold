import { domToCanvas } from "modern-screenshot";
import type { ScreenshotData } from "./types.js";

/**
 * Ported from Ask Lou's proven capture path. Strategy: render the full page
 * to a canvas with scroll positions restored (so a table scrolled sideways
 * shows its right-hand columns), then crop to the viewport rect — the
 * screenshot is exactly what the reporter was looking at.
 */

export interface ScreenshotOptions {
  scale?: number;
  quality?: number;
  redactSensitiveFields?: boolean;
  excludeSelectors?: string[];
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
