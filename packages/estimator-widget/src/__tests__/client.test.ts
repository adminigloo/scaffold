import { describe, expect, it } from "vitest";
import { createEstimatorAdminClient } from "../admin/client.js";
import { createEstimatorClient } from "../client.js";
import { joinUrl, toClientError } from "../http.js";
import { EstimatorTransport } from "../transport.js";
import { adminRamp, CONFIG, estimate, PRICE_ASSUMED, quote, READING, settingsWire, STATUS } from "./fakes.js";

/**
 * The transports (contract 9.1): exact URLs and methods; no custom header on
 * a same-origin GET; the embed key on EVERY request when there is one; JSON on
 * a POST; and never a throw — a thrown fetch is `network` (status 0), a
 * proxy's HTML page is `bad_response`, the contract's error body is its own
 * code with its issues.
 */

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    seen.push({
      url,
      method: init.method ?? "GET",
      headers: (init.headers as Record<string, string> | undefined) ?? {},
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return answer(url, init);
  }) as typeof fetch;
  return { fetchImpl, seen };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("joinUrl", () => {
  it("puts exactly one slash between base and path", () => {
    expect(joinUrl("/api/estimator/", "/v1/config")).toBe("/api/estimator/v1/config");
    expect(joinUrl("https://x.test/api", "v1/config")).toBe("https://x.test/api/v1/config");
  });
});

describe("createEstimatorClient", () => {
  it("same-origin: GETs carry no custom header, POSTs send JSON, every URL is exact and tokens are encoded", async () => {
    const { fetchImpl, seen } = fakeFetch((url) => {
      if (url.endsWith("/v1/config")) return json(CONFIG);
      if (url.endsWith("/v1/calculate")) return json({ status: "priced", missing: [], price: PRICE_ASSUMED, result: null });
      if (url.endsWith("/v1/photo")) return json({ photoId: "ph_1" }, 201);
      if (url.endsWith("/v1/takeoff")) return json({ status: "read", reading: READING, photoId: "ph_1", message: null, cached: false, available: true, result: null });
      if (url.endsWith("/v1/submit")) return json({ estimateId: "e1", estimateNumber: "EST-0001", range: { low: 1, high: 2, single: false }, currency: "USD", emailed: true, id: "e1", subtotal: 2, taxAmount: 0, total: 2 }, 201);
      return json({ quote: quote() });
    });
    const client = createEstimatorClient({ baseUrl: "https://summitramps.test/api/estimator/", fetch: fetchImpl });
    const config = await client.config();
    expect(config.ok && config.data.products.map((p) => p.id)).toEqual(["p-ramp", "p-pad", "p-else"]);
    await client.calculate({ productId: "p-ramp", inputs: { steps: 3 } });
    await client.photo({ imageBase64: "QUJD", mediaType: "image/jpeg" });
    await client.takeoff({ productId: "p-ramp", imageBase64: "QUJD", mediaType: "image/jpeg", inputs: {} });
    await client.submit({ name: "Pat", email: "pat@example.com", items: [{ productId: "p-ramp" }], fillMs: 4000 });
    await client.quote("tok/en+1");
    await client.acceptQuote("tok/en+1", { version: 1, name: "Pat" });
    await client.declineQuote("tok/en+1", { version: 1 });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "GET https://summitramps.test/api/estimator/v1/config",
      "POST https://summitramps.test/api/estimator/v1/calculate",
      "POST https://summitramps.test/api/estimator/v1/photo",
      "POST https://summitramps.test/api/estimator/v1/takeoff",
      "POST https://summitramps.test/api/estimator/v1/submit",
      "GET https://summitramps.test/api/estimator/v1/quote/tok%2Fen%2B1",
      "POST https://summitramps.test/api/estimator/v1/quote/tok%2Fen%2B1/accept",
      "POST https://summitramps.test/api/estimator/v1/quote/tok%2Fen%2B1/decline",
    ]);
    expect(seen[0]!.headers).toEqual({});
    expect(seen[5]!.headers).toEqual({});
    for (const post of seen.filter((s) => s.method === "POST")) {
      expect(post.headers).toEqual({ "content-type": "application/json" });
    }
    expect(seen[1]!.body).toEqual({ productId: "p-ramp", inputs: { steps: 3 } });
  });

  it("keyed: every request, GETs too, carries the embed key", async () => {
    const { fetchImpl, seen } = fakeFetch((url) => (url.endsWith("/config") ? json(CONFIG) : json({ quote: quote() })));
    const client = createEstimatorClient({ baseUrl: "https://summitramps.test/api/estimator", clientKey: "esk_live_1", fetch: fetchImpl });
    await client.config();
    await client.quote("t");
    await client.acceptQuote("t", { version: 1 });
    for (const request of seen) expect(request.headers["x-adminigloo-key"]).toBe("esk_live_1");
  });

  it("never throws: a dead network, an HTML page, a bad shape and the contract's error body each come back as a value", async () => {
    const dead = createEstimatorClient({ baseUrl: "/api/estimator", fetch: (async () => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch });
    expect(await dead.config()).toEqual({ ok: false, error: { code: "network", message: "Couldn't reach the server. Check your internet connection and try again.", status: 0 } });

    const html = createEstimatorClient({ baseUrl: "/api/estimator", fetch: (async () => new Response("<html>Bad gateway</html>", { status: 502 })) as typeof fetch });
    const h = await html.calculate({ productId: "p" });
    expect(!h.ok && h.error.code).toBe("bad_response");
    expect(!h.ok && h.error.status).toBe(502);

    const weird = createEstimatorClient({ baseUrl: "/api/estimator", fetch: (async () => json({ hello: "world" })) as typeof fetch });
    const w = await weird.config();
    expect(!w.ok && w.error.code).toBe("bad_response");

    const refused = createEstimatorClient({
      baseUrl: "/api/estimator",
      fetch: (async () =>
        json({ error: { code: "invalid", message: "Check the highlighted fields.", issues: [{ path: ["inputs", "steps"], message: "Enter a number from 1 to 20." }] } }, 400)) as typeof fetch,
    });
    const r = await refused.calculate({ productId: "p-ramp", inputs: { steps: 40 } });
    expect(r).toEqual({
      ok: false,
      error: { code: "invalid", message: "Check the highlighted fields.", status: 400, issues: [{ path: ["inputs", "steps"], message: "Enter a number from 1 to 20." }] },
    });
  });

  it("a 401 is 'unauthorized' (a bad key), with or without the contract's body", () => {
    expect(toClientError(401, { error: { code: "unauthorized", message: "This estimator key isn't valid. Ask the business for a new one." } })).toEqual({
      code: "unauthorized",
      message: "This estimator key isn't valid. Ask the business for a new one.",
      status: 401,
    });
    expect(toClientError(401, "Sign in").code).toBe("unauthorized");
    expect(toClientError(403, { error: { code: "origin_not_allowed", message: "x" } }).code).toBe("origin_not_allowed");
    expect(toClientError(500, { error: { code: "made_up", message: "x" } }).code).toBe("bad_response");
  });

  it("parses narrowly: unknown field kinds are dropped, a 'priced' answer without a price is a bad answer", async () => {
    const config = {
      ...CONFIG,
      products: [{ ...CONFIG.products[0], fields: [...CONFIG.products[0]!.fields, { key: "x", kind: "slider", label: "X" }] }],
    };
    const client = createEstimatorClient({
      baseUrl: "/e",
      fetch: (async (url: RequestInfo | URL) => (String(url).endsWith("/config") ? json(config) : json({ status: "priced", missing: [], price: null, result: null }))) as typeof fetch,
    });
    const c = await client.config();
    expect(c.ok && c.data.products[0]!.fields.map((f) => f.key)).toEqual(["steps", "stepHeightIn", "totalRiseIn"]);
    const p = await client.calculate({ productId: "p-ramp" });
    expect(!p.ok && p.error.code).toBe("bad_response");
  });
});

describe("EstimatorTransport (0.1, deprecated)", () => {
  it("keeps 0.1's method shapes over the new client: lists, a legacy range, a number — never a throw", async () => {
    const { fetchImpl } = fakeFetch((url) => {
      if (url.endsWith("/config")) return json(CONFIG);
      if (url.endsWith("/options")) return json({ options: CONFIG.products[0]!.options });
      if (url.endsWith("/calculate")) return json({ status: "priced", missing: [], price: PRICE_ASSUMED, result: { sqFt: 0, linearFt: 21, units: 1, subtotal: 644_396, estimateLow: 644_396, estimateHigh: 716_352 } });
      if (url.endsWith("/submit")) return json({ estimateId: "e1", estimateNumber: "EST-0009", range: { low: 1, high: 1, single: true }, currency: "USD", emailed: false, id: "e1", subtotal: 1, taxAmount: 0, total: 1 }, 201);
      return json({ status: "unavailable", reading: null, photoId: null, message: "x", cached: false, available: false, result: null });
    });
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const t = new EstimatorTransport("https://summitramps.test/api/estimator", "esk_1");
      expect((await t.config()).map((p) => p.measurementMode)).toEqual(["linear", "area", "unit"]);
      expect((await t.options("p-ramp")).map((o) => o.name)).toEqual(["Surface"]);
      expect(await t.calculate({ productId: "p-ramp", measurement: { linearFt: 21 }, quantity: 1, optionValueIds: [] })).toMatchObject({ estimateLow: 644_396 });
      expect(await t.submit({ customerName: "Pat", customerEmail: "pat@example.com", items: [{ productId: "p-ramp", description: "Ramp", measurement: { linearFt: 21 }, quantity: 1, optionValueIds: [] }] })).toEqual({
        estimateNumber: "EST-0009",
      });
      expect(await t.takeoff({ productId: "p-ramp", imageBase64: "x", mediaType: "image/jpeg" })).toEqual({ available: false, result: null });
    } finally {
      globalThis.fetch = original;
    }
    const dead = new EstimatorTransport("/x");
    globalThis.fetch = (async () => Promise.reject(new Error("down"))) as typeof fetch;
    try {
      expect(await dead.config()).toEqual([]);
      expect(await dead.calculate({ productId: "p", measurement: {}, quantity: 1, optionValueIds: [] })).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("createEstimatorAdminClient", () => {
  it("speaks every staff route at its exact path and method (contract 8.3)", async () => {
    const product = adminRamp();
    const est = estimate();
    const { fetchImpl, seen } = fakeFetch((url) => {
      const path = url.replace("https://x.test/api/admin/estimator/v1/admin/", "");
      if (path.startsWith("status")) return json(STATUS);
      if (path.startsWith("usage")) return json({ model: "claude-haiku-4-5", days: [], totals: { readings: 0, costMicros: 0, averageCostMicros: 0 } });
      if (path.startsWith("settings")) return json({ settings: settingsWire() });
      if (path === "products" || path.startsWith("products?") || path === "products/reorder") return json({ products: [product], product });
      if (path === "products/preview") return json({ fields: product.fields, status: "needs_inputs", missing: ["steps"], customerView: null, breakdown: null });
      if (path.startsWith("products/") || path.startsWith("options/") || path.startsWith("option-values/")) return json({ product });
      if (path.startsWith("supplies?") || path === "supplies") return json({ supplies: [], supply: { id: "s1", name: "x", unitType: "flat", unitCost: 1, supplier: null, sku: null, note: null, isActive: true, usedBy: [], createdAt: "", updatedAt: "" } });
      if (path.startsWith("supplies/")) return json({ supply: { id: "s1", name: "x", unitType: "flat", unitCost: 1, isActive: true, usedBy: [] }, affectedProducts: [] });
      if (path === "sample-catalog") return json({ products: 5, supplies: 10 });
      if (path.startsWith("estimates?") || path === "estimates?filter=all") return json({ estimates: [], nextCursor: null, counts: {} });
      if (path.endsWith("/link")) return json({ url: "https://x.test/quote/t" });
      if (path.endsWith("/convert")) return json({ invoice: { id: "i1", number: "INV-1", status: "draft", url: null }, estimate: est });
      if (path.startsWith("estimates")) return json({ estimate: est, warnings: [] });
      if (path === "expire") return json({ expired: 2 });
      if (path === "keys") return json({ keys: [], key: { id: "k1", label: "x", keyPrefix: "esk", allowedOrigins: [], revokedAt: null, lastUsedAt: null, createdAt: "" }, plaintext: "esk_x" });
      if (path.startsWith("keys/")) return json({ key: { id: "k1", label: "x", keyPrefix: "esk", allowedOrigins: [], revokedAt: null, lastUsedAt: null, createdAt: "" } });
      return json({}, 404);
    });
    const c = createEstimatorAdminClient({ baseUrl: "https://x.test/api/admin/estimator", fetch: fetchImpl });
    const results = await Promise.all([
      c.status(),
      c.usage({ days: 7 }),
      c.getSettings(),
      c.updateSettings({ taxRateBp: 725 }),
      c.listProducts({ includeInactive: true }),
      c.createProduct({ name: "Ramp", recipe: "ramp_over_steps" }),
      c.reorderProducts(["a", "b"]),
      c.preview({ productId: "p/1" }),
      c.getProduct("p/1"),
      c.updateProduct("p1", { name: "R" }),
      c.deactivateProduct("p1"),
      c.reactivateProduct("p1"),
      c.attachSupply("p1", { supplyId: "s1", quantityMilli: 1000, per: "rampFt" }),
      c.updateAttachment("p1", "a1", { quantityMilli: 2000 }),
      c.removeAttachment("p1", "a1"),
      c.createOption("p1", { name: "Surface" }),
      c.updateOption("o1", { name: "Finish" }),
      c.removeOption("o1"),
      c.createOptionValue("o1", { label: "Heavy" }),
      c.updateOptionValue("v1", { label: "Heavy-duty" }),
      c.setDefaultOptionValue("v1"),
      c.removeOptionValue("v1"),
      c.listSupplies({ includeInactive: true }),
      c.createSupply({ name: "Rail", unitType: "per_linear_ft", unitCost: 1800 }),
      c.updateSupply("s1", { unitCost: 1900 }),
      c.deactivateSupply("s1"),
      c.reactivateSupply("s1"),
      c.loadSampleCatalog(),
      c.listEstimates({ filter: "sent", q: " Pat ", source: "photo", cursor: "c1", limit: 20 }),
      c.createEstimate({}),
      c.getEstimate("e1"),
      c.updateEstimate("e1", { discount: 100 }),
      c.addLine("e1", { description: "x", unitPrice: 100 }),
      c.updateLine("e1", "i1", { quantity: 2 }),
      c.removeLine("e1", "i1"),
      c.addPhoto("e1", { imageBase64: "x", mediaType: "image/jpeg" }),
      c.removePhoto("e1", "ph1"),
      c.sendQuote("e1", { validDays: 30 }),
      c.resendQuote("e1"),
      c.reviseQuote("e1"),
      c.setStatus("e1", { status: "approved" }),
      c.quoteLink("e1"),
      c.archive("e1"),
      c.unarchive("e1"),
      c.duplicate("e1"),
      c.convert("e1"),
      c.expire(),
      c.listKeys(),
      c.issueKey({ label: "Main" }),
      c.updateKey("k1", { allowedOrigins: [] }),
      c.revokeKey("k1"),
    ]);
    for (const [i, result] of results.entries()) expect(result.ok, `call ${i} (${seen[i]?.url})`).toBe(true);
    const A = "https://x.test/api/admin/estimator/v1/admin/";
    expect(seen.map((s) => `${s.method} ${s.url.replace(A, "")}`)).toEqual([
      "GET status",
      "GET usage?days=7",
      "GET settings",
      "POST settings",
      "GET products?include=inactive",
      "POST products",
      "POST products/reorder",
      "POST products/preview",
      "GET products/p%2F1",
      "POST products/p1",
      "POST products/p1/deactivate",
      "POST products/p1/reactivate",
      "POST products/p1/supplies",
      "POST products/p1/supplies/a1",
      "POST products/p1/supplies/a1/remove",
      "POST products/p1/options",
      "POST options/o1",
      "POST options/o1/remove",
      "POST options/o1/values",
      "POST option-values/v1",
      "POST option-values/v1/default",
      "POST option-values/v1/remove",
      "GET supplies?include=inactive",
      "POST supplies",
      "POST supplies/s1",
      "POST supplies/s1/deactivate",
      "POST supplies/s1/reactivate",
      "POST sample-catalog",
      "GET estimates?filter=sent&q=Pat&source=photo&cursor=c1&limit=20",
      "POST estimates",
      "GET estimates/e1",
      "POST estimates/e1",
      "POST estimates/e1/items",
      "POST estimates/e1/items/i1",
      "POST estimates/e1/items/i1/remove",
      "POST estimates/e1/photos",
      "POST estimates/e1/photos/ph1/remove",
      "POST estimates/e1/send",
      "POST estimates/e1/resend",
      "POST estimates/e1/revise",
      "POST estimates/e1/status",
      "POST estimates/e1/link",
      "POST estimates/e1/archive",
      "POST estimates/e1/unarchive",
      "POST estimates/e1/duplicate",
      "POST estimates/e1/convert",
      "POST expire",
      "GET keys",
      "POST keys",
      "POST keys/k1",
      "POST keys/k1/revoke",
    ]);
    // Same-origin admin GETs carry no custom header (no preflight); POSTs send JSON.
    for (const s of seen) expect(s.headers).toEqual(s.method === "POST" ? { "content-type": "application/json" } : {});
    expect(seen.find((s) => s.url.endsWith("products/reorder"))!.body).toEqual({ ids: ["a", "b"] });
  });

  it("a signed-out session (401, or a redirect to an HTML sign-in page) reads as signed out", async () => {
    const c401 = createEstimatorAdminClient({ baseUrl: "/a", fetch: (async () => new Response("Sign in", { status: 401 })) as typeof fetch });
    const r = await c401.status();
    expect(!r.ok && r.error).toEqual({ code: "unauthorized", message: "You've been signed out. Sign in again to keep working.", status: 401 });
    const redirected = new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } });
    Object.defineProperty(redirected, "redirected", { value: true });
    const cRedirect = createEstimatorAdminClient({ baseUrl: "/a", fetch: (async () => redirected) as typeof fetch });
    const r2 = await cRedirect.getSettings();
    expect(!r2.ok && r2.error.status).toBe(401);
  });

  it("keeps a product's costs null when the server stripped them", async () => {
    const stripped = { ...adminRamp(), labor: { hoursPerUnitMilli: 350, setupHoursMilli: 2000, rateCents: null, effectiveRateCents: null }, lumpCosts: null, supplies: [{ ...adminRamp().supplies[0]!, unitCost: null }] };
    const c = createEstimatorAdminClient({ baseUrl: "/a", fetch: (async () => json({ product: stripped })) as typeof fetch });
    const r = await c.getProduct("p-ramp");
    expect(r.ok && r.data.product.labor.rateCents).toBeNull();
    expect(r.ok && r.data.product.lumpCosts).toBeNull();
    expect(r.ok && r.data.product.supplies[0]!.unitCost).toBeNull();
  });
});
