import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { createAnthropicTakeoffRunner } from "../anthropic.js";
import { buildPrice } from "../build.js";
import { attachComponent, createComponent, createProduct, getProductDetail, listProducts } from "../catalog.js";
import { createEstimatorCommsListener } from "../comms.js";
import { createEstimate, createPublicEstimate, getEstimateDetail } from "../estimates.js";
import { createEstimatorAdminHandlers } from "../admin-handlers.js";
import type { EstimatorPermission } from "../permissions.js";
import { clientIpKey, createEstimatorHandlers } from "../handlers.js";
import * as pkg from "../index.js";
import { purgeOrphanPhotos } from "../photos.js";
import { priceProduct } from "../price-product.js";
import {
  acceptQuote,
  expireQuotes,
  getQuoteByToken,
  issueQuoteToken,
  peekQuote,
  reviseQuote,
  sendQuote,
} from "../quotes.js";
import { DEFAULT_RAMP_CONFIG, deriveQuantities, parseCustomerInputs, resolveRecipeConfig, type NormalizedObservation } from "../recipes.js";
import { loadSampleCatalog } from "../sample.js";
import { estimatorEstimates, estimatorPhotos, estimatorTakeoffs } from "../schema.js";
import { updateEstimatorSettings } from "../settings.js";
import { runPhotoTakeoff } from "../takeoff-run.js";
import { suggestFromObservation } from "../takeoff.js";
import { EstimatorInputError } from "../types.js";
import { fakeModel, memoryPhotoStore, photo, readJson, recordingSender } from "./fixtures.js";
import { createTestDb, schemaDdl, tenant, type TestDb } from "./pglite.js";

/**
 * The 2026-10-12 review of estimator 0.3 (business owner, security and a
 * foreign-client install): one test per finding, each written to fail on the
 * code as the review found it. The finding id is in every test's name.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb({ comms: true });
});
afterAll(async () => {
  await t.close();
});

const NOW = new Date("2026-11-02T15:00:00Z");
const BASE = "https://summit.test/api/estimator";
const ADMIN = "https://summit.test/api/admin/estimator/v1/admin";
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..", "..");

async function refusal(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EstimatorInputError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("expected a refusal");
}

const SETTINGS = { businessName: "Summit Ramps", contactPhone: "(801) 555-0143", contactEmail: "hello@summit.test", taxRateBp: 725, timeZone: "America/Denver" };

/** A business with the sample catalog, shown on the website, and its settings saved. */
async function shop(options: { settings?: boolean } = {}) {
  const tenantId = tenant("rv");
  await loadSampleCatalog(t.db, tenantId, { showInEstimator: true });
  if (options.settings !== false) await updateEstimatorSettings(t.db, tenantId, SETTINGS);
  const products = await listProducts(t.db, tenantId);
  const id = (name: string) => products.find((p) => p.name === name)!.id;
  return { tenantId, id };
}

function publicApi(tenantId: string, options: Record<string, unknown> = {}) {
  const handlers = createEstimatorHandlers({ db: t.db, tenantId, now: () => NOW, ...options });
  return (method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}) =>
    handlers.handle(
      new Request(`${BASE}${path}`, {
        method,
        headers: { ...(method === "POST" ? { "content-type": "application/json", "sec-fetch-site": "same-origin" } : {}), ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
}

function adminApi(tenantId: string, grants: readonly EstimatorPermission[] | "all", options: Record<string, unknown> = {}) {
  const handlers = createEstimatorAdminHandlers({
    db: t.db,
    tenantId,
    authorize: (_req, permission) => grants === "all" || grants.includes(permission),
    now: () => NOW,
    ...options,
  });
  return (method: "GET" | "POST", path: string, body?: unknown) =>
    handlers.handle(
      new Request(`${ADMIN}/${path}`, {
        method,
        headers: method === "POST" ? { "content-type": "application/json", "sec-fetch-site": "same-origin" } : {},
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
}

const lead = (productId: string, extra: Record<string, unknown> = {}) => ({
  name: "Pat Lee",
  email: "pat@example.test",
  items: [{ productId, inputs: { steps: 3 } }],
  website: "",
  fillMs: 5000,
  ...extra,
});

// ---------------------------------------------------------------------------
// Business owner
// ---------------------------------------------------------------------------

describe("EST-R01: nothing half-built goes public, and nothing is priced at $0", () => {
  it("the sample catalog loads OFF the website: the owner turns each product on", async () => {
    const tenantId = tenant("rv");
    await loadSampleCatalog(t.db, tenantId);
    const products = await listProducts(t.db, tenantId);
    expect(products.length).toBe(5);
    expect(products.every((p) => p.showInEstimator === false)).toBe(true);
  });

  it("a public price of $0 is answered as price-by-quote, never as $0", async () => {
    const { tenantId } = await shop();
    const bare = await createProduct(t.db, { tenantId, name: "Aluminum wheelchair ramp", recipe: "ramp_over_steps", showInEstimator: true });
    const call = publicApi(tenantId);
    const answer = await readJson(await call("POST", "/v1/calculate", { productId: bare.id, inputs: { steps: 3 } }));
    expect(answer.status).toBe("quote_only");
    expect(answer.price).toBeNull();
    const submitted = await call("POST", "/v1/submit", lead(bare.id));
    expect(submitted.status).toBe(201);
    const [line] = (await getEstimateDetail(t.db, tenantId, (await readJson(submitted)).estimateId))!.lines;
    expect(line!.total).toBe(0);
    expect(line!.notes).toMatch(/priced by a person/);
  });

  it("the admin says which products price at $0, and when none is on the website", async () => {
    const tenantId = tenant("rv");
    await updateEstimatorSettings(t.db, tenantId, SETTINGS);
    await createProduct(t.db, { tenantId, name: "Aluminum wheelchair ramp", recipe: "ramp_over_steps", showInEstimator: false });
    const status = await readJson(await adminApi(tenantId, "all")("GET", "status"));
    const codes = status.notices.map((n: { code: string }) => n.code);
    expect(codes).toContain("products_unpriced");
    expect(codes).toContain("nothing_public");
    expect(status.notices.find((n: { code: string }) => n.code === "products_unpriced").message).toContain(
      "Aluminum wheelchair ramp prices at $0",
    );
  });
});

describe("EST-R02: no customer hears from a business with no name or tax rate", () => {
  it("until settings are saved with a business name, the public estimator is closed", async () => {
    const { tenantId, id } = await shop({ settings: false });
    const call = publicApi(tenantId);
    const config = await readJson(await call("GET", "/v1/config"));
    expect(config.instantEstimatesEnabled).toBe(false);
    expect(config.products).toEqual([]);
    const calc = await call("POST", "/v1/calculate", { productId: id("Modular aluminum ramp"), inputs: { steps: 3 } });
    expect(calc.status).toBe(403);
    expect((await readJson(calc)).error.code).toBe("estimates_closed");
    expect((await call("POST", "/v1/submit", lead(id("Modular aluminum ramp")))).status).toBe(403);
    // A save without the business's name is not enough.
    await updateEstimatorSettings(t.db, tenantId, { taxRateBp: 725 });
    expect((await call("POST", "/v1/calculate", { productId: id("Modular aluminum ramp"), inputs: { steps: 3 } })).status).toBe(403);
    await updateEstimatorSettings(t.db, tenantId, { businessName: "Summit Ramps" });
    expect((await call("POST", "/v1/calculate", { productId: id("Modular aluminum ramp"), inputs: { steps: 3 } })).status).toBe(200);
  });

  it("a quote can't be sent until the business has a name and saved settings", async () => {
    const { tenantId, id } = await shop({ settings: false });
    const created = await createEstimate(t.db, { tenantId, customerName: "Pat", customerEmail: "pat@example.test", items: [{ productId: id("Modular aluminum ramp"), inputs: { steps: 3, stepHeightIn: 7 } }] });
    const refused = await refusal(sendQuote(t.db, tenantId, created.id, {}, { now: NOW }));
    expect(refused.code).toBe("settings_incomplete");
    expect(refused.message).toBe("Add your business name and tax rate in Settings first.");
    const viaHttp = await adminApi(tenantId, "all")("POST", `estimates/${created.id}/send`, {});
    expect(viaHttp.status).toBe(409);
    const status = await readJson(await adminApi(tenantId, "all")("GET", "status"));
    expect(status.notices.find((n: { code: string }) => n.code === "settings_not_saved").message).toMatch(/closed/);
  });
});

describe("EST-R03: a total height never silently replaces the step count", () => {
  const config = resolveRecipeConfig("ramp_over_steps", {});
  const issue = (inputs: Record<string, number>) => {
    try {
      parseCustomerInputs("ramp_over_steps", config, inputs);
    } catch (error) {
      if (error instanceof ZodError) return error.issues[0];
      throw error;
    }
    return null;
  };
  it("3 steps and a 12 in total (meant as feet?) is flagged on the total", () => {
    const found = issue({ steps: 3, totalRiseIn: 12 });
    expect(found?.path).toEqual(["inputs", "totalRiseIn"]);
    expect(found?.message).toBe("That's about 4 in a step for 3 steps. Check the total height: it's in inches, from the ground to the door threshold.");
  });
  it("a total that disagrees with the steps (40 in for 3 steps) is flagged", () => {
    expect(issue({ steps: 3, stepHeightIn: 7, totalRiseIn: 40 })?.path).toEqual(["inputs", "totalRiseIn"]);
  });
  it("a total that fits the steps is used", () => {
    expect(issue({ steps: 3, totalRiseIn: 22 })).toBeNull();
    expect(deriveQuantities("ramp_over_steps", config, { steps: 3, totalRiseIn: 22 }).quantities.point["rampFt"]).toBe(22);
  });
});

describe("EST-R04: the reading says what it counted", () => {
  const config = resolveRecipeConfig("ramp_over_steps", {});
  const read: NormalizedObservation = { recipe: "ramp_over_steps", seen: true, risers: 3, riserHeightIn: null, confidence: "medium" };
  it("'We counted 3 steps up', counting the one onto the porch, and a check for a lower count", () => {
    const suggestion = suggestFromObservation("ramp_over_steps", config, read);
    expect(suggestion.lines[0]).toBe("We counted 3 steps up, including the last one onto the porch or landing.");
    expect((suggestion as unknown as { fewerCheck: string | null }).fewerCheck).toBe(
      "Did you count the step up onto the porch or landing? 2 steps and the porch is 3.",
    );
  });
  it("the stepper's help gives the example", () => {
    expect(DEFAULT_RAMP_CONFIG.stepsHelp).toBe("Count every step up, including the last one onto the porch or landing: 2 steps and the porch is 3.");
  });
});

describe("EST-R05: an unmeasured job is priced in the middle, and the quote says what it assumed", () => {
  const config = resolveRecipeConfig("ramp_over_steps", {});
  it("the typical step is the middle of 7–8 in, so 3 steps price at 23 ft", () => {
    expect(DEFAULT_RAMP_CONFIG.stepHeightIn).toEqual({ typical: 7.5, low: 7, high: 8 });
    const derived = deriveQuantities("ramp_over_steps", config, { steps: 3 });
    expect(derived.quantities.point["rampFt"]).toBe(23);
    expect((derived as unknown as { quoteBasis: string }).quoteBasis).toBe("3 steps, 7.5 in each (estimated), 23 ft of ramp");
  });
  it("staff see the warning BEFORE sending, and the quote line says the basis", async () => {
    const { tenantId, id } = await shop();
    const created = await createEstimate(t.db, { tenantId, customerName: "Pat", customerEmail: "pat@example.test", items: [{ productId: id("Modular aluminum ramp"), inputs: { steps: 3 } }] });
    const detail = (await getEstimateDetail(t.db, tenantId, created.id)) as unknown as { sendWarnings: string[] };
    expect(detail.sendWarnings).toEqual([
      "Line 1 (Modular aluminum ramp) is priced at 3 steps, 7.5 in each (estimated), 23 ft of ramp. The range was $6,473 – $7,146 (Step height 7–8 in (estimated)): measure first, or send it as is.",
    ]);
    await sendQuote(t.db, tenantId, created.id, {}, { now: NOW });
    const quote = (await peekQuote(t.db, tenantId, created.id, NOW))!;
    expect(quote.lines[0]!.details[0]).toBe("3 steps, 7.5 in each (estimated), 23 ft of ramp");
  });
});

describe("EST-R06: labor with no rate is called out", () => {
  it("a product with labor hours and a $0 rate gets a notice", async () => {
    const tenantId = tenant("rv");
    await updateEstimatorSettings(t.db, tenantId, SETTINGS);
    const product = await createProduct(t.db, { tenantId, name: "Ramp", recipe: "ramp_over_steps", laborHoursPerUnitMilli: 500, basePrice: 1000 });
    void product;
    const status = await readJson(await adminApi(tenantId, "all")("GET", "status"));
    const notice = status.notices.find((n: { code: string }) => n.code === "labor_rate_zero");
    expect(notice?.message).toBe("Ramp has labor hours but no labor rate, so its labor is priced at $0. Set a rate on the product or a default in Settings.");
  });
});

describe("EST-R07: no customer sentence points 'below'", () => {
  it("the reading and every takeoff answer avoid directions", async () => {
    const config = resolveRecipeConfig("ramp_over_steps", {});
    const texts = [
      ...suggestFromObservation("ramp_over_steps", config, { recipe: "ramp_over_steps", seen: true, risers: 3, riserHeightIn: null, confidence: "low" }).lines,
      ...suggestFromObservation("ramp_over_steps", config, { recipe: "ramp_over_steps", seen: false, risers: null, riserHeightIn: null, confidence: "low" }).lines,
      ...suggestFromObservation("ramp_over_steps", config, { recipe: "ramp_over_steps", seen: true, risers: 40, riserHeightIn: null, confidence: "high" }).lines,
    ];
    const tenantId = tenant("rv");
    await updateEstimatorSettings(t.db, tenantId, { ...SETTINGS, aiDailyBudgetCents: 0 });
    const ramp = await createProduct(t.db, { tenantId, name: "Ramp", recipe: "ramp_over_steps", showInEstimator: true });
    const area = await createProduct(t.db, { tenantId, name: "Pad", recipe: "area", showInEstimator: true });
    for (const productId of [ramp.id, area.id]) {
      const answer = await runPhotoTakeoff(t.db, { tenantId, productId, ...photo(`dir-${productId}`), requesterKey: "ip:1", now: NOW }, { model: fakeModel() });
      if (answer.message) texts.push(answer.message);
    }
    expect(texts.length).toBeGreaterThan(4);
    for (const text of texts) expect(text).not.toMatch(/\bbelow\b/);
  });
});

describe("EST-R09: supplies bought whole are priced whole", () => {
  it("a 'round up' supply prices 6 posts for 21 ft at one per 4 ft, not 5.25", () => {
    const build = buildPrice({
      quantities: { low: { rampFt: 21 }, point: { rampFt: 21 }, high: { rampFt: 21 } },
      primaryKey: "rampFt",
      quantityKinds: { rampFt: "length" },
      supplies: [
        { assignmentId: "a", supplyId: "s", name: "Support post", unitType: "per_unit", unitCost: 4_200, quantityMilli: 250, per: "rampFt", sortOrder: 0, roundUp: true } as never,
      ],
      lump: { basePrice: 0, pricePerSqFt: null, pricePerLinearFt: null, laborCost: 0 },
      labor: { hoursPerUnitMilli: 0, setupHoursMilli: 0, rateCents: 0 },
      wasteBp: 0,
      pricing: { basis: "markup", markupBp: 0 },
      optionModifiers: [],
      quantity: 1,
      minimumCharge: 0,
      range: { mode: "measured", contingencyBp: 0 },
    });
    expect(build.breakdown[0]).toMatchObject({ label: "Support post", quantity: 6, amount: 25_200 });
    expect(build.point).toBe(25_200);
  });
  it("an 'each' supply attached without saying is rounded up; the sample's posts are", async () => {
    const tenantId = tenant("rv");
    const product = await createProduct(t.db, { tenantId, name: "Ramp", recipe: "ramp_over_steps" });
    const post = await createComponent(t.db, { tenantId, name: "Post", unitType: "per_unit", unitCost: 4_200 });
    await attachComponent(t.db, tenantId, { productId: product.id, componentId: post.id, quantityMilli: 250, per: "rampFt" });
    const detail = await getProductDetail(t.db, tenantId, product.id);
    expect((detail!.components[0] as unknown as { roundUp: boolean }).roundUp).toBe(true);
    const { tenantId: shopId, id } = await shop();
    const priced = await priceProduct(t.db, shopId, { productId: id("Modular aluminum ramp"), inputs: { steps: 3, stepHeightIn: 7 } });
    expect(priced.status === "priced" && priced.build.breakdown.find((l) => l.label === "Support post & footing")?.quantity).toBe(6);
  });
});

describe("EST-R10: the photo's step height stays inside the owner's range", () => {
  const config = resolveRecipeConfig("ramp_over_steps", {});
  const reading = (low: number, high: number): NormalizedObservation => ({ recipe: "ramp_over_steps", seen: true, risers: 3, riserHeightIn: { low, high }, confidence: "medium" });
  it("a 9–12 in guess is not priced: the owner's 7–8 in is, and the customer is told", () => {
    const derived = deriveQuantities("ramp_over_steps", config, { steps: 3 }, { reading: reading(9, 12) });
    expect(derived.basis).toBe("assumed");
    expect(derived.quantities.high["rampFt"]).toBe(24);
    expect(derived.assumption).toBe(
      "Based on an estimated step height of 7–8 in (your photo's steps looked 9–12 in). Measure one step and enter it for a tighter estimate.",
    );
  });
  it("an overlapping guess is cut to the owner's range", () => {
    const derived = deriveQuantities("ramp_over_steps", config, { steps: 3 }, { reading: reading(7.5, 8.5) });
    expect(derived.basis).toBe("photo");
    expect(derived.explanation[0]).toBe("3 steps × 7.5–8 in each (from your photo) = 22.5–24 in rise");
  });
  it("the owner can switch the photo's height off", () => {
    const off = resolveRecipeConfig("ramp_over_steps", { usePhotoStepHeight: false });
    expect(deriveQuantities("ramp_over_steps", off, { steps: 3 }, { reading: reading(7.5, 8) }).basis).toBe("assumed");
  });
});

describe("EST-R11: staff read the reading without the customer's instruction", () => {
  it("the staff reading has no 'change the count' sentence", async () => {
    const { tenantId, id } = await shop();
    const model = fakeModel();
    model.fallback = { seen: true, risers: 3, riserHeightIn: null, confidence: "medium" };
    const answer = await runPhotoTakeoff(t.db, { tenantId, productId: id("Modular aluminum ramp"), ...photo("staff-read"), requesterKey: "ip:2", now: NOW }, { model });
    expect(answer.reading?.lines.some((line) => /change/i.test(line))).toBe(true);
    const created = await createPublicEstimate(
      t.db,
      { customerName: "Pat", customerEmail: "pat@example.test", items: [{ productId: id("Modular aluminum ramp"), inputs: { steps: 3 }, takeoffId: answer.reading!.takeoffId }] },
      { tenantId, now: NOW },
    );
    const detail = (await getEstimateDetail(t.db, tenantId, created.id))!;
    expect(detail.lines[0]!.reading!.lines).toEqual(["We counted 3 steps up, including the last one onto the porch or landing."]);
  });
});

describe("EST-R12: the reason photo reading is off, in words an owner can act on", () => {
  it("not installed: ask the developer", async () => {
    const tenantId = tenant("rv");
    await updateEstimatorSettings(t.db, tenantId, SETTINGS);
    const status = await readJson(await adminApi(tenantId, "all", { photoReading: false, photoReadingOff: "not_installed" })("GET", "status"));
    expect(status.notices.find((n: { code: string }) => n.code === "reading_off").message).toBe(
      "Photo reading isn't part of this site. Ask your developer to add it (pnpm dlx @adminigloo/create-app add ai).",
    );
  });
});

describe("EST-R14: the emails say what is actually there", () => {
  it("'1 photo: see it on the estimate', and the customer's copy says how to send a height", async () => {
    const { tenantId, id } = await shop();
    const mail = recordingSender();
    const listener = createEstimatorCommsListener({
      db: t.db,
      senders: mail.senders,
      quoteUrl: (token) => `https://summit.test/quote/${token}`,
      adminEstimateUrl: (estimateId) => `https://summit.test/admin/estimates/${estimateId}`,
      staffEmails: ["office@summit.test"],
      now: () => NOW,
    });
    const store = memoryPhotoStore();
    const call = publicApi(tenantId, { photoStore: store, onEvent: listener.onEvent });
    const kept = await readJson(await call("POST", "/v1/photo", { ...photo("email-photo") }));
    expect((await call("POST", "/v1/submit", lead(id("Modular aluminum ramp"), { photoIds: [kept.photoId] }))).status).toBe(201);
    const office = mail.to("office@summit.test")[0]!.body;
    expect(office).toContain("1 photo: see it on the estimate.");
    expect(office).not.toContain("attached");
    const copy = mail.to("pat@example.test")[0]!.body;
    expect(copy).toContain("Based on an estimated step height of 7–8 in. Reply with the height of one step");
    expect(copy).not.toContain("enter it");
  });
});

// ---------------------------------------------------------------------------
// Security and correctness
// ---------------------------------------------------------------------------

describe("ADV-1: an anonymous visitor can't put words or links into the business's emails", () => {
  it("a public line's description is ignored; the line is the product's name", async () => {
    const { tenantId, id } = await shop();
    const mail = recordingSender();
    const listener = createEstimatorCommsListener({ db: t.db, senders: mail.senders, quoteUrl: (token) => `https://summit.test/quote/${token}`, staffEmails: ["office@summit.test"], now: () => NOW });
    const call = publicApi(tenantId, { onEvent: listener.onEvent });
    const body = lead(id("Modular aluminum ramp"), {
      email: "victim@example.test",
      items: [{ productId: id("Modular aluminum ramp"), inputs: { steps: 3 }, description: "Your card was declined - update it at https://evil.example/pay now" }],
    });
    const response = await call("POST", "/v1/submit", body);
    expect(response.status).toBe(201);
    const detail = (await getEstimateDetail(t.db, tenantId, (await readJson(response)).estimateId))!;
    expect(detail.lines[0]!.description).toBe("Modular aluminum ramp");
    const copy = mail.to("victim@example.test")[0]!;
    expect(copy.body).not.toMatch(/evil|declined/);
    expect(copy.html ?? "").not.toMatch(/evil\.example/);
  });
});

describe("ADV-2: accept is tied to the version the customer saw, and old links stop working", () => {
  it("an accept from the first version is refused after a revise and re-send; the first link no longer opens", async () => {
    const { tenantId, id } = await shop();
    const created = await createEstimate(t.db, { tenantId, customerName: "Pat", customerEmail: "pat@example.test", items: [{ productId: id("Modular aluminum ramp"), inputs: { steps: 3, stepHeightIn: 7 } }] });
    await sendQuote(t.db, tenantId, created.id, {}, { now: NOW });
    const v1 = (await issueQuoteToken(t.db, tenantId, created.id))!;
    const seen = (await getQuoteByToken(t.db, tenantId, v1, { now: NOW }))!;
    expect((seen as unknown as { version: number }).version).toBe(1);
    await reviseQuote(t.db, tenantId, created.id, { now: NOW });
    await sendQuote(t.db, tenantId, created.id, {}, { now: NOW });
    const v2 = (await issueQuoteToken(t.db, tenantId, created.id))!;
    // The page the customer still has open says version 1.
    const stale = await refusal(acceptQuote(t.db, tenantId, v2, { name: "Pat", version: 1 } as never, { now: NOW }));
    expect(stale.code).toBe("quote_changed");
    expect(stale.message).toBe("This quote changed since you opened it. Here's the new one; check it before you accept.");
    // The link from the first email is dead.
    expect(await getQuoteByToken(t.db, tenantId, v1, { now: NOW })).toBeNull();
    const accepted = await acceptQuote(t.db, tenantId, v2, { name: "Pat", version: 2 } as never, { now: NOW });
    expect(accepted?.status).toBe("accepted");
  });

  it("the public accept route requires the version", async () => {
    const { tenantId, id } = await shop();
    const created = await createEstimate(t.db, { tenantId, customerName: "Pat", customerEmail: "pat@example.test", items: [{ productId: id("Modular aluminum ramp"), inputs: { steps: 3, stepHeightIn: 7 } }] });
    await sendQuote(t.db, tenantId, created.id, {}, { now: NOW });
    const token = (await issueQuoteToken(t.db, tenantId, created.id))!;
    const response = await publicApi(tenantId)("POST", `/v1/quote/${token}/accept`, { name: "Pat" });
    expect(response.status).toBe(400);
  });
});

describe("ADV-3: staff without the costs permission can't read costs", () => {
  const office: EstimatorPermission[] = ["estimator.view", "estimator.estimates.manage"];
  it("a preview with draft cost fields is refused; settings and products come back without cost knobs", async () => {
    const { tenantId, id } = await shop();
    await updateEstimatorSettings(t.db, tenantId, { defaultLaborRateCents: 8_500 });
    const call = adminApi(tenantId, office);
    const product = await getProductDetail(t.db, tenantId, id("Modular aluminum ramp"));
    const supplyId = product!.components[0]!.component.id;
    const preview = await call("POST", "products/preview", {
      draft: { name: "x", recipe: "count", markupBp: 0, wasteBp: 0, minimumCharge: 0, supplies: [{ supplyId, quantityMilli: 1000, per: "job" }] },
      inputs: { count: 1 },
    });
    expect(preview.status).toBe(403);
    const saved = await readJson(await call("POST", "products/preview", { productId: id("Modular aluminum ramp"), inputs: { steps: 3 } }));
    expect(saved.breakdown).toBeNull();
    expect(saved.customerView.low).toBe(647_262);
    const settings = await readJson(await call("GET", "settings"));
    expect(settings.settings.defaultLaborRateCents).toBeNull();
    const products = await readJson(await call("GET", "products"));
    const ramp = products.products.find((p: { name: string }) => p.name === "Modular aluminum ramp");
    expect([ramp.markupBp, ramp.marginBp, ramp.wasteBp]).toEqual([null, null, null]);
  });
});

describe("ADV-4: readings in progress count against the day's budget", () => {
  it("20 visitors at once on a 1-cent budget make at most 3 model calls", async () => {
    const { tenantId, id } = await shop();
    await updateEstimatorSettings(t.db, tenantId, { aiDailyBudgetCents: 1, aiPerRequesterDaily: 5 });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = fakeModel({}, { inputTokens: 900, outputTokens: 40 });
    const read = model.read.bind(model);
    model.read = async (request) => {
      const answer = read(request);
      await gate;
      return answer;
    };
    const runs: Array<Promise<unknown>> = [];
    let settled = 0;
    for (let i = 0; i < 20; i += 1) {
      runs.push(
        runPhotoTakeoff(t.db, { tenantId, productId: id("Modular aluminum ramp"), ...photo(`burst-${i}`), requesterKey: `ip:10.0.0.${i}`, now: NOW }, { model }).finally(() => {
          settled += 1;
        }),
      );
    }
    // Hold every reading until ALL 20 have passed the budget check: each one
    // is either refused (settled) or waiting in the model. Releasing earlier —
    // the old 15 ms spacing, on a busy CI machine — let a late request see the
    // first readings already corrected from their ceiling to their real cost,
    // which honestly leaves room for a 4th call within the same 1 cent.
    for (let waited = 0; settled + model.calls.length < 20; waited += 10) {
      if (waited > 20_000) throw new Error(`only ${settled + model.calls.length} of 20 requests reached the budget check`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    release();
    const answers = (await Promise.all(runs)) as Array<{ status: string }>;
    expect(model.calls.length).toBeLessThanOrEqual(3);
    expect(answers.filter((a) => a.status === "paused").length).toBeGreaterThanOrEqual(17);
    const [spent] = await t.client.query<{ micros: string }>(
      `select coalesce(sum(cost_micros), 0)::text as micros from estimator_takeoffs where tenant_id = $1`,
      [tenantId],
    ).then((r) => r.rows);
    expect(Number(spent!.micros)).toBeLessThanOrEqual(10_000);
  });
});

describe("ADV-5: photo storage is capped per visitor, and the clean-up keeps up", () => {
  it("a visitor over the day's photo cap is refused", async () => {
    const { tenantId } = await shop();
    const store = memoryPhotoStore();
    const call = publicApi(tenantId, { photoStore: store, photoLimits: { perRequesterDaily: 2 } });
    const headers = { "x-forwarded-for": "198.51.100.7" };
    expect((await call("POST", "/v1/photo", photo("cap-1"), headers)).status).toBe(201);
    expect((await call("POST", "/v1/photo", photo("cap-2"), headers)).status).toBe(201);
    const third = await call("POST", "/v1/photo", photo("cap-3"), headers);
    expect(third.status).toBe(400);
    expect((await readJson(third)).error.code).toBe("photo_limit");
    expect(store.puts).toBe(2);
    // Someone else still can.
    expect((await call("POST", "/v1/photo", photo("cap-4"), { "x-forwarded-for": "198.51.100.8" })).status).toBe(201);
  });

  it("the clean-up runs batches until the orphans are gone or its time is up", async () => {
    const tenantId = tenant("rv");
    const store = memoryPhotoStore();
    const old = new Date(NOW.getTime() - 72 * 60 * 60 * 1000);
    const rows = Array.from({ length: 250 }, (_, i) => ({
      tenantId,
      fileId: `f-${i}`,
      url: `https://files.test/${i}`,
      contentType: "image/jpeg",
      sizeBytes: 10,
      width: 10,
      height: 10,
      sha256: `h-${i}`,
      source: "public",
      createdAt: old,
    }));
    await t.db.insert(estimatorPhotos).values(rows);
    const result = await purgeOrphanPhotos(t.db, store, { now: NOW, timeBudgetMs: 30_000 } as never);
    expect(result.deleted).toBe(250);
    expect((await t.db.select().from(estimatorPhotos).where(eq(estimatorPhotos.tenantId, tenantId))).length).toBe(0);
  });
});

describe("ADV-6: a reading gives up well inside the route's time", () => {
  it("one call, at most 12 seconds, no retry", async () => {
    let seen: unknown = null;
    const runner = createAnthropicTakeoffRunner({
      client: {
        messages: {
          create: async (_body: unknown, options: unknown) => {
            seen = options;
            return { stop_reason: "end_turn", content: [{ type: "text", text: "{}" }], usage: { input_tokens: 1, output_tokens: 1 } };
          },
        },
      } as never,
    });
    await runner.read({ system: "s", prompt: "p", schema: {}, image: { base64: "AA==", mediaType: "image/jpeg" }, maxTokens: 150 });
    expect(seen).toEqual({ timeout: 12_000, maxRetries: 0 });
  });
});

describe("ADV-7: an expiry that was cut off is still announced", () => {
  it("quotes marked expired by a run that died are announced by the next run", async () => {
    const { tenantId, id } = await shop();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const created = await createEstimate(t.db, { tenantId, customerName: `C${i}`, customerEmail: `c${i}@example.test`, items: [{ productId: id("Modular aluminum ramp"), inputs: { steps: 3, stepHeightIn: 7 } }] });
      await sendQuote(t.db, tenantId, created.id, { validDays: 1 }, { now: NOW });
      ids.push(created.id);
    }
    const later = new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000);
    // The first run is killed while its second email is being sent.
    let calls = 0;
    const dying = expireQuotes(t.db, tenantId, {
      now: later,
      onEvent: () => {
        calls += 1;
        return calls === 1 ? undefined : new Promise(() => undefined);
      },
    });
    void dying;
    await new Promise((resolve) => setTimeout(resolve, 200));
    const [counted] = (await t.client.query<{ n: number }>(`select count(*)::int as n from estimator_estimates where tenant_id = $1 and status = 'expired'`, [tenantId])).rows;
    expect(counted!.n).toBe(3);
    const heard: string[] = [];
    await expireQuotes(t.db, tenantId, { now: later, onEvent: (event) => void heard.push(event.estimateId) });
    expect(heard.length).toBe(2);
    expect(ids).toEqual(expect.arrayContaining(heard));
  });
});

describe("ADV-8: links a visitor typed aren't clickable in the office's email", () => {
  it("the notes are defanged in the new-lead email", async () => {
    const { tenantId, id } = await shop();
    const mail = recordingSender();
    const listener = createEstimatorCommsListener({ db: t.db, senders: mail.senders, quoteUrl: (token) => `https://summit.test/quote/${token}`, staffEmails: ["office@summit.test"], now: () => NOW });
    const call = publicApi(tenantId, { onEvent: listener.onEvent });
    await call("POST", "/v1/submit", lead(id("Modular aluminum ramp"), { notes: "Your Vercel account is suspended, sign in at https://evil.example/login" }));
    const office = mail.to("office@summit.test")[0]!;
    expect(office.body).toContain("evil[.]example");
    expect(office.body).not.toContain("https://evil.example");
  });
});

// ---------------------------------------------------------------------------
// A foreign client (Ridgeline)
// ---------------------------------------------------------------------------

describe("RL-02: an existing price list can feed the supplies", () => {
  it("upsert by your own reference, managed outside: the admin can't change its cost; changes are announced", async () => {
    const { tenantId } = await shop();
    const upsert = (pkg as unknown as { upsertComponentByRef: (...args: unknown[]) => Promise<{ id: string; unitCost: number; managedExternally: boolean }> }).upsertComponentByRef;
    expect(typeof upsert).toBe("function");
    const first = await upsert(t.db, tenantId, "SVC-100", { name: "Ramp section (Ridgeline)", unitType: "per_linear_ft", unitCost: 9_000 });
    const second = await upsert(t.db, tenantId, "SVC-100", { name: "Ramp section (Ridgeline)", unitType: "per_linear_ft", unitCost: 9_900 });
    expect(second.id).toBe(first.id);
    expect(second.unitCost).toBe(9_900);
    expect(second.managedExternally).toBe(true);
    const changes: unknown[] = [];
    const call = adminApi(tenantId, "all", { onPriceBookChange: (change: unknown) => void changes.push(change) });
    const refused = await call("POST", `supplies/${first.id}`, { unitCost: 1 });
    expect(refused.status).toBe(409);
    expect((await readJson(refused)).error.code).toBe("managed_externally");
    const renamed = await call("POST", "supplies", { name: "Gravel", unitType: "flat", unitCost: 500 });
    expect(renamed.status).toBe(201);
    expect(changes).toEqual([expect.objectContaining({ tenantId, kind: "supply", action: "created" })]);
  });
});

describe("RL-03: the package loads without a Neon driver", () => {
  it("nothing in the estimator imports the @adminigloo/db barrel, and it isn't a dependency", () => {
    const sources = ["events.ts", "schema.ts", "columns.ts"]
      .map((file) => join(packageRoot, "src", file))
      .map((path) => {
        try {
          return readFileSync(path, "utf8");
        } catch {
          return "";
        }
      });
    for (const source of sources) expect(source).not.toMatch(/from "@adminigloo\/db"/);
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain("@adminigloo/db");
  });
});

describe("RL-04: the zod the types are built for", () => {
  it("the peer range is zod 4, as the .d.ts files are", () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { peerDependencies: Record<string, string> };
    expect(manifest.peerDependencies["zod"]).toBe("^4.0.0");
  });
});

describe("RL-06: behind Cloudflare, the visitor is the one Cloudflare saw", () => {
  it("cloudflare: true reads CF-Connecting-IP", () => {
    const req = new Request("https://x.test/", { headers: { "x-forwarded-for": "203.0.113.9, 172.70.1.1", "cf-connecting-ip": "203.0.113.9" } });
    expect(clientIpKey(req, { cloudflare: true } as never)).toBe("ip:203.0.113.9");
    expect(clientIpKey(req)).toBe("ip:172.70.1.1");
  });
});

describe("RL-01: a host whose migrations aren't drizzle's can install from the README", () => {
  it("the README's fresh-install SQL creates exactly the package's tables", async () => {
    const readme = readFileSync(join(packageRoot, "README.md"), "utf8");
    const block = /<!-- fresh-install-sql -->\s*```sql\n([\s\S]*?)```/.exec(readme);
    expect(block, "the README has a fresh-install SQL block").not.toBeNull();
    const { PGlite } = await import("@electric-sql/pglite");
    const fresh = new PGlite();
    const generated = new PGlite();
    try {
      await fresh.exec("create schema adminigloo; set search_path to adminigloo;");
      await fresh.exec(block![1]!);
      await generated.exec("create schema adminigloo; set search_path to adminigloo;");
      for (const statement of schemaDdl()) await generated.exec(statement);
      const columns = async (db: InstanceType<typeof PGlite>) =>
        (
          await db.query<{ t: string; c: string; d: string; n: string }>(
            "select table_name as t, column_name as c, data_type as d, is_nullable as n from information_schema.columns where table_schema = 'adminigloo' order by 1, 2",
          )
        ).rows;
      expect(await columns(fresh)).toEqual(await columns(generated));
    } finally {
      await fresh.close();
      await generated.close();
    }
  });
});

describe("RL-05 … RL-10: what a foreign host needs is written down", () => {
  const server = () => readFileSync(join(packageRoot, "README.md"), "utf8");
  const widget = () => readFileSync(join(packageRoot, "..", "estimator-widget", "README.md"), "utf8");
  it("RL-06: requesterKey and trustProxy, with the shared bucket", () => {
    expect(server()).toContain("createClientIpKey({ trustProxy:");
    expect(server()).toMatch(/one shared bucket/);
  });
  it("RL-07: a cron route with its secret, and a GitHub Actions schedule", () => {
    expect(server()).toContain("Authorization: Bearer");
    expect(server()).toContain("on:\n  schedule:");
  });
  it("RL-08: one install block (repo .npmrc scope, token from the environment) and Docker", () => {
    for (const readme of [server(), widget()]) {
      expect(readme).toContain("//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}");
      expect(readme).toContain("RUN --mount=type=secret,id=npmrc,target=/root/.npmrc");
    }
  });
  it("RL-05, RL-09: the CSP directives and the no-flash server-rendered style", () => {
    expect(widget()).toMatch(/img-src[^\n]*data:/);
    expect(widget()).toContain('<style id="aiew-styles" nonce={nonce}>');
    expect(widget()).not.toContain("never flashes");
  });
  it("RL-10: the wire is documented in the package, and an unlimited host is warned", () => {
    expect(widget()).not.toContain("docs/estimator-0.3-contract.md");
    expect(server()).toContain("Without `rateLimit` every public route is unlimited");
  });
});

// The review's tables, for the RL-01 test's comparison.
void estimatorEstimates;
void estimatorTakeoffs;
