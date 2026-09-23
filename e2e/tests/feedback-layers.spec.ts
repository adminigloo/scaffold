import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";

/**
 * Every fixed layer, not just modals. A full-page capture drops ALL of them —
 * the fixed header, a cookie banner, a toast, a popover, an AI chat panel — so
 * `captureOverlays` finds them by computed style and puts each back where it was,
 * in paint order. Each scenario reads colours out of the real stitched image.
 */

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(here, "..", "fixtures", "feedback-capture.bundle.js");

type RGB = { r: number; g: number; b: number };
const near = (a: RGB, b: RGB, tol = 50) =>
  Math.abs(a.r - b.r) <= tol && Math.abs(a.g - b.g) <= tol && Math.abs(a.b - b.b) <= tol;

interface Layer {
  isBackdrop: boolean;
  isModal: boolean;
}
interface Run {
  dataUrl: string;
  layers: Layer[];
  colours: Record<string, RGB>;
  extra: unknown;
}

/**
 * Build the DOM (`setup` runs in the page), sample `[data-probe]` elements'
 * centres (or explicit points) in the stitched result.
 */
async function run(
  page: Page,
  setup: string,
  points: Record<string, { x: number; y: number }> = {},
  viewport = { width: 1000, height: 700 },
): Promise<Run> {
  await page.setViewportSize(viewport);
  await page.setContent("<!doctype html><html><head></head><body></body></html>");
  await page.addScriptTag({ path: BUNDLE });
  return page.evaluate(
    async ({ setup, points }) => {
      const w = window as unknown as { __extra?: unknown; FeedbackCapture: any };
      // eslint-disable-next-line no-eval
      eval(setup);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const probes: Record<string, { x: number; y: number }> = { ...points };
      document.querySelectorAll<HTMLElement>("[data-probe]").forEach((el) => {
        const r = el.getBoundingClientRect();
        probes[el.dataset.probe!] = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      const cap = w.FeedbackCapture;
      const overlays = await cap.captureOverlays();
      const pageShot = await cap.captureScreenshot({
        excludeElements: new Set(overlays.map((o: { element: Element }) => o.element)),
      });
      const stitched = await cap.stitchOverlays(pageShot, overlays);
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = stitched.dataUrl;
      });
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const s = img.width / window.innerWidth;
      const colours: Record<string, { r: number; g: number; b: number }> = {};
      for (const [k, p] of Object.entries(probes)) {
        const d = ctx.getImageData(Math.round(p.x * s), Math.round(p.y * s), 1, 1).data;
        colours[k] = { r: d[0], g: d[1], b: d[2] };
      }
      return {
        dataUrl: stitched.dataUrl,
        layers: overlays.map((o: Layer) => ({ isBackdrop: o.isBackdrop, isModal: o.isModal })),
        colours,
        extra: w.__extra ?? null,
      };
    },
    { setup, points },
  );
}

const save = (name: string, dataUrl: string) =>
  writeFileSync(join(here, "..", "test-results", `${name}.png`), Buffer.from(dataUrl.split(",")[1] ?? "", "base64"));

const PAGE = `
  document.body.style.cssText = 'margin:0;background:rgb(230,230,230);font:16px sans-serif';
  const filler = document.createElement('div');
  filler.style.cssText = 'height:3000px;padding-top:80px';
  for (let i = 0; i < 60; i++) {
    const p = document.createElement('p');
    p.textContent = 'Page row ' + i;
    p.style.margin = '0 24px 30px';
    filler.appendChild(p);
  }
  document.body.appendChild(filler);
`;

test("a scrolled page keeps its fixed header and banner, and the chat shows its LATEST message", async ({ page }) => {
  const r = await run(
    page,
    `${PAGE}
    const header = document.createElement('header');
    header.style.cssText = 'position:fixed;left:0;right:0;top:0;height:56px;background:rgb(255,140,0);z-index:10';
    header.setAttribute('data-probe','header');
    document.body.appendChild(header);
    const banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:60px;background:rgb(0,160,160);z-index:10';
    banner.setAttribute('data-probe','banner');
    document.body.appendChild(banner);
    const chat = document.createElement('div');
    chat.setAttribute('data-chat-panel','');
    chat.style.cssText = 'position:fixed;right:24px;bottom:90px;width:300px;height:360px;background:#fff;z-index:20;display:flex;flex-direction:column';
    const list = document.createElement('div');
    list.style.cssText = 'flex:1;overflow-y:auto';
    for (let i = 0; i < 30; i++) {
      const m = document.createElement('div');
      m.style.cssText = 'height:40px;margin:6px;background:' + (i === 29 ? 'rgb(255,0,255)' : i === 0 ? 'rgb(0,0,255)' : 'rgb(200,200,200)');
      if (i === 29) m.setAttribute('data-probe','latest');
      list.appendChild(m);
    }
    chat.appendChild(list);
    document.body.appendChild(chat);
    list.scrollTop = list.scrollHeight;
    window.scrollTo(0, 900);`,
  );
  save("layers-scrolled-page", r.dataUrl);
  expect(near(r.colours.header!, { r: 255, g: 140, b: 0 }), `header ${JSON.stringify(r.colours.header)}`).toBe(true);
  expect(near(r.colours.banner!, { r: 0, g: 160, b: 160 }), `banner ${JSON.stringify(r.colours.banner)}`).toBe(true);
  expect(near(r.colours.latest!, { r: 255, g: 0, b: 255 }), `latest chat message ${JSON.stringify(r.colours.latest)}`).toBe(true);
});

test("a see-through fixed layer is drawn exactly once", async ({ page }) => {
  // Unscrolled, the page capture can render a fixed layer in place — and then
  // the stitch would draw it AGAIN on top. Opaque, that is invisible; a
  // translucent layer twice over is visibly darker. Half-blue over white is
  // (127,127,255) once, (64,64,255) twice.
  const r = await run(
    page,
    `document.body.style.cssText = 'margin:0;background:rgb(255,255,255)';
    const filler = document.createElement('div');
    filler.style.height = '2000px';
    document.body.appendChild(filler);
    const bar = document.createElement('div');
    bar.setAttribute('data-probe','bar');
    bar.style.cssText = 'position:fixed;left:0;right:0;top:100px;height:80px;background:rgba(0,0,255,0.5);z-index:10';
    bar.innerHTML = '<span style="font:12px sans-serif">translucent bar</span>';
    document.body.appendChild(bar);`,
  );
  save("layers-drawn-once", r.dataUrl);
  expect(near(r.colours.bar!, { r: 127, g: 127, b: 255 }, 20), `bar ${JSON.stringify(r.colours.bar)}`).toBe(true);
});

test("toasts in a zero-height fixed region are captured where they sit", async ({ page }) => {
  // Sonner's shape: a fixed <ol> with no height of its own, toasts absolutely
  // placed inside it and stacked with transforms.
  const r = await run(
    page,
    `${PAGE}
    const region = document.createElement('ol');
    region.style.cssText = 'position:fixed;right:24px;bottom:24px;width:356px;margin:0;padding:0;list-style:none;z-index:999';
    const toast = document.createElement('li');
    toast.setAttribute('data-probe','toast');
    toast.style.cssText = 'position:absolute;right:0;bottom:0;width:356px;height:64px;background:rgb(220,38,38);border-radius:8px;transform:translateY(-10px)';
    region.appendChild(toast);
    document.body.appendChild(region);`,
  );
  save("layers-toast", r.dataUrl);
  expect(near(r.colours.toast!, { r: 220, g: 38, b: 38 }), `toast ${JSON.stringify(r.colours.toast)}`).toBe(true);
});

test("a popover positioned by transform (Radix/floating-ui shape) lands where it was", async ({ page }) => {
  const r = await run(
    page,
    `${PAGE}
    const wrap = document.createElement('div');
    wrap.setAttribute('data-radix-popper-content-wrapper','');
    wrap.style.cssText = 'position:fixed;left:0;top:0;transform:translate(420px, 260px);z-index:50;min-width:max-content';
    wrap.innerHTML = '<div role="menu" data-probe="menu" style="width:200px;height:120px;background:rgb(16,185,129)"></div>';
    document.body.appendChild(wrap);`,
  );
  save("layers-popover", r.dataUrl);
  expect(near(r.colours.menu!, { r: 16, g: 185, b: 129 }), `menu ${JSON.stringify(r.colours.menu)}`).toBe(true);
});

test("a chat panel UNDER a modal's backdrop is dimmed; the modal on top is not (Ask Lou's layout)", async ({ page }) => {
  const r = await run(
    page,
    `${PAGE}
    const chat = document.createElement('div');
    chat.setAttribute('data-chat-panel','');
    chat.style.cssText = 'position:fixed;left:24px;bottom:24px;width:280px;height:300px;background:rgb(0,128,255);z-index:40';
    chat.setAttribute('data-probe','chat');
    document.body.appendChild(chat);
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:50';
    document.body.appendChild(backdrop);
    const modal = document.createElement('div');
    modal.setAttribute('role','dialog');
    modal.style.cssText = 'position:fixed;left:50%;top:50%;translate:-50% -50%;width:300px;height:200px;background:rgb(255,0,255);z-index:50';
    modal.setAttribute('data-probe','modal');
    document.body.appendChild(modal);`,
  );
  save("layers-chat-under-modal", r.dataUrl);
  // Chat: blue, half-dimmed by the 0.5 black backdrop => ~ (0,64,128).
  expect(near(r.colours.chat!, { r: 0, g: 64, b: 128 }, 30), `chat ${JSON.stringify(r.colours.chat)}`).toBe(true);
  // Modal: full-strength magenta, above the backdrop.
  expect(near(r.colours.modal!, { r: 255, g: 0, b: 255 }), `modal ${JSON.stringify(r.colours.modal)}`).toBe(true);
  expect(r.layers.filter((l) => l.isBackdrop).length).toBe(1);
  expect(r.layers.find((l) => !l.isBackdrop && l.isModal)).toBeTruthy();
});

test("a native <dialog> opened with showModal() is captured with its ::backdrop", async ({ page }) => {
  const r = await run(
    page,
    `${PAGE}
    const style = document.createElement('style');
    style.textContent = 'dialog::backdrop{background:rgba(0,0,0,0.6)}';
    document.head.appendChild(style);
    const d = document.createElement('dialog');
    d.style.cssText = 'width:320px;height:200px;padding:0;border:0;background:rgb(255,0,255)';
    d.innerHTML = '<div data-probe="native" style="width:100%;height:100%"></div>';
    document.body.appendChild(d);
    d.showModal();`,
    { page: { x: 60, y: 400 } },
  );
  save("layers-native-dialog", r.dataUrl);
  expect(near(r.colours.native!, { r: 255, g: 0, b: 255 }), `dialog ${JSON.stringify(r.colours.native)}`).toBe(true);
  // 230 grey under a 0.6 black backdrop => ~92.
  expect(near(r.colours.page!, { r: 92, g: 92, b: 92 }, 25), `page ${JSON.stringify(r.colours.page)}`).toBe(true);
});

test("finding layers stays cheap on a big page", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.setContent("<!doctype html><html><head></head><body></body></html>");
  await page.addScriptTag({ path: BUNDLE });
  const ms = await page.evaluate(async () => {
    // ~10,000 in-flow nodes, no fixed layers.
    const root = document.createElement("div");
    for (let i = 0; i < 1000; i++) {
      const row = document.createElement("div");
      row.innerHTML = "<span>a</span><span>b</span><span>c</span><em>d</em><b>e</b><i>f</i><u>g</u><s>h</s><small>j</small>";
      root.appendChild(row);
    }
    document.body.appendChild(root);
    const cap = (window as unknown as { FeedbackCapture: { captureOverlays: () => Promise<unknown[]> } }).FeedbackCapture;
    const t = performance.now();
    await cap.captureOverlays();
    return performance.now() - t;
  });
  console.log(`captureOverlays on ~10k nodes: ${ms.toFixed(1)}ms`);
  expect(ms).toBeLessThan(250);
});

test("[data-sensitive] CONTENT (not just inputs) is blacked out, on the page and inside a modal", async ({ page }) => {
  const r = await run(
    page,
    `${PAGE}
    const onPage = document.createElement('div');
    onPage.setAttribute('data-sensitive','true');
    onPage.setAttribute('data-probe','onPage');
    onPage.style.cssText = 'position:absolute;left:40px;top:120px;width:260px;height:60px;background:rgb(255,255,0);font:40px sans-serif';
    onPage.textContent = 'SSN 123-45-6789';
    document.body.appendChild(onPage);
    const modal = document.createElement('div');
    modal.setAttribute('role','dialog');
    modal.style.cssText = 'position:fixed;left:500px;top:150px;width:300px;height:200px;background:#fff;z-index:50';
    modal.innerHTML = '<div data-sensitive="true" data-probe="inModal" style="margin:40px;height:80px;background:rgb(255,255,0);font:40px sans-serif">sk-live-KEY</div>';
    document.body.appendChild(modal);`,
  );
  save("layers-sensitive", r.dataUrl);
  // Near-black (#111), not the element's yellow.
  for (const k of ["onPage", "inModal"]) {
    expect(near(r.colours[k]!, { r: 17, g: 17, b: 17 }, 25), `${k} ${JSON.stringify(r.colours[k])}`).toBe(true);
  }
  // And the live page is untouched afterwards.
  const live = await page.evaluate(() => getComputedStyle(document.querySelector("[data-probe='onPage']")!).backgroundColor);
  expect(live).toBe("rgb(255, 255, 0)");
});
