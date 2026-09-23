import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regressions from the 2026-09-23 adversarial review of the modal-capture fix,
 * each reproduced in a real browser by a reviewer before it was fixed. Driven
 * through the buyer-shaped host app (fixtures/host-app.tsx).
 */

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(here, "..", "fixtures", "host-app.bundle.js");

type RGB = { r: number; g: number; b: number };
const near = (a: RGB, b: RGB, tol = 60) =>
  Math.abs(a.r - b.r) <= tol && Math.abs(a.g - b.g) <= tol && Math.abs(a.b - b.b) <= tol;

async function boot(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.setContent('<!doctype html><html><head></head><body><div id="root"></div></body></html>');
  await page.addScriptTag({ path: BUNDLE });
  await page.waitForFunction(() => !!window.__host && !!window.__fb);
}

async function openHostDialog(page: Page): Promise<void> {
  await page.evaluate(() => window.__host.openDialog());
  await page.waitForFunction(() => window.__host.dialogOpen());
  await page.waitForTimeout(50);
}

async function pressFeedbackButton(page: Page): Promise<void> {
  const box = await page.locator(".aif-fab").boundingBox();
  expect(box, "feedback button not rendered").not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
}

const step = (page: Page) => page.evaluate(() => window.__fb.step);
const isOpen = (page: Page) => page.evaluate(() => window.__fb.isOpen);

async function sampleShot(page: Page, points: Record<string, { x: number; y: number }>) {
  return page.evaluate(async (pts) => {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = window.__fb.shot!;
    });
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const s = img.width / window.innerWidth;
    const out: Record<string, { r: number; g: number; b: number }> = {};
    for (const [k, p] of Object.entries(pts)) {
      const d = ctx.getImageData(Math.round(p.x * s), Math.round(p.y * s), 1, 1).data;
      out[k] = { r: d[0]!, g: d[1]!, b: d[2]! };
    }
    return out;
  }, points);
}

test("the board ticket panel's Send stays clickable, and Ctrl+Shift+B still reports the panel", async ({ page }) => {
  await boot(page);
  // Scrolled, so only the overlay capture can supply the (fixed) drawer.
  await page.evaluate(() => window.scrollTo(0, 600));
  await page.evaluate(() => window.__host.openBoardPanel());
  await page.waitForSelector("[data-board-send]");
  // The Feedback button must NOT sit on the panel's reply button (at z-index
  // 2147483647 it did: a click meant to send a reply started a screenshot).
  const sendIsTopmost = await page.evaluate(() => {
    const r = document.querySelector("[data-board-send]")!.getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.hasAttribute("data-board-send");
  });
  expect(sendIsTopmost, "the Feedback button covers the board's Send button").toBe(true);
  await page.keyboard.press("Control+Shift+B");
  await expect.poll(() => step(page), { timeout: 10_000 }).toBe("annotate");
  const colours = await sampleShot(page, { panel: { x: 1000, y: 300 } });
  expect(near(colours.panel!, { r: 255, g: 140, b: 0 }), `board panel was ${JSON.stringify(colours.panel)}`).toBe(true);
});

test("a React-controlled secret re-rendering during a multi-layer capture never reaches the screenshot; live values untouched", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__host.openSecrets());
  await page.waitForSelector("[data-secrets-modal]");
  const boxes = await page.evaluate(() => {
    const out: Record<string, { left: number; top: number; right: number; bottom: number }> = {};
    document.querySelectorAll<HTMLElement>("[data-secret]").forEach((el) => {
      const r = el.getBoundingClientRect();
      out[el.dataset.secret!] = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    });
    return out;
  });
  await page.keyboard.press("Control+Shift+B");
  await expect.poll(() => step(page), { timeout: 10_000 }).toBe("annotate");
  // Rightmost red pixel inside each big-red-text field: the plaintext (24 wide
  // monospace glyphs) reaches ~400px in; eight bullets stay well under 220.
  const reach = await page.evaluate(async (bx) => {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = window.__fb.shot!;
    });
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const s = img.width / window.innerWidth;
    const out: Record<string, number> = {};
    for (const key of ["apiKey", "card", "pk", "auto"]) {
      const b = bx[key]!;
      let right = 0;
      for (let y = b.top + 4; y < b.bottom - 4; y += 2) {
        for (let x = b.left; x < b.right; x += 2) {
          const d = ctx.getImageData(Math.round(x * s), Math.round(y * s), 1, 1).data;
          if (d[0]! > 180 && d[1]! < 90 && d[2]! < 90) right = Math.max(right, x - b.left);
        }
      }
      out[key] = right;
    }
    return out;
  }, boxes);
  for (const [key, px] of Object.entries(reach)) {
    expect(px, `${key}: red text reaches ${px}px into the field — the secret leaked`).toBeLessThan(220);
  }
  // Nothing was written into the live page.
  const live = await page.evaluate(() => ({
    password: (document.querySelector("[data-secret='password']") as HTMLInputElement).value,
    card: (document.querySelector("[data-secret='card']") as HTMLInputElement).value,
    apiKey: (document.querySelector("[data-secret='apiKey']") as HTMLInputElement).value,
  }));
  expect(live).toEqual({ password: "hunter2", card: "4242424242424242", apiKey: "WWWWWWWWWWWWWWWWWWWWWWWW" });
});

test("a platform-initiated close (a mobile back gesture) keeps React in sync", async ({ page }) => {
  await boot(page);
  await openHostDialog(page);
  await pressFeedbackButton(page);
  await expect.poll(() => step(page), { timeout: 10_000 }).toBe("annotate");
  // A second back press cannot be refused: a non-cancelable cancel, then close.
  await page.evaluate(() => {
    const d = document.querySelector("dialog[data-aif-modal]") as HTMLDialogElement;
    d.dispatchEvent(new Event("cancel", { cancelable: false }));
    d.close();
  });
  await expect.poll(() => isOpen(page), { timeout: 3000 }).toBe(false);
  // The button works again.
  await pressFeedbackButton(page);
  await expect.poll(() => isOpen(page), { timeout: 3000 }).toBe(true);
});

test("closing the feedback form hands focus back to where the reporter was", async ({ page }) => {
  await boot(page);
  await openHostDialog(page);
  await page.locator("[data-host-input]").click();
  await page.keyboard.press("Control+Shift+B");
  await expect.poll(() => step(page), { timeout: 10_000 }).toBe("annotate");
  await page.getByRole("button", { name: "Close" }).click({ timeout: 3000 });
  await expect.poll(() => isOpen(page), { timeout: 3000 }).toBe(false);
  await expect
    .poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.hasAttribute("data-host-input") ?? false))
    .toBe(true);
  await page.keyboard.type("still here");
  await expect(page.locator("[data-host-input]")).toHaveValue("still here");
});

test("Escape still closes the form after focus drops to <body>", async ({ page }) => {
  await boot(page);
  await openHostDialog(page);
  await pressFeedbackButton(page);
  await expect.poll(() => step(page), { timeout: 10_000 }).toBe("annotate");
  await page.getByRole("button", { name: "Skip annotation" }).click({ timeout: 3000 });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Escape");
  await expect.poll(() => isOpen(page), { timeout: 3000 }).toBe(false);
  expect(await page.evaluate(() => window.__host.dialogOpen())).toBe(true);
});

test("an IME's Escape (closing a candidate list) does not close the report", async ({ page }) => {
  await boot(page);
  await pressFeedbackButton(page);
  await expect.poll(() => step(page), { timeout: 10_000 }).toBe("annotate");
  await page.getByRole("button", { name: "Skip annotation" }).click({ timeout: 3000 });
  await page.locator("#aif-description").fill("some text");
  await page.evaluate(() => {
    const t = document.querySelector("#aif-description")!;
    t.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(100);
  expect(await isOpen(page)).toBe(true);
  await expect(page.locator("#aif-description")).toHaveValue("some text");
});

test("a click-away panel (MUI ClickAwayListener shape) survives pressing the button and using the form", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__host.openClickaway());
  await page.waitForSelector("[data-clickaway-panel]");
  await page.waitForTimeout(50);
  await pressFeedbackButton(page);
  await expect.poll(() => isOpen(page), { timeout: 3000 }).toBe(true);
  await page.waitForTimeout(50);
  expect(await page.evaluate(() => window.__host.clickawayOpen())).toBe(true);
  await expect.poll(() => step(page), { timeout: 10_000 }).toBe("annotate");
  await page.getByRole("button", { name: "Skip annotation" }).click({ timeout: 3000 });
  await page.waitForTimeout(50);
  expect(await page.evaluate(() => window.__host.clickawayOpen())).toBe(true);
});

test("a host's CSS for its own native dialogs cannot reshape the feedback form", async ({ page }) => {
  await boot(page);
  await pressFeedbackButton(page);
  await expect.poll(() => isOpen(page), { timeout: 3000 }).toBe(true);
  const box = await page.evaluate(() => {
    const r = document.querySelector("dialog[data-aif-modal]")!.getBoundingClientRect();
    return { w: r.width, h: r.height, vw: window.innerWidth, vh: window.innerHeight };
  });
  expect(box.w).toBe(box.vw);
  expect(box.h).toBe(box.vh);
});

test("the click trail submitted with a report never quotes sensitive or ignored content, nor the widget's own clicks", async ({ page }) => {
  let submitted: { clientMetadata?: { clickTrail?: Array<{ target?: string }> } } | null = null;
  await page.route("https://feedback.test/api/**", async (route) => {
    const url = route.request().url();
    if (url.endsWith("/v1/submit")) {
      submitted = route.request().postDataJSON();
      return route.fulfill({ json: { ticketNumber: "FB-00001", ticketToken: "tok" } });
    }
    if (url.endsWith("/v1/upload")) return route.fulfill({ json: { url: "https://blob.test/shot.jpg" } });
    return route.fulfill({ json: { categories: [] } });
  });
  await boot(page);
  await page.locator("[data-probe='secret-code']").click();
  await page.locator("[data-probe='ignored']").click();
  await page.locator("[data-probe='plain']").click();
  await pressFeedbackButton(page);
  await expect.poll(() => step(page), { timeout: 10_000 }).toBe("annotate");
  await page.getByRole("button", { name: "Skip annotation" }).click({ timeout: 3000 });
  await page.locator("#aif-description").fill("The key display looks wrong.");
  await page.locator(".aif-modal .aif-btn-primary").last().click({ timeout: 3000 });
  await expect.poll(() => submitted !== null, { timeout: 10_000 }).toBe(true);
  const trail = JSON.stringify(submitted!.clientMetadata?.clickTrail ?? []);
  expect(trail).not.toContain("TOPSECRET");
  expect(trail).not.toContain("IGNORED-acct");
  expect(trail).not.toContain("Skip annotation");
  expect(trail).toContain("(sensitive)");
  expect(trail).toContain("Plain host button");
});
