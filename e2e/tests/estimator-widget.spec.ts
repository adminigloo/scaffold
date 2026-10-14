import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

/**
 * @adminigloo/estimator-widget in a real browser (estimator 0.3 contract,
 * 11.4), driven the way its people use it:
 *
 *   - a customer on a 390px phone counts the steps with the stepper, sees the
 *     live price and the "estimated step height" note, with no sideways scroll;
 *   - the same customer adds a REAL photo: the browser's canvas shrinks it
 *     (the request's JPEG is decoded here and its long edge must be ≤ 768 px),
 *     the reading appears beside the photo, the count is pre-filled, they
 *     correct it, and send the estimate;
 *   - the customer accepts a quote on its own page;
 *   - an owner loads the sample catalog and tests a quote in the price book;
 *   - the theme follows the HOST page (html.dark; an OS that's dark under a
 *     site that pins light), and the business's brand colour reaches the
 *     button;
 *   - axe finds nothing on the estimate tool, the quote page or the price book.
 *
 * SELF-CONTAINED, like scheduling-widget.spec.ts: the widget is bundled here,
 * in beforeAll, from the package's SOURCE with esbuild (react pinned to e2e's
 * single copy), and the estimator server is a fake answered with page.route
 * on a made-up origin. Development React under StrictMode, the shape of every
 * buyer's `next dev`.
 *
 * Run it: cd e2e && pnpm install && pnpm browsers && pnpm test
 */

const here = dirname(fileURLToPath(import.meta.url));
const e2eRoot = join(here, "..");
const widgetEntry = join(e2eRoot, "..", "packages", "estimator-widget", "src", "index.ts").replace(/\\/g, "/");
const adminEntry = join(e2eRoot, "..", "packages", "estimator-widget", "src", "admin", "index.ts").replace(/\\/g, "/");
const ORIGIN = "https://summitramps.test";

const HOST_APP = `
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { EstimateTool, QuoteView } from ${JSON.stringify(widgetEntry)};
import { PriceBook } from ${JSON.stringify(adminEntry)};

const cfg = window.__ew || {};
window.__submitted = [];

function App() {
  const props = cfg.props || {};
  if (cfg.mode === "quote") return <QuoteView baseUrl="/api/estimator" token="tok_1" bookHref="/book-visit" {...props} />;
  if (cfg.mode === "pricebook") return <PriceBook baseUrl="/api/admin/estimator" {...props} />;
  return <EstimateTool baseUrl="/api/estimator" bookHref="/book-visit" onSubmitted={(r) => window.__submitted.push(r)} {...props} />;
}

createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>);
`;

let bundle = "";

test.beforeAll(async () => {
  const result = await build({
    stdin: { contents: HOST_APP, resolveDir: e2eRoot, sourcefile: "estimator-host.tsx", loader: "tsx" },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2020",
    jsx: "automatic",
    alias: {
      react: join(e2eRoot, "node_modules", "react"),
      "react-dom": join(e2eRoot, "node_modules", "react-dom"),
    },
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    logLevel: "silent",
  });
  bundle = result.outputFiles[0]!.text;
});

test.use({ timezoneId: "America/New_York", locale: "en-US" });

// ---------------------------------------------------------------------------
// The fake estimator server: Summit Ramps (contract 0, 3.3, 4.5)
// ---------------------------------------------------------------------------

const RAMP_FIELDS = [
  { key: "steps", kind: "stepper", label: "How many steps go up to the door?", help: "Count every step up, including the last one onto the porch or landing.", required: true, min: 1, max: 20, presentation: "primary" },
  { key: "stepHeightIn", kind: "number", label: "Height of one step (optional)", help: "Measure from the top of one step to the top of the next.", required: false, min: 3, max: 12, step: 0.25, unit: "in", placeholder: "e.g. 7.5", presentation: "primary" },
  { key: "totalRiseIn", kind: "number", label: "Or the total height, ground to door threshold (optional)", help: "If you measured the whole height instead, enter it here.", required: false, min: 3, max: 360, step: 0.25, unit: "in", placeholder: null, presentation: "secondary" },
];

const CONFIG = {
  businessName: "Summit Ramps",
  contactEmail: "office@summit.test",
  contactPhone: "(801) 555-0143",
  currency: "USD",
  locale: "en-US",
  timeZone: "America/Denver",
  brandColor: null as string | null,
  instantEstimatesEnabled: true,
  photos: { attach: true, reading: true, maxEdgePx: 768, maxBytes: 600_000, jpegQuality: 0.8 },
  emailsEnabled: true,
  minFillMs: 1500,
  products: [
    {
      id: "p-ramp",
      name: "Modular aluminum ramp",
      category: "Ramps",
      description: "An ADA-sloped aluminum ramp with handrails both sides, a top landing, permit and delivery.",
      recipe: "ramp_over_steps",
      fields: RAMP_FIELDS,
      quantity: null,
      isEstimatable: true,
      photo: { reading: true, tip: "Stand to the side so every step shows." },
      options: [],
      measurementMode: "linear",
    },
  ],
};

/** The server's words for a ramp (3.3), by the steps and whether a photo was read — the widget shows them verbatim. */
function priceFor(inputs: Record<string, number>, takeoffId: string | null) {
  const steps = inputs.steps ?? 0;
  if (inputs.stepHeightIn) {
    return { low: 692_367, high: 692_367, single: true, currency: "USD", explanation: [`${steps} steps × ${inputs.stepHeightIn} in = 22.5 in rise`, "ADA 1:12 slope (1 ft of ramp per inch of rise) → 23 ft of ramp (rounded up to whole feet)"], assumption: null, resultPhrase: "That's about a 23-ft ramp.", reasons: [], taxNote: "Plus 7.25% sales tax." };
  }
  if (takeoffId) {
    return steps === 4
      ? { low: 860_265, high: 1_045_807, single: false, currency: "USD", explanation: ["4 steps × 7.5–8.5 in each (from your photo) = 30–34 in rise", "ADA 1:12 slope (1 ft of ramp per inch of rise) → 30–34 ft of ramp", "0–1 resting landings: ramps need one for every 30 in of rise"], assumption: "Based on a step height of about 7.5–8.5 in, from your photo. Measure one step and enter it for a tighter estimate.", resultPhrase: "That's about a 30–34 ft ramp.", reasons: ["Step height 7.5–8.5 in (from the photo)", "A resting landing may be needed (over 30 in of rise)"], taxNote: "Plus 7.25% sales tax." }
      : { low: 692_367, high: 764_323, single: false, currency: "USD", explanation: ["3 steps × 7.5–8.5 in each (from your photo) = 22.5–25.5 in rise", "ADA 1:12 slope (1 ft of ramp per inch of rise) → 23–26 ft of ramp (rounded up to whole feet)"], assumption: "Based on a step height of about 7.5–8.5 in, from your photo. Measure one step and enter it for a tighter estimate.", resultPhrase: "That's about a 23–26 ft ramp.", reasons: ["Step height 7.5–8.5 in (from the photo)"], taxNote: "Plus 7.25% sales tax." };
  }
  return { low: 644_396, high: 716_352, single: false, currency: "USD", explanation: [`${steps} steps × 7–8 in each (estimated) = 21–24 in rise`, "ADA 1:12 slope (1 ft of ramp per inch of rise) → 21–24 ft of ramp"], assumption: "Based on an estimated step height of 7–8 in. Measure one step and enter it for a tighter estimate.", resultPhrase: "That's about a 21–24 ft ramp.", reasons: ["Step height 7–8 in (estimated)"], taxNote: "Plus 7.25% sales tax." };
}

const READING = {
  takeoffId: "tk_porch",
  recipe: "ramp_over_steps",
  status: "read",
  confidence: "medium",
  seen: true,
  suggested: { steps: 3 },
  heightRangeIn: { low: 7.5, high: 8.5 },
  lowConfidence: false,
  usable: true,
  lines: ["We counted 3 steps up, including the last one onto the porch or landing.", "Each step looks about 7.5–8.5 in tall.", "You can change the count if it's wrong."],
  fewerCheck: "Did you count the step up onto the porch or landing? 2 steps and the porch is 3.",
};

function quote(extra: Record<string, unknown> = {}) {
  return {
    status: "open",
    estimateId: "est_1",
    number: "EST-0001",
    businessName: "Summit Ramps",
    contactEmail: "office@summit.test",
    contactPhone: "(801) 555-0143",
    brandColor: null,
    currency: "USD",
    locale: "en-US",
    timeZone: "America/Denver",
    customerName: "Pat Lee",
    jobAddress: "12 Elm St, Salt Lake City",
    message: "Thanks for having us out.",
    footer: "Price includes installation and haul-away.",
    sentAt: "2030-11-02T15:00:00.000Z",
    validUntil: "2030-12-02T15:00:00.000Z",
    respondedAt: null,
    responseName: null,
    lines: [
      { description: "Modular aluminum ramp", details: ["4 steps, 7.25 in each", "Surface: Standard grit"], quantity: 1, total: 836_280 },
      { description: "Remove old wooden steps", details: [], quantity: 1, total: 15_000 },
    ],
    subtotal: 851_280,
    discount: 0,
    taxRateBp: 725,
    taxAmount: 61_718,
    total: 912_998,
    canRespond: true,
    version: 1,
    ...extra,
  };
}

const ADMIN_RAMP = {
  id: "p-ramp",
  name: "Modular aluminum ramp",
  category: "Ramps",
  description: null,
  recipe: "ramp_over_steps",
  recipeInfo: { key: "ramp_over_steps", label: "Steps up to a door (ramp)", description: "Customers count the steps up to their door.", primaryKey: "rampFt", bases: [{ key: "rampFt", label: "per ft of ramp" }, { key: "landings", label: "per resting landing" }, { key: "item", label: "per item" }, { key: "job", label: "once per job" }], photoReading: true },
  recipeConfig: {},
  fields: RAMP_FIELDS,
  allowMultiple: false,
  multipleLabel: null,
  maxQuantity: 10,
  supplies: [{ assignmentId: "a1", supplyId: "s1", name: "Aluminum ramp section", unitType: "per_linear_ft", unitCost: 9500, quantityMilli: 1000, per: "rampFt", perLabel: "per ft of ramp", sortOrder: 0 }],
  labor: { hoursPerUnitMilli: 350, setupHoursMilli: 2000, rateCents: 6500, effectiveRateCents: 6500 },
  wasteBp: 500,
  pricingBasis: "markup",
  markupBp: 4000,
  marginBp: 0,
  minimumCharge: 150_000,
  rangeMode: "measured",
  contingencyBp: null,
  estimateLowBp: 9000,
  estimateHighBp: 11500,
  lumpCosts: { basePrice: 0, pricePerSqFt: null, pricePerLinearFt: null, laborCost: 0 },
  showInEstimator: true,
  isEstimatable: true,
  sortOrder: 0,
  isActive: true,
  options: [],
  createdAt: "2030-11-01T00:00:00.000Z",
  updatedAt: "2030-11-01T00:00:00.000Z",
};

interface Fake {
  config: typeof CONFIG;
  calculations: Array<Record<string, unknown>>;
  takeoffs: Array<Record<string, unknown>>;
  submits: Array<Record<string, unknown>>;
  quote: Record<string, unknown>;
  answers: Array<{ action: string; body: Record<string, unknown> }>;
  sampleLoaded: boolean;
  previews: Array<Record<string, unknown>>;
}

function makeFake(): Fake {
  return { config: structuredClone(CONFIG), calculations: [], takeoffs: [], submits: [], quote: quote(), answers: [], sampleLoaded: false, previews: [] };
}

interface Reply {
  status: number;
  contentType: string;
  body: string;
  headers?: Record<string, string>;
}

const json = (status: number, body: unknown): Reply => ({ status, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(body) });
const refuse = (status: number, code: string, message = code) => json(status, { error: { code, message } });

const SHELL =
  '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>' +
  '<body style="margin:0;padding:16px;font-family:system-ui"><div id="root"></div></body></html>';

function respond(fake: Fake, url: URL, body: Record<string, unknown>): Reply {
  const path = url.pathname;
  if (path.startsWith("/api/admin/estimator/v1/admin/")) return respondAdmin(fake, path.slice("/api/admin/estimator/v1/admin".length), body);
  if (!path.startsWith("/api/estimator/")) return { status: 200, contentType: "text/html", body: SHELL };
  const api = path.slice("/api/estimator".length);
  if (api === "/v1/config") return json(200, fake.config);
  if (api === "/v1/calculate") {
    fake.calculations.push(body);
    const inputs = (body.inputs ?? {}) as Record<string, number>;
    if (!inputs.steps && !inputs.totalRiseIn) return json(200, { status: "needs_inputs", missing: ["steps"], price: null, result: null });
    return json(200, { status: "priced", missing: [], price: priceFor(inputs, (body.takeoffId as string | null) ?? null), result: null });
  }
  if (api === "/v1/takeoff") {
    fake.takeoffs.push(body);
    return json(200, { status: "read", reading: READING, photoId: "ph_1", message: null, cached: false, available: true, result: null });
  }
  if (api === "/v1/photo") return json(201, { photoId: "ph_2" });
  if (api === "/v1/submit") {
    fake.submits.push(body);
    return json(201, { estimateId: "est_1", estimateNumber: "EST-0001", range: { low: 860_265, high: 1_045_807, single: false }, currency: "USD", emailed: true, id: "est_1", subtotal: 997_836, taxAmount: 72_343, total: 1_070_179 });
  }
  const q = api.match(/^\/v1\/quote\/([^/]+)(\/accept|\/decline)?$/);
  if (q) {
    if (q[1] !== "tok_1") return refuse(404, "not_found");
    if (!q[2]) return json(200, { quote: fake.quote });
    fake.answers.push({ action: q[2], body });
    fake.quote = { ...fake.quote, status: q[2] === "/accept" ? "accepted" : "declined", canRespond: false, respondedAt: "2030-11-03T16:00:00.000Z", responseName: body.name ?? null };
    return json(200, { quote: fake.quote });
  }
  return refuse(404, "not_found");
}

function respondAdmin(fake: Fake, api: string, body: Record<string, unknown>): Reply {
  if (api === "/status") {
    return json(200, {
      settingsSaved: true,
      products: { active: fake.sampleLoaded ? 5 : 0, public: fake.sampleLoaded ? 4 : 0 },
      keys: { active: 0, withoutOrigins: 0 },
      delivery: { emails: true, followUps: true, note: null },
      photos: { attach: true, reading: true },
      spend: null,
      embedBaseUrl: `${ORIGIN}/api/estimator`,
      notices: fake.sampleLoaded ? [] : [{ code: "no_products", message: "Add a product, or load the sample catalog, before you share your estimator." }],
    });
  }
  if (api === "/settings") return json(200, { settings: { businessName: "Summit Ramps", contactEmail: null, contactPhone: null, leadNotifyEmails: [], currency: "USD", locale: "en-US", timeZone: "America/Denver", taxRateBp: 725, quoteValidDays: 30, followUpDays: 3, quoteFooter: null, defaultLaborRateCents: 6500, contingencyBp: 0, instantEstimatesEnabled: true, photosEnabled: true, aiDailyBudgetCents: 100, aiPerRequesterDaily: 5, brandColor: null, sampleLoadedAt: null, saved: true, updatedAt: null } });
  if (api === "/products") return json(200, { products: fake.sampleLoaded ? [ADMIN_RAMP] : [] });
  if (api === "/supplies") return json(200, { supplies: [] });
  if (api === "/sample-catalog") {
    fake.sampleLoaded = true;
    return json(200, { products: 5, supplies: 10 });
  }
  if (api === "/products/preview") {
    fake.previews.push(body);
    const inputs = (body.inputs ?? {}) as Record<string, number>;
    if (!inputs.steps) return json(200, { fields: RAMP_FIELDS, status: "needs_inputs", missing: ["steps"], customerView: null, breakdown: null });
    return json(200, {
      fields: RAMP_FIELDS,
      status: "priced",
      missing: [],
      customerView: priceFor(inputs, null),
      breakdown: { low: 644_396, point: 644_396, high: 716_352, cost: 460_283, marginBp: 2857, minimumApplied: false, lines: [{ kind: "supply", label: "Aluminum ramp section", quantity: 21, unit: "ft", unitCost: 9500, amount: 199_500 }] },
    });
  }
  return refuse(404, "not_found");
}

type Mode = "tool" | "quote" | "pricebook";

async function mount(page: Page, fake: Fake, mode: Mode, props: Record<string, unknown> = {}, beforeBundle?: (page: Page) => Promise<void>) {
  await page.route(`${ORIGIN}/**`, (route) => {
    const request = route.request();
    const body = request.method() === "POST" ? ((request.postDataJSON() as Record<string, unknown>) ?? {}) : {};
    return route.fulfill(respond(fake, new URL(request.url()), body));
  });
  await page.goto(`${ORIGIN}/`);
  if (beforeBundle) await beforeBundle(page);
  await page.evaluate((cfg) => {
    (window as unknown as { __ew: unknown }).__ew = cfg;
  }, { mode, props });
  await page.addScriptTag({ content: bundle });
}

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

// ---------------------------------------------------------------------------
// A real photo: a 1600 × 1200 PNG, made here, no fixture file
// ---------------------------------------------------------------------------

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

/** A side view of three steps, drawn as grey blocks on white: big enough that the browser must shrink it. */
function stepsPng(width = 1600, height = 1200): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3, 0xff);
    row[0] = 0;
    for (let x = 0; x < width; x += 1) {
      const step = Math.floor((x / width) * 3);
      const top = height - (step + 1) * (height / 4);
      if (y > top) row.fill(0x77, 1 + x * 3, 4 + x * 3);
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

/** A JPEG's size from its first SOF marker (what the server's inspectImage reads too). */
function jpegSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes[0]).toBe(0xff);
  expect(bytes[1]).toBe(0xd8);
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) throw new Error("not a marker");
    const marker = bytes[i + 1]!;
    const length = bytes.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  throw new Error("no SOF");
}

// ---------------------------------------------------------------------------
// The customer, on a phone
// ---------------------------------------------------------------------------

test.describe("a customer at 390px", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("counts the steps and sees the price, with the assumed step height said plainly", async ({ page }) => {
    const fake = makeFake();
    await mount(page, fake, "tool");
    await expect(page.getByLabel("How many steps go up to the door?", { exact: true })).toHaveValue("");
    await expect(page.getByText("Answer the questions above to see your price.")).toBeVisible();
    await noSidewaysScroll(page);
    const more = page.getByRole("button", { name: "One more: How many steps go up to the door?" });
    await more.click();
    await more.click();
    await more.click();
    await expect(page.getByText("$6,444 – $7,164")).toBeVisible();
    expect(fake.calculations.at(-1)).toMatchObject({ productId: "p-ramp", inputs: { steps: 3 } });
    await expect(page.getByText("Based on an estimated step height of 7–8 in. Measure one step and enter it for a tighter estimate.")).toBeVisible();
    await expect(page.getByText("Why a range? Step height 7–8 in (estimated)")).toBeVisible();
    await expect(page.locator(".aiew-root")).not.toContainText("length of run");
    await page.getByLabel("Height of one step (optional)").fill("7.5");
    await expect(page.getByText("$6,924")).toBeVisible();
    await noSidewaysScroll(page);
  });

  test("a real photo is shrunk in the browser, read, pre-fills the count; they correct it and send the estimate", async ({ page }) => {
    const fake = makeFake();
    await mount(page, fake, "tool");
    await page.locator('input[type="file"]').setInputFiles({ name: "porch.png", mimeType: "image/png", buffer: stepsPng() });
    await expect(page.getByText("We counted 3 steps up, including the last one onto the porch or landing.")).toBeVisible();
    // The request carried a JPEG no larger than 768 px on the long edge.
    const sent = fake.takeoffs[0]!;
    expect(sent.mediaType).toBe("image/jpeg");
    const size = jpegSize(Buffer.from(String(sent.imageBase64), "base64"));
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(768);
    expect(size).toEqual({ width: 768, height: 576 });
    // The photo is shown, the reading beside it, and the count is in the stepper.
    await expect(page.locator("img.aiew-thumb")).toBeVisible();
    await expect(page.getByLabel("How many steps go up to the door?", { exact: true })).toHaveValue("3");
    await expect(page.getByText("From your photo", { exact: true })).toBeVisible();
    await expect(page.getByText("$6,924 – $7,643")).toBeVisible();
    // The customer counts again: there are four.
    await page.getByRole("button", { name: "One more: How many steps go up to the door?" }).click();
    await expect(page.getByText("From your photo", { exact: true })).toHaveCount(0);
    await expect(page.getByText("$8,603 – $10,458")).toBeVisible();
    expect(fake.calculations.at(-1)).toMatchObject({ inputs: { steps: 4 }, takeoffId: "tk_porch" });
    await page.getByLabel("Your name").fill("Pat Lee");
    await page.getByLabel("Email").fill("pat@example.com");
    await page.getByRole("button", { name: "Send me this estimate" }).click();
    await expect(page.getByText("Thanks, Pat. Your estimate EST-0001 is saved.")).toBeVisible();
    expect(fake.submits[0]).toMatchObject({ items: [{ productId: "p-ramp", inputs: { steps: 4 }, takeoffId: "tk_porch" }], photoIds: ["ph_1"] });
    expect(Number(fake.submits[0]!.fillMs)).toBeGreaterThanOrEqual(1500);
    await expect(page.getByRole("link", { name: "Book a visit to measure" })).toHaveAttribute("href", "/book-visit?estimate=est_1");
    await noSidewaysScroll(page);
  });

  test("accepts the quote on its own page", async ({ page }) => {
    const fake = makeFake();
    await mount(page, fake, "quote");
    await expect(page.getByText("Good until December 2, 2030.")).toBeVisible();
    await page.getByRole("button", { name: "Accept this quote" }).click();
    await expect(page.getByRole("heading", { name: "Accept this quote for $9,129.98?" })).toBeFocused();
    await page.getByLabel(/A note for the business/).fill("Mornings are best");
    await page.getByRole("button", { name: "Yes, accept the quote" }).click();
    await expect(page.getByText(/You accepted this quote on November 3, 2030/)).toBeVisible();
    expect(fake.answers).toEqual([{ action: "/accept", body: { version: 1, name: "Pat Lee", note: "Mornings are best" } }]);
    await expect(page.getByRole("link", { name: "Pick a time for the work" })).toHaveAttribute("href", "/book-visit?estimate=est_1");
    await noSidewaysScroll(page);
  });
});

// ---------------------------------------------------------------------------
// The owner
// ---------------------------------------------------------------------------

test.describe("the price book", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("loads the sample on purpose, then tests a quote with the cost breakdown", async ({ page }) => {
    const fake = makeFake();
    await mount(page, fake, "pricebook");
    await expect(page.getByText("No products yet.")).toBeVisible();
    await page.getByRole("button", { name: "Load a sample catalog" }).click();
    const dialog = page.getByRole("dialog", { name: "Load a sample catalog?" });
    // The trade is asked, never assumed (Tenancy 2a review T2A-BO-10).
    await dialog.getByLabel("Wheelchair ramps and accessibility").check();
    await expect(dialog).toContainText("This adds 5 sample products and 10 supplies with sample prices.");
    expect(fake.sampleLoaded).toBe(false);
    await dialog.getByRole("button", { name: "Load the sample" }).click();
    await expect(page.getByText("Modular aluminum ramp")).toBeVisible();
    await page.getByRole("button", { name: "Edit" }).click();
    const test_ = page.getByRole("complementary", { name: "Test a quote" });
    await test_.getByLabel("How many steps go up to the door?", { exact: true }).fill("3");
    await expect(test_.getByText("$6,444 – $7,164")).toBeVisible();
    await expect(test_.getByText("28.57%")).toBeVisible();
    expect(fake.previews.at(-1)).toMatchObject({ productId: "p-ramp", inputs: { steps: 3 } });
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).include(".aiew-root").analyze();
    expect(results.violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Theme, the brand colour, accessibility
// ---------------------------------------------------------------------------

test.describe("theme", () => {
  test("html.dark makes the widget dark", async ({ page }) => {
    await mount(page, makeFake(), "tool", {}, async (p) => {
      await p.evaluate(() => document.documentElement.classList.add("dark"));
    });
    await expect(page.locator(".aiew-root")).toHaveAttribute("data-theme", "dark");
    const background = await page.locator(".aiew-root").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(background).toBe("rgb(20, 27, 34)");
  });

  test("an OS that's dark under a site that pins light stays light", async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: "dark" });
    const page = await context.newPage();
    await mount(page, makeFake(), "tool", {}, async (p) => {
      await p.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    });
    await expect(page.locator(".aiew-root")).toHaveAttribute("data-theme", "light");
    const background = await page.locator(".aiew-root").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(background).toBe("rgb(255, 255, 255)");
    await context.close();
  });

  test("the business's brand colour reaches the button, in light and in dark", async ({ page }) => {
    const fake = makeFake();
    fake.config.brandColor = "#7c3aed";
    await mount(page, fake, "tool");
    await page.getByRole("button", { name: "One more: How many steps go up to the door?" }).click();
    await page.getByLabel("Your name").waitFor();
    const light = await page.getByRole("button", { name: "Send me this estimate" }).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(light).toBe("rgb(124, 58, 237)");
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(page.locator(".aiew-root")).toHaveAttribute("data-theme", "dark");
    const dark = await page.getByRole("button", { name: "Send me this estimate" }).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(dark).toBe("rgb(124, 58, 237)");
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`axe finds nothing on the estimate tool and the quote page — ${scheme}`, async ({ browser }) => {
      const context = await browser.newContext({ colorScheme: scheme, viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      const fake = makeFake();
      await mount(page, fake, "tool");
      await page.getByRole("button", { name: "One more: How many steps go up to the door?" }).click();
      await expect(page.getByText(/\$6,444/)).toBeVisible();
      let results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).include(".aiew-root").analyze();
      expect(results.violations).toEqual([]);
      await context.close();

      const quoteContext = await browser.newContext({ colorScheme: scheme, viewport: { width: 390, height: 844 } });
      const quotePage = await quoteContext.newPage();
      await mount(quotePage, makeFake(), "quote");
      await expect(quotePage.getByText("Quote EST-0001")).toBeVisible();
      results = await new AxeBuilder({ page: quotePage }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).include(".aiew-root").analyze();
      expect(results.violations).toEqual([]);
      await quoteContext.close();
    });
  }
});
