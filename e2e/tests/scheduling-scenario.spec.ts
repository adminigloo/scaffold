import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { startScenarioServer, COMMS_CRON_AT_UTC, type ScenarioServer, type SentEmail } from "../fixtures/scheduling-scenario-server.js";

/**
 * THE BUSINESS SCENARIO, END TO END, IN A BROWSER — the acceptance bar for
 * scheduling 0.4 and the create-app wiring that ships it:
 *
 *   "Business owners aren't devs. If a business owner is told by their dev
 *    that it works, they deploy it and sell it to a customer; they need to
 *    trust that it's actually doing what is needed."
 *
 * Acme Windows, Salt Lake City (America/Denver). The real widgets in a real
 * browser, against the real handlers on a real Postgres (PGlite), with the
 * comms listener sending every email into an outbox this test reads — wired
 * the way a generated `--scheduling --comms --email` project wires them (see
 * fixtures/scheduling-scenario-server.ts). Each person is driven like a person
 * and checked on what they SEE and what they RECEIVE:
 *
 *   customers   book on /book-visit on a phone, in New York (so a time shown in
 *               the browser's zone would be two hours off), open the links in
 *               their emails, reschedule, cancel, and are refused politely
 *               inside the cutoff;
 *   the office  answers requests and moves and reassigns a visit on the
 *               calendar, in Los Angeles;
 *   a crew      is given its route by the owner in Schedule settings (no
 *               developer), then opens it on a phone, starts, completes,
 *               undoes and completes a stop — and can see nothing else.
 *
 * THE CRONS RUN ONLY AT THE HOURS vercel.json GIVES THEM (comms 14:00 UTC,
 * scheduling 13:00 UTC, once a day on Vercel Hobby): a reminder that only
 * arrives when a test runs the cron at a convenient hour proves nothing about
 * the deployment a business gets.
 *
 * The clock starts Thursday 2026-10-29 09:00 MDT. The clocks fall back on
 * Sunday 2026-11-01, so every visit is in MST while every request is made in
 * MDT — the 24-hour notice, the 24-hour reminder and the 12-hour cutoff are all
 * checked as real hours across the change. The steps run in the order time
 * runs: the expiry (step 7) happens on Friday, before the reminder (step 4)
 * on Sunday.
 *
 * Run it: cd e2e && pnpm install && pnpm browsers && pnpm test scheduling-scenario
 * (the scheduling and comms packages must be built: their dist is what runs).
 */

const TENANT = "acme-windows";
// Thu 08:59 MDT. A minute before nine, because the scenario clock FLOWS from
// here (real time plus an offset): Friday 09:00 must still be 24 hours away
// when the customer looks a few seconds later.
const START = new Date("2026-10-29T14:59:00Z");
const PLACES = {
  "1 Depot Rd, Salt Lake City": { lat: 40.75, lng: -111.9 },
  "2 Yard Ln, Salt Lake City": { lat: 40.7, lng: -111.85 },
  "12 Oak St, Salt Lake City": { lat: 40.76, lng: -111.88 },
  "7 Pine Ct, Salt Lake City": { lat: 40.72, lng: -111.87 },
  "40 Elm Ave, Salt Lake City": { lat: 40.77, lng: -111.86 },
  "18 Birch Way, Salt Lake City": { lat: 40.73, lng: -111.84 },
};

const PAT = { name: "Pat Visitor", email: "pat@example.com", phone: "801-555-0100", address: "12 Oak St, Salt Lake City" };
const LEE = { name: "Lee Declined", email: "lee@example.com", phone: "", address: "7 Pine Ct, Salt Lake City" };
const SAM = { name: "Sam Cancels", email: "sam@example.com", phone: "", address: "40 Elm Ave, Salt Lake City" };
const KIM = { name: "Kim Waiting", email: "kim@example.com", phone: "", address: "18 Birch Way, Salt Lake City" };

let server: ScenarioServer;

test.beforeAll(async () => {
  server = await startScenarioServer({ tenantId: TENANT, start: START, places: PLACES });
});
test.afterAll(async () => {
  await server?.close();
});

// --- the people -----------------------------------------------------------------

const PHONE = { width: 390, height: 844 };
// Tall enough that a 08:00–17:00 day view and a two-hour drag fit on screen.
const DESK = { width: 1280, height: 1400 };

/**
 * A browser for one person: their screen, their time zone, the scenario's
 * time on their clock (flowing from there), and — for staff — who they are
 * signed in as.
 */
async function person(
  browser: Browser,
  options: { viewport: { width: number; height: number }; timezoneId: string; staff?: string },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: options.viewport, timezoneId: options.timezoneId, locale: "en-US" });
  if (options.staff) {
    await context.addCookies([{ name: "e2e-staff", value: options.staff, url: server.origin }]);
  }
  const page = await context.newPage();
  await page.clock.install({ time: server.now() });
  await page.clock.resume();
  return { context, page };
}

// --- what they receive -------------------------------------------------------------

let read = 0;
/** The emails sent since the last look. */
function newMail(): SentEmail[] {
  const fresh = server.outbox.slice(read);
  read = server.outbox.length;
  return fresh;
}
const addressed = (mail: SentEmail[]) => mail.map((m) => [m.to, m.subject]);
const mailTo = (mail: SentEmail[], to: string): SentEmail => {
  const found = mail.find((m) => m.to === to);
  if (!found) throw new Error(`no email to ${to} in ${JSON.stringify(addressed(mail))}`);
  return found;
};
/** The manage link in an email body: this server's /visit/<token>. */
function manageLinkIn(body: string): string {
  const match = new RegExp(`${server.origin.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}/visit/([A-Za-z0-9_-]{20,})`).exec(body);
  if (!match) throw new Error(`no manage link in:\n${body}`);
  return match[0];
}

/** Waits until the outbox has grown by `count` since the last look, then returns the new mail. */
async function expectMail(count: number): Promise<SentEmail[]> {
  await expect.poll(() => server.outbox.length - read, { timeout: 10_000 }).toBe(count);
  return newMail();
}

async function visitId(email: string): Promise<string> {
  const [row] = await server.query<{ id: string }>(
    "select id from scheduling_bookings where tenant_id = $1 and customer_email = $2 order by created_at desc limit 1",
    [TENANT, email],
  );
  if (!row) throw new Error(`no visit for ${email}`);
  return row.id;
}
async function visitRow(email: string) {
  const [row] = await server.query<{ status: string; start_time: string; starts_at: Date; resource_id: string | null }>(
    "select status, start_time, starts_at, resource_id from scheduling_bookings where tenant_id = $1 and customer_email = $2 order by created_at desc limit 1",
    [TENANT, email],
  );
  return row!;
}
async function reminders(visit: string) {
  return server.query<{ status: string; send_at: Date; dedupe_key: string }>(
    "select status, send_at, dedupe_key from comms_scheduled where ref_type = 'scheduling_visit' and ref_id = $1 order by created_at",
    [visit],
  );
}

/** A staff call to the admin API, signed in as the owner (for setup only). */
async function adminApi(method: "GET" | "POST", path: string, body?: unknown) {
  const response = await fetch(`${server.origin}/api/admin/schedule/v1/admin${path}`, {
    method,
    headers: {
      cookie: "e2e-staff=owner",
      origin: server.origin,
      "sec-fetch-site": "same-origin",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: (await response.json()) as any };
}

/** A customer books on /book-visit: a day, a time, their details. Returns the page on the confirmation. */
async function book(page: Page, who: typeof PAT, date: string, time: RegExp) {
  await page.goto(`${server.origin}/book-visit`);
  await expect(page.getByText(/Times are/)).toContainText("Mountain Time");
  await page.locator(`.aisw-day[data-date="${date}"]`).click();
  await page.getByRole("button", { name: time }).click();
  await expect(page.getByRole("heading", { name: "Your details" })).toBeVisible();
  await page.getByLabel("Your name").fill(who.name);
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Address for the visit").fill(who.address);
  if (who.phone) await page.getByLabel("Phone").fill(who.phone);
  await page.getByRole("button", { name: "Request this visit" }).click();
  await expect(page.getByRole("heading", { name: "Request received" })).toBeVisible({ timeout: 15_000 });
}

/** A scenario instant, written in UTC with the business's local time beside it. */
const at = (iso: string) => new Date(iso);

/** The comms cron's run on a day, at vercel.json's hour (half a minute in, as a real run starts). */
const commsRunOn = (day: string) => at(`${day}T${COMMS_CRON_AT_UTC}:30Z`);
/** The scheduling (expiry) cron's run on a day: vercel.json's "0 13 * * *". */
const expiryRunOn = (day: string) => at(`${day}T13:00:30Z`);

test("Acme Windows runs its week: customers, the office and a crew, end to end", async ({ browser }) => {
  test.setTimeout(240_000);
  const opened: BrowserContext[] = [];
  const open = async (options: Parameters<typeof person>[1]) => {
    const p = await person(browser, options);
    opened.push(p.context);
    return p.page;
  };

  await test.step("setup: the owner's settings and two crews (the settings screen's API); nobody else is staff yet", async () => {
    const saved = await adminApi("POST", "/settings", {
      timeZone: "America/Denver",
      businessName: "Acme Windows",
      contactPhone: "(801) 555-0143",
      contactEmail: "office@acme.test",
      staffNotifyEmails: ["office@acme.test"],
      autoConfirm: false,
      pendingExpiryHours: 24,
      reminderLeadHours: 24,
      cancelCutoffHours: 12,
      requireAddress: true,
      services: [{ key: "estimate", name: "Free estimate", durationMinutes: 60 }],
    });
    expect(saved.status).toBe(200);
    for (const crew of [
      { name: "Crew A", homeBaseAddress: "1 Depot Rd, Salt Lake City" },
      { name: "Crew B", homeBaseAddress: "2 Yard Ln, Salt Lake City" },
    ]) {
      const created = await adminApi("POST", "/resources", crew);
      expect(created.status).toBe(201);
      // With a Google key, a home base is geocoded on the way in (step 8).
      expect(created.body.resource.homeBaseLat).not.toBeNull();
    }
    // Casey has signed in, but nobody has given them anything: not staff.
    const casey = await fetch(`${server.origin}/api/admin/schedule/v1/admin/crew-day`, { headers: { cookie: "e2e-staff=user_crew_b" } });
    expect(casey.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  await test.step("1. customers pick a time on the website and are acknowledged; the office hears", async () => {
    const pat = await open({ viewport: PHONE, timezoneId: "America/New_York" });

    // 6 (time zone): 24 REAL hours of notice. At Thu 08:59 MDT the first time
    // on Friday is 09:00 — not 08:00 or 08:30, which are under 24 hours away.
    await pat.goto(`${server.origin}/book-visit`);
    await expect(pat.getByText(/Times are/)).toContainText("Mountain Time");
    await pat.locator('.aisw-day[data-date="2026-10-30"]').click();
    await expect(pat.getByRole("button", { name: /^9:00 AM to 10:00 AM/ })).toBeVisible();
    await expect(pat.getByRole("button", { name: /^8:00 AM to 9:00 AM/ })).toHaveCount(0);
    await expect(pat.getByRole("button", { name: /^8:30 AM to 9:30 AM/ })).toHaveCount(0);

    await book(pat, PAT, "2026-11-02", /^9:00 AM to 10:00 AM/);
    // What Pat SEES: the business's 9:00 AM on Monday — in New York that is
    // 11:00 AM, and the page must not say so.
    const done = pat.locator("[data-aisw-confirmation]");
    await expect(done).toContainText("Acme Windows will confirm it soon.");
    await expect(done).toContainText(/Monday, November 2, 9:00\s–\s10:00\sAM\sMST/);
    await expect(done).not.toContainText("11:00");
    await expect(done).toContainText("We've emailed you a copy of your request with a link to change it.");

    // What Pat and the office RECEIVE.
    const mail = await expectMail(2);
    expect(addressed(mail)).toEqual([
      [PAT.email, "We got your request: Free estimate, Mon, Nov 2, 9:00 AM MST"],
      ["office@acme.test", "New request: Pat Visitor, Mon, Nov 2, 9:00 AM MST"],
    ]);
    const ack = mailTo(mail, PAT.email).body;
    expect(ack).toContain("Requested time: Monday, November 2, 2026");
    expect(ack).toContain("MST");
    expect(ack).toContain("Where: 12 Oak St, Salt Lake City");
    expect(ack).toContain("Questions? Call (801) 555-0143 or email office@acme.test.");
    const ackLink = manageLinkIn(ack);
    const office = mailTo(mail, "office@acme.test").body;
    expect(office).toContain("New request from Pat Visitor: Free estimate. Accept or decline it in your schedule.");
    expect(office).toContain(`Your schedule: ${server.origin}/admin/schedule`);
    expect(office).toMatch(/Phone: .*555.*0100/);

    // The link in the email opens Pat's own request.
    await pat.goto(ackLink);
    await expect(pat.getByText("Waiting for Acme Windows to confirm")).toBeVisible();

    // The delivery log keeps the email, never the key to the visit.
    const logged = await server.query<{ body: string }>("select body from comms_messages where template_key = 'visit_requested'");
    expect(logged[0]!.body).toContain(`${server.origin}/visit/:token`);
    expect(logged.some((row) => row.body.includes(ackLink))).toBe(false);

    // Three more customers: one to decline, one who will cancel, one nobody answers.
    const lee = await open({ viewport: PHONE, timezoneId: "America/Denver" });
    await book(lee, LEE, "2026-11-02", /^1:00 PM to 2:00 PM/);
    const sam = await open({ viewport: PHONE, timezoneId: "America/Denver" });
    await book(sam, SAM, "2026-11-04", /^9:00 AM to 10:00 AM/);
    const kim = await open({ viewport: PHONE, timezoneId: "America/Denver" });
    await book(kim, KIM, "2026-11-09", /^10:00 AM to 11:00 AM/);
    const more = await expectMail(6);
    expect(addressed(more).filter(([to]) => to !== "office@acme.test")).toEqual([
      [LEE.email, "We got your request: Free estimate, Mon, Nov 2, 1:00 PM MST"],
      [SAM.email, "We got your request: Free estimate, Wed, Nov 4, 9:00 AM MST"],
      [KIM.email, "We got your request: Free estimate, Mon, Nov 9, 10:00 AM MST"],
    ]);
    state.kimLink = manageLinkIn(mailTo(more, KIM.email).body);
  });

  // -------------------------------------------------------------------------
  await test.step("2. the office sees the requests, accepts one and declines another; customers are told", async () => {
    server.setClock(at("2026-10-29T16:00:00Z")); // Thu 10:00 MDT
    const office = await open({ viewport: DESK, timezoneId: "America/Los_Angeles", staff: "owner" });
    await office.goto(`${server.origin}/admin/schedule`);
    await expect(office.getByRole("button", { name: "Requests, 4 waiting" })).toBeVisible();

    // On the calendar: Monday's requests, in the business's time.
    await office.getByRole("button", { name: "Next week" }).click();
    const patId = await visitId(PAT.email);
    await expect(office.locator(`[data-visit-id="${patId}"]`)).toBeVisible();

    await office.getByRole("button", { name: "Requests, 4 waiting" }).click();
    const inbox = office.getByRole("dialog", { name: /Requests/ });
    await expect(inbox).toContainText("Pat Visitor");
    // When, on the business's clock (the office is in Los Angeles).
    await expect(inbox).toContainText(/Mon, Nov 2, 9:00\s–\s10:00\sAM/);
    // What the owner needs to decide: where it is.
    await expect(inbox).toContainText("12 Oak St, Salt Lake City");
    await inbox.getByRole("button", { name: /^Accept Pat Visitor/ }).click();
    await expect(inbox.getByRole("button", { name: /^Accept Pat Visitor/ })).toHaveCount(0);
    await inbox.getByRole("button", { name: /^Accept Sam Cancels/ }).click();
    await expect(inbox.getByRole("button", { name: /^Accept Sam Cancels/ })).toHaveCount(0);
    await inbox.getByRole("button", { name: /^Decline Lee Declined/ }).click();
    await inbox.getByLabel(/A note for the customer/).fill("We're not in your area that day");
    await inbox.getByRole("button", { name: "Decline request" }).click();
    await expect(inbox.getByText("Lee Declined")).toHaveCount(0);
    // Kim's request is left waiting — step 7.
    await expect(inbox).toContainText("Kim Waiting");
    await office.keyboard.press("Escape");
    await expect(inbox).toBeHidden();

    const mail = await expectMail(3);
    expect(addressed(mail)).toEqual([
      [PAT.email, "Confirmed: Free estimate, Mon, Nov 2, 9:00 AM MST"],
      [SAM.email, "Confirmed: Free estimate, Wed, Nov 4, 9:00 AM MST"],
      [LEE.email, "We can't make Mon, Nov 2, 1:00 PM MST"],
    ]);
    const confirmed = mailTo(mail, PAT.email).body;
    expect(confirmed).toContain("Good news: we've confirmed your Free estimate.");
    expect(confirmed).toContain("Reschedule or cancel here, no account needed (up to 12 hours before the visit):");
    state.patLink = manageLinkIn(confirmed);
    state.samLink = manageLinkIn(mailTo(mail, SAM.email).body);
    const declined = mailTo(mail, LEE.email).body;
    expect(declined).toContain(`Note from us: "We're not in your area that day"`);
    expect(declined).toContain(`pick one here: ${server.origin}/book-visit`);

    // The reminder is due 24 REAL hours before Monday 09:00 MST, across the
    // fall-back: Sunday 16:00Z. The cron runs once a day at 14:00Z, so it is
    // queued for THAT run — Sunday 07:00 MST, a day ahead — not for 16:00Z,
    // which the cron would only reach on Monday morning, past the cutoff.
    const queued = await reminders(patId);
    expect(queued.map((r) => [r.status, new Date(r.send_at).toISOString()])).toEqual([["pending", "2026-11-01T14:00:00.000Z"]]);
  });

  // -------------------------------------------------------------------------
  await test.step("3. the office drags the visit to a new time and gives it to another crew; the customer is told", async () => {
    const office = await open({ viewport: DESK, timezoneId: "America/Los_Angeles", staff: "owner" });
    await office.goto(`${server.origin}/admin/schedule`);
    await office.getByRole("button", { name: "Next week" }).click();
    await office.getByRole("button", { name: /^Open Monday, November 2.* as a day$/ }).click();
    const patId = await visitId(PAT.email);
    const block = office.locator(`[data-visit-id="${patId}"]`);
    await expect(block).toBeVisible();
    await block.scrollIntoViewIfNeeded();

    // A real mouse drag, two hours down (1.6 px a minute), in steps like a hand.
    const box = (await block.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + 10;
    await office.mouse.move(x, y);
    await office.mouse.down();
    await office.mouse.move(x, y + 96, { steps: 6 });
    await office.mouse.move(x, y + 192, { steps: 6 });
    await office.mouse.up();
    const ask = office.getByRole("dialog", { name: "Email the customer about this change?" });
    await expect(ask).toBeVisible();
    await ask.getByRole("button", { name: "Yes, email them" }).click();
    await expect(office.getByText("Pat Visitor moved to Mon, Nov 2, 11:00 AM.")).toBeVisible();

    let mail = await expectMail(1);
    expect(addressed(mail)).toEqual([[PAT.email, "New time: Free estimate, Mon, Nov 2, 11:00 AM MST"]]);
    expect(mail[0]!.body).toContain("We had to move your Free estimate. Sorry for the change.");
    expect(mail[0]!.body).toContain("Was: Monday, November 2, 2026");
    expect(mail[0]!.body).toContain("9:00");

    // Reassign: open the visit, Change crew → Crew B.
    await block.click();
    const panel = office.getByRole("dialog");
    await panel.getByRole("button", { name: "Change crew" }).click();
    await panel.getByLabel("Crew").selectOption({ label: "Crew B" });
    await panel.locator("form[data-aisw-crew]").getByRole("button", { name: "Change crew" }).click();
    mail = await expectMail(1);
    expect(addressed(mail)).toEqual([[PAT.email, "Update to your Free estimate, Mon, Nov 2, 11:00 AM MST"]]);
    expect(mail[0]!.body).toContain("Crew B from our team will now be doing your Free estimate. The time hasn't changed.");

    // The old reminder is withdrawn; one for the new time waits for Sunday's run.
    const queued = await reminders(patId);
    expect(queued.filter((r) => r.status === "pending").map((r) => new Date(r.send_at).toISOString())).toEqual([
      "2026-11-01T14:00:00.000Z",
    ]);
    expect(queued.filter((r) => r.status === "cancelled")).toHaveLength(1);

    // The office goes home: an open calendar refreshes when its window regains
    // focus, and every refresh also releases overdue requests (at most once a
    // minute). That is the app working — but step 7 is about the quiet week,
    // when only the cron is left to tell Kim.
    for (const context of opened.splice(0)) await context.close();
  });

  // -------------------------------------------------------------------------
  await test.step("7. a request nobody answers is released after 24 hours; the customer and the office are told", async () => {
    server.setClock(at("2026-10-30T16:00:00Z")); // Fri 10:00 MDT — Kim's request was due an answer at 09:00
    // Before any cron: Kim's link already says it lapsed, offers nothing to
    // change, and the time it held is free for the next customer.
    const kim = await open({ viewport: PHONE, timezoneId: "America/Denver" });
    await kim.goto(state.kimLink);
    await expect(kim.getByText("Not confirmed in time")).toBeVisible();
    await expect(kim.getByRole("button", { name: "Pick another time" })).toHaveCount(0);
    await kim.goto(`${server.origin}/book-visit`);
    await kim.locator('.aisw-day[data-date="2026-11-09"]').click();
    await expect(kim.getByRole("button", { name: /^10:00 AM to 11:00 AM/ }).first()).toBeVisible();
    expect(server.outbox.length - read).toBe(0);

    // The scheduling cron's next run (vercel.json: 13:00 UTC daily): Saturday.
    server.setClock(expiryRunOn("2026-10-31"));
    const result = await server.runExpiryCron();
    expect(result.expired).toBe(1);
    expect((await visitRow(KIM.email)).status).toBe("expired");
    const mail = await expectMail(2);
    expect(addressed(mail)).toEqual([
      [KIM.email, "We couldn't confirm Mon, Nov 9, 10:00 AM MST in time"],
      ["office@acme.test", "Request expired: Kim Waiting, Mon, Nov 9, 10:00 AM MST"],
    ]);
    expect(mailTo(mail, KIM.email).body).toContain("we weren't able to confirm your Free estimate request for");
    expect(mailTo(mail, KIM.email).body).toContain(`pick one here: ${server.origin}/book-visit`);
    expect(mailTo(mail, "office@acme.test").body).toContain("Nobody answered Kim Waiting's Free estimate request in time");

    await kim.goto(state.kimLink);
    await expect(kim.getByText("Not confirmed in time")).toBeVisible();
    await expect(kim.getByText("Acme Windows wasn't able to confirm your request in time, so it was released.")).toBeVisible();
  });

  // -------------------------------------------------------------------------
  await test.step("4. the reminder arrives with a working link; the customer reschedules from it; another cancels in time", async () => {
    // Sunday's comms cron, at its vercel.json hour: 07:00 MST, after the clocks fell back.
    server.setClock(commsRunOn("2026-11-01"));
    const patId = await visitId(PAT.email);

    // Pat's reminder (Monday 11:00 MST) goes out on this run, a day ahead;
    // Sam's (Wednesday) waits for Tuesday's.
    const run = await server.runCommsCron();
    expect(run.sent).toBe(1);
    let mail = await expectMail(1);
    expect(addressed(mail)).toEqual([[PAT.email, "Reminder: Free estimate, Mon, Nov 2, 11:00 AM MST"]]);
    const reminder = mail[0]!.body;
    expect(reminder).toContain("A reminder of your Free estimate.");
    expect(reminder).toContain("When: Monday, November 2, 2026");
    // The reminder sat in a table for three days without a link; the cron put
    // a fresh one in at send time, and scrubbed it from the log after.
    const reminderLink = manageLinkIn(reminder);
    const logged = await server.query<{ body: string }>("select body from comms_messages where template_key = 'visit_reminder'");
    expect(logged).toHaveLength(1);
    expect(logged[0]!.body).toContain(`${server.origin}/visit/:token`);

    // Pat opens the reminder's link on a phone in New York and moves the visit
    // to Tuesday 10:00 — the business's 10:00, not New York's.
    const pat = await open({ viewport: PHONE, timezoneId: "America/New_York" });
    await pat.goto(reminderLink);
    await expect(pat.getByText("Confirmed", { exact: true })).toBeVisible();
    await expect(pat.locator(".aisw-root")).toContainText("11:00");
    await pat.getByRole("button", { name: "Pick another time" }).click();
    await pat.locator('.aisw-day[data-date="2026-11-03"]').click();
    await pat.getByRole("button", { name: /^10:00 AM to 11:00 AM/ }).click();
    await expect(pat.getByRole("heading", { name: "Move to Tue, Nov 3, 10:00 AM?" })).toBeVisible();
    await pat.getByRole("button", { name: "Yes, move it" }).click();
    await expect(pat.getByText(/Moved to Tuesday, November 3/)).toBeVisible();
    await expect(pat.getByText(/We've emailed you the new time/)).toBeVisible();

    mail = await expectMail(2);
    expect(addressed(mail)).toEqual([
      [PAT.email, "New time: Free estimate, Tue, Nov 3, 10:00 AM MST"],
      ["office@acme.test", "Visit moved: Pat Visitor, Tue, Nov 3, 10:00 AM MST"],
    ]);
    expect(mailTo(mail, PAT.email).body).toContain("Your Free estimate has moved, as you asked.");
    expect(mailTo(mail, "office@acme.test").body).toContain("Pat Visitor moved their Free estimate.");
    const row = await visitRow(PAT.email);
    expect([row.status, row.start_time, new Date(row.starts_at).toISOString()]).toEqual(["confirmed", "10:00", "2026-11-03T17:00:00.000Z"]);
    // A reminder follows the visit: on the run before 24 real hours ahead of
    // Tuesday 10:00 MST — Monday's 14:00Z.
    expect(
      (await reminders(patId)).filter((r) => r.status === "pending").map((r) => new Date(r.send_at).toISOString()),
    ).toEqual(["2026-11-02T14:00:00.000Z"]);

    // Sam cancels from the link in his confirmation, three days ahead.
    const sam = await open({ viewport: PHONE, timezoneId: "America/Denver" });
    await sam.goto(state.samLink);
    await expect(sam.getByText("Confirmed", { exact: true })).toBeVisible();
    await sam.getByRole("button", { name: "Cancel visit" }).click();
    await sam.getByLabel(/Anything you'd like/).fill("Selling the house");
    await sam.getByRole("button", { name: "Yes, cancel it" }).click();
    await expect(sam.getByText("You cancelled this visit.")).toBeVisible();
    mail = await expectMail(2);
    expect(addressed(mail)).toEqual([
      [SAM.email, "Cancelled: Free estimate, Wed, Nov 4, 9:00 AM MST"],
      ["office@acme.test", "Visit cancelled: Sam Cancels, Wed, Nov 4, 9:00 AM MST"],
    ]);
    expect(mailTo(mail, SAM.email).body).toContain("is cancelled, as you asked.");
    // His reminder is withdrawn, so Tuesday's cron sends him nothing.
    expect((await reminders(await visitId(SAM.email))).map((r) => r.status)).toEqual(["cancelled"]);

    // Monday's run (07:00 MST): the reminder for the new time, with a link
    // that still changes the visit — it is 27 hours away, the cutoff is 12.
    server.setClock(commsRunOn("2026-11-02"));
    expect((await server.runCommsCron()).sent).toBe(1);
    mail = await expectMail(1);
    expect(addressed(mail)).toEqual([[PAT.email, "Reminder: Free estimate, Tue, Nov 3, 10:00 AM MST"]]);
    expect(mail[0]!.body).toContain("Reschedule or cancel here, no account needed (up to 12 hours before the visit):");
    const mondayLink = manageLinkIn(mail[0]!.body);
    const fromReminder = await open({ viewport: PHONE, timezoneId: "America/New_York" });
    await fromReminder.goto(mondayLink);
    await expect(fromReminder.getByRole("button", { name: "Pick another time" })).toBeVisible();
  });

  // -------------------------------------------------------------------------
  await test.step("4. (cutoff) inside the last 12 hours the link shows the visit and the phone number, not the buttons", async () => {
    server.setClock(at("2026-11-03T15:00:00Z")); // Tue 08:00 MST, two hours before Pat's visit
    const pat = await open({ viewport: PHONE, timezoneId: "America/New_York" });
    await pat.goto(state.patLink); // the link from the confirmation still works after the moves
    await expect(pat.getByText("Confirmed", { exact: true })).toBeVisible();
    await expect(pat.getByText("This visit starts within 12 hours, so it can't be changed online. Call (801) 555-0143.")).toBeVisible();
    await expect(pat.getByRole("button", { name: "Pick another time" })).toHaveCount(0);
    await expect(pat.getByRole("button", { name: "Cancel visit" })).toHaveCount(0);
    // And the server holds the line too, whatever a page sends.
    const token = state.patLink.split("/visit/")[1]!;
    const refused = await fetch(`${server.origin}/api/schedule/v1/visit/${token}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: server.origin, "sec-fetch-site": "same-origin" },
      body: "{}",
    });
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("too_late");
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(server.outbox.length - read).toBe(0);
  });

  // -------------------------------------------------------------------------
  await test.step("5. the owner gives a crew member their route from settings; they open it on a phone: the stop, directions, Start, Complete, Undo", async () => {
    // Pat's visit is with whichever crew the public offer gave Tuesday 10:00.
    const row = await visitRow(PAT.email);
    const [crew] = await server.query<{ name: string }>("select name from scheduling_resources where id = $1", [row.resource_id]);
    const member = crew!.name === "Crew A"
      ? { userId: "user_crew_a", label: "Alex Crew (alex@acme.test)" }
      : { userId: "user_crew_b", label: "Casey Crew (casey@acme.test)" };

    // The owner, in Schedule settings → Crews: picks them by name. No user id,
    // no developer, no database.
    const owner = await open({ viewport: DESK, timezoneId: "America/Denver", staff: "owner" });
    await owner.goto(`${server.origin}/admin/schedule/settings`);
    const card = owner.locator("[data-aisw-crews] li", { hasText: crew!.name });
    await card.getByRole("button", { name: "Edit" }).click();
    await card.getByLabel("Who opens this crew's route").selectOption({ label: member.label });
    await card.getByRole("button", { name: "Save crew" }).click();
    await expect.poll(() => server.roles.get(member.userId)).toBe("crew");

    // Their sign-in now opens their route — and only their route.
    const crewOnly = { cookie: `e2e-staff=${member.userId}` };
    expect((await fetch(`${server.origin}/api/admin/schedule/v1/admin/calendar?from=2026-11-03&to=2026-11-03`, { headers: crewOnly })).status).toBe(403);
    expect((await fetch(`${server.origin}/api/admin/schedule/v1/admin/settings`, { headers: crewOnly })).status).toBe(403);

    const phone = await open({ viewport: PHONE, timezoneId: "America/Denver", staff: member.userId });
    await phone.goto(`${server.origin}/admin/schedule/today`);
    // Whose route: the crew linked to whoever signed in — no picker.
    await expect(phone.getByText(crew!.name).first()).toBeVisible();
    const patId = await visitId(PAT.email);
    const stop = phone.locator(`[data-stop-id="${patId}"]`);
    await expect(stop).toContainText("10:00");
    await expect(stop).toContainText("Pat Visitor");
    await expect(stop).toContainText("Free estimate");
    // The address is a directions link; the drive from home base is Google's, not an estimate (step 8).
    const directions = stop.getByRole("link", { name: /12 Oak St, Salt Lake City/ });
    await expect(directions).toHaveAttribute("href", /google\.com\/maps\/dir\/.*destination=/);
    await expect(stop).toContainText(/15 min drive · 5\.5 mi from home base/);
    await expect(stop).not.toContainText("(estimate)");
    await expect(stop.getByRole("link", { name: /Call/ })).toHaveAttribute("href", /^tel:/);
    expect(server.googleCalls.geocode).toBeGreaterThan(0);
    expect(server.googleCalls.distance).toBeGreaterThan(0);

    await stop.getByRole("button", { name: /^Start stop 1/ }).click();
    await expect(stop.getByRole("button", { name: /^Complete stop 1/ })).toBeVisible();
    expect((await visitRow(PAT.email)).status).toBe("in_progress");
    await stop.getByRole("button", { name: /^Complete stop 1/ }).click();
    await expect(stop.getByText(/Done \d{1,2}:\d{2} AM/)).toBeVisible();
    expect((await visitRow(PAT.email)).status).toBe("completed");
    // A fat-fingered Complete: Undo puts it back to started, then Complete again.
    await stop.getByRole("button", { name: /^Undo completing stop 1/ }).click();
    await expect(stop.getByRole("button", { name: /^Complete stop 1/ })).toBeVisible();
    expect((await visitRow(PAT.email)).status).toBe("in_progress");
    await stop.getByRole("button", { name: /^Complete stop 1/ }).click();
    await expect(stop.getByText(/Done \d{1,2}:\d{2} AM/)).toBeVisible();
    expect((await visitRow(PAT.email)).status).toBe("completed");
    // Starting and finishing are the crew's business: nobody is emailed.
    expect(server.outbox.length - read).toBe(0);
    // No sideways scroll on a phone.
    expect(await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

    // The customer's page says so.
    const pat = await open({ viewport: PHONE, timezoneId: "America/New_York" });
    await pat.goto(state.patLink);
    await expect(pat.getByText("Your free estimate is done")).toBeVisible();
  });

  // -------------------------------------------------------------------------
  await test.step("6. every email the business sent spoke in its own time zone, and none kept a key", async () => {
    // Every visit in this run is after the fall-back: every customer-facing
    // time is MST, and none is the browser's zone or UTC.
    for (const email of server.outbox) {
      expect(email.subject, `to ${email.to}`).toMatch(/MST/);
    }
    expect(server.outbox.filter((m) => /\b(UTC|GMT|EST|EDT|PST|PDT)\b/.test(`${m.subject}\n${m.body}`))).toEqual([]);
    // The delivery log holds every one of them, with every link scrubbed.
    const logged = await server.query<{ body: string; status: string }>("select body, status from comms_messages");
    expect(logged.length).toBe(server.outbox.length);
    expect(logged.every((row) => row.status === "sent")).toBe(true);
    expect(logged.filter((row) => /\/visit\/(?!:token)[A-Za-z0-9_-]{20,}/.test(row.body))).toEqual([]);

    for (const context of opened) await context.close();
  });
});

/** Links carried between steps. */
const state = { patLink: "", samLink: "", kimLink: "" };
