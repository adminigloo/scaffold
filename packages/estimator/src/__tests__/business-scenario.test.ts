import { commsMessages, commsScheduled, runDueMessages } from "@adminigloo/comms";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createEstimatorCommsListener, ESTIMATOR_COMMS_REF_TYPE } from "../comms.js";
import {
  createEstimatorAdminHandlers,
  createEstimatorHandlers,
  EstimatorInputError,
  markEstimateConverted,
  type EstimatorEvent,
  type EstimatorPermission,
  type EstimatorRateLimitBucket,
  type LinkedInvoice,
  type TakeoffUsage,
} from "../index.js";
import {
  estimatorEstimateItems,
  estimatorEstimates,
  estimatorPhotos,
  estimatorProducts,
  estimatorTakeoffs,
} from "../schema.js";
import {
  ADMIN_BASE,
  fakeModel,
  jpeg,
  memoryPhotoStore,
  photo,
  PUBLIC_BASE,
  readJson,
  recordingSender,
  request,
  toBase64,
} from "./fixtures.js";
import { createTestDb, type TestDb } from "./pglite.js";

/**
 * THE ACCEPTANCE TEST (contract section 11.3): Summit Ramps, a wheelchair-ramp
 * company, runs its estimates through the package end to end, with nothing
 * but the two HTTP handlers, the comms listener and the comms cron — no
 * developer filling gaps.
 *
 * One PGlite database with the estimator and comms tables, one clock shared by
 * everything (the system Date pinned too: comms' queue reads it), a recording
 * email sender, an in-memory photo store, and a fake takeoff model that
 * answers by photo and counts every call. Two staff roles: the OWNER (every
 * permission) and a MEMBER (view + estimates.manage only).
 *
 * The steps share the database and the clock, in order (vitest runs a file's
 * tests one after another).
 */

const TENANT = "summit-ramps";
const START = new Date("2026-11-02T15:00:00Z"); // Mon 08:00 MST
const DAY = 24 * 60 * 60 * 1000;
const IP1 = "203.0.113.10";
const IP2 = "203.0.113.20";

// The photos and what the fake model "sees" in each.
const PORCH = photo("porch-2-steps-plus-deck");
const MEASURED = photo("measured-already");
const BLURRY = photo("blurry-porch");
const NO_STEPS = photo("flat-entry");
const FOURTH = photo("another-porch");
const FIFTH = photo("yet-another-porch");
const HUGE = { imageBase64: toBase64(jpeg(2000, 1500, { tag: "huge" })), mediaType: "image/jpeg" as const };
const model = fakeModel({
  [PORCH.imageBase64]: { seen: true, risers: 3, riserHeightIn: { low: 7.5, high: 8.5 }, confidence: "medium" },
  [BLURRY.imageBase64]: { seen: true, risers: 3, riserHeightIn: { low: 7, high: 9 }, confidence: "low" },
  [NO_STEPS.imageBase64]: { seen: false, risers: null, riserHeightIn: null, confidence: "high" },
  [FOURTH.imageBase64]: { seen: true, risers: 2, riserHeightIn: null, confidence: "high" },
  [FIFTH.imageBase64]: { seen: true, risers: 2, riserHeightIn: null, confidence: "high" },
});

let t: TestDb;
let clock = START;
const mail = recordingSender();
const store = memoryPhotoStore();
const usage: TakeoffUsage[] = [];
const events: EstimatorEvent[] = [];
const buckets: Array<{ path: string; bucket: EstimatorRateLimitBucket }> = [];
let throwOnTakeoff = false;
/** Anything the listener or a handler reported: the scenario must end with none. */
const failures: Array<{ where: string; error: unknown }> = [];
let convertCalls = 0;
const invoices = new Map<string, LinkedInvoice>();
let listener: ReturnType<typeof createEstimatorCommsListener>;
let publicApi: ReturnType<typeof createEstimatorHandlers>;
let adminApi: ReturnType<typeof createEstimatorAdminHandlers>;

/** Ids met along the way (products by name, then the estimates, the reading, the photo, a link). */
const ids = {} as Record<string, string> & { pat: string; sam: string; jo: string; porchTakeoff: string; porchPhoto: string; patToken: string };

function setClock(next: Date) {
  clock = next;
  vi.setSystemTime(next);
}

const MEMBER_MAY: EstimatorPermission[] = ["estimator.view", "estimator.estimates.manage"];

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  setClock(START);
  t = await createTestDb({ comms: true });
  listener = createEstimatorCommsListener({
    db: t.db,
    senders: mail.senders,
    quoteUrl: (token) => `https://summit.test/quote/${token}`,
    adminEstimateUrl: (id) => `https://summit.test/admin/estimates/${id}`,
    bookUrl: (estimate) => `https://summit.test/book-visit?estimate=${estimate.id}`,
    now: () => clock,
    onError: (error, context) => void failures.push({ where: `comms:${context.step}`, error }),
  });
  const onEvent = async (event: EstimatorEvent) => {
    events.push(event);
    await listener.onEvent(event);
  };
  publicApi = createEstimatorHandlers({
    db: t.db,
    tenantId: TENANT,
    photoStore: store,
    takeoff: { model, recordUsage: (entry) => void usage.push(entry) },
    onEvent,
    emailsEnabled: true,
    rateLimit: (req, bucket) => {
      buckets.push({ path: new URL(req.url).pathname, bucket });
      if (bucket === "takeoff" && throwOnTakeoff) throw new Error("limiter store down");
      return true;
    },
    onError: (error, context) => void failures.push({ where: `public:${context.route}`, error }),
    now: () => clock,
  });
  adminApi = createEstimatorAdminHandlers({
    db: t.db,
    tenantId: TENANT,
    authorize: (req, permission) => {
      const role = req.headers.get("x-role");
      if (role === "owner") return { userId: "owner-1" };
      if (role === "member") return MEMBER_MAY.includes(permission) ? { userId: "member-1" } : false;
      return new Response(JSON.stringify({ error: { code: "unauthorized", message: "Sign in." } }), { status: 401 });
    },
    photoStore: store,
    photoReading: true,
    onEvent,
    quoteUrl: (token) => `https://summit.test/quote/${token}`,
    links: {
      bookVisitUrl: (estimate) => `https://summit.test/book-visit?estimate=${estimate.id}`,
      invoice: async (estimateId) => invoices.get(estimateId) ?? null,
    },
    convertToInvoice: async ({ tenantId, estimateId }) => {
      convertCalls += 1;
      return t.db.transaction(async (tx) => {
        const claimed = await markEstimateConverted(tx, tenantId, estimateId);
        if (!claimed) throw new EstimatorInputError("transition_not_allowed", "Only an accepted quote can become an invoice.");
        const invoice = { id: "inv-1", number: "INV-2026-0001", status: "draft", url: "https://summit.test/admin/invoices/inv-1" };
        invoices.set(estimateId, invoice);
        return invoice;
      });
    },
    onError: (error, context) => void failures.push({ where: `admin:${context.route}`, error }),
    now: () => clock,
  });
});

afterAll(async () => {
  vi.useRealTimers();
  await t.close();
});

const pub = (method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}) =>
  publicApi.handle(request(method, `${PUBLIC_BASE}${path}`, body, { "x-forwarded-for": IP1, ...headers }));
const admin = (role: "owner" | "member", method: "GET" | "POST", path: string, body?: unknown) =>
  adminApi.handle(request(method, `${ADMIN_BASE}/v1/admin/${path}`, body, { "x-role": role }));

/**
 * The text a customer reads for the ramp, in 3.3's list: each field's label,
 * help and placeholder; the price's explanation, assumption, result phrase and
 * reasons; a reading's lines; a message. (An option the owner named — the
 * sample's "Straight run" layout — is the owner's word, not the package's.)
 */
function customerStrings(body: any): string[] {
  const out: string[] = [];
  for (const field of body?.fields ?? []) out.push(field.label, field.help ?? "", field.placeholder ?? "");
  const price = body?.price;
  if (price) out.push(...price.explanation, price.assumption ?? "", price.resultPhrase ?? "", ...price.reasons, price.taxNote ?? "");
  if (body?.reading) out.push(...body.reading.lines);
  if (typeof body?.message === "string") out.push(body.message);
  if (body?.quantity?.label) out.push(body.quantity.label);
  return out.filter((text) => text !== "");
}
const rampStrings: string[] = [];

/** No public body anywhere carries a cost. */
function costKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(costKeys);
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) =>
      ["cost", "unitCost", "marginBp", "breakdown", "supplies", "costMicros"].includes(k) ? [k] : costKeys(v),
    );
  }
  return [];
}
const publicBodies: unknown[] = [];
async function publicJson<T = any>(response: Response): Promise<T> {
  const body = await readJson<T>(response);
  publicBodies.push(body);
  return body;
}

function tokenIn(text: string): string {
  const match = /quote\/([A-Za-z0-9_-]{43})/.exec(text);
  if (!match) throw new Error(`no quote link in: ${text}`);
  return match[1] as string;
}

async function estimateRow(id: string) {
  const [row] = await t.db.select().from(estimatorEstimates).where(eq(estimatorEstimates.id, id));
  return row as typeof estimatorEstimates.$inferSelect;
}

describe("Summit Ramps runs its estimates on the package", () => {
  it("1. the owner sets up the price book and settings", async () => {
    // Nothing seeds itself from a public page.
    const empty = await publicJson(await pub("GET", "/v1/config"));
    expect(empty.products).toEqual([]);
    expect(await t.db.select().from(estimatorProducts)).toHaveLength(0);

    const settings = {
      businessName: "Summit Ramps",
      contactPhone: "(801) 555-0143",
      contactEmail: "hello@summit.test",
      timeZone: "America/Denver",
      taxRateBp: 725,
      leadNotifyEmails: ["office@summit.test"],
      quoteValidDays: 30,
      followUpDays: 3,
    };
    expect((await admin("member", "POST", "settings", settings)).status).toBe(403);
    const saved = await readJson(await admin("owner", "POST", "settings", settings));
    expect(saved.settings).toMatchObject({ ...settings, saved: true });

    const loaded = await admin("owner", "POST", "sample-catalog");
    expect(await readJson(loaded)).toEqual({ products: 5, supplies: 10 });
    const again = await admin("owner", "POST", "sample-catalog");
    expect(again.status).toBe(409);
    expect((await readJson(again)).error.code).toBe("sample_already_loaded");

    const products = (await readJson(await admin("owner", "GET", "products"))).products as Array<{ id: string; name: string; options: any[]; showInEstimator: boolean }>;
    for (const p of products) ids[p.name] = p.id;
    expect(Object.keys(ids)).toEqual(["Modular aluminum ramp", "Threshold ramp", "Concrete landing pad", "Handrail only", "Something else"]);
    // The sample arrives OFF the website: made-up prices reach no customer
    // until the owner turns each product on (review EST-R01).
    expect(products.every((p) => p.showInEstimator === false)).toBe(true);
    expect((await publicJson(await pub("GET", "/v1/config"))).products).toEqual([]);
    for (const p of products) expect((await admin("owner", "POST", `products/${p.id}`, { showInEstimator: true })).status).toBe(200);

    // A supplier raises the handrail price: the screen says what it re-prices.
    const supplies = (await readJson(await admin("owner", "GET", "supplies"))).supplies as Array<{ id: string; name: string }>;
    const handrail = supplies.find((s) => s.name === "Handrail")!;
    const raised = await readJson(await admin("owner", "POST", `supplies/${handrail.id}`, { unitCost: 1900 }));
    expect(raised.supply.unitCost).toBe(1900);
    expect(raised.affectedProducts.map((p: { name: string }) => p.name)).toEqual(["Handrail only", "Modular aluminum ramp"]);
    await admin("owner", "POST", `supplies/${handrail.id}`, { unitCost: 1800 });

    // "Test a quote": 3 steps, height unknown.
    const ramp = ids["Modular aluminum ramp"]!;
    const preview = await readJson(await admin("owner", "POST", "products/preview", { productId: ramp, inputs: { steps: 3 } }));
    expect(preview.customerView).toMatchObject({ low: 647_262, high: 714_588, single: false });
    expect(preview.breakdown.marginBp).toBe(2857);
    // The breakdown is at the point: the typical 7.5 in step, 23 ft (review EST-R05); posts whole (EST-R09).
    expect(preview.breakdown.lines.find((l: { label: string }) => l.label === "Aluminum ramp section").quantity).toBe(23);
    expect(preview.breakdown.lines.find((l: { label: string }) => l.label === "Support post & footing").quantity).toBe(6);
    const memberView = await readJson(await admin("member", "POST", "products/preview", { productId: ramp, inputs: { steps: 3 } }));
    expect(memberView.breakdown).toBeNull();
    expect(memberView.customerView).toEqual(preview.customerView);
    const asMargin = await readJson(
      await admin("owner", "POST", "products/preview", { productId: ramp, inputs: { steps: 3 }, draft: { pricingBasis: "margin", marginBp: 3500 } }),
    );
    expect(asMargin.breakdown.point).toBe(760_600);
    expect((await readJson(await admin("owner", "GET", `products/${ramp}`))).product.pricingBasis).toBe("markup"); // nothing saved

    // A product of their own: a count, one supply, one option with three values.
    const created = await admin("owner", "POST", "products", {
      name: "Grab bar",
      category: "Safety",
      recipe: "count",
      recipeConfig: { countLabel: "How many grab bars?", noun: { one: "grab bar", many: "grab bars" } },
      markupBp: 5_000,
      minimumCharge: 9_000,
    });
    expect(created.status).toBe(201);
    const grabBar = (await readJson(created)).product;
    expect(grabBar).toMatchObject({ recipe: "count", rangeMode: "measured", allowMultiple: false });
    ids["Grab bar"] = grabBar.id;
    const kit = (await readJson(await admin("owner", "POST", "supplies", { name: "Grab bar kit", unitType: "per_unit", unitCost: 4_500 }))).supply;
    const attached = (await readJson(await admin("owner", "POST", `products/${grabBar.id}/supplies`, { supplyId: kit.id, quantityMilli: 1000, per: "item" }))).product;
    expect(attached.supplies.map((s: { name: string; perLabel: string }) => [s.name, s.perLabel])).toEqual([["Grab bar kit", "per grab bar"]]);
    const withOption = (await readJson(await admin("owner", "POST", `products/${grabBar.id}/options`, { name: "Finish" }))).product;
    const finish = withOption.options[0].id as string;
    await admin("owner", "POST", `options/${finish}/values`, { label: "Stainless", priceModifier: 0, isDefault: true });
    await admin("owner", "POST", `options/${finish}/values`, { label: "Brass", priceModifier: 2_500 });
    const three = (await readJson(await admin("owner", "POST", `options/${finish}/values`, { label: "Black", priceModifier: 1_500 }))).product;
    const valueId = (label: string) => three.options[0].values.find((v: { label: string }) => v.label === label).id as string;
    await admin("owner", "POST", `option-values/${valueId("Brass")}`, { priceModifier: 3_000 });
    await admin("owner", "POST", `option-values/${valueId("Brass")}/default`);
    const final = (await readJson(await admin("owner", "POST", `option-values/${valueId("Black")}/remove`))).product;
    expect(final.options[0].values.map((v: { label: string; priceModifier: number; isDefault: boolean }) => [v.label, v.priceModifier, v.isDefault])).toEqual([
      ["Stainless", 0, false],
      ["Brass", 3_000, true],
    ]);
  });

  it("2. a customer prices the ramp — by answering what they know, then from a photo", async () => {
    const ramp = ids["Modular aluminum ramp"]!;
    const config = await publicJson(await pub("GET", "/v1/config"));
    const product = config.products.find((p: { id: string }) => p.id === ramp);
    rampStrings.push(...customerStrings(product));
    expect(product.fields.map((f: { key: string }) => f.key)).toEqual(["steps", "stepHeightIn", "totalRiseIn"]);
    expect(product.fields[0]).toMatchObject({ kind: "stepper", label: "How many steps go up to the door?", required: true });
    expect(product.fields[2]).toMatchObject({ presentation: "secondary" });
    expect(product.quantity).toBeNull();
    expect(product.photo).toEqual({ reading: true, tip: "Stand to the side so every step shows." });
    expect(config).toMatchObject({ businessName: "Summit Ramps", currency: "USD", photos: { attach: true, reading: true, maxEdgePx: 768 } });

    const calc = async (body: Record<string, unknown>) => {
      const response = await pub("POST", "/v1/calculate", { productId: ramp, ...body });
      expect(response.status).toBe(200);
      const json = await publicJson(response);
      rampStrings.push(...customerStrings(json));
      return json;
    };

    const unknown = await calc({ inputs: { steps: 3 } });
    expect(unknown.status).toBe("priced");
    expect(unknown.price).toEqual({
      low: 647_262,
      high: 714_588,
      single: false,
      currency: "USD",
      explanation: ["3 steps × 7–8 in each (estimated) = 21–24 in rise", "ADA 1:12 slope (1 ft of ramp per inch of rise) → 21–24 ft of ramp"],
      assumption: "Based on an estimated step height of 7–8 in. Measure one step and enter it for a tighter estimate.",
      resultPhrase: "That's about a 21–24 ft ramp.",
      reasons: ["Step height 7–8 in (estimated)"],
      taxNote: "Plus 7.25% sales tax.",
    });
    expect(model.calls).toHaveLength(0);

    const measured = await calc({ inputs: { steps: 3, stepHeightIn: 7.5 } });
    expect(measured.price).toMatchObject({ low: 692_146, high: 692_146, single: true, reasons: [] });
    expect(model.calls).toHaveLength(0);

    // The photo: the founder's porch (2 steps and the deck: 3 risers).
    const read = await publicJson(await pub("POST", "/v1/takeoff", { productId: ramp, ...PORCH }));
    rampStrings.push(...customerStrings(read));
    expect(read.status).toBe("read");
    expect(read.reading.lines).toEqual(["We counted 3 steps up, including the last one onto the porch or landing.", "Each step looks about 7.5–8.5 in tall.", "You can change the count if it's wrong."]);
    expect(read.reading.suggested).toEqual({ steps: 3 });
    expect(read.photoId).toEqual(expect.any(String));
    expect(read.result).toBeNull();
    expect(store.puts).toBe(1);
    expect(model.calls).toHaveLength(1);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ tenantId: TENANT, operation: "estimator_takeoff", model: "claude-haiku-4-5", inputTokens: 4_000, outputTokens: 50, costMicros: 4_250, costEstimated: false, outcome: "read" });
    const [ledger] = await t.db.select().from(estimatorTakeoffs).where(eq(estimatorTakeoffs.id, read.reading.takeoffId));
    expect(ledger).toMatchObject({ status: "read", costMicros: 4_250, model: "claude-haiku-4-5", confidence: "medium" });
    ids.porchTakeoff = read.reading.takeoffId;
    ids.porchPhoto = read.photoId;

    const cached = await publicJson(await pub("POST", "/v1/takeoff", { productId: ramp, ...PORCH }));
    expect(cached).toMatchObject({ status: "read", cached: true });
    expect(model.calls).toHaveLength(1);

    const fromPhoto = await calc({ inputs: { steps: 3 }, takeoffId: ids.porchTakeoff });
    // The photo's 7.5–8.5 in, kept inside the owner's 7–8 in (review EST-R10).
    expect(fromPhoto.price).toMatchObject({ low: 692_146, high: 714_588, reasons: ["Step height 7.5–8 in (from the photo)"] });

    const corrected = await calc({ inputs: { steps: 4 }, takeoffId: ids.porchTakeoff });
    expect(corrected.price.low).toBe(861_000);
    expect(corrected.price.high).toBe(995_484);
    expect(corrected.price.explanation).toContain("0–1 resting landings: ramps need one for every 30 in of rise");
    expect(corrected.price.reasons).toEqual(["Step height 7.5–8 in (from the photo)", "A resting landing may be needed (over 30 in of rise)"]);

    const notNeeded = await publicJson(await pub("POST", "/v1/takeoff", { productId: ramp, ...MEASURED, inputs: { steps: 3, stepHeightIn: 7.5 } }));
    expect(notNeeded).toMatchObject({ status: "not_needed", message: "You've measured it already, so we've just kept your photo with your estimate." });
    expect(model.calls).toHaveLength(1);

    const blurry = await publicJson(await pub("POST", "/v1/takeoff", { productId: ramp, ...BLURRY }));
    expect(blurry.reading.lines).toContain("We're not sure about this photo, so please check the count.");
    expect(blurry.reading.heightRangeIn).toBeNull();
    const notPriced = await calc({ inputs: { steps: 3 }, takeoffId: blurry.reading.takeoffId });
    expect(notPriced.price).toMatchObject({ low: 647_262, high: 714_588 }); // the low-confidence height is never priced

    const none = await publicJson(await pub("POST", "/v1/takeoff", { productId: ramp, ...NO_STEPS }));
    expect(none.status).toBe("unreadable");
    expect(none.reading.lines).toEqual(["We couldn't count the steps in this photo, so please enter the number."]);
    expect(model.calls).toHaveLength(3);

    // Limits, all failing closed with "count them yourself". Three readings
    // (4 250 micro-dollars each) are on today's books.
    await admin("owner", "POST", "settings", { aiPerRequesterDaily: 2 });
    const limited = await publicJson(await pub("POST", "/v1/takeoff", { productId: ramp, ...FOURTH }));
    expect(limited).toMatchObject({ status: "limited", message: "You've used today's photo readings, so please count the steps and enter the number." });
    await admin("owner", "POST", "settings", { aiPerRequesterDaily: 5, aiDailyBudgetCents: 1 });
    const paused = await publicJson(await pub("POST", "/v1/takeoff", { productId: ramp, ...FOURTH }, { "x-forwarded-for": IP2 }));
    expect(paused).toMatchObject({ status: "paused", message: "Photo reading is paused for today, so please count the steps and enter the number." });
    await admin("owner", "POST", "settings", { aiDailyBudgetCents: 0 });
    const off = await publicJson(await pub("POST", "/v1/takeoff", { productId: ramp, ...FIFTH }, { "x-forwarded-for": IP2 }));
    expect(off).toMatchObject({ status: "unavailable", available: false });
    throwOnTakeoff = true;
    const throttled = await pub("POST", "/v1/takeoff", { productId: ramp, ...FIFTH }, { "x-forwarded-for": IP2 });
    expect(throttled.status).toBe(429);
    throwOnTakeoff = false;
    const tooBig = await pub("POST", "/v1/takeoff", { productId: ramp, ...HUGE });
    expect(tooBig.status).toBe(400);
    expect((await readJson(tooBig)).error).toMatchObject({ code: "photo_invalid", message: expect.stringContaining("This one is too large.") });
    expect(model.calls).toHaveLength(3);
    await admin("owner", "POST", "settings", { aiDailyBudgetCents: 100 });

    // The founder's rule E: nothing a customer reads for the ramp says "length of run".
    expect(rampStrings.length).toBeGreaterThan(20);
    for (const text of rampStrings) expect(text).not.toMatch(/length of run|linear|\brun\b/i);
  });

  it("3. the lead: saved with the photo, the reading and the correction; the office and Pat are emailed", async () => {
    const ramp = ids["Modular aluminum ramp"]!;
    const config = await publicJson(await pub("GET", "/v1/config"));
    const defaults = config.products
      .find((p: { id: string }) => p.id === ramp)
      .options.map((o: { values: Array<{ id: string; isDefault: boolean }> }) => o.values.find((v) => v.isDefault)!.id);
    const before = mail.sent.length;
    const response = await pub("POST", "/v1/submit", {
      name: "Pat Lee",
      email: "pat@example.test",
      phone: "(801) 555-0199",
      address: "12 Oak St, Salt Lake City",
      items: [{ productId: ramp, inputs: { steps: 4 }, takeoffId: ids.porchTakeoff, optionValueIds: defaults }],
      photoIds: [ids.porchPhoto],
      website: "",
      fillMs: 5000,
    });
    expect(response.status).toBe(201);
    const submitted = await publicJson(response);
    expect(submitted).toMatchObject({ range: { low: 861_000, high: 995_484, single: false }, currency: "USD", emailed: true });
    ids.pat = submitted.estimateId;

    const row = await estimateRow(ids.pat);
    expect(row).toMatchObject({ source: "photo", rangeLow: 861_000, rangeHigh: 995_484, status: "draft" });
    const [line] = await t.db.select().from(estimatorEstimateItems).where(eq(estimatorEstimateItems.estimateId, ids.pat));
    expect(line).toMatchObject({
      inputs: { steps: 4, stepHeightIn: null, totalRiseIn: null },
      takeoffId: ids.porchTakeoff,
      corrections: [{ field: "steps", label: "Steps", from: 3, to: 4 }],
      recipe: "ramp_over_steps",
    });
    expect((line!.derived as { explanation: string[] }).explanation[0]).toBe("4 steps × 7.5–8 in each (from your photo) = 30–32 in rise");
    const [kept] = await t.db.select().from(estimatorPhotos).where(eq(estimatorPhotos.id, ids.porchPhoto!));
    expect(kept).toMatchObject({ estimateId: ids.pat, width: 768, height: 576 });

    const office = mail.sent.slice(before).filter((m) => m.to === "office@summit.test");
    expect(office).toHaveLength(1);
    expect(office[0]!.subject).toBe(`New lead: Pat Lee, $8,610 – $9,955 (${row.estimateNumber})`);
    expect(office[0]!.body).toContain("Estimate: $8,610 – $9,955, plus 7.25% sales tax.");
    expect(office[0]!.body).toContain("Why it's a range: Step height 7.5–8 in (from the photo); A resting landing may be needed (over 30 in of rise).");
    expect(office[0]!.body).toContain(
      "From the photo: We counted 3 steps up, including the last one onto the porch or landing. Each step looks about 7.5–8.5 in tall. (medium confidence).",
    );
    expect(office[0]!.body).toContain("The customer changed: steps 3 → 4.");
    expect(office[0]!.body).toContain("1 photo: see it on the estimate.");
    expect(office[0]!.body).toContain(`Open it: https://summit.test/admin/estimates/${ids.pat}`);
    expect(office[0]!.body).toContain("• Modular aluminum ramp: 4 steps (Surface: Standard grit, Layout: Straight run), $8,610 – $9,955");
    expect(office[0]!.body).not.toMatch(/cost|margin/i);
    const copy = mail.sent.slice(before).filter((m) => m.to === "pat@example.test");
    expect(copy).toHaveLength(1);
    expect(copy[0]!.subject).toBe(`Your estimate from Summit Ramps (${row.estimateNumber})`);
    expect(copy[0]!.body).toContain("Estimate: $8,610 – $9,955, plus 7.25% sales tax.");
    // An email has nowhere to type a height: it says to reply with one (review EST-R14).
    expect(copy[0]!.body).toContain(
      "Based on a step height of about 7.5–8 in, from your photo. Reply with the height of one step (from the top of one step to the top of the next) for a tighter price.",
    );
    expect(copy[0]!.body).toContain("Questions? Call (801) 555-0143 or email hello@summit.test.");
    const [messages] = [await t.db.select().from(commsMessages)];
    expect(messages.every((m) => (m.missingVars ?? []).length === 0)).toBe(true);

    // Spam: a filled honeypot, and a form sent faster than a person — nothing written.
    const count = async () => (await t.db.select().from(estimatorEstimates)).length;
    const rows = await count();
    const base = { name: "Bot", email: "bot@example.test", items: [{ productId: ramp, inputs: { steps: 2 } }] };
    for (const body of [{ ...base, website: "https://spam.example", fillMs: 9000 }, { ...base, fillMs: 100 }]) {
      const spam = await pub("POST", "/v1/submit", body);
      expect(spam.status).toBe(400);
      expect((await readJson(spam)).error.code).toBe("spam_suspected");
    }
    expect(await count()).toBe(rows);

    // Website keys: one that works only on the business's own site.
    const issued = await readJson(await admin("owner", "POST", "keys", { label: "summitramps.test", allowedOrigins: ["https://SummitRamps.test/"] }));
    expect(issued.key.allowedOrigins).toEqual(["https://summitramps.test"]);
    const keyed = (origin: string, body: unknown, path = "/v1/submit") =>
      publicApi.handle(
        new Request(`https://summit.test/api/estimator${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-adminigloo-key": issued.plaintext, origin, "x-forwarded-for": IP2 },
          body: JSON.stringify(body),
        }),
      );
    // A 0.1 widget's body (0.2 names, a measurement, no fillMs) on the business's site.
    const legacy = await keyed("https://summitramps.test", {
      customerName: "Lee Park",
      customerEmail: "lee@example.test",
      items: [{ productId: ids["Threshold ramp"], measurement: {}, quantity: 2 }],
    });
    expect(legacy.status).toBe(201);
    expect(legacy.headers.get("access-control-allow-origin")).toBe("https://summitramps.test");
    expect(legacy.headers.get("vary")).toBe("Origin");
    const evil = await keyed("https://evil.test", { customerName: "X", customerEmail: "x@example.test", items: [] });
    expect(evil.status).toBe(403);
    expect((await readJson(evil)).error.code).toBe("origin_not_allowed");
  });

  it("4. staff work the lead: search, read, edit, send a quote", async () => {
    const leads = await readJson(await admin("member", "GET", "estimates?filter=leads"));
    expect(leads.estimates.map((e: { id: string }) => e.id)).toContain(ids.pat);
    expect(leads.counts.leads).toBe(2);
    const search = await readJson(await admin("member", "GET", "estimates?q=Pat"));
    expect(search.estimates.map((e: { customerName: string }) => e.customerName)).toEqual(["Pat Lee"]);
    expect(search.estimates[0]).toMatchObject({ photoCount: 1, hasReading: true, rangeLow: 861_000 });

    const asMember = (await readJson(await admin("member", "GET", `estimates/${ids.pat}`))).estimate;
    expect(asMember.photos).toHaveLength(1);
    expect(asMember.photos[0].url).toMatch(/^https:\/\/files\.test\/.+\?signed=1$/);
    expect(asMember.photos[0].takeoffId).toBe(ids.porchTakeoff);
    expect(asMember.lines[0].reading).toMatchObject({ status: "read", confidence: "medium", suggested: { steps: 3 }, costMicros: null });
    expect(asMember.lines[0].corrections).toEqual([{ field: "steps", label: "Steps", from: 3, to: 4 }]);
    expect(asMember.cost).toBeNull();
    expect(asMember.lines[0].cost).toBeNull();
    const asOwner = (await readJson(await admin("owner", "GET", `estimates/${ids.pat}`))).estimate;
    expect(asOwner.cost).toEqual(expect.any(Number));
    expect(asOwner.marginBp).toEqual(expect.any(Number));
    expect(asOwner.lines[0].reading.costMicros).toBe(4_250);

    // The crew measured: 4 steps at 7.25 in.
    const lineId = asOwner.lines[0].id as string;
    const edited = await readJson(await admin("member", "POST", `estimates/${ids.pat}/items/${lineId}`, { inputs: { steps: 4, stepHeightIn: 7.25 } }));
    expect(edited.estimate.lines[0]).toMatchObject({ total: 838_558, lowTotal: 838_558, highTotal: 838_558, inputsSummary: "4 steps, 7.25 in each" });
    expect(edited.estimate.lines[0].corrections).toEqual([{ field: "steps", label: "Steps", from: 3, to: 4 }]); // the customer's, kept
    await admin("member", "POST", `estimates/${ids.pat}/items`, { description: "Remove old wooden steps", quantity: 1, unitPrice: 15_000 });
    const withThreshold = await readJson(await admin("member", "POST", `estimates/${ids.pat}/items`, { productId: ids["Threshold ramp"], inputs: { count: 1 } }));
    const threshold = withThreshold.estimate.lines.find((l: { description: string }) => l.description === "Threshold ramp").id;
    const totals = (await readJson(await admin("member", "POST", `estimates/${ids.pat}/items/${threshold}/remove`))).estimate;
    expect(totals).toMatchObject({ subtotal: 853_558, taxAmount: 61_883, total: 915_441 });

    const tooMuch = await admin("member", "POST", `estimates/${ids.pat}`, { discount: 900_000 });
    expect(tooMuch.status).toBe(400);
    expect((await readJson(tooMuch)).error.code).toBe("discount_exceeds_subtotal");
    expect((await estimateRow(ids.pat)).discount).toBe(0);

    const before = mail.sent.length;
    const sent = await readJson(await admin("member", "POST", `estimates/${ids.pat}/send`, { validDays: 30 }));
    expect(sent.estimate).toMatchObject({ status: "sent", quoteSequence: 1, validUntil: new Date(clock.getTime() + 30 * DAY).toISOString() });
    expect(sent.warnings).toEqual([]);
    const quoteMail = mail.sent.slice(before).filter((m) => m.to === "pat@example.test");
    expect(quoteMail).toHaveLength(1);
    expect(quoteMail[0]!.subject).toBe(`Your quote from Summit Ramps (${sent.estimate.number})`);
    expect(quoteMail[0]!.body).toContain("Total: $9,154.41, including $618.83 sales tax");
    expect(quoteMail[0]!.body).toContain("Good until: December 2, 2026");
    ids.patToken = tokenIn(quoteMail[0]!.body);
    const logged = await t.db.select().from(commsMessages).where(eq(commsMessages.templateKey, "quote_sent"));
    expect(logged[0]!.body).toContain("/quote/:token");
    expect(logged[0]!.body).not.toContain(ids.patToken);
    const queued = await t.db.select().from(commsScheduled).where(eq(commsScheduled.refId, ids.pat));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      templateKey: "quote_follow_up",
      refType: ESTIMATOR_COMMS_REF_TYPE,
      dedupeKey: `estimate:${ids.pat}:followup:1`,
      status: "pending",
    });
    expect(queued[0]!.sendAt.toISOString()).toBe(new Date(clock.getTime() + 3 * DAY).toISOString());

    const locked = await admin("member", "POST", `estimates/${ids.pat}`, { customerName: "Patricia Lee" });
    expect(locked.status).toBe(409);
    expect((await readJson(locked)).error).toEqual({ code: "not_changeable", message: "This quote has been sent. Revise it to make changes." });
    expect((await admin("member", "POST", `estimates/${ids.pat}`, { internalNotes: "Side gate code 4411" })).status).toBe(200);
  });

  it("5. the customer answers: view, a revision, accept; a follow-up; an expiry", async () => {
    setClock(new Date(START.getTime() + 2 * 60 * 60 * 1000));
    const quoteBefore = events.length;
    const view = await pub("GET", `/v1/quote/${ids.patToken}`);
    expect(view.status).toBe(200);
    expect(view.headers.get("referrer-policy")).toBe("no-referrer");
    expect(view.headers.get("x-robots-tag")).toBe("noindex");
    const quote = (await publicJson(view)).quote;
    expect(quote).toMatchObject({ status: "open", canRespond: true, businessName: "Summit Ramps", taxRateBp: 725, total: 915_441, customerName: "Pat Lee" });
    expect(quote.lines[0]).toEqual({
      description: "Modular aluminum ramp",
      details: ["4 steps, 7.25 in each, 29 ft of ramp", "Surface: Standard grit", "Layout: Straight run"],
      quantity: 1,
      total: 838_558,
    });
    expect((await estimateRow(ids.pat)).status).toBe("viewed");
    await pub("GET", `/v1/quote/${ids.patToken}`);
    expect(events.slice(quoteBefore).map((e) => e.type)).toEqual(["quote.viewed"]);

    // Revise: the link says "updating", the follow-up goes.
    await admin("member", "POST", `estimates/${ids.pat}/revise`);
    expect((await publicJson(await pub("GET", `/v1/quote/${ids.patToken}`))).quote.status).toBe("updating");
    const firstFollowUp = await t.db.select().from(commsScheduled).where(eq(commsScheduled.dedupeKey, `estimate:${ids.pat}:followup:1`));
    expect(firstFollowUp[0]!.status).toBe("cancelled");
    await admin("member", "POST", `estimates/${ids.pat}`, { discount: 12_998 });
    const resentAt = mail.sent.length;
    const resent = await readJson(await admin("member", "POST", `estimates/${ids.pat}/send`, {}));
    expect(resent.estimate).toMatchObject({ quoteSequence: 2, total: 901_501 });
    // The first email's link is dead now; the new email carries a working one (review ADV-2).
    expect((await pub("GET", `/v1/quote/${ids.patToken}`)).status).toBe(404);
    ids.patToken = tokenIn(mail.sent.slice(resentAt).find((m) => m.to === "pat@example.test")!.body);
    expect((await publicJson(await pub("GET", `/v1/quote/${ids.patToken}`))).quote).toMatchObject({ status: "open", version: 2 });
    const second = await t.db.select().from(commsScheduled).where(eq(commsScheduled.dedupeKey, `estimate:${ids.pat}:followup:2`));
    expect(second[0]!.status).toBe("pending");

    // Accept, with a name and a note.
    const before = mail.sent.length;
    // From a page still showing version 1: refused, and shown the new one.
    const stale = await pub("POST", `/v1/quote/${ids.patToken}/accept`, { version: 1, name: "Pat Lee" });
    expect(stale.status).toBe(409);
    expect((await readJson(stale)).error.code).toBe("quote_changed");
    const accepted = await pub("POST", `/v1/quote/${ids.patToken}/accept`, { version: 2, name: "Pat Lee", note: "Mornings are best" });
    expect(accepted.status).toBe(200);
    expect((await publicJson(accepted)).quote).toMatchObject({ status: "accepted", responseName: "Pat Lee", canRespond: false });
    const notice = mail.sent.slice(before).find((m) => m.to === "office@summit.test")!;
    expect(notice.subject).toMatch(/^Quote accepted: Pat Lee, EST-2026-\d{4}$/);
    expect(notice.body).toContain('Their note: "Mornings are best"');
    expect(notice.body).toContain("Pat Lee accepted quote");
    const thanks = mail.sent.slice(before).find((m) => m.to === "pat@example.test")!;
    expect(thanks.subject).toMatch(/^Thanks, you've accepted quote EST-2026-\d{4}$/);
    expect(thanks.body).toContain(`Pick a time for the work here: https://summit.test/book-visit?estimate=${ids.pat}`);
    expect((await t.db.select().from(commsScheduled).where(eq(commsScheduled.dedupeKey, `estimate:${ids.pat}:followup:2`)))[0]!.status).toBe("cancelled");
    const eventsBefore = events.length;
    expect((await pub("POST", `/v1/quote/${ids.patToken}/accept`, { version: 2, name: "Pat Lee" })).status).toBe(200);
    expect(events.length).toBe(eventsBefore); // a double tap: no event
    const decline = await pub("POST", `/v1/quote/${ids.patToken}/decline`, { version: 2 });
    expect(decline.status).toBe(409);
    expect((await readJson(decline)).error.code).toBe("already_answered");

    // The follow-up path: Sam doesn't answer for three days.
    const sam = await readJson(
      await admin("member", "POST", "estimates", {
        customerName: "Sam Ortiz",
        customerEmail: "sam@example.test",
        items: [{ productId: ids["Modular aluminum ramp"], inputs: { steps: 2, stepHeightIn: 7 } }],
      }),
    );
    ids.sam = sam.estimate.id;
    await admin("member", "POST", `estimates/${ids.sam}/send`, {});
    setClock(new Date(clock.getTime() + 3 * DAY + 60_000));
    const beforeRun = mail.sent.length;
    await runDueMessages(t.db, mail.senders, { now: clock, beforeSend: async (row) => (await listener.beforeSend(row)) ?? "send" });
    const followUp = mail.sent.slice(beforeRun).find((m) => m.to === "sam@example.test")!;
    expect(followUp.subject).toBe(`Following up on your quote ${sam.estimate.number}`);
    expect(followUp.body).toContain("Just checking in on the quote we sent on November 2, 2026");
    const samToken = tokenIn(followUp.body);
    expect((await pub("GET", `/v1/quote/${samToken}`)).status).toBe(200);
    expect(await listener.redactSent()).toBeGreaterThan(0);
    const followUpLog = await t.db.select().from(commsMessages).where(eq(commsMessages.templateKey, "quote_follow_up"));
    expect(followUpLog[0]!.body).not.toContain(samToken);
    const beforeDecline = mail.sent.length;
    const declined = await pub("POST", `/v1/quote/${samToken}/decline`, { version: 1, note: "Going with my brother-in-law" });
    expect((await publicJson(declined)).quote.status).toBe("declined");
    const declinedNotice = mail.sent.slice(beforeDecline).find((m) => m.to === "office@summit.test")!;
    expect(declinedNotice.subject).toMatch(/^Quote declined: Sam Ortiz/);
    expect(declinedNotice.body).toContain('Their note: "Going with my brother-in-law"');

    // The expiry path: Jo's quote is good for 5 days, and lapses.
    const jo = await readJson(
      await admin("member", "POST", "estimates", {
        customerName: "Jo Banks",
        customerEmail: "jo@example.test",
        items: [{ productId: ids["Handrail only"], inputs: { length: 12 } }],
      }),
    );
    ids.jo = jo.estimate.id;
    const joSentAt = mail.sent.length;
    await admin("member", "POST", `estimates/${ids.jo}/send`, { validDays: 5 });
    const joToken = tokenIn(mail.sent.slice(joSentAt).find((m) => m.to === "jo@example.test")!.body);
    setClock(new Date(clock.getTime() + 6 * DAY));
    const beforeExpire = mail.sent.length;
    expect(await readJson(await admin("member", "POST", "expire"))).toEqual({ expired: 1 });
    const lapsed = mail.sent.slice(beforeExpire);
    expect(lapsed.find((m) => m.to === "jo@example.test")!.subject).toBe(`Your quote ${jo.estimate.number} has expired`);
    expect(lapsed.find((m) => m.to === "office@summit.test")!.subject).toBe(`Quote expired: Jo Banks, ${jo.estimate.number}`);
    const late = await pub("POST", `/v1/quote/${joToken}/accept`, { version: 1, name: "Jo" });
    expect(late.status).toBe(409);
    expect((await readJson(late)).error).toMatchObject({ code: "quote_expired", message: expect.stringContaining("Call us at (801) 555-0143") });
  });

  it("6. an accepted quote is one click from booking the visit and from an invoice", async () => {
    const detail = (await readJson(await admin("member", "GET", `estimates/${ids.pat}`))).estimate;
    expect(detail.status).toBe("approved");
    expect(detail.actions).toEqual(expect.arrayContaining(["book_visit", "convert"]));
    expect(detail.links.bookVisitUrl).toBe(`https://summit.test/book-visit?estimate=${ids.pat}`);
    const converted = await readJson(await admin("member", "POST", `estimates/${ids.pat}/convert`));
    expect(convertCalls).toBe(1);
    expect(converted.invoice).toMatchObject({ number: "INV-2026-0001" });
    expect(converted.estimate.status).toBe("converted");
    expect(converted.estimate.links.invoice).toMatchObject({ id: "inv-1" });
    expect(events.at(-1)?.type).toBe("estimate.converted");
    const again = await admin("member", "POST", `estimates/${ids.pat}/convert`);
    expect(again.status).toBe(409);
    expect((await readJson(again)).error.code).toBe("transition_not_allowed");
    expect(convertCalls).toBe(1);
  });

  it("7. protection, collected", async () => {
    // Every public POST of this file went through the limiter with the right bucket.
    const expected: Record<string, EstimatorRateLimitBucket> = {
      config: "read",
      calculate: "calculate",
      takeoff: "takeoff",
      submit: "submit",
      accept: "respond",
      decline: "respond",
    };
    for (const entry of buckets) {
      const last = entry.path.split("/").at(-1) as string;
      const want = expected[last] ?? (entry.path.includes("/v1/quote/") ? "read" : undefined);
      expect(want, entry.path).toBeDefined();
      expect(entry.bucket, entry.path).toBe(want);
    }
    expect(new Set(buckets.map((b) => b.bucket))).toEqual(new Set(["read", "calculate", "takeoff", "submit", "respond"]));
    // A cross-site POST to the business's own page is refused before any work.
    const forged = await publicApi.handle(
      new Request(`${PUBLIC_BASE}/v1/submit`, {
        method: "POST",
        headers: { "content-type": "application/json", "sec-fetch-site": "cross-site", origin: "https://evil.test" },
        body: JSON.stringify({ name: "x" }),
      }),
    );
    expect(forged.status).toBe(403);
    expect((await readJson(forged)).error.code).toBe("forbidden");
    // The model was called once per distinct photo worth reading: the porch, the blurry one, the flat entry.
    expect(model.calls).toHaveLength(3);
    // No public body anywhere carried a cost.
    expect(publicBodies.length).toBeGreaterThan(10);
    for (const body of publicBodies) expect(costKeys(body)).toEqual([]);
    // Every email rendered with no missing variable, and no delivery-log row holds a quote token.
    const messages = await t.db.select().from(commsMessages);
    expect(messages.length).toBeGreaterThan(8);
    for (const message of messages) {
      expect(message.missingVars ?? []).toEqual([]);
      expect(`${message.subject ?? ""} ${message.body}`).not.toMatch(/quote\/[A-Za-z0-9_-]{43}/);
    }
    // Nothing failed quietly along the way: no email step, no handler fault.
    expect(failures).toEqual([]);
  });
});
