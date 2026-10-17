import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { COMPANY, OWNER, startAssistantScenario, type AssistantScenario } from "../fixtures/assistant-scenario-server.js";

/**
 * A COMPANY'S ASSISTANT, IN A BROWSER (Tenancy 2b-3): the real launcher, chat
 * and settings, bundled from @adminigloo/assistant-widget's source, against
 * @adminigloo/assistant's real company handler on a real Postgres — with a
 * scripted model, never a real call (fixtures/assistant-scenario-server.ts).
 * Driven like the owner of Green Acres would, on a desktop (1280) and a phone
 * (390), checked on what they SEE:
 *
 *   - the button on the company page opens the chat as a dialog: focus in,
 *     trapped, Escape closes, focus back on the button; full screen on a
 *     phone with nothing to scroll sideways;
 *   - a starter question streams an answer rendered as Markdown, from a tool,
 *     with the figures the tool worked out;
 *   - "remember…" shows an "ask before acting" card; "Yes, do it" (clicked
 *     twice) saves ONE answer; asking that question again is answered with
 *     the owner's words and NO model call;
 *   - Stop ends an answer; the settings show the month's use; a spent month
 *     says so in plain words; a dark host gets the dark widget.
 *
 * Run it: cd e2e && pnpm install && pnpm browsers && pnpm test assistant-scenario
 * (the assistant, assistant-widget and ai packages must be built).
 */

let server: AssistantScenario;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  server = await startAssistantScenario();
});
test.afterAll(async () => {
  await server?.close();
});

const DESK = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

async function person(browser: Browser, viewport: { width: number; height: number }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport, ...(viewport.width < 640 ? { isMobile: true, hasTouch: true } : {}) });
  await context.addCookies([{ name: "e2e-user", value: OWNER, url: server.origin }]);
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    throw error;
  });
  return { context, page };
}

async function faqCount(): Promise<number> {
  const [row] = await server.query<{ n: number }>("select count(*)::int as n from assistant_page_docs where tenant_id = $1 and kind = 'faq' and is_active", [COMPANY]);
  return Number(row?.n ?? 0);
}

for (const [label, viewport] of [
  ["desktop 1280", DESK],
  ["phone 390", PHONE],
] as const) {
  test.describe(`the assistant on a ${label}`, () => {
    test("opens from the button as a dialog, answers a starter from a tool, and closes with Escape", async ({ browser }, info) => {
      const { context, page } = await person(browser, viewport);
      await page.goto(`${server.origin}/app`);
      const launcher = page.getByRole("button", { name: "Ask the assistant" });
      await expect(launcher).toBeVisible();
      await launcher.click();

      const dialog = page.getByRole("dialog", { name: "Green Acres's assistant" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("textbox", { name: "Your question" })).toBeFocused();
      if (viewport.width < 640) {
        const box = await dialog.boundingBox();
        expect(Math.round(box?.width ?? 0)).toBe(viewport.width);
      }

      const calls = server.calls();
      await dialog.getByRole("button", { name: "Which invoices are overdue?" }).click();
      // Markdown, rendered: bold invoice numbers, a list, a link to this site.
      const answer = dialog.locator("[data-aia-message=assistant]").last();
      await expect(answer).toContainText("2 invoices are overdue, $1,060.00 in all");
      await expect(answer.locator("strong", { hasText: "INV-0042" })).toBeVisible();
      await expect(answer.locator("li")).toHaveCount(2);
      await expect(answer.getByRole("link", { name: "Invoices" })).toHaveAttribute("href", "/app/invoices");
      await expect(answer).not.toContainText("**");
      expect(server.calls() - calls).toBe(2); // the tool call, then the answer

      // Nothing wider than the screen.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      await page.screenshot({ path: info.outputPath(`answer-${viewport.width}.png`) });

      // Tab stays inside; Escape closes and gives focus back to the button.
      for (let i = 0; i < 12; i += 1) await page.keyboard.press("Tab");
      expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(launcher).toBeFocused();
      await context.close();
    });

    test("asks before acting: one “Yes, do it” saves one answer, and that question is then answered without AI", async ({ browser }, info) => {
      const { context, page } = await person(browser, viewport);
      await page.goto(`${server.origin}/app`);
      await page.getByRole("button", { name: "Ask the assistant" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "New conversation" }).click();
      const before = await faqCount();

      const box = dialog.getByRole("textbox", { name: "Your question" });
      await box.fill("Remember that we don't work on Sundays");
      await box.press("Enter");
      const card = dialog.locator("[data-aia-action]").last();
      await expect(card).toContainText("The assistant would like to make a change");
      await expect(card).toContainText("Save an answer to “Do you work on Sundays?”");
      expect(await faqCount()).toBe(before); // nothing is done until they say so
      await page.screenshot({ path: info.outputPath(`ask-before-acting-${viewport.width}.png`) });

      const yes = card.getByRole("button", { name: "Yes, do it" });
      await yes.dblclick();
      await expect(card).toContainText("Saved. That question will be answered with these words from now on.");
      await expect(card.getByRole("button", { name: "Yes, do it" })).toHaveCount(0);
      expect(await faqCount()).toBe(before === 0 ? 1 : before);

      // The owner's words, word for word, and no model call.
      const calls = server.calls();
      await dialog.getByRole("button", { name: "New conversation" }).click();
      await box.fill("Do you work on Sundays?");
      await dialog.getByRole("button", { name: "Send" }).click();
      const answer = dialog.locator("[data-aia-message=assistant]").last();
      await expect(answer).toContainText("No — we work Monday to Saturday, 7am to 6pm.");
      await expect(answer).toContainText("From your business's own answers.");
      expect(server.calls()).toBe(calls);
      await context.close();
    });

    test("the card shows everything it will save, can be changed, and saves what was confirmed; a saved answer's link is plain text", async ({ browser }, info) => {
      const { context, page } = await person(browser, viewport);
      await page.goto(`${server.origin}/app`);
      await page.getByRole("button", { name: "Ask the assistant" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "New conversation" }).click();
      const box = dialog.getByRole("textbox", { name: "Your question" });
      await box.fill("Remember how the deposit works");
      await box.press("Enter");
      const card = dialog.locator("[data-aia-action]").last();
      // Review H3: the full answer, as plain text, before anything is saved.
      await expect(card).toContainText("Deposits are paid at https://pay-elsewhere.example/deposit — have your card ready.");
      await expect(card.locator("a")).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`card-full-${viewport.width}.png`) });
      await card.getByRole("button", { name: "Change it" }).click();
      await card.getByRole("textbox", { name: "Answer" }).fill("Pay your deposit at the office, or ask us for an invoice.");
      await card.getByRole("button", { name: "Yes, do it" }).click();
      await expect(card).toContainText("Saved.");
      const [saved] = await server.query<{ body: string }>("select body from assistant_page_docs where tenant_id = $1 and title = $2 and is_active", [COMPANY, "How do I pay my deposit?"]);
      expect(saved?.body).toBe("Pay your deposit at the office, or ask us for an invoice.");
      await context.close();
    });

    test("Stop ends an answer where it is", async ({ browser }) => {
      const { context, page } = await person(browser, viewport);
      await page.goto(`${server.origin}/app`);
      await page.getByRole("button", { name: "Ask the assistant" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "New conversation" }).click();
      const box = dialog.getByRole("textbox", { name: "Your question" });
      await box.fill("Tell me something slow");
      await box.press("Enter");
      await expect(dialog.locator(".aia-msg.aia-assistant").last()).toContainText("word3");
      await dialog.getByRole("button", { name: "Stop" }).click();
      await expect(dialog.getByText("Stopped.")).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Send" })).toBeVisible();
      // Review H1: a stopped answer is NEVER free — it is settled at what was
      // sent and streamed, so it counts against the month and the site's day.
      await expect
        .poll(async () => (await server.query<{ status: string; cost: string | null }>("select status, cost_micros::text as cost from ai_usage order by id desc limit 1"))[0])
        .toMatchObject({ status: "cancelled" });
      const [row] = await server.query<{ cost: string | null; input_tokens: number; output_tokens: number }>(
        "select cost_micros::text as cost, input_tokens, output_tokens from ai_usage order by id desc limit 1",
      );
      expect(row?.cost).not.toBeNull();
      expect(Number(row?.cost)).toBeGreaterThan(0);
      expect(row?.input_tokens).toBeGreaterThan(0);
      expect(row?.output_tokens).toBeGreaterThan(0);
      await context.close();
    });
  });
}

test("the settings show the month's use; a spent month says so; history reopens a conversation", async ({ browser }, info) => {
  const { context, page } = await person(browser, PHONE);
  await page.goto(`${server.origin}/app/assistant`);
  await expect(page.getByRole("heading", { name: "About your business" })).toBeVisible();
  await expect(page.locator("[data-aia-usage]")).toContainText(/of 300 questions used this month/);
  await expect(page.getByText("Do you work on Sundays?", { exact: true })).toBeVisible();
  // Saved twice (once per screen size) is one answer, logged as added once, then changed.
  await expect(page.getByText("Added an answer: Do you work on Sundays?")).toHaveCount(1);
  await expect(page.getByText("Changed an answer: Do you work on Sundays?")).toHaveCount(1);
  await page.getByRole("textbox", { name: "About your business" }).fill("Green Acres mows and edges lawns in Boise, Monday to Saturday.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.getByRole("textbox", { name: "New house rule" }).fill("Always offer a free quote.");
  await page.getByRole("button", { name: "Add rule" }).click();
  await expect(page.locator(".aia-item-body", { hasText: /^Always offer a free quote\.$/ })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: info.outputPath("settings-390.png"), fullPage: true });

  // The month is spent: the chat says so, in the server's words.
  server.setMonthlyMessages(0);
  await page.goto(`${server.origin}/app`);
  await page.getByRole("button", { name: "Ask the assistant" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("[data-aia-allowance=used-up]")).toContainText("This month's assistant allowance is used up");
  const calls = server.calls();
  const box = dialog.getByRole("textbox", { name: "Your question" });
  await box.fill("Which invoices are overdue this week?");
  await box.press("Enter");
  await expect(dialog.getByRole("alert")).toContainText("This month's assistant allowance is used up");
  expect(server.calls()).toBe(calls);
  server.setMonthlyMessages(300);

  // History: an earlier conversation, reopened.
  await dialog.getByRole("button", { name: "Your conversations" }).click();
  await dialog.getByRole("button", { name: /Which invoices are overdue\?/ }).first().click();
  await expect(dialog.locator("[data-aia-message=assistant]").first()).toContainText("INV-0042");
  await page.screenshot({ path: info.outputPath("history-390.png") });
  await context.close();
});

test("on a dark host page the widget is dark too", async ({ browser }, info) => {
  const { context, page } = await person(browser, DESK);
  await page.goto(`${server.origin}/app?dark=1`);
  const root = page.locator("[data-aia-launcher]");
  await expect(root).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Ask the assistant" }).click();
  const background = await page.locator(".aia-sheet").evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(background).toBe("rgb(20, 27, 34)");
  await page.screenshot({ path: info.outputPath("dark-1280.png") });
  await context.close();
});
