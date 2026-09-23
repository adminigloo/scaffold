import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";

/**
 * Capture regressions from the 2026-09-23 adversarial review, each reproduced
 * by a reviewer in Chromium before it was fixed. Every case runs the same
 * composition production runs: captureOverlays, then captureScreenshot with
 * the captured layers excluded, then stitchOverlays — and reads pixels back.
 */

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(here, "..", "fixtures", "feedback-capture.bundle.js");

type RGB = { r: number; g: number; b: number };
const near = (a: RGB, b: RGB, tol = 45) =>
  Math.abs(a.r - b.r) <= tol && Math.abs(a.g - b.g) <= tol && Math.abs(a.b - b.b) <= tol;

async function run(
  page: Page,
  setup: string,
  points: Record<string, { x: number; y: number }> = {},
  viewport = { width: 1000, height: 700 },
): Promise<{ dataUrl: string; colours: Record<string, RGB>; ms: number }> {
  await page.setViewportSize(viewport);
  await page.setContent("<!doctype html><html><head></head><body></body></html>");
  await page.addScriptTag({ path: BUNDLE });
  return page.evaluate(
    async ({ setup, points }) => {
      // eslint-disable-next-line no-eval
      await eval(`(async () => { ${setup} })()`);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const probes: Record<string, { x: number; y: number }> = { ...points };
      document.querySelectorAll<HTMLElement>("[data-probe]").forEach((el) => {
        const r = el.getBoundingClientRect();
        probes[el.dataset.probe!] = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      const cap = (window as unknown as { FeedbackCapture: any }).FeedbackCapture;
      const t = performance.now();
      const overlays = await cap.captureOverlays();
      const pageShot = await cap.captureScreenshot({
        excludeElements: new Set(overlays.map((o: { element: Element }) => o.element)),
      });
      const stitched = await cap.stitchOverlays(pageShot, overlays);
      const ms = performance.now() - t;
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
        colours[k] = { r: d[0]!, g: d[1]!, b: d[2]! };
      }
      return { dataUrl: stitched.dataUrl, colours, ms };
    },
    { setup, points },
  );
}

const save = (name: string, dataUrl: string) =>
  writeFileSync(join(here, "..", "test-results", `${name}.png`), Buffer.from(dataUrl.split(",")[1] ?? "", "base64"));

const GREY = { r: 230, g: 230, b: 230 };
const BASE = `document.body.style.cssText = 'margin:0;background:rgb(230,230,230);font:16px sans-serif';`;
const block = (probe: string, css: string, colour: string) =>
  `{ const d = document.createElement('div'); d.setAttribute('data-probe', '${probe}'); d.style.cssText = '${css};background:${colour}'; document.body.appendChild(d); }`;

test("a vertically scrolled page shows the region the reporter was looking at (not twice as far down)", async ({ page }) => {
  const r = await run(
    page,
    `${BASE}
    document.body.style.height = '4000px'; document.body.style.position = 'relative';
    ${block("blue", "position:absolute;left:300px;top:1000px;width:100px;height:100px", "rgb(0,0,255)")}
    ${block("red", "position:absolute;left:300px;top:1900px;width:100px;height:100px", "rgb(255,0,0)")}
    window.scrollTo(0, 900);`,
  );
  save("regress-scroll-y", r.dataUrl);
  // blue sits at viewport y=100..200 now; red is far below the viewport.
  expect(near(r.colours.blue!, { r: 0, g: 0, b: 255 }), `blue ${JSON.stringify(r.colours.blue)}`).toBe(true);
});

test("a horizontally scrolled page shows the right-hand columns in place", async ({ page }) => {
  const r = await run(
    page,
    `${BASE}
    document.body.style.width = '3000px'; document.body.style.height = '800px'; document.body.style.position = 'relative';
    ${block("green", "position:absolute;left:1300px;top:200px;width:100px;height:100px", "rgb(0,160,0)")}
    window.scrollTo(400, 0);`,
  );
  expect(near(r.colours.green!, { r: 0, g: 160, b: 0 }), `green ${JSON.stringify(r.colours.green)}`).toBe(true);
});

test("an app shell with a fixed inset-0 root (html has no height) still gets a screenshot", async ({ page }) => {
  const r = await run(
    page,
    `document.body.style.margin = '0';
    const shell = document.createElement('div');
    shell.style.cssText = 'position:fixed;inset:0;display:flex;background:#fff';
    shell.innerHTML = '<aside data-probe="side" style="width:220px;background:rgb(15,23,42)"></aside><main style="flex:1;overflow:auto"><div data-probe="card" style="margin:40px;height:200px;background:rgb(255,140,0)"></div></main>';
    document.body.appendChild(shell);`,
  );
  expect(near(r.colours.side!, { r: 15, g: 23, b: 42 }), `side ${JSON.stringify(r.colours.side)}`).toBe(true);
  expect(near(r.colours.card!, { r: 255, g: 140, b: 0 }), `card ${JSON.stringify(r.colours.card)}`).toBe(true);
});

test("a shadcn dialog on a phone (max-width: calc(100% - 2rem)) is captured full width", async ({ page }) => {
  const r = await run(
    page,
    `${BASE}
    const d = document.createElement('div');
    d.setAttribute('role','dialog');
    d.style.cssText = 'position:fixed;left:50%;top:50%;translate:-50% -50%;width:100%;max-width:calc(100% - 2rem);height:300px;background:#fff;z-index:50';
    d.innerHTML = '<div style="position:absolute;right:4px;top:100px;width:20px;height:40px;background:rgb(255,0,255)"></div>';
    document.body.appendChild(d);`,
    { edge: { x: 390 - 16 - 14, y: 400 - 150 + 120 } },
    { width: 390, height: 800 },
  );
  save("regress-phone-dialog", r.dataUrl);
  expect(near(r.colours.edge!, { r: 255, g: 0, b: 255 }), `right edge ${JSON.stringify(r.colours.edge)}`).toBe(true);
});

test("stacked toasts keep their own order: the newest is on top", async ({ page }) => {
  const r = await run(
    page,
    `${BASE}
    const ol = document.createElement('ol');
    ol.style.cssText = 'position:fixed;right:24px;bottom:24px;width:356px;margin:0;padding:0;list-style:none;z-index:999';
    ol.innerHTML =
      '<li data-probe="newest" style="position:absolute;right:0;bottom:0;width:356px;height:64px;z-index:2;background:rgb(220,38,38)"></li>' +
      '<li style="position:absolute;right:0;bottom:0;width:356px;height:64px;z-index:1;transform:translateY(-14px) scale(.95);background:#fff"></li>';
    document.body.appendChild(ol);`,
  );
  expect(near(r.colours.newest!, { r: 220, g: 38, b: 38 }), `newest ${JSON.stringify(r.colours.newest)}`).toBe(true);
});

test("a fixed page background under positioned content does not replace the page", async ({ page }) => {
  const r = await run(
    page,
    `${BASE}
    const bg = document.createElement('div');
    bg.style.cssText = 'position:fixed;inset:0;z-index:0;background:linear-gradient(rgb(20,20,80),rgb(20,20,80))';
    document.body.appendChild(bg);
    const main = document.createElement('main');
    main.style.cssText = 'position:relative;z-index:1;padding:80px';
    main.innerHTML = '<div data-probe="card" style="height:300px;background:#fff"></div>';
    document.body.appendChild(main);`,
  );
  expect(near(r.colours.card!, { r: 255, g: 255, b: 255 }), `card ${JSON.stringify(r.colours.card)}`).toBe(true);
});

test("a fixed menu inside a modal (react-select menuPosition=fixed) lands where it was", async ({ page }) => {
  const r = await run(
    page,
    `${BASE}
    const modal = document.createElement('div');
    modal.setAttribute('role','dialog');
    modal.style.cssText = 'position:fixed;inset:0;margin:auto;width:400px;height:300px;background:#fff;z-index:50';
    modal.innerHTML = '<div data-probe="menu" style="position:fixed;left:640px;top:520px;width:150px;height:120px;background:rgb(16,185,129)"></div>';
    document.body.appendChild(modal);
    window.scrollTo(0, 0);`,
  );
  save("regress-nested-fixed", r.dataUrl);
  expect(near(r.colours.menu!, { r: 16, g: 185, b: 129 }), `menu ${JSON.stringify(r.colours.menu)}`).toBe(true);
});

test("a sticky header on a scrolled page is in the shot", async ({ page }) => {
  const r = await run(
    page,
    `${BASE}
    const header = document.createElement('header');
    header.setAttribute('data-probe','header');
    header.style.cssText = 'position:sticky;top:0;height:56px;background:rgb(255,140,0);z-index:40';
    document.body.appendChild(header);
    const filler = document.createElement('div');
    filler.style.height = '4000px';
    document.body.appendChild(filler);
    window.scrollTo(0, 900);`,
  );
  expect(near(r.colours.header!, { r: 255, g: 140, b: 0 }), `header ${JSON.stringify(r.colours.header)}`).toBe(true);
});

test("a fixed layer inside a hidden (opacity:0) wrapper is not stitched as a phantom", async ({ page }) => {
  const r = await run(
    page,
    `${BASE}
    const w = document.createElement('div');
    w.style.opacity = '0';
    w.innerHTML = '<div data-probe="ghost" style="position:fixed;left:100px;top:100px;width:200px;height:200px;background:rgb(255,0,0)"></div>';
    document.body.appendChild(w);`,
  );
  expect(near(r.colours.ghost!, GREY), `ghost ${JSON.stringify(r.colours.ghost)}`).toBe(true);
});

test("a fixed panel inside an open shadow root, and a fixed <svg>, are captured on a scrolled page", async ({ page }) => {
  const r = await run(
    page,
    `${BASE}
    const filler = document.createElement('div');
    filler.style.height = '4000px';
    document.body.appendChild(filler);
    const host = document.createElement('div');
    document.body.appendChild(host);
    host.attachShadow({ mode: 'open' }).innerHTML = '<div style="position:fixed;left:100px;top:100px;width:300px;height:200px;background:rgb(0,0,255)"></div>';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width','80'); svg.setAttribute('height','80');
    svg.style.cssText = 'position:fixed;left:600px;top:100px';
    svg.innerHTML = '<rect width="80" height="80" fill="rgb(255,0,255)"/>';
    document.body.appendChild(svg);
    window.scrollTo(0, 900);`,
    { shadow: { x: 250, y: 200 }, svg: { x: 640, y: 140 } },
  );
  expect(near(r.colours.shadow!, { r: 0, g: 0, b: 255 }), `shadow ${JSON.stringify(r.colours.shadow)}`).toBe(true);
  expect(near(r.colours.svg!, { r: 255, g: 0, b: 255 }), `svg ${JSON.stringify(r.colours.svg)}`).toBe(true);
});

test("a fixed child clipped by a transformed, overflow:hidden ancestor stays clipped", async ({ page }) => {
  const r = await run(
    page,
    `${BASE}
    const card = document.createElement('div');
    card.style.cssText = 'position:absolute;left:100px;top:100px;width:200px;height:200px;transform:translateZ(0);overflow:hidden;background:#fff';
    card.innerHTML = '<div style="position:fixed;left:150px;top:150px;width:200px;height:200px;background:rgb(255,0,255)"></div>';
    document.body.appendChild(card);`,
    { outside: { x: 380, y: 380 } },
  );
  expect(near(r.colours.outside!, GREY), `outside ${JSON.stringify(r.colours.outside)}`).toBe(true);
});

test("an image inside a layer that never loads does not hold the capture for long", async ({ page }) => {
  await page.route("https://slow.test/**", () => new Promise(() => {}));
  const r = await run(
    page,
    `${BASE}
    for (const left of [40, 400]) {
      const p = document.createElement('div');
      p.style.cssText = 'position:fixed;top:40px;left:' + left + 'px;width:300px;height:200px;background:#fff;z-index:20';
      p.innerHTML = '<img src="https://slow.test/a.png?' + left + '" width="40" height="40">';
      document.body.appendChild(p);
    }`,
  );
  expect(r.ms, `capture took ${Math.round(r.ms)}ms`).toBeLessThan(8000);
});

test("capturing never writes into the page: a double-matched password and a chosen file survive", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.setContent(
    '<!doctype html><html><body><div role="dialog" style="position:fixed;left:100px;top:100px;width:400px;height:200px;background:#fff">' +
      '<input id="pw" type="password" name="password" value="hunter2">' +
      '<input id="cc" name="credit_card" value="4242424242424242">' +
      '<input id="kyc" type="file" name="id_card">' +
      "</div></body></html>",
  );
  await page.setInputFiles("#kyc", { name: "id.png", mimeType: "image/png", buffer: Buffer.from("x") });
  await page.addScriptTag({ path: BUNDLE });
  const result = await page.evaluate(async () => {
    const cap = (window as unknown as { FeedbackCapture: any }).FeedbackCapture;
    const overlays = await cap.captureOverlays();
    const shot = await cap.captureScreenshot({ excludeElements: new Set(overlays.map((o: { element: Element }) => o.element)) });
    return {
      overlays: overlays.length,
      shot: shot.dataUrl.length > 1000,
      pw: (document.getElementById("pw") as HTMLInputElement).value,
      cc: (document.getElementById("cc") as HTMLInputElement).value,
      file: (document.getElementById("kyc") as HTMLInputElement).files?.length ?? 0,
      styleLeft: document.getElementById("aif-redact-sensitive") !== null,
    };
  });
  expect(result).toEqual({ overlays: 1, shot: true, pw: "hunter2", cc: "4242424242424242", file: 1, styleLeft: false });
});

test("sticky bars inside a scrolled modal stay where the reporter saw them", async ({ page }) => {
  const r = await run(
    page,
    `${BASE}
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.style.cssText = 'position:fixed;left:200px;top:100px;width:400px;height:400px;overflow-y:auto;background:#fff;z-index:50';
    modal.innerHTML =
      '<div data-probe="top" style="position:sticky;top:0;height:40px;background:rgb(0,0,255)"></div>' +
      '<div style="height:1600px"></div>' +
      '<div data-probe="bottom" style="position:sticky;bottom:0;height:40px;background:rgb(0,160,0)"></div>';
    document.body.appendChild(modal);
    modal.scrollTop = 500;`,
  );
  save("regress-sticky-in-modal", r.dataUrl);
  expect(near(r.colours.top!, { r: 0, g: 0, b: 255 }), `top bar ${JSON.stringify(r.colours.top)}`).toBe(true);
  expect(near(r.colours.bottom!, { r: 0, g: 160, b: 0 }), `bottom bar ${JSON.stringify(r.colours.bottom)}`).toBe(true);
});

test("a fixed layer inside a half-transparent wrapper is blended, not drawn solid", async ({ page }) => {
  const r = await run(
    page,
    `${BASE}
    const w = document.createElement('div');
    w.style.opacity = '0.3';
    w.innerHTML = '<div data-probe="faded" style="position:fixed;left:100px;top:100px;width:200px;height:200px;background:rgb(255,0,0)"></div>';
    document.body.appendChild(w);`,
  );
  // 30% red over 230 grey = (238,161,161).
  expect(near(r.colours.faded!, { r: 238, g: 161, b: 161 }, 25), `faded ${JSON.stringify(r.colours.faded)}`).toBe(true);
});
