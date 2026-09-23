import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";

/**
 * Reporting a modal, end to end, in a buyer-shaped app (React 19 + a shadcn-shaped
 * Radix Dialog + the whole widget). Driven the way a person does it: the modal is
 * open, they press the feedback button, they type.
 *
 * Every assertion here is a way the sibling project's (Riddler Go's) owner found
 * the feature broken in live use:
 *   - the button was UNCLICKABLE over the modal (Radix sets pointer-events:none on
 *     <body> while a modal is open);
 *   - pressing it DISMISSED the modal being reported (Radix treats the press as an
 *     outside click), destroying the evidence;
 *   - the stitched screenshot showed only a CORNER of the modal;
 *   - the feedback modal sat BEHIND the product modal, so it was unusable.
 * Plus the one that follows from the others: the modal's focus trap must not pull
 * focus out of the feedback form, or nobody can type their report.
 */

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(here, "..", "fixtures", "host-app.bundle.js");

type RGB = { r: number; g: number; b: number };
const CORNERS: Record<string, RGB> = {
  tl: { r: 255, g: 0, b: 0 },
  tr: { r: 0, g: 200, b: 0 },
  bl: { r: 0, g: 0, b: 255 },
  br: { r: 255, g: 0, b: 255 },
};
const CHAT: RGB = { r: 0, g: 128, b: 255 };

function near(a: RGB, b: RGB, tol = 60): boolean {
  return Math.abs(a.r - b.r) <= tol && Math.abs(a.g - b.g) <= tol && Math.abs(a.b - b.b) <= tol;
}

async function boot(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.setContent('<!doctype html><html><head></head><body><div id="root"></div></body></html>');
  await page.addScriptTag({ path: BUNDLE });
  await page.waitForFunction(() => !!window.__host && !!window.__fb);
}

async function openHostDialog(page: Page): Promise<void> {
  await page.evaluate(() => window.__host.openDialog());
  await page.waitForFunction(() => window.__host.dialogOpen());
  // Radix arms its outside-pointerdown listener on a setTimeout(0) after open.
  await page.waitForTimeout(50);
}

/** Press the floating button like a person: a real mouse click at its centre. */
async function pressFeedbackButton(page: Page): Promise<void> {
  const box = await page.locator(".aif-fab").boundingBox();
  expect(box, "feedback button not rendered").not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
}

/** Viewport centres of the given [data-marker] elements, read from the live DOM. */
async function markerCentres(page: Page): Promise<Record<string, { x: number; y: number }>> {
  return page.evaluate(() => {
    const out: Record<string, { x: number; y: number }> = {};
    document.querySelectorAll<HTMLElement>("[data-marker]").forEach((el) => {
      const r = el.getBoundingClientRect();
      out[el.dataset.marker!] = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    return out;
  });
}

/** Colours of the widget's captured screenshot at viewport points. */
async function sampleShot(page: Page, points: Record<string, { x: number; y: number }>) {
  return page.evaluate(async (pts) => {
    const src = window.__fb.shot!;
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = src;
    });
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const scale = img.width / window.innerWidth;
    const out: Record<string, { r: number; g: number; b: number }> = {};
    for (const [k, p] of Object.entries(pts)) {
      const d = ctx.getImageData(Math.round(p.x * scale), Math.round(p.y * scale), 1, 1).data;
      out[k] = { r: d[0], g: d[1], b: d[2] };
    }
    return { colours: out, dataUrl: src };
  }, points);
}

function savePng(name: string, dataUrl: string): void {
  writeFileSync(join(here, "..", "test-results", `${name}.png`), Buffer.from(dataUrl.split(",")[1] ?? "", "base64"));
}

test("the feedback button works over an open Radix modal, and the modal survives", async ({ page }) => {
  await boot(page);
  await openHostDialog(page);
  await pressFeedbackButton(page);

  // The press opened the feedback flow...
  await expect.poll(() => page.evaluate(() => window.__fb.isOpen), { timeout: 3000 }).toBe(true);
  // ...and did NOT dismiss the modal the reporter is reporting.
  expect(await page.evaluate(() => window.__host.dialogOpen())).toBe(true);
});

test("the screenshot contains the WHOLE Radix modal at its true position", async ({ page }) => {
  await boot(page);
  await openHostDialog(page);
  const centres = await markerCentres(page);
  await pressFeedbackButton(page);
  await expect.poll(() => page.evaluate(() => window.__fb.step), { timeout: 10_000 }).toBe("annotate");

  const { colours, dataUrl } = await sampleShot(page, {
    tl: centres.tl!,
    tr: centres.tr!,
    bl: centres.bl!,
    br: centres.br!,
  });
  savePng("radix-modal-report", dataUrl);
  for (const [corner, want] of Object.entries(CORNERS)) {
    expect(near(colours[corner]!, want), `${corner} was ${JSON.stringify(colours[corner])}`).toBe(true);
  }
});

test("the feedback modal is on top and the reporter can type into it", async ({ page }) => {
  await boot(page);
  await openHostDialog(page);
  await pressFeedbackButton(page);
  await expect.poll(() => page.evaluate(() => window.__fb.step), { timeout: 10_000 }).toBe("annotate");

  // Playwright's click refuses if anything else would receive the pointer — so a
  // passing click proves the feedback modal is the topmost, interactive layer.
  await page.getByRole("button", { name: "Skip annotation" }).click({ timeout: 3000 });
  const box = page.locator("#aif-description");
  await box.click({ timeout: 3000 });
  await page.keyboard.type("The AI modal cut off my answer.");
  await expect(box).toHaveValue("The AI modal cut off my answer.");
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("aif-description");
  // Still reporting over a modal that is still there.
  expect(await page.evaluate(() => window.__host.dialogOpen())).toBe(true);
});

test("Escape closes the feedback modal, not the modal being reported", async ({ page }) => {
  await boot(page);
  await openHostDialog(page);
  await pressFeedbackButton(page);
  await expect.poll(() => page.evaluate(() => window.__fb.step), { timeout: 10_000 }).toBe("annotate");
  await page.getByRole("button", { name: "Skip annotation" }).click({ timeout: 3000 });
  await page.locator("#aif-description").click({ timeout: 3000 });

  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() => window.__fb.isOpen), { timeout: 3000 }).toBe(false);
  expect(await page.evaluate(() => window.__host.dialogOpen())).toBe(true);
});

test("Ctrl+Shift+B over the open modal captures it and leaves it open", async ({ page }) => {
  await boot(page);
  await openHostDialog(page);
  const centres = await markerCentres(page);
  await page.keyboard.press("Control+Shift+B");
  await expect.poll(() => page.evaluate(() => window.__fb.step), { timeout: 10_000 }).toBe("annotate");
  expect(await page.evaluate(() => window.__host.dialogOpen())).toBe(true);
  const { colours } = await sampleShot(page, { tl: centres.tl!, br: centres.br! });
  expect(near(colours.tl!, CORNERS.tl!), `tl was ${JSON.stringify(colours.tl)}`).toBe(true);
  expect(near(colours.br!, CORNERS.br!), `br was ${JSON.stringify(colours.br)}`).toBe(true);
});

test("an open AI chat panel is captured and the page is not dimmed", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__host.openChat());
  await page.waitForSelector("[data-chat-panel]");
  const centres = await markerCentres(page);
  await pressFeedbackButton(page);
  await expect.poll(() => page.evaluate(() => window.__fb.step), { timeout: 10_000 }).toBe("annotate");
  const { colours, dataUrl } = await sampleShot(page, { chat: centres.chat!, bg: { x: 700, y: 400 } });
  savePng("chat-panel-report", dataUrl);
  expect(near(colours.chat!, CHAT), `chat marker was ${JSON.stringify(colours.chat)}`).toBe(true);
  expect(colours.bg!.r, `page should stay bright, was ${JSON.stringify(colours.bg)}`).toBeGreaterThan(200);
});

test("over a host's native <dialog>: the shortcut opens feedback ON TOP, typeable, and the host dialog survives", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__host.openNativeDialog());
  await page.locator("[data-native-input]").click();
  await page.keyboard.press("Control+Shift+B");
  await expect.poll(() => page.evaluate(() => window.__fb.step), { timeout: 10_000 }).toBe("annotate");
  // The host dialog (magenta) is in the screenshot.
  const { colours } = await sampleShot(page, { native: { x: 600, y: 400 } });
  expect(near(colours.native!, { r: 255, g: 0, b: 255 }), `native dialog was ${JSON.stringify(colours.native)}`).toBe(true);
  // The feedback modal is above the host's top-layer dialog and usable.
  await page.getByRole("button", { name: "Skip annotation" }).click({ timeout: 3000 });
  await page.locator("#aif-description").click({ timeout: 3000 });
  await page.keyboard.type("Native dialog report");
  await expect(page.locator("#aif-description")).toHaveValue("Native dialog report");
  expect(await page.evaluate(() => window.__host.nativeDialogOpen())).toBe(true);
});

test("the feedback modal scrolls with the wheel while a Radix scroll lock is active", async ({ page }) => {
  await boot(page);
  await page.setViewportSize({ width: 1200, height: 420 });
  await openHostDialog(page);
  await pressFeedbackButton(page);
  await expect.poll(() => page.evaluate(() => window.__fb.step), { timeout: 10_000 }).toBe("annotate");
  await page.getByRole("button", { name: "Skip annotation" }).click({ timeout: 3000 });
  const body = page.locator(".aif-modal-body");
  const overflows = await body.evaluate((el) => el.scrollHeight > el.clientHeight + 10);
  expect(overflows, "describe step should overflow a 420px viewport for this test to mean anything").toBe(true);
  // Keep the wheel event itself: once dispatch finishes, its defaultPrevented
  // says whether anything (Radix's document-level scroll lock) cancelled the
  // scroll. Asserting on that, not only on scrollTop, because Playwright's
  // synthetic wheel scrolls even a cancelled event — a real wheel would not.
  await body.evaluate((el) => {
    el.addEventListener("wheel", (e) => ((window as unknown as { __wheel: Event }).__wheel = e));
  });
  const box = (await body.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 400);
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { __wheel?: Event }).__wheel)).toBe(true);
  expect(
    await page.evaluate(() => (window as unknown as { __wheel: Event }).__wheel.defaultPrevented),
    "a host scroll lock cancelled wheel scrolling inside the feedback modal",
  ).toBe(false);
  await expect.poll(() => body.evaluate((el) => el.scrollTop), { timeout: 2000 }).toBeGreaterThan(0);
});

test("over a Headless UI dialog: the button works, the dialog survives, it is in the shot, and typing works", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__host.openHeadless());
  await page.waitForSelector("[data-headless-panel]");
  await page.waitForTimeout(100);
  const panel = (await page.locator("[data-headless-panel]").boundingBox())!;
  await pressFeedbackButton(page);
  await expect.poll(() => page.evaluate(() => window.__fb.step), { timeout: 10_000 }).toBe("annotate");
  expect(await page.evaluate(() => window.__host.headlessOpen())).toBe(true);
  const { colours, dataUrl } = await sampleShot(page, { panel: { x: panel.x + panel.width / 2, y: panel.y + panel.height - 20 } });
  savePng("headless-report", dataUrl);
  expect(near(colours.panel!, { r: 0, g: 200, b: 0 }), `panel was ${JSON.stringify(colours.panel)}`).toBe(true);
  await page.getByRole("button", { name: "Skip annotation" }).click({ timeout: 3000 });
  await page.locator("#aif-description").click({ timeout: 3000 });
  await page.keyboard.type("Headless report");
  await expect(page.locator("#aif-description")).toHaveValue("Headless report");
  expect(await page.evaluate(() => window.__host.headlessOpen())).toBe(true);
});

