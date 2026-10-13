import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { startTenancyScenarioServer, BOOTSTRAP_ADMIN_EMAIL, type TenancyScenarioServer } from "../fixtures/tenancy-scenario-server.js";

/**
 * THE BUSINESS SCENARIO FOR COMPANIES (Tenancy 1), END TO END, IN A BROWSER —
 * contract 13.8, and the acceptance bar the founder set:
 *
 *   "Business owners aren't devs. If a business owner is told by their dev
 *    that it works, they deploy it and sell it to a customer; they need to
 *    trust that it's actually doing what is needed."
 *
 * Summit Window Co. signs up for Igloo Back Office. The real screens
 * (@adminigloo/tenancy-widget, bundled from source) in a real browser, against
 * the real service and HTTP handlers (@adminigloo/tenancy 0.4) on a real
 * Postgres (PGlite), wired the way a generated `--tenant-noun Company` project
 * wires them (see fixtures/tenancy-scenario-server.ts):
 *
 *   Olivia   the owner: signs up, names the company, sets it up, runs the team,
 *            hands the company over and leaves;
 *   Sam      joins through an invitation, is promoted, removed, invited back,
 *            starts a second company and ends up owning Summit;
 *   Ava      the platform owner (BOOTSTRAP_ADMIN_EMAIL): finds the company,
 *            suspends and reactivates one, gives a staff role.
 *
 * Every screen a step lands on is checked with axe (no serious or critical
 * violations), and step 9 checks the phone widths: nothing scrolls sideways at
 * 390, 360 or 320 px and every target is at least 44 px.
 *
 * NEGATIVE CONTROLS (bottom of the file): the same assertions re-run against a
 * deliberately broken FIXTURE (never the packages) must FAIL — a fresh request
 * key on every create, and a company gate that trusts the session from sign-in.
 *
 * Run it: cd e2e && pnpm install && pnpm browsers && pnpm test tenancy-scenario
 * (build the packages first: their dist is what runs).
 */

const OLIVIA = { email: "olivia@summitwindow.test", name: "Olivia Owner" };
const SAM = { email: "sam@summitwindow.test", name: "Sam Field" };
const AVA = { email: BOOTSTRAP_ADMIN_EMAIL, name: "Ava Admin" };
const COMPANY = "Summit Window Co.";

let server: TenancyScenarioServer;

test.beforeAll(async () => {
  server = await startTenancyScenarioServer();
});
test.afterAll(async () => {
  await server?.close();
});

/**
 * ON SCREEN, not merely in the page (review R2 T1BO-04). Playwright calls a
 * 1px, clipped screen-reader line "visible", so the confirmations an owner
 * never saw passed here. A real box, wider and taller than a pixel, is what a
 * person can read.
 */
async function seenOnScreen(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box && box.width > 1 && box.height > 1, "shown on screen, not only to a screen reader").toBe(true);
}

const DESK = { width: 1280, height: 1000 };

async function person(browser: Browser, viewport = DESK): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport, locale: "en-US", timezoneId: "America/Denver" });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("page error:", error.message));
  return { context, page };
}

async function signIn(page: Page, who: { email: string; name: string }, via: "webhook" | "page", next = "/dashboard"): Promise<void> {
  const q = new URLSearchParams({ email: who.email, name: who.name, via, next });
  await page.goto(`${server.origin}/__test/sign-in?${q.toString()}`);
}

/** Serious and critical axe violations on the page, as "rule: target" lines. */
async function axe(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

async function companies(name?: string): Promise<number> {
  const rows = await server.query<{ n: number }>(
    name === undefined ? "select count(*)::int as n from tenants where kind = 'org'" : "select count(*)::int as n from tenants where kind = 'org' and name = $1",
    name === undefined ? [] : [name],
  );
  return Number(rows[0]?.n ?? 0);
}

async function latestInvitationTo(email: string): Promise<string> {
  const sent = server.outbox.filter((m) => m.to === email);
  const last = sent.at(-1);
  if (!last) throw new Error(`no invitation to ${email} in ${JSON.stringify(server.outbox)}`);
  return last.url;
}

/** Nothing scrolls sideways, and every control in the widgets is a thumb-sized target. */
async function phoneChecks(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `${label}: horizontal scroll`).toBeLessThanOrEqual(0);
  const small = await page.evaluate(() => {
    const out: string[] = [];
    const nodes = document.querySelectorAll<HTMLElement>(
      ".aitw-root button, .aitw-root a.aitw-btn, .aitw-root select, .aitw-root input:not([type=file]):not([type=color]):not([type=checkbox]):not([type=radio]), .aitw-root summary",
    );
    for (const node of nodes) {
      const box = node.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (getComputedStyle(node).visibility === "hidden") continue;
      if (box.height < 43.5) out.push(`${node.tagName.toLowerCase()} "${(node.textContent || node.getAttribute("aria-label") || "").trim().slice(0, 40)}" ${Math.round(box.height)}px`);
    }
    return out;
  });
  expect(small, `${label}: targets under 44px`).toEqual([]);
}

test.describe.serial("Summit Window Co. on Igloo Back Office: owner, team and platform owner, end to end", () => {
  let olivia: { context: BrowserContext; page: Page };
  let sam: { context: BrowserContext; page: Page };
  let ava: { context: BrowserContext; page: Page };

  test.afterAll(async () => {
    await olivia?.context.close();
    await sam?.context.close();
    await ava?.context.close();
  });

  test("1. Olivia signs up and names her company — one company, however the answer is lost or the button pressed", async ({ browser }) => {
    olivia = await person(browser);
    const { page } = olivia;
    // The webhook writes her row and sets her up; her first page sends her to onboarding.
    await signIn(page, OLIVIA, "webhook", "/dashboard");
    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByLabel("What's your company called?")).toBeVisible();
    expect(await axe(page), "onboarding").toEqual([]);

    await page.getByLabel("What's your company called?").fill(COMPANY);
    await expect(page.locator("[data-aitw-address]")).toContainText("/t/summit-window-co");

    // A reserved web address is refused in a sentence, with a free one a click away.
    await page.getByRole("button", { name: /^Change/ }).click();
    await page.getByLabel("Web address").fill("admin");
    await page.getByRole("button", { name: "Create company" }).click();
    await expect(page.getByText("That web address is kept for the site itself", { exact: false }).first()).toBeVisible();
    const use = page.getByRole("button", { name: /^Use / });
    await expect(use).toBeVisible();
    const suggested = ((await use.textContent()) ?? "").replace(/^Use /, "").trim();
    await use.click();
    await expect(page.getByLabel("Web address")).toHaveValue(suggested);

    // The first answer is lost on the way back (the fixture drops it, after the
    // company was saved). Pressing again — twice, quickly — must not make a second one.
    await page.getByRole("button", { name: "Create company" }).click();
    await expect(page.locator("[data-aitw-alert]")).not.toHaveText("");
    await page.getByRole("button", { name: "Create company" }).dblclick();
    await expect(page).toHaveURL(/\/dashboard$/);
    expect(await companies(COMPANY), "companies named Summit Window Co.").toBe(1);
  });

  test("2. the setup checklist starts at 0 of 3, and the details she adds tick one off", async () => {
    const { page } = olivia;
    await expect(page.getByText("0 of 3 done").first()).toBeVisible();
    expect(await axe(page), "dashboard").toEqual([]);
    await page.getByRole("link", { name: /Add details/ }).click();
    await expect(page).toHaveURL(/\/settings\/company#details$/);
    const details = page.locator("#details");
    await expect(details.getByLabel("Time zone")).toBeVisible();
    await details.getByLabel("Time zone").selectOption("America/Denver");
    await details.getByLabel("Email customers can reach you at").fill("office@summitwindow.test");
    await details.getByLabel("Phone customers can call").fill("801-555-0123");
    await details.getByRole("button", { name: "Save" }).click();
    await expect(details.getByText("Saved").first()).toBeVisible();
    expect(await axe(page), "company settings").toEqual([]);
    await page.goto(`${server.origin}/dashboard`);
    await expect(page.getByText("1 of 3 done").first()).toBeVisible();
  });

  test("3. branding: a colour that reads well, and a logo that shows in the header", async () => {
    const { page } = olivia;
    await page.goto(`${server.origin}/settings/company`);
    const branding = page.locator("#branding");
    await branding.locator('input[type="text"][placeholder="#0f766e"]').fill("#0f766e");
    await expect(branding.locator("[data-aitw-ratio]")).toContainText("easy to read");
    await branding.getByRole("button", { name: "Save" }).click();
    await expect(branding.getByText("Saved").first()).toBeVisible();

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    await branding.locator('input[type="file"]').setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: png });
    await expect(branding.locator("[data-aitw-logo] img")).toBeVisible();
    await page.reload();
    await expect(page.locator(".e2e-header img")).toBeVisible();
  });

  test("4. an invitation: emailed, opened signed out, accepted — and Sam never sees onboarding", async ({ browser }) => {
    const { page } = olivia;
    await page.goto(`${server.origin}/settings/team`);
    await page.getByLabel("Email address").fill(SAM.email);
    await page.getByLabel("Role", { exact: true }).selectOption("member");
    await page.getByRole("button", { name: "Send invitation" }).click();
    await expect(page.getByText(`Invitation sent to ${SAM.email}.`).first()).toBeVisible();
    expect(await axe(page), "team page").toEqual([]);
    const link = await latestInvitationTo(SAM.email);

    sam = await person(browser);
    await sam.page.goto(link);
    await expect(sam.page.getByRole("heading", { name: "You've been invited" })).toBeVisible();
    await sam.page.getByRole("link", { name: "Create an account" }).click();
    await sam.page.getByLabel("Email").fill(SAM.email);
    await sam.page.getByLabel("Name").fill(SAM.name);
    await sam.page.getByRole("button", { name: "Continue" }).click();
    await expect(sam.page).toHaveURL(/\/invite\//);
    // What the link is for, before anything happens.
    await expect(sam.page.getByText(`${COMPANY} invited you to join as a Member.`).first()).toBeVisible();
    expect(await axe(sam.page), "accept invitation").toEqual([]);
    await sam.page.getByRole("button", { name: "Accept invitation" }).click();
    await expect(sam.page).toHaveURL(/\/dashboard$/, { timeout: 10_000 });
    await expect(sam.page.getByRole("heading", { name: COMPANY })).toBeVisible();
  });

  test("5. Olivia promotes Sam, then removes him — he loses access on his very next request", async () => {
    const { page } = olivia;
    await page.goto(`${server.origin}/settings/team`);
    await page.getByLabel(`Role for ${SAM.name}`).selectOption("admin");
    await page.getByRole("button", { name: "Make an Admin" }).click();
    await seenOnScreen(page.locator("[data-aitw-done]").filter({ hasText: `Role changed. ${SAM.name} is now an Admin.` }));

    await sam.page.goto(`${server.origin}/settings/team`);
    await expect(sam.page.locator(`tr[data-member]`).filter({ hasText: "(you)" })).toBeVisible();
    // His own role is not his to change.
    await expect(sam.page.getByLabel(`Role for ${SAM.name}`)).toHaveCount(0);
    await expect(sam.page.getByRole("button", { name: "Send invitation" })).toBeVisible();

    await page.getByRole("button", { name: `Remove ${SAM.name}` }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: `Remove ${SAM.name}` }).click();
    await seenOnScreen(page.locator("[data-aitw-done]").filter({ hasText: `${SAM.name} was removed.` }));

    // Sam's open tab: the next thing he does is refused, in a sentence.
    await sam.page.getByLabel("Email address").fill("someone@example.test");
    await sam.page.getByRole("button", { name: "Send invitation" }).click();
    await expect(sam.page.getByText("You're not part of this company.").first()).toBeVisible();
    // And the next page he loads sends him to onboarding, which says which company.
    await sam.page.goto(`${server.origin}/dashboard`);
    await expect(sam.page).toHaveURL(/\/onboarding$/);
    await expect(sam.page.getByText(`You're no longer part of ${COMPANY}.`, { exact: false }).first()).toBeVisible();
  });

  test("6. two companies: Sam rejoins Summit, starts Side Gig, and switches between them", async () => {
    await olivia.page.goto(`${server.origin}/settings/team`);
    await olivia.page.getByLabel("Email address").fill(SAM.email);
    await olivia.page.getByLabel("Role", { exact: true }).selectOption("member");
    await olivia.page.getByRole("button", { name: "Send invitation" }).click();
    await expect(olivia.page.getByText(`Invitation sent to ${SAM.email}.`).first()).toBeVisible();
    await sam.page.goto(await latestInvitationTo(SAM.email));
    await sam.page.getByRole("button", { name: "Accept invitation" }).click();
    await expect(sam.page).toHaveURL(/\/dashboard$/, { timeout: 10_000 });

    await sam.page.getByRole("button", { name: `${COMPANY}, switch company` }).click();
    await sam.page.getByRole("menuitem", { name: "Create another company" }).click();
    await expect(sam.page).toHaveURL(/\/onboarding\?another=1$/);
    await sam.page.getByLabel("Create another company").fill("Side Gig");
    // The answer is lost again (the fixture drops it after the save); he presses again.
    await sam.page.getByRole("button", { name: "Create company" }).click();
    await expect(sam.page.locator("[data-aitw-alert]")).not.toHaveText("");
    await sam.page.getByRole("button", { name: "Create company" }).click();
    await expect(sam.page).toHaveURL(/\/dashboard$/);
    expect(await companies("Side Gig"), "companies named Side Gig").toBe(1);
    await expect(sam.page.getByRole("heading", { name: "Side Gig" })).toBeVisible();

    await sam.page.getByRole("button", { name: "Side Gig, switch company" }).click();
    const menu = sam.page.getByRole("menu");
    await expect(menu.getByRole("menuitemradio")).toHaveCount(2);
    expect(await axe(sam.page), "switcher menu open").toEqual([]);
    await menu.getByRole("menuitemradio", { name: new RegExp(COMPANY.replace(".", "\\.")) }).click();
    await expect(sam.page.getByRole("heading", { name: COMPANY })).toBeVisible();
    await sam.page.goto(`${server.origin}/settings/team`);
    const rows = sam.page.locator("tr[data-member]");
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: OLIVIA.name })).toHaveCount(1);
  });

  test("7. Olivia hands Summit to Sam and leaves; the owner can't just leave", async () => {
    const { page } = olivia;
    await page.goto(`${server.origin}/settings/team`);
    const form = page.locator("[data-aitw-transfer]");
    await form.getByLabel("New owner").selectOption({ label: SAM.name });
    const transfer = form.getByRole("button", { name: "Transfer ownership" });
    await expect(transfer).toBeDisabled();
    await form.getByLabel(`Type ${COMPANY} to confirm`).fill(COMPANY);
    await expect(transfer).toBeEnabled();
    await transfer.click();
    await seenOnScreen(page.locator("[data-aitw-done]").filter({ hasText: `${SAM.name} is now the owner. You're an Admin.` }));

    await page.getByRole("button", { name: `Leave ${COMPANY}` }).click();
    await page.getByRole("dialog").getByRole("button", { name: `Leave ${COMPANY}` }).click();
    await expect(page).toHaveURL(/\/onboarding$/, { timeout: 10_000 });

    await sam.page.goto(`${server.origin}/settings/team`);
    await expect(sam.page.locator("[data-aitw-leave-blocked]")).toBeVisible();
    await expect(sam.page.getByRole("button", { name: `Leave ${COMPANY}` })).toHaveCount(0);
  });

  test("8. the platform owner: let in, finds Summit, suspends and reactivates Side Gig, gives a staff role", async ({ browser }) => {
    ava = await person(browser);
    const { page } = ava;
    await signIn(page, AVA, "page", "/admin/companies");
    await expect(page).toHaveURL(/\/admin\/companies$/);
    await expect(page.getByRole("heading", { name: "Companies" })).toBeVisible();
    expect(await axe(page), "operator console").toEqual([]);
    // "summit window", not "summit": Side Gig's owner's email is at summitwindow.test,
    // and the search rightly matches owners' emails too.
    await page.getByLabel("Search companies by name, web address or owner's email").fill("summit window");
    await expect(page.getByRole("link", { name: COMPANY })).toBeVisible();
    await expect(page.getByRole("link", { name: "Side Gig" })).toHaveCount(0);

    await page.getByLabel("Search companies by name, web address or owner's email").fill("side");
    await page.getByRole("link", { name: "Side Gig" }).click();
    await expect(page).toHaveURL(/\/admin\/companies\/.+/);
    expect(await axe(page), "company detail").toEqual([]);
    await page.getByRole("button", { name: "Suspend company" }).click();
    await page.getByLabel("Why (only staff see this)").fill("Payment needed");
    await page.getByRole("dialog").getByRole("button", { name: "Suspend" }).click();
    await expect(page.getByText("Side Gig is suspended.").first()).toBeVisible();

    // Sam picks Side Gig: a plain suspended screen, with a way back to Summit.
    await sam.page.goto(`${server.origin}/dashboard`);
    await sam.page.getByRole("button", { name: `${COMPANY}, switch company` }).click();
    await sam.page.getByRole("menuitemradio", { name: /Side Gig/ }).click();
    await expect(sam.page.getByRole("heading", { name: "Side Gig is suspended" })).toBeVisible();
    await expect(sam.page.getByRole("button", { name: new RegExp(COMPANY.replace(".", "\\.")) })).toBeVisible();
    expect(await axe(sam.page), "suspended screen").toEqual([]);

    await page.getByRole("button", { name: "Reactivate" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Reactivate" }).click();
    await expect(page.getByText("Side Gig is active again.").first()).toBeVisible();
    await sam.page.reload();
    await expect(sam.page.getByRole("heading", { name: "Side Gig" })).toBeVisible();

    // People: a staff role for Olivia; Ava's own row is not hers to change.
    await page.goto(`${server.origin}/admin/people`);
    await page.getByLabel(`Staff role for ${OLIVIA.email}`).selectOption({ label: "Customer service agent" });
    await page.getByRole("dialog").getByRole("button", { name: "Give role" }).click();
    await expect(page.getByText(`Staff role changed for ${OLIVIA.email}.`).first()).toBeVisible();
    await expect(page.getByLabel(`Staff role for ${AVA.email}`)).toBeDisabled();
    await expect(page.getByText("You can't change your own role.").first()).toBeVisible();
    expect(await axe(page), "people").toEqual([]);
  });

  test("9. on a phone: nothing scrolls sideways and every target is thumb-sized, at 390, 360 and 320 px", async ({ browser }) => {
    for (const width of [390, 360, 320]) {
      const phone = await person(browser, { width, height: 800 });
      const who = { email: `phone${width}@summitwindow.test`, name: `Phone ${width}` };
      await signIn(phone.page, who, "page", "/onboarding");
      await expect(phone.page.getByLabel("What's your company called?")).toBeVisible();
      await phoneChecks(phone.page, `${width}px onboarding`);
      await phone.page.getByLabel("What's your company called?").fill("Green Acres Lawn & Landscape Services LLC");
      await phone.page.getByRole("button", { name: "Create company" }).click();
      await expect(phone.page).toHaveURL(/\/dashboard$/);
      await phoneChecks(phone.page, `${width}px dashboard`);
      // The header: the switcher shrinks; the account button stays on screen.
      const avatar = await phone.page.locator(".e2e-avatar").boundingBox();
      expect(avatar && avatar.x + avatar.width <= width, `${width}px: account button on screen`).toBe(true);
      await phone.page.getByRole("button", { name: /switch company/ }).click();
      await expect(phone.page.getByRole("menu")).toBeVisible();
      await phoneChecks(phone.page, `${width}px switcher menu`);
      await phone.page.keyboard.press("Escape");
      await phone.page.goto(`${server.origin}/settings/team`);
      await expect(phone.page.getByRole("button", { name: "Send invitation" })).toBeVisible();
      await phoneChecks(phone.page, `${width}px team`);
      await phone.page.goto(`${server.origin}/settings/company`);
      await expect(phone.page.locator("#details")).toBeVisible();
      await phoneChecks(phone.page, `${width}px settings`);
      await phone.context.close();
    }
  });
});

test.describe("a lost answer, when the page can still ask (review R2 T1BO-01)", () => {
  test("a Create whose answer is lost says the company was made and opens it — no retry, no twin", async ({ browser }) => {
    const checked = await startTenancyScenarioServer({ lostAnswer: "check" });
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      await page.goto(`${checked.origin}/__test/sign-in?${new URLSearchParams({ email: OLIVIA.email, name: OLIVIA.name, via: "webhook", next: "/onboarding" })}`);
      await page.getByLabel("What's your company called?").fill(COMPANY);
      await page.getByRole("button", { name: "Create company" }).click();
      // Onboarding: the answer is lost, the page finds the company and offers it.
      await seenOnScreen(page.getByText(`${COMPANY} was created.`, { exact: false }).first());
      await page.getByRole("button", { name: `Continue to ${COMPANY}` }).click();
      await expect(page).toHaveURL(/\/dashboard$/);

      // "Create another": the same, where a retry used to make a twin.
      await page.goto(`${checked.origin}/onboarding?another=1`);
      await page.getByLabel("Create another company").fill("Cal's Snow Removal");
      await page.getByRole("button", { name: "Create company" }).click();
      await seenOnScreen(page.getByText("Cal's Snow Removal was created.", { exact: false }).first());
      expect(await axe(page), "lost answer, company found").toEqual([]);
      await page.getByRole("button", { name: "Continue to Cal's Snow Removal" }).click();
      await expect(page).toHaveURL(/\/dashboard$/);
      const [row] = await checked.query<{ n: number }>("select count(*)::int as n from tenants where kind = 'org' and name = $1", ["Cal's Snow Removal"]);
      expect(Number(row?.n), "companies named Cal's Snow Removal").toBe(1);
      await context.close();
    } finally {
      await checked.close();
    }
  });
});

// ---------------------------------------------------------------------------
// NEGATIVE CONTROLS: a test that passes either way guards nothing. Each re-runs
// one assertion above against a deliberately broken FIXTURE and must fail.
// ---------------------------------------------------------------------------

test.describe("negative controls (each must FAIL)", () => {
  test("fresh-key: a new request key on every create makes a second company", async ({ browser }) => {
    test.fail();
    const broken = await startTenancyScenarioServer({ break: "fresh-key" });
    try {
      const context = await browser.newContext({ viewport: DESK });
      const page = await context.newPage();
      await page.goto(`${broken.origin}/__test/sign-in?${new URLSearchParams({ email: OLIVIA.email, name: OLIVIA.name, via: "webhook", next: "/onboarding" })}`);
      await page.getByLabel("What's your company called?").fill(COMPANY);
      await page.getByRole("button", { name: "Create company" }).click();
      await expect(page.locator("[data-aitw-alert]")).not.toHaveText("");
      await page.getByRole("button", { name: "Create company" }).click();
      await expect(page).toHaveURL(/\/dashboard$/);
      // Onboarding is guarded twice over (one company per person there), so the
      // key is what protects "Create another": the retry after its lost answer.
      await page.goto(`${broken.origin}/onboarding?another=1`);
      await page.getByLabel("Create another company").fill("Side Gig");
      await page.getByRole("button", { name: "Create company" }).click();
      await expect(page.locator("[data-aitw-alert]")).not.toHaveText("");
      await page.getByRole("button", { name: "Create company" }).click();
      await expect(page).toHaveURL(/\/dashboard$/);
      const [row] = await broken.query<{ n: number }>("select count(*)::int as n from tenants where kind = 'org' and name = $1", ["Side Gig"]);
      expect(Number(row?.n), "companies named Side Gig").toBe(1);
      await context.close();
    } finally {
      await broken.close();
    }
  });

  test("cached-gate: a gate that trusts the session from sign-in lets a removed member back in", async ({ browser }) => {
    test.fail();
    const broken = await startTenancyScenarioServer({ break: "cached-gate" });
    try {
      const signInAt = (page: Page, who: { email: string; name: string }, next: string) =>
        page.goto(`${broken.origin}/__test/sign-in?${new URLSearchParams({ email: who.email, name: who.name, via: "page", next })}`);
      const owner = await (await browser.newContext({ viewport: DESK })).newPage();
      await signInAt(owner, OLIVIA, "/onboarding");
      await owner.getByLabel("What's your company called?").fill(COMPANY);
      await owner.getByRole("button", { name: "Create company" }).click();
      await expect(owner.locator("[data-aitw-alert]")).not.toHaveText("");
      await owner.getByRole("button", { name: "Create company" }).click();
      await expect(owner).toHaveURL(/\/dashboard$/);
      await owner.goto(`${broken.origin}/settings/team`);
      await owner.getByLabel("Email address").fill(SAM.email);
      await owner.getByRole("button", { name: "Send invitation" }).click();
      await expect(owner.getByText(`Invitation sent to ${SAM.email}.`).first()).toBeVisible();
      const link = broken.outbox.filter((m) => m.to === SAM.email).at(-1)!.url;

      const member = await (await browser.newContext({ viewport: DESK })).newPage();
      await signInAt(member, SAM, new URL(link).pathname);
      await member.getByRole("button", { name: "Accept invitation" }).click();
      await expect(member).toHaveURL(/\/dashboard$/, { timeout: 10_000 });

      await owner.reload();
      await owner.getByRole("button", { name: `Remove ${SAM.name}` }).first().click();
      await owner.getByRole("dialog").getByRole("button", { name: `Remove ${SAM.name}` }).click();
      await seenOnScreen(owner.locator("[data-aitw-done]").filter({ hasText: `${SAM.name} was removed.` }));

      await member.goto(`${broken.origin}/dashboard`);
      await expect(member).toHaveURL(/\/onboarding$/);
    } finally {
      await broken.close();
    }
  });
});
