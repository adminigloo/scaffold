import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The widget under React StrictMode on a DEVELOPMENT build — what every buyer's
 * `next dev` runs (Next turns StrictMode on by default). Every other spec loads
 * the production bundle, where StrictMode never double-runs an effect, which is
 * how this shipped: the dialog's mount → cleanup → mount called close() then
 * showModal(), the queued `close` event arrived at the re-opened dialog, and
 * the widget shut itself the instant it opened (found on adminigloo.com's own
 * dev server, 2026-10-01; fixed in 0.3.1).
 */

const here = dirname(fileURLToPath(import.meta.url));
const DEV_BUNDLE = join(here, "..", "fixtures", "host-app.dev.bundle.js");

async function boot(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.setContent('<!doctype html><html><head></head><body><div id="root"></div></body></html>');
  await page.addScriptTag({ path: DEV_BUNDLE });
  await page.waitForFunction(() => !!window.__host && !!window.__fb);
}

async function pressFeedbackButton(page: Page): Promise<void> {
  const box = await page.locator(".aif-fab").boundingBox();
  expect(box, "feedback button not rendered").not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
}

const step = (page: Page) => page.evaluate(() => window.__fb.step);
const isOpen = (page: Page) => page.evaluate(() => window.__fb.isOpen);
const dialogOpen = (page: Page) =>
  page.evaluate(() => (document.querySelector("dialog[data-aif-modal]") as HTMLDialogElement | null)?.open ?? false);

test("the form opens and STAYS open under StrictMode in development", async ({ page }) => {
  await boot(page);
  await pressFeedbackButton(page);
  await expect.poll(() => step(page), { timeout: 10_000 }).toBe("annotate");
  // The stale close event lands within a task or two of opening; give it far
  // longer than that, then the form must still be up.
  await page.waitForTimeout(1500);
  expect(await isOpen(page)).toBe(true);
  expect(await dialogOpen(page)).toBe(true);
});

test("a platform-initiated close still closes the form under StrictMode", async ({ page }) => {
  await boot(page);
  await pressFeedbackButton(page);
  await expect.poll(() => step(page), { timeout: 10_000 }).toBe("annotate");
  await page.evaluate(() => {
    const d = document.querySelector("dialog[data-aif-modal]") as HTMLDialogElement;
    d.dispatchEvent(new Event("cancel", { cancelable: false }));
    d.close();
  });
  await expect.poll(() => isOpen(page), { timeout: 3000 }).toBe(false);
  await pressFeedbackButton(page);
  await expect.poll(() => step(page), { timeout: 10_000 }).toBe("annotate");
  await page.waitForTimeout(1000);
  expect(await isOpen(page)).toBe(true);
});

test("the Close button closes it under StrictMode", async ({ page }) => {
  await boot(page);
  await pressFeedbackButton(page);
  await expect.poll(() => step(page), { timeout: 10_000 }).toBe("annotate");
  await page.getByRole("button", { name: "Close" }).click({ timeout: 3000 });
  await expect.poll(() => isOpen(page), { timeout: 3000 }).toBe(false);
});
