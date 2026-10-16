import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import {
  BOOTSTRAP_ADMIN_EMAIL,
  PLATFORM_FROM_ADDRESS,
  startTenancy2b1ScenarioServer,
  type SentMail,
  type Tenancy2b1Break,
  type Tenancy2b1ScenarioServer,
} from "../fixtures/tenancy-2b1-scenario-server.js";

/**
 * TENANCY 2b-1, END TO END, IN A BROWSER — contract section 16.
 *
 * The two lawn companies of the 2a scenario, now with ALERTS and FILES: the
 * REAL screens (every widget from source, the bell in every header) in a real
 * browser, against the REAL alerts (@adminigloo/notifications) and files
 * (@adminigloo/storage) wired the way a generated `--tenant-noun Company
 * --estimator --scheduling --invoicing --comms --email --storage
 * --notifications` project wires them, on PGlite
 * (fixtures/tenancy-2b1-scenario-server.ts).
 *
 *   Gail   owns Green Acres (green-acres, Mountain Time; business email office@greenacres.test);
 *   Mia    is a member of Green Acres; Cam is its crew member, on crew "North";
 *   Sam    owns Summit Lawn (summit-lawn, Central Time);
 *   Pat, Kim and Lee are Green Acres' customers; Ava is the platform owner.
 *
 * The steps (contract 16): 1. alerts; 2. choices; 3. housekeeping; 4. files;
 * 5. files are private. Every screen a step lands on is checked with axe.
 *
 * NEGATIVE CONTROLS (bottom of the file): four of the assertions against a
 * deliberately broken FIXTURE (never the packages) must FAIL.
 *
 * Run it: cd e2e && pnpm install && pnpm browsers && pnpm test tenancy-2b1-scenario
 * (build the packages first: their dist is what runs).
 */

// Monday 2026-11-02, 08:00 in Denver (MST).
const START = new Date("2026-11-02T15:00:00Z");
const TODAY = "2026-11-02";

const GAIL = { email: "gail@greenacres.test", name: "Gail Green" };
const MIA = { email: "mia@greenacres.test", name: "Mia Member" };
const CAM = { email: "cam@greenacres.test", name: "Cam Crew" };
const VIC = { email: "vic@greenacres.test", name: "Vic Viewer" };
const SAM = { email: "sam@summitlawn.test", name: "Sam Summit" };
const AVA = { email: BOOTSTRAP_ADMIN_EMAIL, name: "Ava Admin" };
const GREEN = { name: "Green Acres", slug: "green-acres", zone: "America/Denver", office: "office@greenacres.test", phone: "303-555-0140", pay: "Pay by check to Green Acres LLC." };
const SUMMIT = { name: "Summit Lawn", slug: "summit-lawn", zone: "America/Chicago", office: "office@summitlawn.test", phone: "312-555-0170", pay: "Pay by bank transfer." };
const PAT = { name: "Pat Rivera", email: "pat@example.com", phone: "303-555-0199", address: "12 Oak St, Denver" };
const KIM = { name: "Kim Waits", email: "kim@example.com", address: "40 Elm Ave, Denver" };
const DISPATCH = "dispatch@greenacres.test";

const DESK = { width: 1280, height: 1000 };
const PHONE = { width: 390, height: 844 };

/** A 1×1 PNG: a real picture every browser decodes. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const pdf = (padBytes = 0) => Buffer.concat([Buffer.from("%PDF-1.4\n% e2e\n"), Buffer.alloc(padBytes, 0x20), Buffer.from("\n%%EOF\n")]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');

let server: Tenancy2b1ScenarioServer;

test.beforeAll(async () => {
  server = await startTenancy2b1ScenarioServer({ start: START });
});
test.afterAll(async () => {
  await server?.close();
});

// --- the people (the 2a spec's helpers) -------------------------------------------------

async function person(browser: Browser, on: Tenancy2b1ScenarioServer, options: { viewport?: { width: number; height: number }; timezoneId?: string } = {}) {
  const context = await browser.newContext({ viewport: options.viewport ?? DESK, locale: "en-US", timezoneId: options.timezoneId ?? GREEN.zone });
  const page = await context.newPage();
  await page.clock.install({ time: on.now() });
  await page.clock.resume();
  page.on("pageerror", (error) => console.error("page error:", error.message));
  return { context, page };
}

async function signIn(page: Page, on: Tenancy2b1ScenarioServer, who: { email: string; name: string }, via: "webhook" | "page", next = "/dashboard"): Promise<void> {
  const q = new URLSearchParams({ email: who.email, name: who.name, via, next });
  await page.goto(`${on.origin}/__test/sign-in?${q.toString()}`);
}

async function axe(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => `${n.target.join(" ")} (${(n.failureSummary ?? "").replace(/\s+/g, " ").slice(0, 200)})`).join(", ")}`);
}

async function api(page: Page, on: Tenancy2b1ScenarioServer, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await page.request.fetch(`${on.origin}${path}`, {
    method,
    headers: { origin: on.origin, "sec-fetch-site": "same-origin", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { data: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* text stays text */
  }
  return { status: response.status(), body: parsed };
}

async function mailTo(on: Tenancy2b1ScenarioServer, to: string): Promise<SentMail[]> {
  return (await on.outbox()).filter((m) => m.to === to);
}

async function expectMailTo(on: Tenancy2b1ScenarioServer, to: string, subject: RegExp): Promise<SentMail> {
  await expect.poll(async () => (await mailTo(on, to)).some((m) => subject.test(m.subject)), { timeout: 10_000, message: `an email to ${to} matching ${subject}` }).toBe(true);
  return (await mailTo(on, to)).filter((m) => subject.test(m.subject)).at(-1)!;
}

function linkIn(mail: SentMail, prefix: string): string {
  const link = [...mail.text.matchAll(/https?:\/\/[^\s<>")]+/g)].map((m) => m[0]!.replace(/[.,;:]+$/, "")).find((l) => l.startsWith(prefix));
  if (!link) throw new Error(`no ${prefix} link in:\n${mail.text}`);
  return link;
}

/** A person's alert rows in a company, newest first (what the bell lists, before the read filter). */
async function alertRows(on: Tenancy2b1ScenarioServer, tenantId: string, email: string) {
  return on.query<{ kind: string; title: string; read_at: string | null; href: string | null }>(
    `select n.kind, n.title, n.read_at, n.href from notifications n join users u on u.id::text = n.recipient_id::text
      where n.tenant_id = $1 and u.email = $2 order by n.created_at desc, n.id desc`,
    [tenantId, email],
  );
}

/** The bell's button, whatever its count says. */
function bell(page: Page) {
  return page.locator("button.ainw-bell");
}

async function userId(on: Tenancy2b1ScenarioServer, email: string): Promise<string> {
  const [row] = await on.query<{ id: string }>("select id from users where email = $1", [email]);
  if (!row) throw new Error(`no user ${email}`);
  return row.id;
}

// --- one owner's setup (the 2a spec's, trimmed to what 2b-1 needs) -------------------

async function createCompany(page: Page, on: Tenancy2b1ScenarioServer, who: { email: string; name: string }, name: string, slug: string): Promise<void> {
  await signIn(page, on, who, "webhook", "/dashboard");
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByLabel("What's your company called?").fill(name);
  await expect(page.locator("[data-aitw-address]")).toContainText(`/t/${slug}`);
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

async function companyDetails(page: Page, on: Tenancy2b1ScenarioServer, company: typeof GREEN): Promise<void> {
  await page.goto(`${on.origin}/settings/company`);
  const details = page.locator("#details");
  await details.getByLabel("Time zone").selectOption(company.zone);
  await details.getByLabel("Email customers can reach you at").fill(company.office);
  await details.getByLabel("Phone customers can call").fill(company.phone);
  await details.getByRole("button", { name: "Save" }).click();
  await expect(details.getByText("Saved").first()).toBeVisible();
  const invoices = page.locator("#invoicing");
  await invoices.getByLabel("How customers pay you").fill(company.pay);
  await invoices.getByRole("button", { name: "Save" }).click();
  await expect(invoices.getByText("Saved").first()).toBeVisible();
}

async function scheduleSetup(page: Page, on: Tenancy2b1ScenarioServer, tenantId: string, crewName: string): Promise<void> {
  await page.goto(`${on.origin}/app/schedule/settings`);
  const booking = page.locator("#booking");
  await booking.getByRole("switch", { name: /Take bookings online/ }).check();
  await booking.getByRole("button", { name: "Save", exact: true }).click();
  await expect(booking.getByText("Saved").first()).toBeVisible();
  const crews = page.locator("#crews");
  await crews.getByRole("button", { name: "+ Add a crew" }).click();
  await crews.getByLabel("Crew name").fill(crewName);
  await crews.getByRole("button", { name: "Add crew" }).click();
  await expect(crews.locator("[data-crew]").filter({ hasText: crewName })).toBeVisible();
  const hours = page.locator("#hours");
  await hours.getByRole("button", { name: "Save the week" }).click();
  await expect(hours.getByText("Saved").first()).toBeVisible();
  // Same-day visits, and changes up to the day itself: the owner's choice in
  // Schedule settings, so a customer can book and move a visit for today.
  const sameDay = await api(page, on, "POST", `/api/app/${tenantId}/schedule/v1/admin/settings`, { minNoticeMinutes: 60, cancelCutoffHours: 0 });
  expect(sameDay.status, JSON.stringify(sameDay.body)).toBe(200);
}

async function priceBookAndEstimates(page: Page, on: Tenancy2b1ScenarioServer): Promise<void> {
  await page.goto(`${on.origin}/app/price-book`);
  await page.getByRole("button", { name: "Load a sample catalog" }).click();
  const sample = page.getByRole("dialog", { name: "Load a sample catalog?" });
  await sample.getByLabel("Lawn care and landscaping").check();
  await sample.getByRole("button", { name: "Load the sample" }).click();
  const mowing = page.locator("li", { hasText: "Lawn mowing" }).first();
  await mowing.getByRole("button", { name: "Edit" }).click();
  await page.getByRole("switch", { name: /Show on your website/ }).check();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.goto(`${on.origin}/app/estimates/settings`);
  const start = page.locator('[data-aiew-panel="get-started"]');
  await start.getByLabel("Sales tax (%)").fill("7.25");
  await start.getByRole("button", { name: "Save and open my estimate page" }).click();
  await expect(page.locator('[data-aiew-panel="business"]')).toBeVisible();
}

async function invite(page: Page, on: Tenancy2b1ScenarioServer, email: string, role: string): Promise<void> {
  await page.goto(`${on.origin}/settings/team`);
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Role", { exact: true }).selectOption(role);
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByText(`Invitation sent to ${email}.`).first()).toBeVisible();
}

async function accept(browser: Browser, on: Tenancy2b1ScenarioServer, who: { email: string; name: string }, viewport = DESK) {
  const p = await person(browser, on, { viewport });
  const link = on.invitations.filter((i) => i.to === who.email).at(-1)!.url;
  await signIn(p.page, on, who, "page", new URL(link).pathname);
  await p.page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(p.page).toHaveURL(/\/dashboard$/, { timeout: 10_000 });
  return p;
}

/** A customer asks for a visit on the company's booking page. */
async function requestVisit(page: Page, on: Tenancy2b1ScenarioServer, slug: string, date: string, time: RegExp, who: { name: string; email: string; address: string }): Promise<void> {
  await page.goto(`${on.origin}/t/${slug}/book-visit`);
  await page.locator(`.aisw-day[data-date="${date}"]`).click();
  await page.getByRole("button", { name: time }).click();
  await page.getByLabel("Your name").fill(who.name);
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Address for the visit").fill(who.address);
  await page.getByRole("button", { name: "Request this visit" }).click();
  await expect(page.getByRole("heading", { name: "Request received" })).toBeVisible({ timeout: 15_000 });
}

/** The customer moves their visit to another time the same day, from their own link. */
async function moveVisit(page: Page, link: string, time: RegExp): Promise<void> {
  await page.goto(link);
  await page.getByRole("button", { name: "Pick another time" }).click();
  await page.locator(`.aisw-day[data-date="${TODAY}"]`).click();
  await page.getByRole("button", { name: time }).click();
  await page.getByRole("button", { name: "Yes, move it" }).click();
  await expect(page.locator(".aisw-root")).toContainText("Moved to", { timeout: 15_000 });
}

/** Gail accepts every waiting request in her schedule. */
async function acceptRequests(page: Page, on: Tenancy2b1ScenarioServer, who: string): Promise<void> {
  await page.goto(`${on.origin}/app/schedule?date=${TODAY}`);
  await page.getByRole("button", { name: /^Requests, [1-9]\d* waiting$/ }).click();
  const inbox = page.getByRole("dialog", { name: /Requests/ });
  await inbox.getByRole("button", { name: new RegExp(`^Accept ${who}`) }).click();
  await expect(inbox.getByRole("button", { name: new RegExp(`^Accept ${who}`) })).toHaveCount(0);
  await page.keyboard.press("Escape");
}

const state = {
  green: "",
  summit: "",
  patEstimate: "",
  patVisitLink: "",
  libraryFile: "",
  miaLink: "",
  camPhoto: "",
  invoiceId: "",
  pdfFile: "",
};

test.describe.serial("Green Acres and Summit Lawn with alerts and files", () => {
  let gail: { context: BrowserContext; page: Page };
  let sam: { context: BrowserContext; page: Page };
  let mia: { context: BrowserContext; page: Page };
  let cam: { context: BrowserContext; page: Page };
  let vic: { context: BrowserContext; page: Page };

  test.afterAll(async () => {
    for (const p of [gail, sam, mia, cam, vic]) await p?.context.close();
  });

  test("0. two companies set up as in 2a: Green Acres with Mia (member) and Cam (crew on North), and Summit Lawn", async ({ browser }) => {
    test.setTimeout(240_000);
    gail = await person(browser, server);
    sam = await person(browser, server, { timezoneId: SUMMIT.zone });
    await createCompany(gail.page, server, GAIL, GREEN.name, GREEN.slug);
    await createCompany(sam.page, server, SAM, SUMMIT.name, SUMMIT.slug);
    state.green = (await server.companyId(GREEN.slug))!;
    state.summit = (await server.companyId(SUMMIT.slug))!;
    await companyDetails(gail.page, server, GREEN);
    await companyDetails(sam.page, server, SUMMIT);
    await priceBookAndEstimates(gail.page, server);
    await scheduleSetup(gail.page, server, state.green, "North");
    await scheduleSetup(sam.page, server, state.summit, "Summit crew");
    await invite(gail.page, server, CAM.email, "crew");
    await invite(gail.page, server, MIA.email, "member");
    await invite(gail.page, server, VIC.email, "viewer");
    cam = await accept(browser, server, CAM, PHONE);
    mia = await accept(browser, server, MIA);
    vic = await accept(browser, server, VIC);
    // Cam is put on North, Green Acres' one free crew, as he joins (2a).
    await expect.poll(async () => (await server.query<{ user_id: string | null }>("select user_id from scheduling_resources where name = 'North'"))[0]?.user_id).not.toBeNull();

    // Gail heard about her team joining; she reads it all, so the scenario starts clean.
    await gail.page.goto(`${server.origin}/dashboard`);
    await expect(bell(gail.page)).toHaveAccessibleName(/^Alerts, [1-9]\d* unread$/);
    await bell(gail.page).click();
    await gail.page.getByRole("button", { name: "Mark all as read" }).click();
    await expect(bell(gail.page)).toHaveAccessibleName("Alerts");
    await gail.page.keyboard.press("Escape");
    expect(server.failures, "nothing failed quietly").toEqual([]);
  });

  test("1. alerts: a lead and a customer's visit reach exactly the people they should — once", async ({ browser }) => {
    test.setTimeout(240_000);
    const pat = await person(browser, server, { viewport: PHONE, timezoneId: "America/New_York" });

    // A signed-out customer asks Green Acres for an estimate, with a photo of the job.
    await pat.page.goto(`${server.origin}/t/${GREEN.slug}/estimate`);
    await pat.page.getByRole("button", { name: "One more: How many visits?" }).click();
    await expect(pat.page.locator("[data-aiew-price] [data-aiew-amount]")).toContainText("$");
    await pat.page.locator("[data-aiew-photos] input[type=file]").setInputFiles({ name: "lawn.png", mimeType: "image/png", buffer: PNG });
    await expect(pat.page.locator("[data-aiew-photo-note=ok]")).toContainText("Photo added. The business will see it with your estimate.", { timeout: 15_000 });
    await pat.page.getByLabel("Your name").fill(PAT.name);
    await pat.page.getByLabel("Email").fill(PAT.email);
    await pat.page.getByLabel("Phone").fill(PAT.phone);
    await pat.page.getByLabel("Address of the job").fill(PAT.address);
    await pat.page.getByRole("button", { name: "Send me this estimate" }).click();
    await expect(pat.page.locator("[data-aiew-done]")).toContainText(/Thanks, Pat\./, { timeout: 15_000 });
    const [estimate] = await server.query<{ id: string }>("select id from estimator_estimates where customer_email = $1", [PAT.email]);
    state.patEstimate = estimate!.id;

    // Gail's bell shows ONE: "New estimate request: …"; Sam's shows nothing.
    await gail.page.goto(`${server.origin}/dashboard`);
    await expect(bell(gail.page)).toHaveAccessibleName("Alerts, 1 unread", { timeout: 10_000 });
    await sam.page.goto(`${server.origin}/dashboard`);
    await expect(bell(sam.page)).toHaveAccessibleName("Alerts");
    expect(await alertRows(server, state.summit, SAM.email)).toEqual([]);

    // ONE office email for the lead: to the business email (review BO-01), as Green Acres.
    const leads = (await server.outbox()).filter((m) => m.templateKey === "estimate_lead_staff");
    expect(leads.map((m) => [m.to, m.fromName, m.fromAddress])).toEqual([[GREEN.office, GREEN.name, PLATFORM_FROM_ADDRESS]]);

    // The same page in a second tab: opening the alert in one updates the other's badge.
    const second = await gail.context.newPage();
    await second.goto(`${server.origin}/dashboard`);
    await expect(bell(second)).toHaveAccessibleName("Alerts, 1 unread");
    await bell(gail.page).click();
    const panel = gail.page.getByRole("dialog", { name: "Alerts" });
    await expect(panel.locator(".ainw-item-title").first()).toContainText(/^Unread: New estimate request: Pat Rivera/);
    expect(await axe(gail.page), "the bell, open").toEqual([]);
    await panel.locator("button.ainw-item-btn").first().click();
    await expect(gail.page).toHaveURL(`${server.origin}/app/estimates/${state.patEstimate}`);
    await expect(bell(second)).toHaveAccessibleName("Alerts", { timeout: 10_000 });
    await second.close();

    // Alert settings: the estimates list is on "The owner", at the business email.
    await gail.page.goto(`${server.origin}/app/alerts/settings`);
    await expect(gail.page.locator('[data-ainw-group="estimates"]')).toContainText(`Emails go to ${GREEN.office}, the business email in company settings.`);
    expect(await axe(gail.page), "alert settings").toEqual([]);

    // The customer asks for a visit TODAY; it goes on North; Gail accepts it.
    await requestVisit(pat.page, server, GREEN.slug, TODAY, /^1:00 PM to 2:00 PM/, PAT);
    await expect.poll(async () => (await alertRows(server, state.green, GAIL.email)).map((r) => r.kind)).toContain("scheduling.visit.requested");
    expect((await alertRows(server, state.green, GAIL.email))[0]!.title).toMatch(/^New visit request: Pat Rivera/);
    await acceptRequests(gail.page, server, PAT.name);
    state.patVisitLink = linkIn(await expectMailTo(server, PAT.email, /^Confirmed:/), `${server.origin}/t/${GREEN.slug}/visit/`);

    // …and later moves it, still today.
    await moveVisit(pat.page, state.patVisitLink, /^3:00 PM to 4:00 PM/);
    await expect.poll(async () => (await alertRows(server, state.green, GAIL.email))[0]?.title).toMatch(/^Pat Rivera moved their visit to/);

    // Cam's bell has ONLY the move, opening Today's route — and his email is a team alert, never the office notice.
    await expect.poll(async () => (await alertRows(server, state.green, CAM.email)).map((r) => r.kind)).toEqual(["scheduling.visit.moved"]);
    await cam.page.goto(`${server.origin}/dashboard`);
    await expect(bell(cam.page)).toHaveAccessibleName("Alerts, 1 unread");
    await bell(cam.page).click();
    const camPanel = cam.page.getByRole("dialog", { name: "Alerts" });
    await expect(camPanel.locator(".ainw-item")).toHaveCount(1);
    await expect(camPanel).toHaveAttribute("data-ainw-mode", "sheet");
    expect(await axe(cam.page), "the bell, as a sheet").toEqual([]);
    await camPanel.locator("button.ainw-item-btn").first().click();
    await expect(cam.page).toHaveURL(`${server.origin}/app/schedule/today`);
    const camMail = await mailTo(server, CAM.email);
    expect(camMail.map((m) => m.templateKey)).toEqual(["team_alert"]);
    expect((await server.outbox()).filter((m) => m.templateKey === "visit_staff_notice" && m.to === CAM.email)).toEqual([]);

    // Mia has nothing: she's not on the visits list.
    //
    // CONTRACT: 16 step 1 has Mia's empty bell say she isn't on any alert
    // lists yet (review BO-12). With the packages' defaults a member holds
    // schedule.route (she can be put on a crew), so notifications counts her
    // as reachable and her bell says "Nothing new" — correctly. The BO-12
    // sentence is shown to someone who can't be reached by any list: Vic, a
    // viewer (every kind he can see is routed to the owner).
    expect(await alertRows(server, state.green, MIA.email)).toEqual([]);
    await mia.page.goto(`${server.origin}/dashboard`);
    await bell(mia.page).click();
    await expect(mia.page.getByRole("dialog", { name: "Alerts" })).toContainText("Nothing new. Alerts about your work show up here.");
    await mia.page.keyboard.press("Escape");
    expect(await alertRows(server, state.green, VIC.email)).toEqual([]);
    await vic.page.goto(`${server.origin}/dashboard`);
    await bell(vic.page).click();
    await expect(vic.page.getByRole("dialog", { name: "Alerts" })).toContainText(
      "You're not on any alert lists yet. The owner chooses who hears about new work in Alert settings.",
    );
    await vic.page.keyboard.press("Escape");

    // The same event handed to the listeners again (a retried delivery): no new alert, no new email.
    const alertsBefore = (await server.query("select id from notifications where tenant_id = $1", [state.green])).length;
    const mailBefore = (await server.outbox()).length;
    expect((await (await fetch(`${server.origin}/__test/replay-last-event`, { method: "POST" })).json()).replayed).toBe("scheduling:visit.rescheduled");
    expect((await server.query("select id from notifications where tenant_id = $1", [state.green])).length, "no new alert").toBe(alertsBefore);
    // Contract 16 step 1: "no new email" — none at all. The alert and office
    // emails are claimed once (D6, D7); the customer's own "your visit moved"
    // email is sent once per event too (scheduling 0.6: its link's token is
    // keyed by the event, so a second delivery mints none and sends nothing).
    expect(
      (await server.outbox()).slice(mailBefore).map((m) => `${m.templateKey} to ${m.to}`),
      "no new email, Pat's included",
    ).toEqual([]);

    // The alerts page.
    await gail.page.goto(`${server.origin}/app/alerts`);
    await expect(gail.page.locator(".ainw-item").first()).toContainText("Pat Rivera moved their visit");
    expect(await axe(gail.page), "alerts page").toEqual([]);
    await pat.context.close();
    expect(server.failures, "nothing failed quietly").toEqual([]);
  });

  test("2. choices: the owner chooses how she hears, and who hears about new work", async ({ browser }) => {
    test.setTimeout(180_000);
    const pat = await person(browser, server, { viewport: PHONE, timezoneId: "America/New_York" });

    // Gail: a customer moving a visit, in the app only. The next move sends her no email.
    await gail.page.goto(`${server.origin}/app/alerts/settings`);
    const moved = gail.page.locator('[data-ainw-kind="scheduling.visit.moved"]');
    await moved.getByLabel("In the app", { exact: true }).check();
    await expect(gail.page.locator(".ainw-status")).toHaveText("Saved.");
    const before = (await server.outbox()).length;
    await moveVisit(pat.page, state.patVisitLink, /^4:00 PM to 5:00 PM/);
    await expect.poll(async () => (await alertRows(server, state.green, GAIL.email))[0]?.title).toMatch(/moved their visit to .*4:00/);
    const after = (await server.outbox()).slice(before);
    expect(after.filter((m) => m.to === GREEN.office || m.to === GAIL.email), "no email to Gail or her office").toEqual([]);
    expect(after.filter((m) => m.templateKey === "visit_staff_notice"), "no office notice").toEqual([]);

    // Who hears about new work: Mia for visits, and the dispatch address.
    const visits = gail.page.locator('[data-ainw-group="visits"]');
    await visits.getByLabel("These people", { exact: true }).check();
    await visits.getByRole("checkbox", { name: new RegExp(MIA.name) }).check();
    await visits.getByRole("button", { name: "Add an address" }).click();
    await visits.getByLabel("Address 1").fill(DISPATCH);
    await visits.getByRole("button", { name: "Save" }).click();
    await expect(gail.page.locator(".ainw-status")).toHaveText("Saved.");
    expect(await axe(gail.page), "who hears about new work").toEqual([]);

    // The next request alerts Mia, not Gail; the office notice goes to Mia and to dispatch, once each.
    const gailRows = (await alertRows(server, state.green, GAIL.email)).length;
    const sent = (await server.outbox()).length;
    const kim = await person(browser, server, { viewport: PHONE });
    await requestVisit(kim.page, server, GREEN.slug, TODAY, /^2:00 PM to 3:00 PM/, KIM);
    await expect.poll(async () => (await alertRows(server, state.green, MIA.email)).map((r) => r.kind)).toEqual(["scheduling.visit.requested"]);
    expect((await alertRows(server, state.green, GAIL.email)).length, "Gail isn't on the visits list now").toBe(gailRows);
    await expect
      .poll(async () => (await server.outbox()).slice(sent).filter((m) => m.templateKey === "visit_staff_notice").map((m) => m.to).sort())
      .toEqual([DISPATCH, MIA.email].sort());
    await mia.page.goto(`${server.origin}/dashboard`);
    await expect(bell(mia.page)).toHaveAccessibleName("Alerts, 1 unread");

    // Back to the owner.
    await gail.page.reload();
    await visits.getByLabel(/^The owner/).check();
    await visits.getByRole("button", { name: "Save" }).click();
    await expect(gail.page.locator(".ainw-status")).toHaveText("Saved.");
    await expect(visits).toContainText(`Emails go to ${GREEN.office}, the business email in company settings.`);
    for (const p of [pat, kim]) await p.context.close();
    expect(server.failures, "nothing failed quietly").toEqual([]);
  });

  test("3. housekeeping: a removed member loses the alerts and her links; a suspended company is written nothing; old read alerts go", async ({ browser }) => {
    test.setTimeout(240_000);
    // Gail keeps a company file; Mia (files.view) opens it and copies a link.
    await gail.page.goto(`${server.origin}/app/files`);
    await gail.page.locator('[data-aifw-input="files"]').setInputFiles({ name: "price-list.pdf", mimeType: "application/pdf", buffer: pdf() });
    await expect(gail.page.locator("[data-aifw-file]").filter({ hasText: "price-list.pdf" })).toBeVisible({ timeout: 15_000 });
    expect(await axe(gail.page), "files").toEqual([]);
    const [library] = await server.query<{ id: string }>("select id from stored_files where tenant_id = $1 and filename = 'price-list.pdf'", [state.green]);
    state.libraryFile = library!.id;

    await mia.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: server.origin });
    await mia.page.goto(`${server.origin}/app/files`);
    const row = mia.page.locator("[data-aifw-file]").filter({ hasText: "price-list.pdf" });
    await expect(row).toBeVisible();
    expect((await api(mia.page, server, "GET", `/api/app/${state.green}/files/v1/admin/files/${state.libraryFile}/content`)).status, "Mia opens it").toBe(200);
    await row.getByRole("button", { name: "Copy a link (works for 1 hour)" }).click();
    await expect(mia.page.locator(".aifw-sr[role=status]").first()).toContainText("Link copied. It works for 1 hour.");
    state.miaLink = await mia.page.evaluate(() => navigator.clipboard.readText());
    expect(state.miaLink).toContain("/api/files/v1/f/");
    expect((await fetch(state.miaLink)).status, "the link opens while Mia is in the team").toBe(200);

    // Gail removes Mia. Mia's alerts are refused, and her link stops working (review G2).
    await gail.page.goto(`${server.origin}/settings/team`);
    await gail.page.getByRole("button", { name: `Remove ${MIA.name}` }).first().click();
    await gail.page.getByRole("dialog").getByRole("button", { name: `Remove ${MIA.name}` }).click();
    await expect(gail.page.locator("tr[data-member]").filter({ hasText: MIA.email })).toHaveCount(0);
    expect((await api(mia.page, server, "GET", `/api/app/${state.green}/alerts/v1/admin/count`)).status).toBe(403);
    expect(await alertRows(server, state.green, MIA.email), "her alerts in Green Acres are forgotten").toEqual([]);
    const opened = await (await mia.context.newPage());
    await opened.goto(state.miaLink);
    await expect(opened.locator("body")).toContainText("This link has expired, or the file was removed.");
    await opened.close();

    // Ava suspends Summit; a customer's request to Summit's page is refused, and nothing is written for Summit.
    const ava = await person(browser, server);
    await signIn(ava.page, server, AVA, "page", "/admin/companies");
    await ava.page.getByLabel("Search companies by name, web address or owner's email").fill("summit");
    await ava.page.getByRole("link", { name: SUMMIT.name }).click();
    await ava.page.getByRole("button", { name: "Suspend company" }).click();
    await ava.page.getByLabel("Why (only staff see this)").fill("Payment needed");
    await ava.page.getByRole("dialog").getByRole("button", { name: "Suspend" }).click();
    await expect(ava.page.getByText(`${SUMMIT.name} is suspended.`).first()).toBeVisible();
    const summitAlerts = (await server.query("select id from notifications where tenant_id = $1", [state.summit])).length;
    const visitor = await person(browser, server, { viewport: PHONE, timezoneId: SUMMIT.zone });
    await visitor.page.goto(`${server.origin}/t/${SUMMIT.slug}/book-visit`);
    await expect(visitor.page.getByRole("heading", { name: `${SUMMIT.name} isn't taking requests online right now` })).toBeVisible();
    expect((await api(visitor.page, server, "GET", `/api/t/${SUMMIT.slug}/schedule/v1/config`)).status).toBe(409);
    expect((await server.query("select id from notifications where tenant_id = $1", [state.summit])).length, "nothing written for Summit").toBe(summitAlerts);

    // 31 days on, the alerts cron: Gail's READ alerts are gone, her unread stay.
    const gailBefore = await alertRows(server, state.green, GAIL.email);
    const unread = gailBefore.filter((r) => r.read_at === null).length;
    expect(gailBefore.some((r) => r.read_at !== null)).toBe(true);
    server.setClock(new Date(START.getTime() + 31 * 24 * 60 * 60 * 1000));
    const cron = await (await fetch(`${server.origin}/__test/cron/alerts`, { method: "POST" })).json();
    expect(cron.sweeps.failed).toEqual([]);
    const gailAfter = await alertRows(server, state.green, GAIL.email);
    expect(gailAfter.filter((r) => r.read_at !== null), "read alerts older than 30 days are cleared").toEqual([]);
    expect(gailAfter.filter((r) => r.read_at === null).length, "unread alerts stay").toBe(unread);

    // The bell's count is the server's; a sheet on a phone, a popover at 1280.
    const phone = await person(browser, server, { viewport: PHONE });
    await signIn(phone.page, server, GAIL, "page", "/dashboard");
    const count = await api(phone.page, server, "GET", `/api/app/${state.green}/alerts/v1/admin/count`);
    expect(count.status).toBe(200);
    await expect(bell(phone.page)).toHaveAccessibleName(count.body.unread > 0 ? `Alerts, ${count.body.unread} unread` : "Alerts");
    await bell(phone.page).click();
    await expect(phone.page.getByRole("dialog", { name: "Alerts" })).toHaveAttribute("data-ainw-mode", "sheet");
    expect(await phone.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), "no sideways scroll").toBeLessThanOrEqual(0);
    await gail.page.goto(`${server.origin}/dashboard`);
    await bell(gail.page).click();
    await expect(gail.page.getByRole("dialog", { name: "Alerts" })).toHaveAttribute("data-ainw-mode", "popover");
    await gail.page.keyboard.press("Escape");
    for (const p of [ava, visitor, phone]) await p.context.close();
    expect(server.failures, "nothing failed quietly").toEqual([]);
  });

  test("4. files: the logo, the crew's photo, files on the invoice and the estimate, the customer's photo — each where it belongs", async ({ browser }) => {
    test.setTimeout(240_000);
    const day = new Date(server.now().getTime()).toLocaleDateString("en-CA", { timeZone: GREEN.zone });

    // The logo: the company's one PUBLIC file, at an address nobody can guess.
    await gail.page.goto(`${server.origin}/settings/company`);
    await gail.page.locator("#branding input[type=file]").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
    await expect(gail.page.locator("[data-aitw-logo] img")).toBeVisible({ timeout: 15_000 });
    const visitor = await person(browser, server, { viewport: PHONE });
    await visitor.page.goto(`${server.origin}/t/${GREEN.slug}`);
    const logo = visitor.page.locator(".aitw-brandbar img");
    await expect(logo).toHaveAttribute("src", new RegExp(`^${server.origin.replace(/[.]/g, "\\.")}/__blob/p/`));
    const logoKey = decodeURIComponent((await logo.getAttribute("src"))!.slice(`${server.origin}/__blob/`.length));
    expect(server.blobs().find((b) => b.key === logoKey)?.access).toBe("public");
    await visitor.context.close();

    // Cam's stop today, on North (Gail books it), and his photo from the job, on a phone.
    const [north] = await server.query<{ id: string }>("select id from scheduling_resources where name = 'North'");
    const booked = await api(gail.page, server, "POST", `/api/app/${state.green}/schedule/v1/admin/visits`, {
      resourceId: north!.id,
      date: day,
      startTime: "10:00",
      endTime: "11:00",
      customerName: PAT.name,
      customerEmail: PAT.email,
      address: PAT.address,
      status: "confirmed",
    });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const visitId = booked.body.visit.id as string;
    await cam.page.goto(`${server.origin}/app/schedule/today`);
    await cam.page.locator("[data-aisw-stop-files]").first().click();
    await expect(cam.page).toHaveURL(`${server.origin}/app/schedule/visits/${visitId}/files`);
    await cam.page.locator('[data-aifw-input="camera"]').setInputFiles({ name: "job.png", mimeType: "image/png", buffer: PNG });
    await expect(cam.page.locator(".aifw-thumb")).toHaveCount(1, { timeout: 15_000 });
    expect(await axe(cam.page), "a visit's photos and files, on a phone").toEqual([]);
    const [camFile] = await server.query<{ id: string }>("select id from stored_files where tenant_id = $1 and record_type = 'scheduling.visit' and record_id = $2", [state.green, visitId]);
    state.camPhoto = camFile!.id;
    await gail.page.goto(`${server.origin}/app/schedule/visits/${visitId}/files`);
    await expect(gail.page.locator(".aifw-thumb")).toHaveCount(1);

    // A PDF on an invoice, and a photo on the estimate ("Other files").
    const made = await api(gail.page, server, "POST", `/api/app/${state.green}/invoices/v1/admin/invoices`, {
      customerName: PAT.name,
      customerEmail: PAT.email,
      items: [{ description: "Lawn mowing", quantity: 1, unitPrice: 6_000 }],
    });
    expect(made.status).toBe(201);
    state.invoiceId = made.body.invoice.id;
    await gail.page.goto(`${server.origin}/app/invoices/${state.invoiceId}`);
    const invoiceFiles = gail.page.getByRole("region", { name: "Photos and files" });
    await expect(invoiceFiles).toContainText("Your team sees these; they aren't sent to the customer.");
    await invoiceFiles.locator('[data-aifw-input="files"]').setInputFiles({ name: "receipt.pdf", mimeType: "application/pdf", buffer: pdf() });
    await expect(invoiceFiles.locator(".aifw-doc").filter({ hasText: "receipt.pdf" })).toBeVisible({ timeout: 15_000 });
    expect(await axe(gail.page), "invoice with its files").toEqual([]);
    await gail.page.goto(`${server.origin}/app/estimates/${state.patEstimate}`);
    const estimateFiles = gail.page.getByRole("region", { name: "Other files" });
    await estimateFiles.locator('[data-aifw-input="files"]').setInputFiles({ name: "side-yard.png", mimeType: "image/png", buffer: PNG });
    await expect(estimateFiles.locator(".aifw-thumb")).toHaveCount(1, { timeout: 15_000 });

    // The customer's own photo is on the estimate, and PRIVATE.
    const [customerPhoto] = await server.query<{ id: string; pathname: string; access: string }>(
      "select id, pathname, access from stored_files where tenant_id = $1 and kind = 'estimator.photo' and record_id = $2",
      [state.green, state.patEstimate],
    );
    expect(customerPhoto?.access).toBe("private");
    expect(server.blobs().find((b) => b.key === customerPhoto!.pathname)?.access).toBe("private");

    // /app/files: all of them, the usage, each linked to its record; "Invoices" shows only the PDF.
    await gail.page.goto(`${server.origin}/app/files`);
    const files = gail.page.getByRole("region", { name: "Files" });
    await expect(files).toContainText(/Using .* of 5 GB/);
    for (const name of ["price-list.pdf", "job.png", "receipt.pdf", "side-yard.png"]) await expect(files.locator("[data-aifw-file]").filter({ hasText: name })).toHaveCount(1);
    await expect(files.locator(`[data-aifw-file="${customerPhoto!.id}"]`)).toContainText(/Estimate .* · Pat Rivera/);
    await files.getByRole("button", { name: "Invoices", exact: true }).click();
    await expect(files.locator("[data-aifw-file]")).toHaveCount(1);
    await expect(files.locator("[data-aifw-file]")).toContainText("receipt.pdf");
    expect(await axe(gail.page), "files, filtered").toEqual([]);

    // Cam's upload with the signal gone: the photo keeps its card with "Try again", which then adds it (review BO-05).
    await cam.page.goto(`${server.origin}/app/schedule/visits/${visitId}/files`);
    await cam.page.route("**/files/v1/admin/attachments**", (route) => (route.request().method() === "POST" ? route.abort("internetdisconnected") : route.continue()));
    await cam.page.locator('[data-aifw-input="camera"]').setInputFiles({ name: "second.png", mimeType: "image/png", buffer: PNG });
    const card = cam.page.locator('[data-aifw-pending="failed"]');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(card.getByRole("link", { name: "Save to phone" })).toBeVisible();
    await cam.page.unroute("**/files/v1/admin/attachments**");
    await card.getByRole("button", { name: "Try again" }).click();
    await expect(cam.page.locator(".aifw-thumb")).toHaveCount(2, { timeout: 15_000 });
    expect(server.failures, "nothing failed quietly").toEqual([]);
  });

  test("5. files are private: no address, another company or a removed member opens one; a link lasts an hour", async ({ browser }) => {
    test.setTimeout(180_000);
    const [cams] = await server.query<{ pathname: string }>("select pathname from stored_files where id = $1", [state.camPhoto]);
    // Anonymously: the content route asks who you are; the public store hasn't got it.
    const anonymous = await fetch(`${server.origin}/api/app/${state.green}/files/v1/admin/files/${state.camPhoto}/content`);
    expect([401, 403]).toContain(anonymous.status);
    expect((await fetch(`${server.origin}/__blob/${encodeURIComponent(cams!.pathname)}`)).status, "a private file isn't in the public store").toBe(404);

    // A copied link opens it; 61 minutes later it doesn't.
    const link = await api(gail.page, server, "POST", `/api/app/${state.green}/files/v1/admin/files/${state.camPhoto}/link`, {});
    expect(link.status).toBe(200);
    expect((await fetch(link.body.url)).status).toBe(200);
    server.setClock(new Date(server.now().getTime() + 61 * 60 * 1000));
    const expired = await fetch(link.body.url);
    expect(expired.status).toBe(404);
    expect(await expired.text()).toContain("This link has expired, or the file was removed.");

    // Sam: Green Acres' route refuses him; his own company's route has no such file.
    sam = sam ?? (await person(browser, server));
    await signIn(sam.page, server, SAM, "page", "/dashboard");
    expect((await api(sam.page, server, "GET", `/api/app/${state.green}/files/v1/admin/files/${state.camPhoto}`)).status).toBe(403);
    // Summit is suspended (step 3): Ava reactivates it so Sam's own route answers.
    await server.query("update tenants set suspended_at = null, suspended_reason = null where id = $1", [state.summit]);
    expect((await api(sam.page, server, "GET", `/api/app/${state.summit}/files/v1/admin/files/${state.camPhoto}`)).status).toBe(404);

    // Gail deletes the PDF on the invoice: gone from the store.
    const [receipt] = await server.query<{ id: string; pathname: string }>("select id, pathname from stored_files where tenant_id = $1 and filename = 'receipt.pdf'", [state.green]);
    await gail.page.goto(`${server.origin}/app/files`);
    await gail.page.getByRole("button", { name: "Remove receipt.pdf" }).first().click();
    await gail.page.getByRole("dialog", { name: /^Remove receipt\.pdf\?/ }).getByRole("button", { name: "Remove" }).click();
    await expect(gail.page.locator("[data-aifw-file]").filter({ hasText: "receipt.pdf" })).toHaveCount(0);
    expect(server.blobs().some((b) => b.key === receipt!.pathname), "the bytes are gone from the store").toBe(false);

    // Mia, removed in step 3: the files route refuses her.
    expect((await api(mia.page, server, "GET", `/api/app/${state.green}/files/v1/admin/files`)).status).toBe(403);

    // What can't be kept, in plain words.
    await gail.page.locator('[data-aifw-input="files"]').setInputFiles({ name: "huge.pdf", mimeType: "application/pdf", buffer: pdf(5 * 1024 * 1024) });
    await expect(gail.page.locator('[data-aifw-pending="failed"]').filter({ hasText: "huge.pdf" })).toContainText("That file is too big.", { timeout: 20_000 });
    await gail.page.locator('[data-aifw-input="files"]').setInputFiles({ name: "drawing.svg", mimeType: "image/svg+xml", buffer: SVG });
    await expect(gail.page.locator('[data-aifw-pending="failed"]').filter({ hasText: "drawing.svg" })).toContainText("That kind of file can't be kept here.", { timeout: 20_000 });
    expect(server.failures, "nothing failed quietly").toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// NEGATIVE CONTROLS (contract 16): ONE assertion of the scenario on a fresh
// fixture, once wired right (it must pass) and once with the fixture's wiring
// deliberately broken (it must FAIL, `test.fail()`). The packages carry no
// bug switches; the break is where a generated project's wiring would be.
// ---------------------------------------------------------------------------

async function startFor(breakMode?: Tenancy2b1Break) {
  return startTenancy2b1ScenarioServer({ start: START, ...(breakMode ? { break: breakMode } : {}) });
}

/** A company through the routes its owner's screens call; a caller signed in as the owner. */
async function companyByApi(on: Tenancy2b1ScenarioServer, owner: { email: string; name: string }, company: typeof GREEN) {
  const signedIn = await fetch(`${on.origin}/__test/sign-in?${new URLSearchParams({ email: owner.email, name: owner.name, via: "webhook" })}`, { redirect: "manual" });
  const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
  const call = async (method: "GET" | "POST", path: string, body?: unknown, form?: FormData) => {
    const response = await fetch(`${on.origin}${path}`, {
      method,
      headers: { cookie, origin: on.origin, "sec-fetch-site": "same-origin", ...(body === undefined || form ? {} : { "content-type": "application/json" }) },
      ...(form ? { body: form } : body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json().catch(() => null)) as any };
  };
  const created = await call("POST", "/api/tenancy/v1/companies", { name: company.name, slug: company.slug, purpose: "onboarding", requestKey: `e2e-${company.slug}-request-key-0001` });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const id = created.body.company.id as string;
  const details = await call("POST", `/api/tenancy/v1/companies/${id}/settings/company`, { values: { timeZone: company.zone, contactEmail: company.office, contactPhone: company.phone } });
  expect(details.status, JSON.stringify(details.body)).toBe(200);
  return { id, cookie, call };
}

/** Someone invited by the owner, signed in, and in: returns their caller. */
async function joinByApi(on: Tenancy2b1ScenarioServer, owner: Awaited<ReturnType<typeof companyByApi>>, who: { email: string; name: string }, roleKey: string) {
  const invited = await owner.call("POST", `/api/tenancy/v1/companies/${owner.id}/invitations`, { email: who.email, roleKey });
  expect(invited.status, JSON.stringify(invited.body)).toBeLessThan(300);
  const token = decodeURIComponent(new URL(on.invitations.filter((i) => i.to === who.email).at(-1)!.url).pathname.split("/").at(-1)!);
  const signedIn = await fetch(`${on.origin}/__test/sign-in?${new URLSearchParams({ email: who.email, name: who.name, via: "webhook" })}`, { redirect: "manual" });
  const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
  const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const response = await fetch(`${on.origin}${path}`, {
      method,
      headers: { cookie, origin: on.origin, "sec-fetch-site": "same-origin", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json().catch(() => null)) as any };
  };
  const accepted = await call("POST", "/api/tenancy/v1/invitations/accept", { token });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  return { call, userId: await userId(on, who.email) };
}

/** Step 1's flow, on its own: a crew on North with Cam on it, a customer's visit today, accepted, then moved by the customer. */
async function customerMovesTodaysVisit(on: Tenancy2b1ScenarioServer, browser: Browser) {
  const owner = await person(browser, on);
  try {
    await createCompany(owner.page, on, GAIL, GREEN.name, GREEN.slug);
    const green = (await on.companyId(GREEN.slug))!;
    await companyDetails(owner.page, on, GREEN);
    await scheduleSetup(owner.page, on, green, "North");
    await invite(owner.page, on, CAM.email, "crew");
    await invite(owner.page, on, MIA.email, "member");
    const camP = await accept(browser, on, CAM, PHONE);
    const miaP = await accept(browser, on, MIA);
    await camP.context.close();
    await miaP.context.close();
    const customer = await person(browser, on, { viewport: PHONE });
    await requestVisit(customer.page, on, GREEN.slug, TODAY, /^1:00 PM to 2:00 PM/, PAT);
    await acceptRequests(owner.page, on, PAT.name);
    const link = linkIn(await expectMailTo(on, PAT.email, /^Confirmed:/), `${on.origin}/t/${GREEN.slug}/visit/`);
    await moveVisit(customer.page, link, /^3:00 PM to 4:00 PM/);
    await customer.context.close();
    return { green };
  } finally {
    await owner.context.close();
  }
}

/** Step 1's "replay → no new alert, no new email". */
async function replayAlertsNothingNew(on: Tenancy2b1ScenarioServer, browser: Browser): Promise<void> {
  const owner = await person(browser, on);
  try {
    await createCompany(owner.page, on, GAIL, GREEN.name, GREEN.slug);
    const green = (await on.companyId(GREEN.slug))!;
    await companyDetails(owner.page, on, GREEN);
    await scheduleSetup(owner.page, on, green, "North");
    const customer = await person(browser, on, { viewport: PHONE });
    await requestVisit(customer.page, on, GREEN.slug, TODAY, /^1:00 PM to 2:00 PM/, PAT);
    await customer.context.close();
    await expect.poll(async () => (await alertRows(on, green, GAIL.email)).length).toBeGreaterThan(0);
    const alertsBefore = (await on.query("select id from notifications where tenant_id = $1", [green])).length;
    const mailBefore = (await on.outbox()).length;
    await fetch(`${on.origin}/__test/replay-last-event`, { method: "POST" });
    expect((await on.query("select id from notifications where tenant_id = $1", [green])).length, "no new alert").toBe(alertsBefore);
    // The team's emails only (the customer's own is scheduling's 2a listener; see step 1).
    expect((await on.outbox()).slice(mailBefore).filter((m) => m.to !== PAT.email), "no new alert or office email").toEqual([]);
  } finally {
    await owner.context.close();
  }
}

/** Step 1's "Cam's bell has only the move" (the rows the bell reads, and the bell). */
async function camHearsOnlyTheMove(on: Tenancy2b1ScenarioServer, browser: Browser): Promise<void> {
  const { green } = await customerMovesTodaysVisit(on, browser);
  await expect.poll(async () => (await alertRows(on, green, CAM.email)).length).toBeGreaterThan(0);
  expect((await alertRows(on, green, CAM.email)).map((r) => r.kind)).toEqual(["scheduling.visit.moved"]);
  expect((await mailTo(on, CAM.email)).map((m) => m.templateKey)).toEqual(["team_alert"]);
}

/** Step 5's "/__blob/{private key} → 404". */
async function privateFileIsNotPublic(on: Tenancy2b1ScenarioServer): Promise<void> {
  const green = await companyByApi(on, GAIL, GREEN);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(PNG)], { type: "image/png" }), "job.png");
  const stored = await green.call("POST", `/api/app/${green.id}/files/v1/admin/files`, undefined, form);
  expect(stored.status, JSON.stringify(stored.body)).toBe(201);
  const [row] = await on.query<{ pathname: string }>("select pathname from stored_files where id = $1", [stored.body.file.id]);
  expect((await fetch(`${on.origin}/__blob/${encodeURIComponent(row!.pathname)}`)).status).toBe(404);
}

/** Step 3's "her copied link now shows the expired sentence". */
async function removedMakersLinkStops(on: Tenancy2b1ScenarioServer): Promise<void> {
  const green = await companyByApi(on, GAIL, GREEN);
  const miaApi = await joinByApi(on, green, MIA, "member");
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(pdf())], { type: "application/pdf" }), "price-list.pdf");
  const stored = await green.call("POST", `/api/app/${green.id}/files/v1/admin/files`, undefined, form);
  expect(stored.status, JSON.stringify(stored.body)).toBe(201);
  const link = await miaApi.call("POST", `/api/app/${green.id}/files/v1/admin/files/${stored.body.file.id}/link`, {});
  expect(link.status, JSON.stringify(link.body)).toBe(200);
  expect((await fetch(link.body.url)).status).toBe(200);
  const removed = await green.call("POST", `/api/tenancy/v1/companies/${green.id}/members/${miaApi.userId}/remove`, {});
  expect(removed.status, JSON.stringify(removed.body)).toBe(200);
  const opened = await fetch(link.body.url);
  expect(await opened.text()).toContain("This link has expired, or the file was removed.");
}

test.describe("negative controls: the same assertion, on a fixture wired right and on one wired wrong", () => {
  test("wired right: a replayed event alerts nobody again", async ({ browser }) => {
    test.setTimeout(120_000);
    const target = await startFor();
    try {
      await replayAlertsNothingNew(target, browser);
    } finally {
      await target.close();
    }
  });
  test("break=no-dedupe (MUST FAIL): every draft is new, so the replay alerts again", async ({ browser }) => {
    test.setTimeout(120_000);
    test.fail();
    const broken = await startFor("no-dedupe");
    try {
      await replayAlertsNothingNew(broken, browser);
    } finally {
      await broken.close();
    }
  });

  test("wired right: the crew member hears only about the move on his crew", async ({ browser }) => {
    test.setTimeout(180_000);
    const target = await startFor();
    try {
      await camHearsOnlyTheMove(target, browser);
    } finally {
      await target.close();
    }
  });
  test("break=no-crew-scope (MUST FAIL): people() ignores the permission", async ({ browser }) => {
    test.setTimeout(180_000);
    test.fail();
    const broken = await startFor("no-crew-scope");
    try {
      await camHearsOnlyTheMove(broken, browser);
    } finally {
      await broken.close();
    }
  });

  test("wired right: a private file isn't in the public store", async () => {
    const target = await startFor();
    try {
      await privateFileIsNotPublic(target);
    } finally {
      await target.close();
    }
  });
  test("break=private-as-public (MUST FAIL): the private slot is the public store", async () => {
    test.fail();
    const broken = await startFor("private-as-public");
    try {
      await privateFileIsNotPublic(broken);
    } finally {
      await broken.close();
    }
  });

  test("wired right: a removed member's copied link stops working", async () => {
    const target = await startFor();
    try {
      await removedMakersLinkStops(target);
    } finally {
      await target.close();
    }
  });
  test("break=link-ignores-maker (MUST FAIL): stillValid always answers yes", async () => {
    test.fail();
    const broken = await startFor("link-ignores-maker");
    try {
      await removedMakersLinkStops(broken);
    } finally {
      await broken.close();
    }
  });
});
