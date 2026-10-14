import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import {
  BOOTSTRAP_ADMIN_EMAIL,
  PLATFORM_FROM_ADDRESS,
  startTenancy2aScenarioServer,
  type Tenancy2aScenarioServer,
  type SentMail,
} from "../fixtures/tenancy-2a-scenario-server.js";

/**
 * TENANCY 2a, END TO END, IN A BROWSER — contract section 14, acceptance item 9,
 * and the bar the founder set:
 *
 *   "Business owners aren't devs. If a business owner is told by their dev
 *    that it works, they deploy it and sell it to a customer; they need to
 *    trust that it's actually doing what is needed."
 *
 * Two lawn-care companies run on one Igloo Back Office: the REAL screens
 * (every widget, bundled from source) in a real browser, against the REAL
 * tenancy service, route seams and feature handlers (scheduling, the
 * estimator, invoicing and messages, from their built dist) on a real
 * Postgres (PGlite), wired the way a generated `--tenant-noun Company
 * --estimator --scheduling --invoicing --comms --email` project wires them
 * (fixtures/tenancy-2a-scenario-server.ts).
 *
 *   Gail   owns Green Acres (green-acres, Mountain Time);
 *   Sam    owns Summit Lawn (summit-lawn, Central Time);
 *   Pat    is a customer of Green Acres: an estimate, a visit, a quote, an invoice;
 *   Cam    is Green Acres' crew member, Mia a member, Vic a viewer;
 *   Ava    is the platform owner (BOOTSTRAP_ADMIN_EMAIL).
 *
 * The steps (contract 14): 1. two companies set themselves up in their own
 * area; 2. their public pages carry their name, colour and time zone; 3. one
 * customer of Green Acres, end to end — and every email is Green Acres', and
 * Summit sees none of it; 4. company roles; 5. crons serve every active
 * company, skip a suspended one and survive one company's failure; 6. phone
 * width. Every screen a step lands on is checked with axe (no serious or
 * critical violations).
 *
 * NEGATIVE CONTROLS (bottom of the file): the same assertions against a
 * deliberately broken FIXTURE (never the packages) must FAIL.
 *
 * Run it: cd e2e && pnpm install && pnpm browsers && pnpm test tenancy-2a-scenario
 * (build the packages first: their dist is what runs).
 */

// Monday 2026-11-02, 08:00 in Denver (MST) and 09:00 in Chicago (CST): after
// the clocks changed, so every time in the scenario is standard time.
const START = new Date("2026-11-02T15:00:00Z");

const GAIL = { email: "gail@greenacres.test", name: "Gail Green" };
const SAM = { email: "sam@summitlawn.test", name: "Sam Summit" };
const CAM = { email: "cam@greenacres.test", name: "Cam Crew" };
const MIA = { email: "mia@greenacres.test", name: "Mia Member" };
const VIC = { email: "vic@greenacres.test", name: "Vic Viewer" };
const AVA = { email: BOOTSTRAP_ADMIN_EMAIL, name: "Ava Admin" };
const GREEN = {
  name: "Green Acres",
  slug: "green-acres",
  zone: "America/Denver",
  office: "office@greenacres.test",
  phone: "303-555-0140",
  colour: "#2e7d32",
  pay: "Pay by check to Green Acres LLC, or call 303-555-0140 to pay by card.",
};
const SUMMIT = {
  name: "Summit Lawn",
  slug: "summit-lawn",
  zone: "America/Chicago",
  office: "office@summitlawn.test",
  phone: "312-555-0170",
  colour: "#1d4ed8",
  pay: "Pay by bank transfer to Summit Lawn, account on the invoice.",
};
const PAT = { name: "Pat Rivera", email: "pat@example.com", phone: "303-555-0199", address: "12 Oak St, Denver" };
const KIM = { name: "Kim Waits", email: "kim@example.com", address: "40 Elm Ave, Denver" };
const LOU = { name: "Lou Lakeside", email: "lou@example.com", address: "9 Lake Shore Dr, Chicago" };

const DESK = { width: 1280, height: 1000 };
const PHONE = { width: 390, height: 844 };

let server: Tenancy2aScenarioServer;

test.beforeAll(async () => {
  server = await startTenancy2aScenarioServer({ start: START });
});
test.afterAll(async () => {
  await server?.close();
});

// --- the people ------------------------------------------------------------------

async function person(browser: Browser, options: { viewport?: { width: number; height: number }; timezoneId?: string } = {}) {
  const context = await browser.newContext({ viewport: options.viewport ?? DESK, locale: "en-US", timezoneId: options.timezoneId ?? "America/Denver" });
  const page = await context.newPage();
  // The scenario's time on their clock, flowing from there.
  await page.clock.install({ time: server.now() });
  await page.clock.resume();
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
    .map((v) => `${v.id}: ${v.nodes.map((n) => `${n.target.join(" ")} (${(n.failureSummary ?? "").replace(/\s+/g, " ").slice(0, 200)})`).join(", ")}`);
}

/** A JSON call to a route as the signed-in person in this page's browser (cookies and all). */
async function api(page: Page, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await page.request.fetch(`${server.origin}${path}`, {
    method,
    headers: { origin: server.origin, "sec-fetch-site": "same-origin", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { data: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* an HTML answer stays text */
  }
  return { status: response.status(), body: parsed };
}

// --- what they receive ---------------------------------------------------------------

/** Every http(s) link in an email's text. */
function linksIn(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>")]+/g)].map((m) => m[0]!.replace(/[.,;:]+$/, ""));
}

function mailTo(to: string, on: Tenancy2aScenarioServer = server): SentMail[] {
  return on.outbox.filter((m) => m.to === to);
}

async function expectMailTo(to: string, subject: RegExp): Promise<SentMail> {
  await expect.poll(() => mailTo(to).some((m) => subject.test(m.subject)), { timeout: 10_000, message: `an email to ${to} matching ${subject}` }).toBe(true);
  return mailTo(to).filter((m) => subject.test(m.subject)).at(-1)!;
}

/** The token in a company page link out of an email: /t/{slug}/{kind}/{token}. */
function tokenLink(mail: SentMail, slug: string, kind: "quote" | "visit" | "invoice"): string {
  const link = linksIn(mail.text).find((l) => l.startsWith(`${server.origin}/t/${slug}/${kind}/`));
  if (!link) throw new Error(`no /t/${slug}/${kind}/ link in:\n${mail.text}`);
  return link;
}

/**
 * THE OUTBOX ASSERTION (step 3 and the shared-identity negative control):
 * every message to the company's customer went out AS THE COMPANY — its name
 * on the platform's sending address, its contact email as Reply-To — and
 * every link in it is one of the company's own public pages; every office
 * notice went to the company's own address, never the platform owner's.
 */
function expectCompanyMail(
  options: {
    company: { name: string; slug: string; office: string };
    customer: string;
    /** Office notices expected (at least one when given). */
    officeNotices?: boolean;
  },
  on: Tenancy2aScenarioServer = server,
): void {
  const toCustomer = mailTo(options.customer, on);
  expect(toCustomer.length, `emails to ${options.customer}`).toBeGreaterThan(0);
  for (const mail of toCustomer) {
    expect({ subject: mail.subject, fromName: mail.fromName, fromAddress: mail.fromAddress, replyTo: mail.replyTo }).toEqual({
      subject: mail.subject,
      fromName: options.company.name,
      fromAddress: PLATFORM_FROM_ADDRESS,
      replyTo: options.company.office,
    });
    for (const link of linksIn(mail.text)) {
      expect(link.startsWith(`${on.origin}/t/${options.company.slug}/`), `"${mail.subject}" links to ${link}`).toBe(true);
    }
  }
  if (options.officeNotices) {
    const office = mailTo(options.company.office, on);
    expect(office.length, `notices to ${options.company.office}`).toBeGreaterThan(0);
    for (const mail of office) {
      expect(mail.fromName, mail.subject).toBe(options.company.name);
      for (const link of linksIn(mail.text)) {
        const own = link.startsWith(`${on.origin}/t/${options.company.slug}/`) || link.startsWith(`${on.origin}/app/switch/${options.company.slug}?`);
        expect(own, `office notice "${mail.subject}" links to ${link}`).toBe(true);
      }
    }
    // The platform owner hears nothing of a company's leads (D8).
    expect(mailTo(BOOTSTRAP_ADMIN_EMAIL, on)).toEqual([]);
  }
}

/** Nothing scrolls sideways, and every control in the widgets is a thumb-sized target. */
async function phoneChecks(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `${label}: horizontal scroll`).toBeLessThanOrEqual(0);
  const small = await page.evaluate(() => {
    const out: string[] = [];
    const roots = ".aitw-root, .aisw-root, .aiew-root, .aiiw-root, .aicw-root";
    const nodes = document.querySelectorAll<HTMLElement>(
      ["button", "a.aitw-btn", "a.aisw-btn", "a.aiew-btn", "a.aiiw-btn", "select", "input:not([type=file]):not([type=color]):not([type=checkbox]):not([type=radio]):not([type=hidden])", "summary"]
        .map((control) => roots.split(", ").map((root) => `${root} ${control}`).join(", "))
        .join(", "),
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

// --- one owner's setup, the way an owner does it -----------------------------------------

async function createCompany(page: Page, who: { email: string; name: string }, name: string, slug: string): Promise<void> {
  await signIn(page, who, "webhook", "/dashboard");
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByLabel("What's your company called?").fill(name);
  await expect(page.locator("[data-aitw-address]")).toContainText(`/t/${slug}`);
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
}

async function companyDetails(page: Page, company: typeof GREEN): Promise<void> {
  await page.goto(`${server.origin}/settings/company`);
  const details = page.locator("#details");
  await details.getByLabel("Time zone").selectOption(company.zone);
  await details.getByLabel("Email customers can reach you at").fill(company.office);
  await details.getByLabel("Phone customers can call").fill(company.phone);
  await details.getByRole("button", { name: "Save" }).click();
  await expect(details.getByText("Saved").first()).toBeVisible();

  const branding = page.locator("#branding");
  await branding.locator('input[type="text"]').first().fill(company.colour);
  await expect(branding.locator("[data-aitw-ratio]")).toContainText("easy to read");
  await branding.getByRole("button", { name: "Save" }).click();
  await expect(branding.getByText("Saved").first()).toBeVisible();

  // The Invoices section: invoicing's registry fragment (D15), on the same page.
  const invoices = page.locator("#invoicing");
  await expect(invoices.getByRole("heading", { name: "Invoices" })).toBeVisible();
  await invoices.getByLabel("How customers pay you").fill(company.pay);
  await invoices.getByRole("button", { name: "Save" }).click();
  await expect(invoices.getByText("Saved").first()).toBeVisible();
}

async function estimateSettings(page: Page, taxPercent: string, company: typeof GREEN): Promise<void> {
  await page.goto(`${server.origin}/app/estimates/settings`);
  const start = page.locator('[data-aiew-panel="get-started"]');
  // The company's basics are the company's: no name or contact to type here.
  await expect(start.locator("[data-aiew-company-note]")).toContainText("These come from your company settings.");
  await expect(start.getByLabel("Business name")).toHaveCount(0);
  await start.getByLabel("Sales tax (%)").fill(taxPercent);
  await start.getByRole("button", { name: "Save and open my estimate page" }).click();
  // Then the business card: read-only, with the way to change it.
  const business = page.locator('[data-aiew-panel="business"]');
  await expect(business.locator("[data-aiew-managed]")).toContainText(company.name);
  await expect(business).toContainText(company.office);
  await expect(business).toContainText(company.phone);
  // The zone by its name, as Schedule settings says it — never "America/Denver" (review T2A-BO-14).
  await expect(business).toContainText(({ "America/Denver": "Mountain Time", "America/Chicago": "Central Time" } as Record<string, string>)[company.zone]!);
  await expect(business).not.toContainText(company.zone);
  await expect(business.getByRole("link", { name: "Change them in company settings" })).toHaveAttribute("href", "/settings/company#details");
  expect(await axe(page), "estimate settings").toEqual([]);
}

async function scheduleSetup(page: Page, crewName: string, company: typeof GREEN): Promise<void> {
  await page.goto(`${server.origin}/app/schedule/settings`);
  // Name, zone and contact: the company's, shown read-only with the link (D6).
  const managed = page.locator("[data-aisw-managed]");
  await expect(managed).toContainText(company.name);
  await expect(managed).toContainText(company.office);
  await expect(managed).toContainText(company.phone);
  await expect(managed.getByRole("link", { name: "Change them in company settings" })).toHaveAttribute("href", "/settings/company#details");

  const booking = page.locator("#booking");
  await booking.getByRole("switch", { name: /Take bookings online/ }).check();
  await booking.getByRole("button", { name: "Save", exact: true }).click();
  await expect(booking.getByText("Saved").first()).toBeVisible();

  const crews = page.locator("#crews");
  await crews.getByRole("button", { name: "+ Add a crew" }).click();
  await crews.getByLabel("Crew name").fill(crewName);
  await crews.getByRole("button", { name: "Add crew" }).click();
  await expect(crews.locator("[data-crew]").filter({ hasText: crewName })).toBeVisible();

  // Its usual hours, Monday to Friday, saved as its own.
  const hours = page.locator("#hours");
  await hours.getByRole("button", { name: "Save the week" }).click();
  await expect(hours.getByText("Saved").first()).toBeVisible();
  expect(await axe(page), "schedule settings").toEqual([]);
}

async function invite(page: Page, email: string, role: string): Promise<void> {
  await page.goto(`${server.origin}/settings/team`);
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Role", { exact: true }).selectOption(role);
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByText(`Invitation sent to ${email}.`).first()).toBeVisible();
}

/**
 * The dashboard's checklist, finished. The website embed is the one item an
 * owner may not need: Gail marks it "Not needed"; Sam made a key, so his is
 * already done.
 */
async function allSet(page: Page, embed: "skip" | "done"): Promise<void> {
  await page.goto(`${server.origin}/dashboard`);
  const item = page.locator('[data-item="estimator.embed"]');
  if (embed === "skip") {
    await item.getByRole("button", { name: /^Not needed/ }).click();
    await expect(item.getByText("Skipped").first()).toBeVisible();
  } else {
    await expect(item).toHaveAttribute("data-done", "");
  }
  await expect(page.getByText("You're all set.")).toBeVisible();
  expect(await axe(page), "dashboard, all set").toEqual([]);
}

/**
 * The company's own website, where the checklist's "Get the button" sends the
 * owner. FIRST what any website takes, no key and no developer (review
 * T2A-BO-02): a button in the company's colour and a page frame, both pointing
 * at its own estimate page. Then, under "For developers", a key: shown once,
 * with a snippet that points at THIS deployment's estimator and carries the key
 * — and "Test this key" proves it answers with the company's own products.
 * Returns the key.
 */
async function embedKey(page: Page, label: string, works: string, company: { slug: string; colour: string }): Promise<string> {
  await page.goto(`${server.origin}/app/estimates/settings#embed`);
  await expect(page.locator("[data-aiew-no-code]")).toContainText("Wix, Squarespace, WordPress");
  const copies = await page.locator("[data-aiew-copy] input").evaluateAll((inputs) => inputs.map((i) => (i as HTMLInputElement).value));
  const estimatePage = `${server.origin}/t/${company.slug}/estimate`;
  expect(copies.find((v) => v.startsWith("<a href="))).toContain(`href="${estimatePage}"`);
  expect(copies.find((v) => v.startsWith("<a href="))?.toLowerCase()).toContain(`background:${company.colour.toLowerCase()}`);
  expect(copies.find((v) => v.startsWith("<iframe"))).toContain(`src="${estimatePage}"`);
  await page.locator("[data-aiew-developer] > summary").click();
  const make = page.locator('[data-aiew-panel="new-key"]');
  await make.getByLabel("Name", { exact: true }).fill(label);
  await make.getByRole("button", { name: "Make the key" }).click();
  const issued = page.locator('[data-aiew-panel="issued"]');
  await expect(issued).toContainText(`Your new key: ${label}`);
  const key = await issued.getByLabel("Key", { exact: true }).inputValue();
  expect(key.length, "the key is shown once, in full").toBeGreaterThan(20);
  for (const snippet of ["modal", "inline"]) {
    const text = await issued.locator(`[data-aiew-snippet="${snippet}"]`).innerText();
    expect(text, `the ${snippet} snippet`).toContain(JSON.stringify(`${server.origin}/api/estimator`));
    expect(text, `the ${snippet} snippet`).toContain(JSON.stringify(key));
  }
  await issued.getByRole("button", { name: "Test this key" }).click();
  await expect(issued.locator("[data-aiew-test]")).toHaveText(works);
  expect(await axe(page), "website embed").toEqual([]);
  await issued.getByRole("button", { name: "I've copied it" }).click();
  return key;
}

/** The estimator embed on a company's own website: a keyed call from that site, no cookie, no web address. */
async function embedCall(key: string, path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${server.origin}/api/estimator/${path}`, {
    headers: { "x-adminigloo-key": key, origin: "https://www.summitlawn.example" },
  });
  return { status: response.status, body: await response.json() };
}

/** A customer asks for a visit on a company's booking page and leaves it there, unanswered. */
async function requestVisit(page: Page, slug: string, date: string, time: RegExp, who: { name: string; email: string; address: string }): Promise<void> {
  await page.goto(`${server.origin}/t/${slug}/book-visit`);
  await page.locator(`.aisw-day[data-date="${date}"]`).click();
  await page.getByRole("button", { name: time }).click();
  await page.getByLabel("Your name").fill(who.name);
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Address for the visit").fill(who.address);
  await page.getByRole("button", { name: "Request this visit" }).click();
  await expect(page.getByRole("heading", { name: "Request received" })).toBeVisible({ timeout: 15_000 });
}

/** Ids and links carried between steps. */
const state = {
  green: "",
  summit: "",
  patEstimate: "",
  patVisit: "",
  patQuoteLink: "",
  patInvoiceLink: "",
  patInvoiceId: "",
  summitInvoiceToken: "",
  patVisitLink: "",
  summitKey: "",
};

test.describe.serial("Green Acres and Summit Lawn on Igloo Back Office: two companies, their customers, their crews", () => {
  let gail: { context: BrowserContext; page: Page };
  let sam: { context: BrowserContext; page: Page };

  test.afterAll(async () => {
    await gail?.context.close();
    await sam?.context.close();
  });

  test("1. two companies set themselves up, each in its own area", async ({ browser }) => {
    test.setTimeout(180_000);
    gail = await person(browser, { timezoneId: GREEN.zone });
    sam = await person(browser, { timezoneId: SUMMIT.zone });
    await createCompany(gail.page, GAIL, GREEN.name, GREEN.slug);
    await createCompany(sam.page, SAM, SUMMIT.name, SUMMIT.slug);
    state.green = (await server.companyId(GREEN.slug))!;
    state.summit = (await server.companyId(SUMMIT.slug))!;
    expect(state.green).toBeTruthy();
    expect(state.summit).toBeTruthy();

    // A new company's checklist: Tenancy 1's three and every feature's.
    await expect(gail.page.getByText("0 of 9 done").first()).toBeVisible();
    expect(await axe(gail.page), "dashboard").toEqual([]);
    // The feature cards the owner's role opens.
    const cards = gail.page.getByRole("navigation", { name: "Go to" });
    for (const label of ["Schedule", "Today's route", "Estimates", "Invoices", "Messages", "Team", "Settings"]) {
      await expect(cards.getByRole("link", { name: label, exact: true })).toBeVisible();
    }

    // Each owner, in /settings/company: zone, contact, colour, how customers pay.
    await companyDetails(gail.page, GREEN);
    expect(await axe(gail.page), "company settings").toEqual([]);
    await companyDetails(sam.page, SUMMIT);

    // Gail loads the sample price book ON PURPOSE and puts one product on her website.
    await gail.page.goto(`${server.origin}/app/price-book`);
    await expect(gail.page.getByText("No products yet.")).toBeVisible();
    await gail.page.getByRole("button", { name: "Load a sample catalog" }).click();
    // The sample for HER trade, asked, never assumed (review T2A-BO-10): a lawn
    // company is never handed a wheelchair-ramp price book.
    const sample = gail.page.getByRole("dialog", { name: "Load a sample catalog?" });
    await sample.getByLabel("Lawn care and landscaping").check();
    await expect(sample).toContainText("This adds 5 sample products and 8 supplies with sample prices.");
    await sample.getByRole("button", { name: "Load the sample" }).click();
    const mowing = gail.page.locator("li", { hasText: "Lawn mowing" }).first();
    await expect(mowing).toContainText("Staff only");
    await expect(gail.page.locator("li", { hasText: /ramp/i })).toHaveCount(0);
    await mowing.getByRole("button", { name: "Edit" }).click();
    await gail.page.getByRole("switch", { name: /Show on your website/ }).check();
    await gail.page.getByRole("button", { name: "Save changes" }).click();
    await expect(gail.page.getByText("Saved", { exact: true })).toBeVisible();
    expect(await axe(gail.page), "price book").toEqual([]);

    // Sam adds one product by hand.
    await sam.page.goto(`${server.origin}/app/price-book`);
    await sam.page.getByRole("button", { name: "Add a product" }).first().click();
    await sam.page.getByLabel("Name", { exact: true }).fill("Spring cleanup");
    await sam.page.getByLabel("Measured as").selectOption({ label: "A count" });
    await sam.page.getByRole("switch", { name: /Show on your website/ }).check();
    await sam.page.getByLabel("Minimum charge ($)").fill("150");
    await sam.page.getByRole("button", { name: "Create the product" }).click();
    await expect(sam.page.getByRole("status").filter({ hasText: "Created" })).toBeVisible();
    await sam.page.getByRole("button", { name: "Back to products" }).click();
    await expect(sam.page.locator("li", { hasText: "Spring cleanup" }).first()).toBeVisible();

    // Estimate settings: the tax rate and quote rules are the estimator's own.
    await estimateSettings(gail.page, "7.25", GREEN);
    await estimateSettings(sam.page, "8", SUMMIT);

    // Sam puts the estimator on Summit's own website: a key, and the snippet
    // to paste there, pointing at this deployment.
    state.summitKey = await embedKey(sam.page, "Summit website", "Works: 1 product on your estimator.", SUMMIT);

    // Scheduling: online booking on, a crew with hours.
    await scheduleSetup(gail.page, "Green crew", GREEN);
    await scheduleSetup(sam.page, "Summit crew", SUMMIT);

    // The team: Gail invites a crew member and a member; Sam, a member. (The
    // Team page offers Crew, which scheduling adds to every company's roles.)
    await gail.page.goto(`${server.origin}/settings/team`);
    await expect(gail.page.getByLabel("Role", { exact: true }).locator("option", { hasText: "Crew member" })).toHaveCount(1);
    await invite(gail.page, CAM.email, "crew");
    await invite(gail.page, MIA.email, "member");
    await invite(gail.page, VIC.email, "viewer");
    await invite(sam.page, "sid@summitlawn.test", "member");

    // Every dashboard reaches "all set": Gail marks the website embed "Not
    // needed"; Sam's is done (he made a key).
    await allSet(gail.page, "skip");
    await allSet(sam.page, "done");
    expect(server.failures, "nothing failed quietly").toEqual([]);
  });

  test("2. each company's public pages: its name, its colour, its time zone", async ({ browser }) => {
    const visitor = await person(browser, { viewport: PHONE, timezoneId: "America/New_York" });
    const { page } = visitor;
    await page.goto(`${server.origin}/t/${GREEN.slug}/estimate`);
    const bar = page.locator(".aitw-brandbar");
    await expect(bar).toContainText(GREEN.name);
    await expect(bar).toHaveAttribute("style", new RegExp(`--aitw-brand:\\s*${GREEN.colour}`, "i"));
    await expect(page.locator(".aiew-root").first()).toContainText("Lawn mowing");
    await expect(page.locator(".aiew-root").first()).not.toContainText("Spring cleanup");
    // The tab is Green Acres', never this site's (review T2A-BO-01).
    await expect(page).toHaveTitle(`Instant estimate · ${GREEN.name}`);
    expect(await axe(page), "public estimate page").toEqual([]);

    // Times in the COMPANY's zone, whatever the visitor's (New York here).
    await page.goto(`${server.origin}/t/${SUMMIT.slug}/book-visit`);
    await expect(page.locator(".aitw-brandbar")).toContainText(SUMMIT.name);
    await expect(page.getByText(/Times are/)).toContainText("Central Time");
    expect(await axe(page), "public booking page").toEqual([]);
    await page.goto(`${server.origin}/t/${GREEN.slug}/book-visit`);
    await expect(page.getByText(/Times are/)).toContainText("Mountain Time");

    // The company's home: a button per public page.
    await page.goto(`${server.origin}/t/${GREEN.slug}`);
    await expect(page.getByRole("link", { name: "Get an instant estimate" })).toHaveAttribute("href", `/t/${GREEN.slug}/estimate`);
    await expect(page.getByRole("link", { name: "Book a visit" })).toHaveAttribute("href", `/t/${GREEN.slug}/book-visit`);
    await visitor.context.close();

    // The embed on Summit's own website: the KEY alone names the company — its
    // name, its zone, its one product; nothing of Green Acres'.
    const embedded = await embedCall(state.summitKey, "v1/config");
    expect(embedded.status).toBe(200);
    expect(embedded.body).toMatchObject({ businessName: SUMMIT.name, timeZone: SUMMIT.zone, instantEstimatesEnabled: true });
    expect(embedded.body.products.map((p: { name: string }) => p.name)).toEqual(["Spring cleanup"]);
  });

  test("3. a customer of Green Acres, end to end: estimate, visit, quote, invoice — all of it Green Acres', none of it Summit's", async ({ browser }) => {
    test.setTimeout(180_000);
    const pat = await person(browser, { viewport: PHONE, timezoneId: "America/New_York" });
    const { page } = pat;

    // The estimate, on Green Acres' page: the one product it put on its website.
    await page.goto(`${server.origin}/t/${GREEN.slug}/estimate`);
    await page.getByRole("button", { name: "One more: How many visits?" }).click();
    await expect(page.locator("[data-aiew-price] [data-aiew-amount]")).toContainText("$");
    await page.getByLabel("Your name").fill(PAT.name);
    await page.getByLabel("Email").fill(PAT.email);
    await page.getByLabel("Phone").fill(PAT.phone);
    await page.getByLabel("Address of the job").fill(PAT.address);
    await page.getByRole("button", { name: "Send me this estimate" }).click();
    await expect(page.locator("[data-aiew-done]")).toContainText(/Thanks, Pat\. Your estimate EST-\d{4}-\d{4} is saved\./, { timeout: 15_000 });
    const [estimate] = await server.query<{ id: string; tenant_id: string }>("select id, tenant_id from estimator_estimates where customer_email = $1", [PAT.email]);
    expect(estimate!.tenant_id).toBe(state.green);
    state.patEstimate = estimate!.id;
    await expectMailTo(PAT.email, /^Your estimate from Green Acres/);
    await expectMailTo(GREEN.office, /^New lead: Pat Rivera/);

    // A visit tied to it, on Green Acres' booking page, in Mountain Time.
    const book = page.getByRole("link", { name: /Book a visit/ });
    await expect(book).toHaveAttribute("href", `/t/${GREEN.slug}/book-visit?estimate=${state.patEstimate}`);
    await book.click();
    await expect(page.getByText(/Times are/)).toContainText("Mountain Time");
    await page.locator('.aisw-day[data-date="2026-11-04"]').click();
    await page.getByRole("button", { name: /^9:00 AM to 10:00 AM/ }).click();
    await page.getByLabel("Your name").fill(PAT.name);
    await page.getByLabel("Email").fill(PAT.email);
    await page.getByLabel("Address for the visit").fill(PAT.address);
    await page.getByRole("button", { name: "Request this visit" }).click();
    await expect(page.getByRole("heading", { name: "Request received" })).toBeVisible({ timeout: 15_000 });
    const [visit] = await server.query<{ id: string; tenant_id: string; estimate_id: string }>(
      "select id, tenant_id, estimate_id from scheduling_bookings where customer_email = $1",
      [PAT.email],
    );
    expect(visit).toMatchObject({ tenant_id: state.green, estimate_id: state.patEstimate });
    state.patVisit = visit!.id;
    await expectMailTo(GREEN.office, /^New request: Pat Rivera/);

    // Gail accepts the visit in HER schedule (hers to change: New visit is offered).
    await gail.page.goto(`${server.origin}/app/schedule`);
    await expect(gail.page.getByRole("button", { name: "New visit" })).toBeVisible();
    await gail.page.getByRole("button", { name: "Requests, 1 waiting" }).click();
    const inbox = gail.page.getByRole("dialog", { name: /Requests/ });
    await expect(inbox).toContainText(PAT.name);
    await inbox.getByRole("button", { name: /^Accept Pat Rivera/ }).click();
    await expect(inbox.getByRole("button", { name: /^Accept Pat Rivera/ })).toHaveCount(0);
    await gail.page.keyboard.press("Escape");
    state.patVisitLink = tokenLink(await expectMailTo(PAT.email, /^Confirmed:/), GREEN.slug, "visit");
    expect(await axe(gail.page), "schedule").toEqual([]);

    // Pat's link to manage the visit: Green Acres' page, the time on Green
    // Acres' clock (Mountain), whatever Pat's own (New York).
    await page.goto(state.patVisitLink);
    await expect(page.locator(".aitw-brandbar")).toContainText(GREEN.name);
    const manage = page.locator(".aisw-root");
    await expect(manage.locator("[data-aisw-status]")).toHaveText(/Confirmed/);
    await expect(manage).toContainText(/Wednesday, November 4, 9:00/);
    await expect(manage).toContainText("MST");
    await expect(manage).toContainText(`with ${GREEN.name}`);
    expect(await axe(page), "manage-visit page").toEqual([]);
    // The same token under Summit's web address opens nothing (D13).
    const visitToken = decodeURIComponent(new URL(state.patVisitLink).pathname.split("/").at(-1)!);
    await page.goto(`${server.origin}/t/${SUMMIT.slug}/visit/${encodeURIComponent(visitToken)}`);
    await expect(page.getByRole("heading", { name: "This link doesn't open a visit." })).toBeVisible();
    await expect(page.locator("body")).not.toContainText(PAT.address);

    // She sends the quote from the estimate's page (hers to work: New estimate is offered).
    await gail.page.goto(`${server.origin}/app/estimates`);
    await expect(gail.page.getByRole("button", { name: "New estimate" })).toBeVisible();
    await gail.page.locator(`[data-aiew-row="${state.patEstimate}"]`).click();
    await expect(gail.page).toHaveURL(`${server.origin}/app/estimates/${state.patEstimate}`);
    expect(await axe(gail.page), "estimate").toEqual([]);
    await gail.page.getByRole("button", { name: "Send quote" }).click();
    await gail.page.getByRole("dialog", { name: "Send the quote" }).getByRole("button", { name: `Send to ${PAT.email}` }).click();
    await expect(gail.page.getByText(`Quote sent to ${PAT.email}.`)).toBeVisible();
    state.patQuoteLink = tokenLink(await expectMailTo(PAT.email, /^Your quote from Green Acres/), GREEN.slug, "quote");

    // Pat accepts it on Green Acres' quote page.
    await page.goto(state.patQuoteLink);
    await expect(page.locator(".aitw-brandbar")).toContainText(GREEN.name);
    await page.getByRole("button", { name: "Accept this quote" }).click();
    await page.getByRole("button", { name: "Yes, accept the quote" }).click();
    await expect(page.getByText(/You accepted this quote on/)).toBeVisible();
    expect(await axe(page), "quote page").toEqual([]);
    await expectMailTo(GREEN.office, /^Quote accepted: Pat Rivera/);

    // Gail turns it into an invoice and sends it.
    await gail.page.reload();
    await gail.page.getByRole("button", { name: "Make an invoice" }).click();
    await gail.page.getByRole("dialog", { name: "Make an invoice from this quote?" }).getByRole("button", { name: "Make the invoice" }).click();
    await expect(gail.page.getByText(/Invoice INV-\d{4}-\d{4} made\./)).toBeVisible();
    const [invoice] = await server.query<{ id: string; tenant_id: string }>("select id, tenant_id from invoices where estimate_id = $1", [state.patEstimate]);
    expect(invoice!.tenant_id).toBe(state.green);
    state.patInvoiceId = invoice!.id;
    await gail.page.goto(`${server.origin}/app/invoices/${state.patInvoiceId}`);
    expect(await axe(gail.page), "invoice").toEqual([]);
    await gail.page.getByRole("button", { name: `Send to ${PAT.email}` }).click();
    state.patInvoiceLink = tokenLink(await expectMailTo(PAT.email, /Invoice INV-\d{4}-\d{4} from Green Acres/), GREEN.slug, "invoice");
    // Sent: the owner can take a payment against it (the viewer, in step 4, can't).
    await expect(gail.page.getByRole("button", { name: "Record payment" })).toBeVisible();

    // Pat opens it: Green Acres' invoice, with Green Acres' way to pay.
    await page.goto(state.patInvoiceLink);
    await expect(page.locator(".aitw-brandbar")).toContainText(GREEN.name);
    await expect(page.locator(".aiiw-root")).toContainText(GREEN.pay);
    expect(await axe(page), "invoice page").toEqual([]);

    // THE OUTBOX: every email to Pat is Green Acres' — its name, its reply-to,
    // its pages; every office notice went to Green Acres' own address.
    expectCompanyMail({ company: GREEN, customer: PAT.email, officeNotices: true });
    expect(mailTo(SUMMIT.office), "Summit's office heard nothing of Pat").toEqual([]);
    // The delivery log says the same, row by row.
    const logged = await server.query<{ tenant_id: string; from_name: string | null; reply_to: string | null }>(
      "select tenant_id, from_name, reply_to from comms_messages where to_address = $1",
      [PAT.email],
    );
    expect(logged.length).toBeGreaterThan(0);
    for (const row of logged) expect(row).toEqual({ tenant_id: state.green, from_name: GREEN.name, reply_to: GREEN.office });

    // A Summit invoice token under Green Acres' address is not found (D13);
    // under Summit's own, it opens.
    const made = await api(sam.page, "POST", `/api/app/${state.summit}/invoices/v1/admin/invoices`, {
      customerName: LOU.name,
      customerEmail: LOU.email,
      items: [{ description: "Spring cleanup", quantity: 1, unitPrice: 15_000 }],
    });
    expect(made.status).toBe(201);
    // Sent (a draft is nobody's to see): Lou's email is Summit's, as Pat's are Green Acres'.
    expect((await api(sam.page, "POST", `/api/app/${state.summit}/invoices/v1/admin/invoices/${made.body.invoice.id}/send`, {})).status).toBe(200);
    expectCompanyMail({ company: SUMMIT, customer: LOU.email });
    const [summitInvoice] = await server.query<{ view_token: string; tenant_id: string }>("select view_token, tenant_id from invoices where customer_email = $1", [LOU.email]);
    expect(summitInvoice!.tenant_id).toBe(state.summit);
    state.summitInvoiceToken = summitInvoice!.view_token;
    await page.goto(`${server.origin}/t/${GREEN.slug}/invoice/${encodeURIComponent(state.summitInvoiceToken)}`);
    await expect(page.getByText("This invoice isn't available.", { exact: false })).toBeVisible();
    await expect(page.locator("body")).not.toContainText(LOU.name);
    await page.goto(`${server.origin}/t/${SUMMIT.slug}/invoice/${encodeURIComponent(state.summitInvoiceToken)}?preview=1`);
    await expect(page.locator(".aiiw-root")).toContainText(LOU.name);

    // SUMMIT SEES NONE OF IT: its screens show its own (an empty queue, its
    // own invoice) and nothing of Pat's.
    const sp = sam.page;
    await sp.goto(`${server.origin}/app/estimates`);
    await expect(sp.locator("[data-aiew-empty]")).toBeVisible();
    await expect(sp.locator("body")).not.toContainText(PAT.name);
    await sp.goto(`${server.origin}/app/schedule`);
    await expect(sp.getByRole("button", { name: "Requests, 0 waiting" })).toBeVisible();
    await expect(sp.locator("body")).not.toContainText(PAT.name);
    await sp.goto(`${server.origin}/app/invoices`);
    await expect(sp.locator(".aiiw-root")).toContainText(LOU.name);
    await expect(sp.getByRole("button", { name: "New invoice" })).toBeVisible();
    await expect(sp.locator("body")).not.toContainText(PAT.name);
    await sp.goto(`${server.origin}/app/messages`);
    await expect(sp.getByRole("heading", { name: "What went out" })).toBeVisible();
    await expect(sp.getByText("Loading what went out…")).toHaveCount(0);
    await expect(sp.locator("body")).not.toContainText(PAT.email);
    expect(await axe(sp), "messages").toEqual([]);
    // …and through the routes: Green Acres' id in the path is refused for Sam.
    const refused = await api(sp, "GET", `/api/app/${state.green}/estimator/v1/admin/estimates`);
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: { code: "forbidden", message: "You're not part of this company." } });
    for (const route of [
      `/api/app/${state.green}/schedule/v1/admin/visits/${state.patVisit}`,
      `/api/app/${state.green}/invoices/v1/admin/invoices/${state.patInvoiceId}`,
      `/api/app/${state.green}/messages/v1/admin/messages`,
    ]) {
      expect((await api(sp, "GET", route)).status, route).toBe(403);
    }
    // Gail's Messages shows what went out, as Green Acres.
    await gail.page.goto(`${server.origin}/app/messages`);
    await expect(gail.page.locator(".aicw-root")).toContainText(PAT.email);
    await pat.context.close();
    expect(server.failures, "nothing failed quietly").toEqual([]);
  });

  test("4. company roles: a crew member sees only today's route; a member quotes but doesn't keep the price book; a viewer reads", async ({ browser }) => {
    test.setTimeout(180_000);
    // Wednesday 07:00 in Denver: the morning of Pat's visit.
    server.setClock(new Date("2026-11-04T14:00:00Z"));

    // Cam accepts his invitation (Crew).
    const cam = await person(browser, { viewport: PHONE, timezoneId: GREEN.zone });
    const camLink = server.invitations.filter((i) => i.to === CAM.email).at(-1)!.url;
    await signIn(cam.page, CAM, "page", new URL(camLink).pathname);
    await expect(cam.page.getByText(`${GREEN.name} invited you to join as a Crew member.`).first()).toBeVisible();
    await cam.page.getByRole("button", { name: "Accept invitation" }).click();
    await expect(cam.page).toHaveURL(/\/dashboard$/, { timeout: 10_000 });
    // His header: the dashboard and his route. Nothing else.
    const camNav = cam.page.getByRole("navigation", { name: "Main" }).getByRole("link");
    await expect(camNav).toHaveText(["Dashboard", "Today's route"]);
    await expect(cam.page.getByRole("navigation", { name: "Go to" }).getByRole("link")).toHaveText(["Today's route"]);
    expect(await axe(cam.page), "crew dashboard").toEqual([]);

    // Mia accepts hers (Member).
    const mia = await person(browser, { timezoneId: GREEN.zone });
    const miaLink = server.invitations.filter((i) => i.to === MIA.email).at(-1)!.url;
    await signIn(mia.page, MIA, "page", new URL(miaLink).pathname);
    await mia.page.getByRole("button", { name: "Accept invitation" }).click();
    await expect(mia.page).toHaveURL(/\/dashboard$/, { timeout: 10_000 });

    // Cam joined as a crew member and Green Acres has ONE crew nobody opens:
    // he is put on it as he joins, so his first morning isn't a dead end
    // (review T2A-BO-04). Gail sees him picked; the picker lists Green Acres'
    // own people — never Summit's.
    await expect.poll(async () => (await server.query<{ user_id: string | null }>("select user_id from scheduling_resources where name = 'Green crew'"))[0]?.user_id).not.toBeNull();
    await gail.page.goto(`${server.origin}/app/schedule/settings`);
    const crew = gail.page.locator("#crews [data-crew]").filter({ hasText: "Green crew" });
    await crew.getByRole("button", { name: "Edit" }).click();
    const picker = crew.getByLabel("Who opens this crew's route");
    const people = await picker.locator("option").allTextContents();
    expect(people.some((p) => p.includes(CAM.email))).toBe(true);
    expect(people.some((p) => p.includes(MIA.email))).toBe(true);
    expect(people.some((p) => p.includes("summitlawn"))).toBe(false);
    await expect(picker.locator("option:checked")).toHaveText(`${CAM.name} (${CAM.email})`);
    await crew.getByRole("button", { name: "Close" }).first().click();

    // Cam's route this morning: Pat's visit, on his phone.
    await cam.page.goto(`${server.origin}/app/schedule/today`);
    const stops = cam.page.getByRole("list", { name: "Stops, in order" });
    await expect(stops).toContainText(PAT.name);
    await expect(stops).toContainText(PAT.address);
    expect(await axe(cam.page), "today's route").toEqual([]);
    // TODAY's route only (review SEC-2A-05): no other day is offered, and the
    // route refuses one asked for directly.
    await expect(cam.page.getByRole("button", { name: "Next day" })).toHaveCount(0);
    await expect(cam.page.getByRole("button", { name: "Previous day" })).toHaveCount(0);
    expect((await api(cam.page, "GET", `/api/app/${state.green}/schedule/v1/admin/crew-day?date=2026-11-05`)).status).toBe(403);
    // Everything else is closed to him, on the page and on the route.
    await cam.page.goto(`${server.origin}/app/estimates`);
    await expect(cam.page.getByRole("heading", { name: "You don't have access to this page" })).toBeVisible();
    expect(await axe(cam.page), "no access").toEqual([]);
    expect((await api(cam.page, "GET", `/api/app/${state.green}/estimator/v1/admin/estimates`)).status).toBe(403);
    expect((await api(cam.page, "GET", `/api/app/${state.green}/invoices/v1/admin/invoices`)).status).toBe(403);

    // Mia quotes: an estimate for a new customer, and the quote sent from its page.
    const [threshold] = await server.query<{ id: string }>("select id from estimator_products where tenant_id = $1 and name = 'Lawn mowing'", [state.green]);
    const made = await api(mia.page, "POST", `/api/app/${state.green}/estimator/v1/admin/estimates`, {
      customerName: "Lee Lawn",
      customerEmail: "lee@example.com",
      items: [{ productId: threshold!.id, inputs: { count: 2 } }],
    });
    expect(made.status).toBe(201);
    await mia.page.goto(`${server.origin}/app/estimates/${made.body.estimate.id}`);
    await mia.page.getByRole("button", { name: "Send quote" }).click();
    await mia.page.getByRole("dialog", { name: "Send the quote" }).getByRole("button", { name: "Send to lee@example.com" }).click();
    await expect(mia.page.getByText("Quote sent to lee@example.com.")).toBeVisible();
    expectCompanyMail({ company: GREEN, customer: "lee@example.com" });
    // …but the price book is the owner's: shown, and nothing offered to change it.
    await mia.page.goto(`${server.origin}/app/price-book`);
    await expect(mia.page.getByText("You can see the price book. Only the owner or an admin can change it.")).toBeVisible();
    await expect(mia.page.locator("li", { hasText: "Lawn mowing" }).first()).toBeVisible();
    for (const control of ["Add a product", "Edit", "Retire"]) await expect(mia.page.getByRole("button", { name: control, exact: true })).toHaveCount(0);
    expect(await axe(mia.page), "price book, read-only").toEqual([]);
    // …and estimate settings are read-only.
    await mia.page.goto(`${server.origin}/app/estimates/settings`);
    await expect(mia.page.getByText("Only the owner or an admin can change these settings.")).toBeVisible();
    await expect(mia.page.getByLabel("Sales tax (%)")).toBeDisabled();
    await expect(mia.page.getByRole("button", { name: "Make the key" })).toHaveCount(0);
    expect(await axe(mia.page), "estimate settings, read-only").toEqual([]);
    // The server says the same if she tries anyway.
    expect((await api(mia.page, "POST", `/api/app/${state.green}/estimator/v1/admin/settings`, { taxRateBp: 0 })).status).toBe(403);

    // Vic accepts his (Viewer): he READS — every list Green Acres keeps, and
    // nothing offered to change, on the screens or through the routes.
    const vic = await person(browser, { timezoneId: GREEN.zone });
    const vicLink = server.invitations.filter((i) => i.to === VIC.email).at(-1)!.url;
    await signIn(vic.page, VIC, "page", new URL(vicLink).pathname);
    await expect(vic.page.getByText(`${GREEN.name} invited you to join as a Viewer.`).first()).toBeVisible();
    await vic.page.getByRole("button", { name: "Accept invitation" }).click();
    await expect(vic.page).toHaveURL(/\/dashboard$/, { timeout: 10_000 });
    await expect(vic.page.getByRole("navigation", { name: "Main" }).getByRole("link")).toHaveText([
      "Dashboard",
      "Schedule",
      "Estimates",
      "Invoices",
      "Messages",
      "Team",
      "Settings",
    ]);
    await vic.page.goto(`${server.origin}/app/schedule`);
    await expect(vic.page.getByRole("button", { name: /^Requests, \d+ waiting$/ })).toBeVisible();
    await expect(vic.page.getByRole("button", { name: "New visit" })).toHaveCount(0);
    expect(await axe(vic.page), "schedule, read-only").toEqual([]);
    await vic.page.goto(`${server.origin}/app/estimates`);
    await vic.page.locator('[data-aiew-filters] [data-filter="all"]').click();
    await expect(vic.page.locator(`[data-aiew-row="${state.patEstimate}"]`)).toBeVisible();
    await expect(vic.page.getByRole("button", { name: "New estimate" })).toHaveCount(0);
    // Lee's quote, as Mia sent it: shown in full, nothing offered to change it.
    const [lee] = await server.query<{ id: string }>("select id from estimator_estimates where customer_email = 'lee@example.com'");
    await vic.page.goto(`${server.origin}/app/estimates/${lee!.id}`);
    await expect(vic.page.locator(".aiew-root").first()).toContainText("Lee Lawn");
    await expect(vic.page.getByText("You can see this estimate. Your role can't change it.")).toBeVisible();
    for (const control of ["Send again", "Revise", "Customer said yes", "Archive", "Duplicate"]) {
      await expect(vic.page.getByRole("button", { name: control, exact: true }), control).toHaveCount(0);
    }
    await expect(vic.page.getByText("Add photo")).toHaveCount(0);
    expect(await axe(vic.page), "estimate, read-only").toEqual([]);
    await vic.page.goto(`${server.origin}/app/invoices`);
    await expect(vic.page.locator(".aiiw-root")).toContainText(PAT.name);
    await expect(vic.page.getByRole("button", { name: "New invoice" })).toHaveCount(0);
    await vic.page.goto(`${server.origin}/app/invoices/${state.patInvoiceId}`);
    await expect(vic.page.locator(".aiiw-root")).toContainText(PAT.name);
    await expect(vic.page.getByRole("button", { name: /^Send to / })).toHaveCount(0);
    await expect(vic.page.getByRole("button", { name: "Record payment" })).toHaveCount(0);
    const read = await api(vic.page, "GET", `/api/app/${state.green}/estimator/v1/admin/estimates`);
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body)).toContain(PAT.name);
    for (const [path, body] of [
      [`/api/app/${state.green}/estimator/v1/admin/estimates`, { customerName: "Not allowed" }],
      [`/api/app/${state.green}/invoices/v1/admin/invoices`, { customerName: "Not allowed", items: [{ description: "x", quantity: 1, unitPrice: 100 }] }],
      [`/api/app/${state.green}/schedule/v1/admin/visits/${state.patVisit}/details`, { notes: "Not allowed" }],
      [`/api/app/${state.green}/messages/v1/admin/run-due`, {}],
    ] as const) {
      expect((await api(vic.page, "POST", path, body)).status, `a viewer's POST ${path}`).toBe(403);
    }

    await cam.context.close();
    await mia.context.close();
    await vic.context.close();
    expect(server.failures, "nothing failed quietly").toEqual([]);
  });

  test("5. crons serve every active company, skip a suspended one, and one company's failure stops no other", async ({ browser }) => {
    test.setTimeout(180_000);
    // Both companies hold a request nobody answers.
    const kim = await person(browser, { viewport: PHONE, timezoneId: GREEN.zone });
    await requestVisit(kim.page, GREEN.slug, "2026-11-06", /^10:00 AM to 11:00 AM/, KIM);
    const lou = await person(browser, { viewport: PHONE, timezoneId: SUMMIT.zone });
    await requestVisit(lou.page, SUMMIT.slug, "2026-11-06", /^9:00 AM to 10:00 AM/, LOU);
    // A third company, so a failed run has someone else to go on to.
    const tia = await person(browser);
    await createCompany(tia.page, { email: "tia@thirdturf.test", name: "Tia Turf" }, "Third Turf", "third-turf");
    const third = (await server.companyId("third-turf"))!;

    // Ava, the platform owner, looks into Green Acres (its people, its
    // activity), then suspends Summit Lawn — in /admin, the operator console.
    const ava = await person(browser);
    await signIn(ava.page, AVA, "page", "/admin/companies");
    await expect(ava.page.getByRole("heading", { name: "Companies" })).toBeVisible();
    const search = ava.page.getByLabel("Search companies by name, web address or owner's email");
    await search.fill("green");
    await ava.page.getByRole("link", { name: GREEN.name }).click();
    await expect(ava.page.locator("body")).toContainText(CAM.email);
    await expect(ava.page.locator("body")).toContainText(MIA.email);
    expect(await axe(ava.page), "company detail").toEqual([]);
    await ava.page.goto(`${server.origin}/admin/companies`);
    await search.fill("summit");
    await ava.page.getByRole("link", { name: SUMMIT.name }).click();
    await ava.page.getByRole("button", { name: "Suspend company" }).click();
    await ava.page.getByLabel("Why (only staff see this)").fill("Payment needed");
    await ava.page.getByRole("dialog").getByRole("button", { name: "Suspend" }).click();
    await expect(ava.page.getByText(`${SUMMIT.name} is suspended.`).first()).toBeVisible();

    // Its public pages say so plainly, with how to reach it; no widget, no request.
    await lou.page.goto(`${server.origin}/t/${SUMMIT.slug}/book-visit`);
    await expect(lou.page.getByRole("heading", { name: `${SUMMIT.name} isn't taking requests online right now` })).toBeVisible();
    await expect(lou.page.locator("[data-aitw-unavailable]")).toContainText(`Call ${SUMMIT.phone}`);
    await expect(lou.page.locator(".aisw-root")).toHaveCount(0);
    expect(await axe(lou.page), "suspended company's page").toEqual([]);
    // …and its public API refuses, for a page loaded before or an embed elsewhere.
    const closed = await api(lou.page, "GET", `/api/t/${SUMMIT.slug}/schedule/v1/config`);
    expect(closed.status).toBe(409);
    expect(closed.body.error).toMatchObject({ code: "booking_closed", message: `${SUMMIT.name} isn't taking requests online right now. Call ${SUMMIT.phone} or email ${SUMMIT.office}.` });
    // …and so does its estimator on its own website: the key still names
    // Summit, and Summit is closed.
    const embedClosed = await embedCall(state.summitKey, "v1/config");
    expect(embedClosed.status).toBe(409);
    expect(embedClosed.body.error).toMatchObject({
      code: "estimates_closed",
      message: `${SUMMIT.name} isn't taking requests online right now. Call ${SUMMIT.phone} or email ${SUMMIT.office}.`,
    });

    // Saturday morning, the scheduling cron's hour: both requests are long overdue.
    server.setClock(new Date("2026-11-07T13:00:30Z"));
    const run = await (await fetch(`${server.origin}/__test/cron/scheduling`, { method: "POST" })).json();
    expect(run.companies, "active companies: Green Acres and Third Turf, not Summit").toBe(2);
    expect(run.failed).toEqual([]);
    expect(run.ran).toEqual(expect.arrayContaining([{ tenantId: state.green, result: 1 }, { tenantId: third, result: 0 }]));
    const status = async (email: string) => (await server.query<{ status: string }>("select status from scheduling_bookings where customer_email = $1", [email]))[0]!.status;
    expect(await status(KIM.email), "Green Acres' unanswered request").toBe("expired");
    expect(await status(LOU.email), "Summit's, while Summit is suspended").toBe("pending");
    // Kim is told — by Green Acres.
    await expectMailTo(KIM.email, /^We couldn't confirm .* in time/);
    expectCompanyMail({ company: GREEN, customer: KIM.email });

    // One company's run breaks: it is reported, and the next company still runs.
    const broken = await (await fetch(`${server.origin}/__test/cron/scheduling?failCompany=${encodeURIComponent(state.green)}`, { method: "POST" })).json();
    expect(broken.failed).toEqual([{ tenantId: state.green, error: "this company's run broke on purpose" }]);
    expect(broken.ran).toEqual([{ tenantId: third, result: 0 }]);

    // The other two crons walk the same list.
    const estimates = await (await fetch(`${server.origin}/__test/cron/estimator`, { method: "POST" })).json();
    expect(estimates.companies).toBe(2);
    expect(estimates.failed).toEqual([]);
    const drained = await (await fetch(`${server.origin}/__test/cron/comms`, { method: "POST" })).json();
    expect(drained.failed).toBe(0);
    // Nothing went out under Summit's name while it is suspended.
    expect(server.outbox.filter((m) => m.fromName === SUMMIT.name && m.at >= "2026-11-07")).toEqual([]);

    for (const p of [kim, lou, tia, ava]) await p.context.close();
    expect(server.failures, "nothing failed quietly").toEqual([]);
  });

  test("6. on a phone: today's route, the booking page, the invoice and the ledger — nothing scrolls sideways, every target thumb-sized", async ({ browser }) => {
    const cam = await person(browser, { viewport: PHONE, timezoneId: GREEN.zone });
    await signIn(cam.page, CAM, "page", "/app/schedule/today");
    await expect(cam.page.getByRole("heading", { name: "Green crew" })).toBeVisible();
    await phoneChecks(cam.page, "today's route");

    const visitor = await person(browser, { viewport: PHONE, timezoneId: "America/New_York" });
    await visitor.page.goto(`${server.origin}/t/${GREEN.slug}/book-visit`);
    await expect(visitor.page.getByText(/Times are/)).toBeVisible();
    await phoneChecks(visitor.page, "booking page");
    await visitor.page.goto(state.patInvoiceLink);
    await expect(visitor.page.locator(".aiiw-root")).toContainText(GREEN.pay);
    await phoneChecks(visitor.page, "invoice page");

    const owner = await person(browser, { viewport: PHONE, timezoneId: GREEN.zone });
    await signIn(owner.page, GAIL, "page", "/app/invoices");
    await expect(owner.page.locator(".aiiw-root")).toContainText(PAT.name);
    await phoneChecks(owner.page, "invoices");
    for (const p of [cam, visitor, owner]) await p.context.close();
  });
});

// ---------------------------------------------------------------------------
// NEGATIVE CONTROLS: a test that passes either way guards nothing. Each pair
// runs ONE assertion of the scenario on a fresh fixture: once as it is (it
// must pass), once with the fixture's wiring deliberately broken (it must
// FAIL, `test.fail()`). The packages carry no bug switches; the break is
// in the fixture, where a generated project's wiring would be.
// ---------------------------------------------------------------------------

/**
 * A company set up through the routes its owner's screens call (the screens
 * themselves are step 1's business): the company, its contact details and
 * how its customers pay. Returns its id and a caller signed in as the owner.
 */
async function companyByApi(target: Tenancy2aScenarioServer, owner: { email: string; name: string }, company: typeof GREEN) {
  const signedIn = await fetch(`${target.origin}/__test/sign-in?${new URLSearchParams({ email: owner.email, name: owner.name, via: "webhook" })}`, { redirect: "manual" });
  const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
  const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const response = await fetch(`${target.origin}${path}`, {
      method,
      headers: { cookie, origin: target.origin, "sec-fetch-site": "same-origin", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json().catch(() => null)) as any };
  };
  const created = await call("POST", "/api/tenancy/v1/companies", {
    name: company.name,
    slug: company.slug,
    purpose: "onboarding",
    requestKey: `e2e-${company.slug}-request-key-0001`,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const id = created.body.company.id as string;
  const details = await call("POST", `/api/tenancy/v1/companies/${id}/settings/company`, {
    values: { timeZone: company.zone, contactEmail: company.office, contactPhone: company.phone },
  });
  expect(details.status, JSON.stringify(details.body)).toBe(200);
  const paying = await call("POST", `/api/tenancy/v1/companies/${id}/settings/invoicing`, { values: { paymentInstructions: company.pay, dueDays: 14 } });
  expect(paying.status, JSON.stringify(paying.body)).toBe(200);
  return { id, call };
}

/** An invoice raised and sent through the company's own ledger routes. */
async function sendInvoice(company: Awaited<ReturnType<typeof companyByApi>>, customer: { name: string; email: string }): Promise<void> {
  const made = await company.call("POST", `/api/app/${company.id}/invoices/v1/admin/invoices`, {
    customerName: customer.name,
    customerEmail: customer.email,
    items: [{ description: "Spring cleanup", quantity: 1, unitPrice: 15_000 }],
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const sent = await company.call("POST", `/api/app/${company.id}/invoices/v1/admin/invoices/${made.body.invoice.id}/send`, {});
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
}

/** Step 3's outbox assertion, on its own: Green Acres' customer's email is Green Acres'. */
async function greenAcresInvoiceIsGreenAcres(target: Tenancy2aScenarioServer): Promise<void> {
  const green = await companyByApi(target, GAIL, GREEN);
  await sendInvoice(green, PAT);
  expectCompanyMail({ company: GREEN, customer: PAT.email }, target);
}

/** Step 3's D13 assertion, on its own: a Summit invoice token under Green Acres' web address is not found. */
async function summitTokenIsNotGreenAcres(target: Tenancy2aScenarioServer, browser: Browser): Promise<void> {
  await companyByApi(target, GAIL, GREEN);
  const summit = await companyByApi(target, SAM, SUMMIT);
  await sendInvoice(summit, LOU);
  const [row] = await target.query<{ view_token: string }>("select view_token from invoices where customer_email = $1", [LOU.email]);
  const context = await browser.newContext({ viewport: PHONE });
  try {
    const page = await context.newPage();
    await page.goto(`${target.origin}/t/${GREEN.slug}/invoice/${encodeURIComponent(row!.view_token)}`);
    await expect(page.locator(".aiiw-root")).toContainText("This invoice isn't available.", { timeout: 5_000 });
    await expect(page.locator("body")).not.toContainText(LOU.name);
  } finally {
    await context.close();
  }
}

test.describe("negative controls: the same assertion, on a fixture wired right and on one wired wrong", () => {
  test("wired right: Green Acres' invoice email goes out as Green Acres", async () => {
    const target = await startTenancy2aScenarioServer({ start: START });
    try {
      await greenAcresInvoiceIsGreenAcres(target);
    } finally {
      await target.close();
    }
  });

  test("break=shared-identity (MUST FAIL): the comms senders get no identity, so the customer hears from the platform", async () => {
    test.fail();
    const broken = await startTenancy2aScenarioServer({ start: START, break: "shared-identity" });
    try {
      await greenAcresInvoiceIsGreenAcres(broken);
    } finally {
      await broken.close();
    }
  });

  test("wired right: a Summit invoice token under Green Acres' web address isn't available", async ({ browser }) => {
    const target = await startTenancy2aScenarioServer({ start: START });
    try {
      await summitTokenIsNotGreenAcres(target, browser);
    } finally {
      await target.close();
    }
  });

  test("break=unscoped-invoice-token (MUST FAIL): the public invoice handler reads the token without the company", async ({ browser }) => {
    test.fail();
    const broken = await startTenancy2aScenarioServer({ start: START, break: "unscoped-invoice-token" });
    try {
      await summitTokenIsNotGreenAcres(broken, browser);
    } finally {
      await broken.close();
    }
  });
});
