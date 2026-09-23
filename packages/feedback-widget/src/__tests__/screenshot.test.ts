import { describe, expect, it } from "vitest";
import {
  captureElement,
  captureOverlays,
  DEFAULT_OVERLAY_SELECTORS,
  isUsableScreenshot,
  stitchOverlays,
} from "../screenshot.js";
import type { ScreenshotData } from "../types.js";

/**
 * These run in the node test environment — no DOM, no canvas — so they pin the
 * contracts that hold WITHOUT a browser: the SSR guards and the no-op paths.
 * The canvas compositing itself is a faithful port of Ask Lou's proven capture
 * and is exercised in the browser, not here.
 */

const main: ScreenshotData = {
  dataUrl: "data:image/jpeg;base64,AAAA",
  width: 100,
  height: 100,
  capturedAt: 0,
};

describe("screenshot capture contracts", () => {
  it("defaults to catching accessible dialogs and the opt-in attribute", () => {
    expect(DEFAULT_OVERLAY_SELECTORS).toContain('[role="dialog"]');
    expect(DEFAULT_OVERLAY_SELECTORS).toContain('[role="alertdialog"]');
    expect(DEFAULT_OVERLAY_SELECTORS).toContain("[data-feedback-overlay]");
  });

  it("captureOverlays is a no-op without a document (SSR / node)", async () => {
    await expect(captureOverlays()).resolves.toEqual([]);
  });

  it("captureElement returns null without a window (SSR / node)", async () => {
    await expect(captureElement({} as HTMLElement)).resolves.toBeNull();
  });

  it("stitchOverlays returns the page screenshot unchanged when there is nothing to stitch", async () => {
    await expect(stitchOverlays(main, [])).resolves.toBe(main);
  });

  it("stitchOverlays does not throw or hang when overlays exist but no DOM does", async () => {
    // In node there is no document to build a canvas with; the function must
    // degrade to the page screenshot rather than crash on `new Image()`.
    const shot = await stitchOverlays(main, [
      { dataUrl: main.dataUrl, width: 10, height: 10, rect: { left: 0, top: 0, width: 10, height: 10 } },
    ]);
    expect(shot).toBe(main);
  });

  it("isUsableScreenshot rejects empty, short, and non-image payloads", () => {
    expect(isUsableScreenshot(undefined)).toBe(false);
    expect(isUsableScreenshot("")).toBe(false);
    expect(isUsableScreenshot("data:image/jpeg;base64,short")).toBe(false);
    expect(isUsableScreenshot(`data:image/jpeg;base64,${"A".repeat(200)}`)).toBe(true);
    expect(isUsableScreenshot(`${"A".repeat(200)}`)).toBe(false);
  });
});
