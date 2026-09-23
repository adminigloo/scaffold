import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";

/**
 * The feedback screenshot capture, in a real browser.
 *
 * This is the test that would have caught the bug we chased by hand: a full-page
 * capture drops position:fixed overlays, so a report about a modal showed only
 * the page behind it. And it guards the sibling-project failure mode too — an
 * in-flow dialog getting double-drawn and the whole page wrongly dimmed.
 *
 * Each scenario builds a real DOM, runs the actual capture+stitch, then reads
 * pixels out of the result. Colours are the assertions: a bright marker inside
 * the overlay must survive to its viewport position, and the page behind it must
 * be dimmed ONLY when a real modal is open.
 */

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(here, "..", "fixtures", "feedback-capture.bundle.js");

const BG = { r: 230, g: 230, b: 230 }; // body background — dimmed => much darker
const MODAL_MARK = { r: 255, g: 0, b: 255 }; // magenta
const CHAT_MARK = { r: 0, g: 128, b: 255 }; // blue
const INFLOW_MARK = { r: 0, g: 200, b: 0 }; // green

/** The DOM each scenario injects. Kept in the browser as a string the page runs. */
// Each overlay carries a solid-colour CHILD marked [data-marker]. The marker is
// a CHILD, not the overlay's own background, on purpose: captureElement paints
// the captured element's own background white (matching Ask Lou), so a marker on
// the root would whiten — but a child's colour survives, which is what proves
// the overlay's CONTENT (not just an empty white box) was captured and placed
// at the right spot.
const SCENARIOS = {
  modal: `
    document.body.innerHTML = '';
    document.body.style.background = 'rgb(230,230,230)';
    const filler = document.createElement('div');
    filler.style.cssText = 'height:2000px;padding:24px;font:16px sans-serif;color:#333';
    filler.textContent = 'Background page content that must end up dimmed behind the modal.';
    document.body.appendChild(filler);
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000';
    document.body.appendChild(backdrop);
    const modal = document.createElement('div');
    modal.setAttribute('role','dialog');
    modal.setAttribute('aria-modal','true');
    modal.style.cssText = 'position:fixed;left:200px;top:150px;width:400px;height:300px;z-index:1001;background:#fff';
    modal.innerHTML = '<div data-marker style="position:absolute;left:60px;top:100px;width:160px;height:100px;background:rgb(255,0,255)"></div>';
    document.body.appendChild(modal);
  `,
  chat: `
    document.body.innerHTML = '';
    document.body.style.background = 'rgb(230,230,230)';
    const filler = document.createElement('div');
    filler.style.cssText = 'height:2000px;padding:24px;font:16px sans-serif;color:#333';
    filler.textContent = 'Background page content that must stay bright behind a side panel.';
    document.body.appendChild(filler);
    const chat = document.createElement('div');
    chat.setAttribute('data-chat-panel','');
    chat.style.cssText = 'position:fixed;right:24px;bottom:24px;width:320px;height:420px;z-index:1000;background:#fff';
    chat.innerHTML = '<div data-marker style="position:absolute;left:40px;top:140px;width:160px;height:100px;background:rgb(0,128,255)"></div>';
    document.body.appendChild(chat);
  `,
  inflow: `
    document.body.innerHTML = '';
    document.body.style.background = 'rgb(230,230,230)';
    const dlg = document.createElement('div');
    dlg.setAttribute('role','dialog');
    dlg.style.cssText = 'position:static;margin:120px auto;width:400px;height:300px;background:#fff';
    dlg.innerHTML = '<div data-marker style="position:absolute;left:60px;top:100px;width:160px;height:100px;background:rgb(0,200,0)"></div>';
    document.body.appendChild(dlg);
    const filler = document.createElement('div');
    filler.style.cssText = 'height:1500px';
    document.body.appendChild(filler);
  `,
} as const;

/** Runs a scenario in the page: builds DOM, captures, stitches, samples pixels. */
async function run(page: import("@playwright/test").Page, scenario: keyof typeof SCENARIOS) {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.setContent("<!doctype html><html><head></head><body></body></html>");
  await page.addScriptTag({ path: BUNDLE });

  return page.evaluate(async (setup) => {
    // eslint-disable-next-line no-eval
    eval(setup);
    // The coloured marker child inside the overlay, and a background sample
    // point, in viewport px. Sampling the marker proves the overlay's content
    // landed at the right place — not just that a white box appeared.
    const markerEl = document.querySelector<HTMLElement>("[data-marker]");
    const rect = markerEl!.getBoundingClientRect();
    const markerPt = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    // A background point well away from any overlay AND any text — left column,
    // below the one-line filler, left of the modal/chat/dialog in every scenario.
    const bgPt = { x: 60, y: 400 };

    const cap = (window as unknown as {
      FeedbackCapture: {
        captureScreenshot: () => Promise<{ dataUrl: string; width: number; height: number }>;
        captureOverlays: () => Promise<Array<{ isModal: boolean }>>;
        stitchOverlays: (m: unknown, o: unknown) => Promise<{ dataUrl: string; width: number; height: number }>;
      };
    }).FeedbackCapture;

    const overlays = await cap.captureOverlays();
    const pageShot = await cap.captureScreenshot();
    const stitched = await cap.stitchOverlays(pageShot, overlays);

    // Read pixels out of the stitched result.
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = stitched.dataUrl;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const scale = img.width / window.innerWidth;
    const at = (x: number, y: number) => {
      const d = ctx.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data;
      return { r: d[0], g: d[1], b: d[2] };
    };

    return {
      dataUrl: stitched.dataUrl,
      overlayCount: overlays.length,
      isModal: overlays[0]?.isModal ?? null,
      marker: at(markerPt.x, markerPt.y),
      bg: at(bgPt.x, bgPt.y),
    };
  }, SCENARIOS[scenario]);
}

function near(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }, tol = 60): boolean {
  return Math.abs(a.r - b.r) <= tol && Math.abs(a.g - b.g) <= tol && Math.abs(a.b - b.b) <= tol;
}

function savePng(name: string, dataUrl: string): void {
  const b64 = dataUrl.split(",")[1] ?? "";
  writeFileSync(join(here, "..", "test-results", `${name}.png`), Buffer.from(b64, "base64"));
}

test("a fixed modal is captured and the page behind it is dimmed", async ({ page }) => {
  const r = await run(page, "modal");
  savePng("modal", r.dataUrl);
  // The overlay was captured as exactly one modal.
  expect(r.overlayCount).toBe(1);
  expect(r.isModal).toBe(true);
  // The modal's magenta marker survived to its viewport position (it was drawn
  // on top, after the tint, so it stays bright).
  expect(near(r.marker, MODAL_MARK), `modal marker was ${JSON.stringify(r.marker)}`).toBe(true);
  // The page behind it is dimmed — noticeably darker than the 230 background.
  expect(r.bg.r, `bg should be dimmed, was ${JSON.stringify(r.bg)}`).toBeLessThan(190);
});

test("a fixed chat panel is captured but the page is NOT dimmed", async ({ page }) => {
  const r = await run(page, "chat");
  savePng("chat", r.dataUrl);
  expect(r.overlayCount).toBe(1);
  expect(r.isModal).toBe(false); // a side panel is not a modal
  expect(near(r.marker, CHAT_MARK), `chat marker was ${JSON.stringify(r.marker)}`).toBe(true);
  // No modal => no backdrop tint => the page stays bright.
  expect(r.bg.r, `bg should stay bright, was ${JSON.stringify(r.bg)}`).toBeGreaterThan(200);
});

test("an in-flow dialog is NOT re-captured and the page is NOT dimmed", async ({ page }) => {
  const r = await run(page, "inflow");
  savePng("inflow", r.dataUrl);
  // It is already in the full-page shot, so it must not be captured again.
  expect(r.overlayCount).toBe(0);
  // Its green is still there (from the page capture)...
  expect(near(r.marker, INFLOW_MARK), `inflow marker was ${JSON.stringify(r.marker)}`).toBe(true);
  // ...and nothing dimmed the page (the double-draw/over-dim bug).
  expect(r.bg.r, `bg should stay bright, was ${JSON.stringify(r.bg)}`).toBeGreaterThan(200);
});
