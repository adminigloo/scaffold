import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { deflateSync } from "node:zlib";
import { startEstimatorScenario, type EstimatorScenario, type SentEmail } from "../fixtures/estimator-scenario-server.js";

/**
 * THE ESTIMATOR'S BUSINESS SCENARIO, END TO END, IN A BROWSER — the acceptance
 * bar for estimator 0.3 and the create-app wiring that ships it:
 *
 *   "Business owners aren't devs. If a business owner is told by their dev
 *    that it works, they deploy it and sell it to a customer; they need to
 *    trust that it's actually doing what is needed."
 *
 * Summit Ramps, a wheelchair-ramp company in Salt Lake City. The real widgets
 * in a real browser, against the real handlers on a real Postgres (PGlite),
 * with the comms listener sending every email into an outbox this test reads,
 * a customer's photo kept through the storage package, and an accepted quote
 * turned into a visit (scheduling) and an invoice (invoicing) — wired the way
 * a generated `--estimator --scheduling --invoicing --comms --email --storage
 * --ai` project wires them (see fixtures/estimator-scenario-server.ts). The
 * photo reading is a fake model that reports only what it SEES (four risers,
 * 7.5–8.5 in each: one more than Pat's door, two steps and the porch, has), so
 * every number on screen is the package's code.
 *
 * Each person is driven like a person and checked on what they SEE and what
 * they RECEIVE:
 *
 *   the owner   saves the business's name and tax rate (the estimate page is
 *               closed until then), loads the sample price book on purpose —
 *               off the website — turns the ramp on, and tests a quote;
 *   a customer  on a phone answers what they know (how many steps, the height
 *               of one if they measured it — never a "length of run"), adds a
 *               photo the browser shrinks, sees what the AI counted and the
 *               working, corrects the count, and saves the estimate;
 *   the office  reads the lead with its photo and the AI's reading beside the
 *               customer's correction, edits it, and sends the quote;
 *   the customer accepts it from the link in the email; the office hears, and
 *               the follow-up is withdrawn; another customer who never answers
 *               gets the follow-up, then the quote lapses;
 *   the office  books the visit from the accepted quote and makes the invoice.
 *
 * The clock starts Monday 2026-11-02 08:00 MST. The crons run only when the
 * test says, at the hours vercel.json gives them (comms 14:00 UTC).
 *
 * Run it: cd e2e && pnpm install && pnpm browsers && pnpm test estimator-scenario
 * (the estimator, comms, storage, invoicing and scheduling packages must be
 * built: their dist is what runs).
 */

const TENANT = "summit-ramps";
const START = new Date("2026-11-02T15:00:00Z"); // Mon 08:00 MST
const PAT = { name: "Pat Lee", email: "pat@example.com", phone: "801-555-0199", address: "12 Oak St, Salt Lake City" };
const SAM = { name: "Sam Ortiz", email: "sam@example.com" };
const OFFICE = "office@summit.test";
const PHONE = { width: 390, height: 844 };
const DESK = { width: 1280, height: 1000 };

let server: EstimatorScenario;

test.beforeAll(async () => {
  server = await startEstimatorScenario({ tenantId: TENANT, start: START });
});
test.afterAll(async () => {
  await server?.close();
});

// --- the people -----------------------------------------------------------------

async function person(
  browser: Browser,
  options: { viewport: { width: number; height: number }; staff?: "owner" | "office" },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: options.viewport, timezoneId: "America/Denver", locale: "en-US" });
  if (options.staff) await context.addCookies([{ name: "e2e-staff", value: options.staff, url: server.origin }]);
  const page = await context.newPage();
  await page.clock.install({ time: server.now() });
  await page.clock.resume();
  return { context, page };
}

// --- what they receive -------------------------------------------------------------

let read = 0;
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
async function expectMail(count: number): Promise<SentEmail[]> {
  await expect.poll(() => server.outbox.length - read, { timeout: 10_000 }).toBe(count);
  return newMail();
}
/** The quote link in an email body: this server's /quote/<token>. */
function quoteLinkIn(body: string): string {
  const match = new RegExp(`${server.origin.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}/quote/([A-Za-z0-9_-]{43})`).exec(body);
  if (!match) throw new Error(`no quote link in:\n${body}`);
  return match[0];
}

/** A staff call to the admin API (the settings screen's), signed in as `who`. */
async function adminApi(who: "owner" | "office", method: "GET" | "POST", path: string, body?: unknown) {
  const response = await fetch(`${server.origin}/api/admin/estimator/v1/admin/${path}`, {
    method,
    headers: {
      cookie: `e2e-staff=${who}`,
      origin: server.origin,
      "sec-fetch-site": "same-origin",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: (await response.json()) as any };
}

/** A whole-dollar range as the widget prints it, back to numbers. */
function dollars(text: string): number[] {
  return [...text.matchAll(/\$([\d,]+)/g)].map((m) => Number(m[1]!.replace(/,/g, "")));
}

// --- a real photo: a 1600 × 1200 PNG of three steps, made here ------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function stepsPng(width = 1600, height = 1200): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3, 0xff);
    row[0] = 0;
    for (let x = 0; x < width; x += 1) {
      const step = Math.floor((x / width) * 3);
      if (y > height - (step + 1) * (height / 4)) row.fill(0x77, 1 + x * 3, 4 + x * 3);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}
function jpegSize(bytes: Buffer): { width: number; height: number } {
  expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
  let i = 2;
  while (i < bytes.length) {
    const marker = bytes[i + 1]!;
    const length = bytes.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  throw new Error("no SOF");
}

/** Ids and links carried between steps. */
const state = { ramp: "", pat: "", patNumber: "", patLink: "", sam: "", samNumber: "", patTotal: 0 };

test("Summit Ramps prices, quotes and wins a ramp job: owner, customer and office, end to end", async ({ browser }) => {
  test.setTimeout(300_000);
  const opened: BrowserContext[] = [];
  const open = async (options: Parameters<typeof person>[1]) => {
    const p = await person(browser, options);
    opened.push(p.context);
    return p.page;
  };
  const steps = (page: Page) => page.getByLabel("How many steps go up to the door?", { exact: true });
  const height = (page: Page) => page.getByLabel("Height of one step (optional)", { exact: true });
  const amount = (page: Page) => page.locator("[data-aiew-price] [data-aiew-amount]");
  const explanation = (page: Page) => page.locator("[data-aiew-price] [data-aiew-explain]");

  // -------------------------------------------------------------------------
  await test.step("1. the owner sets up: settings first, then the sample price book ON PURPOSE (off the website), turns the ramp on, and tests a quote", async () => {
    // Before anything: nothing seeds itself from a public page, and the page
    // is closed — no customer gets a price, or an email, from a business with
    // no name at a tax rate nobody chose (review EST-R02).
    const early = await open({ viewport: PHONE });
    await early.goto(`${server.origin}/estimate`);
    await expect(early.getByText("Instant estimates aren't available right now.")).toBeVisible();
    expect(await server.query("select id from estimator_products")).toEqual([]);

    // Office staff can't change the settings: their role holds view + manage only.
    expect((await adminApi("office", "POST", "settings", { businessName: "Not us" })).status).toBe(403);

    // The owner's first visit to Estimate settings: ONE form, "Get started" —
    // the name, how to reach them, the sales tax and the labor rate.
    const owner = await open({ viewport: DESK, staff: "owner" });
    await owner.goto(`${server.origin}/admin/estimator/settings`);
    const start = owner.locator('[data-aiew-panel="get-started"]');
    await expect(start).toContainText("Your estimate page is closed until you save these");
    await expect(owner.locator('[data-aiew-panel="business"]')).toHaveCount(0);
    await start.getByRole("button", { name: "Save and open my estimate page" }).click();
    await expect(start).toContainText("Add your business name.");
    await start.getByLabel("Business name").fill("Summit Ramps");
    await start.getByLabel("Contact phone").fill("(801) 555-0143");
    await start.getByLabel("Contact email").fill("hello@summit.test");
    await start.getByLabel("Sales tax (%)").fill("7.25");
    await start.getByLabel("Hourly labor rate ($)").fill("65");
    await start.getByRole("button", { name: "Save and open my estimate page" }).click();
    await expect(owner.locator('[data-aiew-panel="business"]')).toBeVisible();
    await expect(start).toHaveCount(0);

    // The rest the screens save section by section (here through their API):
    // who hears about a lead, the zone, the quote rules.
    const rest = { timeZone: "America/Denver", leadNotifyEmails: [OFFICE], quoteValidDays: 30, followUpDays: 3 };
    const saved = await adminApi("owner", "POST", "settings", rest);
    expect(saved.status).toBe(200);
    expect(saved.body.settings).toMatchObject({
      ...rest,
      businessName: "Summit Ramps",
      contactPhone: "(801) 555-0143",
      contactEmail: "hello@summit.test",
      taxRateBp: 725,
      defaultLaborRateCents: 6500,
      saved: true,
    });

    // The price book: empty, then the sample — only when the owner says so,
    // and OFF the website, so its made-up prices reach no customer (EST-R01).
    await owner.goto(`${server.origin}/admin/estimator`);
    await expect(owner.getByText("No products yet.")).toBeVisible();
    await owner.getByRole("button", { name: "Load a sample catalog" }).click();
    const dialog = owner.getByRole("dialog", { name: "Load a sample catalog?" });
    await expect(dialog).toContainText("This adds 5 sample products and 10 supplies with sample prices.");
    await expect(dialog).toContainText("They stay off your website until you turn each one on");
    expect(await server.query("select id from estimator_products")).toEqual([]);
    await dialog.getByRole("button", { name: "Load the sample" }).click();
    const rampRow = owner.locator("li", { hasText: "Modular aluminum ramp" }).first();
    await expect(rampRow).toBeVisible();
    await expect(rampRow).toContainText("Staff only");
    // Each product's everyday price, and the margin (the owner sees costs).
    await expect(rampRow.locator("[data-aiew-example]")).toHaveText("3 steps: $6,921.46, margin 28.57%");
    const [ramp] = await server.query<{ id: string }>("select id from estimator_products where name = 'Modular aluminum ramp'");
    state.ramp = ramp!.id;
    expect(await server.query("select id from estimator_products where show_in_estimator")).toEqual([]);
    await early.reload();
    await expect(early.getByText("Instant estimates aren't available right now.")).toBeVisible();

    // "Test a quote": exactly what a customer is asked, priced from the
    // supplies with the cost and margin beside it — at the typical step, the
    // middle of the band, never the cheapest end of the range (EST-R05).
    await rampRow.getByRole("button", { name: "Edit" }).click();
    const testPanel = owner.getByRole("complementary", { name: "Test a quote" });
    await testPanel.getByLabel("How many steps go up to the door?", { exact: true }).fill("3");
    await expect(testPanel.getByText("$6,473 – $7,146")).toBeVisible();
    await expect(testPanel.getByText("Based on an estimated step height of 7–8 in. Measure one step and enter it for a tighter estimate.")).toBeVisible();
    await expect(testPanel.locator("[data-aiew-point]")).toHaveText("$6,921.46");
    await expect(testPanel.getByText("28.57%")).toBeVisible();
    await expect(testPanel).not.toContainText(/length of run/i);
    // Posts are bought whole: 23 ft at one every 4 ft is 6, not 5.75 (EST-R09).
    await expect(owner.locator('[data-aiew-breakdown] tr', { hasText: "Support post" })).toContainText("6 each");

    // On the website, on purpose.
    await owner.getByRole("switch", { name: /Show on your website/ }).check();
    await owner.getByRole("button", { name: "Save changes" }).click();
    await expect(owner.getByText("Saved", { exact: true })).toBeVisible();
    expect(await server.query("select name from estimator_products where show_in_estimator")).toEqual([{ name: "Modular aluminum ramp" }]);

    // The supplies on the owner's phone, where prices change: each one a card,
    // Edit and Retire on screen, nothing scrolling sideways (EST-R08).
    const phoneOwner = await open({ viewport: PHONE, staff: "owner" });
    await phoneOwner.goto(`${server.origin}/admin/estimator`);
    await phoneOwner.getByRole("tab", { name: "Supplies" }).click();
    const edits = phoneOwner.locator("[data-aiew-supply] button", { hasText: "Edit" });
    await expect(edits).toHaveCount(10);
    for (const button of await edits.all()) {
      const box = (await button.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
    }
    await expect(phoneOwner.locator("table.aiew-supply-table thead")).toBeHidden();
    expect(await phoneOwner.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });

  // -------------------------------------------------------------------------
  await test.step("2. a customer answers what they know, adds a photo, sees what the AI counted and the working, and corrects it", async () => {
    const pat = await open({ viewport: PHONE });
    await pat.goto(`${server.origin}/estimate`);
    // The one product on the website: no choice to make.
    await expect(pat.getByText("What do you need?")).toHaveCount(0);
    await expect(pat.getByRole("radio", { name: "Modular aluminum ramp" })).toHaveCount(0);
    await expect(pat.locator(".aiew-root")).toContainText("Modular aluminum ramp.");

    // ASKED IN PLAIN WORDS: the steps (a stepper) and, optionally, the height
    // of one. Never a number they'd have to work out.
    await expect(steps(pat)).toHaveValue("");
    await expect(height(pat)).toBeVisible();
    await expect(pat.getByText("Measure from the top of one step to the top of the next.")).toBeVisible();
    await expect(pat.getByText("Count every step up, including the last one onto the porch or landing: 2 steps and the porch is 3.")).toBeVisible();
    await expect(pat.locator("body")).not.toContainText(/length of run|run \(ft\)/i);
    await expect(pat.getByText("Answer the questions above to see your price.")).toBeVisible();
    // Two questions, not three: the total height stays behind "More ways to
    // measure" until asked for — really hidden, not just marked (EST-R03).
    const total = pat.getByLabel("Or the total height, ground to door threshold (optional)", { exact: true });
    await expect(total).toBeHidden();
    await pat.getByRole("button", { name: "More ways to measure" }).click();
    await expect(total).toBeVisible();
    await pat.getByRole("button", { name: "More ways to measure" }).click();
    await expect(total).toBeHidden();

    // No height: the price says it assumed one, and what the customer can do.
    const more = pat.getByRole("button", { name: "One more: How many steps go up to the door?" });
    for (let i = 0; i < 3; i += 1) await more.click();
    await expect(amount(pat)).toHaveText("$6,473 – $7,146");
    await expect(explanation(pat)).toContainText("3 steps × 7–8 in each (estimated) = 21–24 in rise");
    await expect(explanation(pat)).toContainText("ADA 1:12 slope (1 ft of ramp per inch of rise) → 21–24 ft of ramp");
    await expect(pat.getByText("Based on an estimated step height of 7–8 in. Measure one step and enter it for a tighter estimate.")).toBeVisible();
    await expect(pat.getByText("Why a range? Step height 7–8 in (estimated)")).toBeVisible();

    // A measured height collapses the range to one price.
    await height(pat).fill("7.5");
    await expect(amount(pat)).toHaveText("$6,921");
    await expect(explanation(pat)).toContainText("3 steps × 7.5 in = 22.5 in rise");
    await expect(pat.locator("[data-aiew-assumption]")).toHaveCount(0);
    await expect(pat.locator("[data-aiew-why]")).toHaveCount(0);
    // Typing the measurement never calls the model.
    expect(server.modelCalls).toHaveLength(0);

    // Start again from the photo: the fields empty, the photo fills the count.
    await height(pat).fill("");
    await steps(pat).fill("");
    await expect(pat.getByText("Answer the questions above to see your price.")).toBeVisible();
    const takeoff = pat.waitForRequest((r) => r.url().endsWith("/api/estimator/v1/takeoff"));
    await pat.locator('input[type="file"]').setInputFiles({ name: "porch.png", mimeType: "image/png", buffer: stepsPng() });
    // THE BROWSER SHRANK IT: the request carried a JPEG no larger than 768 px.
    const sent = (await takeoff).postDataJSON() as { imageBase64: string; mediaType: string };
    expect(sent.mediaType).toBe("image/jpeg");
    expect(jpegSize(Buffer.from(sent.imageBase64, "base64"))).toEqual({ width: 768, height: 576 });

    // The photo is SHOWN, with what the AI saw beside it — its words are the
    // package's sentences from the model's observation, not the model's. The
    // preview is a data: image, so a strict CSP host shows it too (RL-05).
    const thumb = pat.locator("img.aiew-thumb");
    await expect(thumb).toBeVisible();
    expect(await thumb.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    expect(await thumb.getAttribute("src")).toMatch(/^data:image\/jpeg;base64,/);
    const card = pat.locator("[data-aiew-reading-card]");
    await expect(card).toContainText("What we see in your photo");
    await expect(card).toContainText("We counted 4 steps up, including the last one onto the porch or landing.");
    await expect(card).toContainText("Each step looks about 7.5–8.5 in tall.");
    await expect(card).toContainText("You can change the count if it's wrong.");
    await expect(pat.locator(".aiew-root")).not.toContainText(/\bbelow\b/i);
    await expect(card.locator("[data-aiew-confidence]")).toHaveAttribute("data-aiew-confidence", "medium");
    expect(server.modelCalls).toHaveLength(1);
    // A few short lines, a small answer.
    expect(server.modelCalls[0]!.maxTokens).toBe(150);
    expect(server.modelCalls[0]!.prompt.split("\n").length).toBeLessThanOrEqual(12);

    // The count is filled in, in the same stepper, for the customer to check.
    await expect(steps(pat)).toHaveValue("4");
    await expect(pat.getByText("From your photo", { exact: true })).toBeVisible();
    // THE CODE DID THE ARITHMETIC, and says how. The photo's 7.5–8.5 in is kept
    // inside the owner's own 7–8 in (EST-R10).
    await expect(amount(pat)).toHaveText("$8,610 – $9,955");
    await expect(explanation(pat)).toContainText("4 steps × 7.5–8 in each (from your photo) = 30–32 in rise");
    await expect(explanation(pat)).toContainText("ADA 1:12 slope (1 ft of ramp per inch of rise) → 30–32 ft of ramp");
    await expect(pat.getByText("Why a range? Step height 7.5–8 in (from the photo)")).toBeVisible();

    // "Change the count" goes to the count — which is ABOVE the photo, so no
    // sentence anywhere says "below" (EST-R07).
    await card.getByRole("button", { name: "Change the count" }).click();
    await expect(steps(pat)).toBeFocused();

    // Pat counts again: two steps and the porch, THREE up — the AI counted one
    // too many. Lowering the photo's count asks the one question that catches
    // the opposite mistake (EST-R04); Pat's 3 includes the porch, so it stays.
    await pat.getByRole("button", { name: "One fewer: How many steps go up to the door?" }).click();
    await expect(steps(pat)).toHaveValue("3");
    await expect(pat.locator('[data-aiew-check="steps"]')).toHaveText("Did you count the step up onto the porch or landing? 2 steps and the porch is 3.");
    await expect(pat.getByText("From your photo", { exact: true })).toHaveCount(0);
    await expect(explanation(pat)).toContainText("3 steps × 7.5–8 in each (from your photo) = 22.5–24 in rise");
    await expect(explanation(pat)).toContainText("→ 23–24 ft of ramp");
    await expect(amount(pat)).toHaveText("$6,921 – $7,146");

    // A measured height still collapses it, photo or not.
    await height(pat).fill("7.5");
    await expect(amount(pat)).toHaveText("$6,921");
    await height(pat).fill("");
    await expect(amount(pat)).toHaveText("$6,921 – $7,146");
    const corrected = dollars((await amount(pat).textContent()) ?? "");
    expect(corrected).toEqual([6_921, 7_146]);
    // Still one reading: the same photo is never read twice, and the count is
    // never sent back to the model.
    expect(server.modelCalls).toHaveLength(1);
    expect(server.aiUsage).toEqual([
      { tenantId: TENANT, operation: "estimator_takeoff", model: "claude-haiku-4-5", inputTokens: 830, outputTokens: 38, costMicros: 1_020, outcome: "read" },
    ]);

    // Their details, and the estimate is saved — the photo with it.
    await pat.getByLabel("Your name").fill(PAT.name);
    await pat.getByLabel("Email").fill(PAT.email);
    await pat.getByLabel("Phone").fill(PAT.phone);
    await pat.getByLabel("Address of the job").fill(PAT.address);
    await pat.getByRole("button", { name: "Send me this estimate" }).click();
    const done = pat.locator("[data-aiew-done]");
    await expect(done).toContainText(/Thanks, Pat\. Your estimate EST-2026-\d{4} is saved\./, { timeout: 15_000 });
    await expect(done).toContainText("We've emailed you a copy.");
    await expect(done).toContainText(`$${corrected[0]!.toLocaleString("en-US")} – $${corrected[1]!.toLocaleString("en-US")}`);
    const [row] = await server.query<{ id: string; estimate_number: string }>(
      "select id, estimate_number from estimator_estimates where customer_email = $1",
      [PAT.email],
    );
    state.pat = row!.id;
    state.patNumber = row!.estimate_number;
    await expect(pat.getByRole("link", { name: "Book a visit to measure" })).toHaveAttribute("href", `/book-visit?estimate=${state.pat}`);
    expect(await pat.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });

  // -------------------------------------------------------------------------
  await test.step("3. saved WITH the photo, the AI's reading and Pat's correction; the office gets the lead, Pat a copy", async () => {
    const [estimate] = await server.query<{ source: string; range_low: number; range_high: number; status: string }>(
      "select source, range_low, range_high, status from estimator_estimates where id = $1",
      [state.pat],
    );
    expect(estimate).toMatchObject({ source: "photo", status: "draft" });
    const [line] = await server.query<{ inputs: any; takeoff_id: string; corrections: any; recipe: string; derived: any }>(
      "select inputs, takeoff_id, corrections, recipe, derived from estimator_estimate_items where estimate_id = $1",
      [state.pat],
    );
    expect(line).toMatchObject({ recipe: "ramp_over_steps", inputs: { steps: 3 } });
    expect(line!.corrections).toEqual([{ field: "steps", label: "Steps", from: 4, to: 3 }]);
    expect(line!.derived.explanation[0]).toBe("3 steps × 7.5–8 in each (from your photo) = 22.5–24 in rise");
    const [reading] = await server.query<{ status: string; model: string; confidence: string; observation: any }>(
      "select status, model, confidence, observation from estimator_takeoffs where id = $1",
      [line!.takeoff_id],
    );
    // What is kept of the model's answer is the observation (tagged with the
    // recipe it was read for): what it saw — no measurement, no price.
    expect(reading).toMatchObject({ status: "read", model: "claude-haiku-4-5", confidence: "medium" });
    expect(reading!.observation).toMatchObject({ seen: true, risers: 4, riserHeightIn: { low: 7.5, high: 8.5 }, confidence: "medium" });
    expect(Object.keys(reading!.observation).filter((key) => key !== "recipe").sort()).toEqual(["confidence", "riserHeightIn", "risers", "seen"]);
    const photos = await server.query<{ file_id: string; width: number; height: number }>(
      "select file_id, width, height from estimator_photos where estimate_id = $1",
      [state.pat],
    );
    expect(photos).toEqual([{ file_id: expect.any(String), width: 768, height: 576 }]);
    // Kept through the storage package, as the generated photo store keeps it.
    const [file] = await server.query<{ kind: string; content_type: string; url: string }>(
      "select kind, content_type, url from stored_files where id = $1",
      [photos[0]!.file_id],
    );
    expect(file).toMatchObject({ kind: "estimator.photo", content_type: "image/jpeg" });
    expect((await fetch(file!.url)).status).toBe(200);

    const mail = await expectMail(2);
    const lead = mailTo(mail, OFFICE);
    expect(lead.subject).toBe(`New lead: Pat Lee, $6,921 – $7,146 (${state.patNumber})`);
    expect(lead.body).toContain("From the photo: We counted 4 steps up, including the last one onto the porch or landing. Each step looks about 7.5–8.5 in tall.");
    expect(lead.body).toContain("(medium confidence)");
    expect(lead.body).toContain("The customer changed: steps 4 → 3.");
    // The email has no attachment: it says where the photo is (EST-R14).
    expect(lead.body).toContain("1 photo: see it on the estimate.");
    expect(lead.body).toContain(`Open it: ${server.origin}/admin/estimates/${state.pat}`);
    expect(lead.body).toContain("Phone: 801-555-0199");
    expect(lead.body).not.toMatch(/cost|margin/i);
    const copy = mailTo(mail, PAT.email);
    expect(copy.subject).toBe(`Your estimate from Summit Ramps (${state.patNumber})`);
    // An email has nowhere to type a height: it asks for a reply (EST-R14).
    expect(copy.body).toContain(
      "Based on a step height of about 7.5–8 in, from your photo. Reply with the height of one step (from the top of one step to the top of the next) for a tighter price.",
    );
    expect(copy.body).toContain("Questions? Call (801) 555-0143 or email hello@summit.test.");
  });

  // -------------------------------------------------------------------------
  await test.step("4. the office reads the lead — photo, AI reading, correction — edits it and sends the quote", async () => {
    const office = await open({ viewport: DESK, staff: "office" });
    await office.goto(`${server.origin}/admin/estimates`);
    const row = office.locator(`[data-aiew-row="${state.pat}"]`);
    await expect(row).toContainText("Pat Lee");
    await expect(row).toContainText("AI read");
    await expect(row).toContainText("New lead");
    await row.click();
    await expect(office).toHaveURL(`${server.origin}/admin/estimates/${state.pat}`);

    // The photo, as the customer sent it.
    const photo = office.locator(`[data-aiew-photo] img`).first();
    await expect(photo).toBeVisible();
    expect(await photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(768);
    // What the AI saw, beside what Pat settled on, and the working.
    const readingBox = office.locator("[data-aiew-line-reading]");
    await expect(readingBox).toContainText("From the photo");
    await expect(readingBox).toContainText("We counted 4 steps up, including the last one onto the porch or landing.");
    // Staff get the reading, not the customer's instructions (EST-R11).
    await expect(readingBox).not.toContainText("You can change the count");
    await expect(readingBox).toContainText("medium confidence");
    const star = (await readingBox.locator("svg").first().boundingBox())!;
    expect(star.width).toBeLessThanOrEqual(20);
    await expect(readingBox.locator("[data-aiew-corrections]")).toContainText("The customer changed: steps 4 → 3");
    const line = office.locator("[data-aiew-line]").first();
    await expect(line).toContainText("3 steps × 7.5–8 in each (from your photo) = 22.5–24 in rise");
    await expect(line.locator("[data-aiew-shown]")).toContainText("Customer was shown $6,921.46 – $7,145.88");
    // Office staff see prices, never costs.
    await expect(office.locator("[data-aiew-line-cost]")).toHaveCount(0);

    // Before anything is sent, the office is told what the unmeasured line is
    // priced at, in dollars (EST-R05).
    await office.getByRole("button", { name: "Send quote" }).click();
    const early = office.getByRole("dialog", { name: "Send the quote" });
    await expect(early.locator('[data-aiew-notice="send-warnings"]')).toContainText("Line 1 (Modular aluminum ramp) is priced at 3 steps");
    await expect(early.locator('[data-aiew-notice="send-warnings"]')).toContainText("measure first, or send it as is.");
    await early.getByRole("button", { name: "Cancel" }).click();

    // The crew measured: 7.25 in a step. Re-priced from the price book.
    const before = await line.locator("[data-aiew-line-total]").textContent();
    await line.getByLabel("Height of one step (optional)", { exact: true }).fill("7.25");
    await line.getByLabel("Height of one step (optional)", { exact: true }).press("Tab");
    await expect(line).toContainText("3 steps × 7.25 in = 21.75 in rise");
    await expect(line.locator("[data-aiew-line-total]")).not.toHaveText(before ?? "");
    // The correction is still Pat's.
    await expect(readingBox.locator("[data-aiew-corrections]")).toContainText("steps 4 → 3");

    // A line of their own.
    await office.getByRole("button", { name: "A line of my own" }).click();
    const own = office.locator('[data-aiew-add-line="own"]');
    await own.getByLabel("Description").fill("Remove old wooden steps");
    await own.getByLabel("Price each ($)").fill("150");
    await own.getByRole("button", { name: "Add line" }).click();
    await expect(office.locator("[data-aiew-line]")).toHaveCount(2);

    // The totals were worked out again by the server, tax included.
    const detail = (await adminApi("office", "GET", `estimates/${state.pat}`)).body.estimate;
    const lines = detail.lines as Array<{ description: string; total: number }>;
    expect(lines.map((l) => l.description)).toEqual(["Modular aluminum ramp", "Remove old wooden steps"]);
    expect(lines[1]!.total).toBe(15_000);
    expect(detail.subtotal).toBe(lines[0]!.total + lines[1]!.total);
    expect(detail.taxRateBp).toBe(725);
    expect(detail.total).toBe(detail.subtotal - detail.discount + detail.taxAmount);
    state.patTotal = detail.total;

    // Send the quote.
    await office.getByRole("button", { name: "Send quote" }).click();
    const send = office.getByRole("dialog", { name: "Send the quote" });
    await expect(send).toContainText("2 lines");
    // Measured now: nothing left to warn about.
    await expect(send.locator('[data-aiew-notice="send-warnings"]')).toHaveCount(0);
    await send.getByRole("button", { name: `Send to ${PAT.email}` }).click();
    await expect(office.getByText(`Quote sent to ${PAT.email}.`)).toBeVisible();
    await expect(office.locator("[data-aiew-status-tag]")).toHaveText("Sent");

    const mail = await expectMail(1);
    expect(addressed(mail)).toEqual([[PAT.email, `Your quote from Summit Ramps (${state.patNumber})`]]);
    expect(mail[0]!.body).toContain("Good until: December 2, 2026");
    expect(mail[0]!.body).toMatch(/Total: \$[\d,]+\.\d{2}, including \$[\d,]+\.\d{2} sales tax/);
    state.patLink = quoteLinkIn(mail[0]!.body);
    // The delivery log keeps the email, never the key to the quote.
    const logged = await server.query<{ body: string }>("select body from comms_messages where template_key = 'quote_sent'");
    expect(logged[0]!.body).toContain("/quote/:token");
    expect(logged.some((r) => r.body.includes(state.patLink))).toBe(false);
    // The follow-up is queued for the comms cron's run three days on.
    const queued = await server.query<{ status: string; send_at: Date }>(
      "select status, send_at from comms_scheduled where ref_id = $1",
      [state.pat],
    );
    expect(queued.map((q) => [q.status, new Date(q.send_at).toISOString()])).toEqual([["pending", "2026-11-05T14:00:00.000Z"]]);

    // Another customer, priced by the office on the phone, sent a quote good
    // for five days — and never answers.
    const sam = await adminApi("office", "POST", "estimates", {
      customerName: SAM.name,
      customerEmail: SAM.email,
      items: [{ productId: state.ramp, inputs: { steps: 2, stepHeightIn: 7 } }],
    });
    expect(sam.status).toBe(201);
    state.sam = sam.body.estimate.id;
    state.samNumber = sam.body.estimate.number;
    expect((await adminApi("office", "POST", `estimates/${state.sam}/send`, { validDays: 5 })).status).toBe(200);
    expect(addressed(await expectMail(1))).toEqual([[SAM.email, `Your quote from Summit Ramps (${state.samNumber})`]]);
  });

  // -------------------------------------------------------------------------
  await test.step("5. Pat accepts from the emailed link; the office hears; the follow-up is withdrawn", async () => {
    server.setClock(new Date("2026-11-03T16:00:00Z")); // Tue 09:00 MST
    const pat = await open({ viewport: PHONE });
    await pat.goto(state.patLink);
    await expect(pat.getByText(`Quote ${state.patNumber}`)).toBeVisible();
    await expect(pat.locator(".aiew-root")).toContainText("Summit Ramps");
    await expect(pat.locator(".aiew-root")).toContainText("Modular aluminum ramp");
    await expect(pat.locator(".aiew-root")).toContainText("Remove old wooden steps");
    await expect(pat.getByText("Good until December 2, 2026.")).toBeVisible();
    const total = `$${(state.patTotal / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    await expect(pat.locator(".aiew-root")).toContainText(total);
    const [viewed] = await server.query<{ status: string }>("select status from estimator_estimates where id = $1", [state.pat]);
    expect(viewed!.status).toBe("viewed");
    // The line says what it is priced at (EST-R05).
    await expect(pat.locator(".aiew-root")).toContainText("3 steps, 7.25 in each, 22 ft of ramp");
    // An answer names the version it saw: one for any other is refused, and
    // binds Pat to nothing (ADV-2).
    const token = state.patLink.split("/quote/")[1]!;
    const stale = await fetch(`${server.origin}/api/estimator/v1/quote/${token}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: server.origin, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ version: 99, name: "Pat Lee" }),
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe("quote_changed");

    await pat.getByRole("button", { name: "Accept this quote" }).click();
    await expect(pat.getByRole("heading", { name: `Accept this quote for ${total}?` })).toBeVisible();
    await pat.getByLabel(/A note for the business/).fill("Mornings are best");
    const accepted = pat.waitForRequest((r) => r.url().endsWith("/accept"));
    await pat.getByRole("button", { name: "Yes, accept the quote" }).click();
    expect((await accepted).postDataJSON()).toMatchObject({ version: 1 });
    await expect(pat.getByText("You accepted this quote on November 3, 2026. Thank you!")).toBeVisible();
    await expect(pat.getByRole("link", { name: "Pick a time for the work" })).toHaveAttribute("href", `/book-visit?estimate=${state.pat}`);

    const mail = await expectMail(2);
    const notice = mailTo(mail, OFFICE);
    expect(notice.subject).toBe(`Quote accepted: Pat Lee, ${state.patNumber}`);
    expect(notice.body).toContain('Their note: "Mornings are best"');
    const thanks = mailTo(mail, PAT.email);
    expect(thanks.subject).toBe(`Thanks, you've accepted quote ${state.patNumber}`);
    expect(thanks.body).toContain(`Pick a time for the work here: ${server.origin}/book-visit?estimate=${state.pat}`);
    // The follow-up is withdrawn the moment Pat answered.
    const queued = await server.query<{ status: string }>("select status from comms_scheduled where ref_id = $1", [state.pat]);
    expect(queued.map((q) => q.status)).toEqual(["cancelled"]);
  });

  // -------------------------------------------------------------------------
  await test.step("6. the accepted quote books the visit and becomes an invoice, one click each", async () => {
    server.setClock(new Date("2026-11-03T17:00:00Z")); // Tue 10:00 MST
    // Pat follows "Pick a time for the work" to the booking page.
    const pat = await open({ viewport: PHONE });
    await pat.goto(state.patLink);
    await pat.getByRole("link", { name: "Pick a time for the work" }).click();
    await expect(pat).toHaveURL(`${server.origin}/book-visit?estimate=${state.pat}`);
    await expect(pat.getByText(/Times are/)).toContainText("Mountain Time");
    await pat.locator('.aisw-day[data-date="2026-11-09"]').click();
    await pat.getByRole("button", { name: /^9:00 AM to 11:00 AM/ }).click();
    await pat.getByLabel("Your name").fill(PAT.name);
    await pat.getByLabel("Email").fill(PAT.email);
    await pat.getByLabel("Address for the visit").fill(PAT.address);
    await pat.getByRole("button", { name: "Request this visit" }).click();
    await expect(pat.getByRole("heading", { name: "Request received" })).toBeVisible({ timeout: 15_000 });
    const visits = await server.query<{ estimate_id: string; status: string }>("select estimate_id, status from scheduling_bookings");
    expect(visits).toEqual([{ estimate_id: state.pat, status: "pending" }]);

    // The office sees the visit on the estimate, and makes the invoice.
    const office = await open({ viewport: DESK, staff: "office" });
    await office.goto(`${server.origin}/admin/estimates/${state.pat}`);
    await expect(office.locator("[data-aiew-status-tag]")).toHaveText("Accepted");
    await expect(office.locator('[data-action="book_visit"]')).toHaveAttribute("href", `${server.origin}/book-visit?estimate=${state.pat}`);
    const visit = office.getByRole("link", { name: "Mon, Nov 9, 9:00 AM MST" });
    await expect(visit).toHaveAttribute("href", `${server.origin}/admin/schedule?date=2026-11-09`);
    await expect(office.getByText("(requested)")).toBeVisible();
    await expect(office.locator(".aiew-root")).toContainText('Pat Lee wrote: “Mornings are best”');

    await office.getByRole("button", { name: "Make an invoice" }).click();
    await office.getByRole("dialog", { name: "Make an invoice from this quote?" }).getByRole("button", { name: "Make the invoice" }).click();
    await expect(office.getByText(/Invoice INV-2026-\d{4} made\./)).toBeVisible();
    await expect(office.locator("[data-aiew-invoice]")).toContainText(/Invoice: INV-2026-\d{4} \(draft\)/);
    await expect(office.locator("[data-aiew-status-tag]")).toHaveText("Invoiced");

    const invoices = await server.query<{ estimate_id: string; total: number; tax_rate_bp: number; status: string }>(
      "select estimate_id, total, tax_rate_bp, status from invoices",
    );
    // Billed exactly what Pat accepted, tax and all.
    expect(invoices).toEqual([{ estimate_id: state.pat, total: state.patTotal, tax_rate_bp: 725, status: "draft" }]);
    const [estimate] = await server.query<{ status: string }>("select status from estimator_estimates where id = $1", [state.pat]);
    expect(estimate!.status).toBe("converted");
    expect(server.events.filter((e) => e.estimateId === state.pat).at(-1)?.type).toBe("estimate.converted");
    // Once: a second click is refused, and no second invoice exists.
    const again = await adminApi("office", "POST", `estimates/${state.pat}/convert`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("transition_not_allowed");
    expect(await server.query("select id from invoices")).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  await test.step("5. (no answer) Pat's withdrawn follow-up stays unsent; Sam gets his on its day, with a working link; then his quote lapses", async () => {
    // The comms cron, Thursday at its vercel.json hour: Pat's follow-up was
    // due on this run too, and is not sent — Pat answered.
    server.setClock(new Date("2026-11-05T14:00:30Z"));
    const run = await server.runCommsCron();
    expect(run.sent).toBe(1);
    const mail = await expectMail(1);
    expect(addressed(mail)).toEqual([[SAM.email, `Following up on your quote ${state.samNumber}`]]);
    expect(mail[0]!.body).toContain("Just checking in on the quote we sent on November 2, 2026");
    const samLink = quoteLinkIn(mail[0]!.body);
    const sam = await open({ viewport: PHONE });
    await sam.goto(samLink);
    await expect(sam.getByRole("button", { name: "Accept this quote" })).toBeVisible();
    // Minted at send time, scrubbed from the log after.
    const logged = await server.query<{ body: string }>("select body from comms_messages where template_key = 'quote_follow_up'");
    expect(logged[0]!.body).not.toContain(samLink);

    // Valid five days (to Saturday): the estimator cron on Sunday marks it
    // expired, and both sides are told.
    server.setClock(new Date("2026-11-08T13:30:30Z"));
    expect(await server.runEstimatorCron()).toEqual({ expired: 1, announced: 1, photosDeleted: 0 });
    const lapsed = await expectMail(2);
    expect(mailTo(lapsed, SAM.email).subject).toBe(`Your quote ${state.samNumber} has expired`);
    expect(mailTo(lapsed, OFFICE).subject).toBe(`Quote expired: Sam Ortiz, ${state.samNumber}`);
    await sam.reload();
    await expect(sam.getByRole("button", { name: "Accept this quote" })).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  await test.step("7. one photo reading in the whole scenario, nothing failed quietly, and no key kept in the log", async () => {
    expect(server.modelCalls).toHaveLength(1);
    expect(server.aiUsage).toHaveLength(1);
    const messages = await server.query<{ subject: string | null; body: string; status: string; missing_vars: string[] | null }>(
      "select subject, body, status, missing_vars from comms_messages",
    );
    expect(messages.length).toBe(server.outbox.length);
    for (const message of messages) {
      expect(message.status).toBe("sent");
      expect(message.missing_vars ?? []).toEqual([]);
      expect(`${message.subject ?? ""} ${message.body}`).not.toMatch(/quote\/[A-Za-z0-9_-]{43}/);
    }
    expect(server.failures).toEqual([]);
    for (const context of opened) await context.close();
  });
});
