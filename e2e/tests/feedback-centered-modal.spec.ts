import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";

/**
 * The CENTERED modal — the shape almost every real dialog has, and the one the
 * first capture spec never exercised (its modal sat at a fixed left/top).
 *
 * shadcn/Radix dialogs centre themselves with `left:50%; top:50%` plus a -50%
 * shift. On Tailwind v4 that shift is the independent CSS `translate` property
 * (computed `transform` is literally "none"); on Tailwind v3 it is
 * `transform: translate(-50%,-50%)`. A capture library that inlines those
 * computed styles onto the clone it rasterises shifts half the panel out of the
 * capture box — the stitched screenshot shows only a CORNER of the modal. The
 * sibling project (Riddler Go) shipped that bug twice before pinning it.
 *
 * Each modal carries four solid markers in its four inner corners. All four must
 * survive to their true viewport positions: a corner-only capture loses three,
 * a mis-scaled stitch misplaces them.
 */

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(here, "..", "fixtures", "feedback-capture.bundle.js");

type RGB = { r: number; g: number; b: number };
const MARKS: Record<string, RGB> = {
  tl: { r: 255, g: 0, b: 0 },
  tr: { r: 0, g: 200, b: 0 },
  bl: { r: 0, g: 0, b: 255 },
  br: { r: 255, g: 0, b: 255 },
};

/** A centred modal panel; `centering` is the CSS that does the -50% shift. */
function centredModal(centering: string, extra = ""): string {
  return `
    document.body.innerHTML = '';
    document.body.style.cssText = 'margin:0;background:rgb(230,230,230)';
    const filler = document.createElement('div');
    filler.style.cssText = 'height:2400px;padding:24px;font:16px sans-serif;color:#333';
    filler.textContent = 'Background page content behind a centred modal.';
    document.body.appendChild(filler);
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000';
    document.body.appendChild(backdrop);
    const modal = document.createElement('div');
    modal.setAttribute('role','dialog');
    modal.setAttribute('aria-modal','true');
    modal.style.cssText = 'position:fixed;left:50%;top:50%;width:480px;height:320px;z-index:1001;background:#fff;border-radius:12px;${centering}';
    const mk = (name, rgb, pos) => '<div data-marker="' + name + '" style="position:absolute;' + pos + ';width:48px;height:48px;background:rgb(' + rgb + ')"></div>';
    modal.innerHTML =
      mk('tl','255,0,0','left:12px;top:12px') +
      mk('tr','0,200,0','right:12px;top:12px') +
      mk('bl','0,0,255','left:12px;bottom:12px') +
      mk('br','255,0,255','right:12px;bottom:12px') +
      '<p style="position:absolute;left:80px;top:140px;font:16px sans-serif">Centred dialog content</p>';
    document.body.appendChild(modal);
    ${extra}
  `;
}

const SCENARIOS = {
  // Tailwind v4: -translate-x-1/2 -translate-y-1/2 emits the `translate` property.
  "tailwind-v4-translate": centredModal("translate:-50% -50%"),
  // Tailwind v3 / older shadcn: the shift lives in `transform`.
  "tailwind-v3-transform": centredModal("transform:translate(-50%,-50%)"),
  // Same modal with the page scrolled — the stitch must still land on the viewport.
  "scrolled-page": centredModal("translate:-50% -50%", "window.scrollTo(0, 700);"),
} as const;

async function run(page: Page, scenario: keyof typeof SCENARIOS) {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.setContent("<!doctype html><html><head></head><body></body></html>");
  await page.addScriptTag({ path: BUNDLE });

  return page.evaluate(async (setup) => {
    // eslint-disable-next-line no-eval
    eval(setup);
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    // Marker centres in VIEWPORT px, read from the live DOM.
    const markers: Record<string, { x: number; y: number }> = {};
    document.querySelectorAll<HTMLElement>("[data-marker]").forEach((el) => {
      const r = el.getBoundingClientRect();
      markers[el.dataset.marker!] = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });

    const cap = (window as unknown as {
      FeedbackCapture: {
        captureScreenshot: (o?: { excludeElements?: Set<Element> }) => Promise<{ dataUrl: string; width: number; height: number }>;
        captureOverlays: () => Promise<Array<{ isModal: boolean; isBackdrop: boolean; dataUrl: string }>>;
        stitchOverlays: (m: unknown, o: unknown) => Promise<{ dataUrl: string; width: number; height: number }>;
      };
    }).FeedbackCapture;

    const overlays = await cap.captureOverlays();
    // Production composition: the captured layers are left out of the page
    // capture, so the overlay path alone must supply them.
    const pageShot = await cap.captureScreenshot({
      excludeElements: new Set(overlays.map((o) => (o as unknown as { element: Element }).element)),
    });
    const stitched = await cap.stitchOverlays(pageShot, overlays);

    const load = (src: string) =>
      new Promise<HTMLImageElement>((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = rej;
        i.src = src;
      });
    const img = await load(stitched.dataUrl);
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
    const sampled: Record<string, { r: number; g: number; b: number }> = {};
    for (const [k, p] of Object.entries(markers)) sampled[k] = at(p.x, p.y);

    // The backdrop is its own layer; keep the panel capture for eyeballing.
    const panels = overlays.filter((o) => !o.isBackdrop);
    return {
      dataUrl: stitched.dataUrl,
      overlayUrl: panels[0]?.dataUrl ?? null,
      overlayCount: panels.length,
      backdropCount: overlays.length - panels.length,
      isModal: panels[0]?.isModal ?? null,
      sampled,
    };
  }, SCENARIOS[scenario]);
}

function near(a: RGB, b: RGB, tol = 60): boolean {
  return Math.abs(a.r - b.r) <= tol && Math.abs(a.g - b.g) <= tol && Math.abs(a.b - b.b) <= tol;
}

function savePng(name: string, dataUrl: string | null): void {
  if (!dataUrl) return;
  const b64 = dataUrl.split(",")[1] ?? "";
  writeFileSync(join(here, "..", "test-results", `${name}.png`), Buffer.from(b64, "base64"));
}

for (const dpr of [1, 1.5]) {
  test.describe(`device pixel ratio ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });
    for (const scenario of Object.keys(SCENARIOS) as Array<keyof typeof SCENARIOS>) {
      test(`${scenario}: the whole centred modal lands at its true position`, async ({ page }) => {
        const r = await run(page, scenario);
        savePng(`centred-${scenario}-dpr${dpr}`, r.dataUrl);
        savePng(`centred-${scenario}-dpr${dpr}-overlay`, r.overlayUrl);
        expect(r.overlayCount).toBe(1);
        expect(r.backdropCount).toBe(1);
        expect(r.isModal).toBe(true);
        for (const [corner, want] of Object.entries(MARKS)) {
          const got = r.sampled[corner];
          expect(got, `marker ${corner} missing`).toBeTruthy();
          expect(near(got!, want), `${corner} corner marker was ${JSON.stringify(got)}, want ${JSON.stringify(want)}`).toBe(true);
        }
      });
    }
  });
}
