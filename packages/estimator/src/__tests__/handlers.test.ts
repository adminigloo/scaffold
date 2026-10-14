import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listProducts } from "../catalog.js";
import { createEstimate } from "../estimates.js";
import {
  createEstimatorAdminHandlers,
  createEstimatorHandlers,
  ESTIMATOR_ADMIN_ROUTE_PERMISSIONS,
  type CreateEstimatorAdminHandlersOptions,
  type CreateEstimatorHandlersOptions,
  type EstimatorPermission,
  type EstimatorRateLimitBucket,
} from "../index.js";
import { WIRE_ERROR_STATUS } from "../http.js";
import { issueClientKey, revokeClientKey } from "../keys.js";
import { insertQuoteToken, sendQuote } from "../quotes.js";
import { loadSampleCatalog } from "../sample.js";
import { estimatorEstimates, estimatorTakeoffs } from "../schema.js";
import { updateEstimatorSettings } from "../settings.js";
import { fakeModel, memoryPhotoStore, photo, readJson } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * Both handler factories (8): every route, every error code with its status,
 * keyed vs same-origin, CORS, allowed origins, the CSRF matrix, rate-limit
 * buckets, spam checks, token-route headers, 0.1 bodies, unexpected errors,
 * and — for staff — exactly one permission per route, and costs stripped
 * without `estimator.costs.view`.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const BASE = "https://summit.test/api/estimator";
const ADMIN = "https://summit.test/api/admin/estimator/v1/admin";

async function shop() {
  const tenantId = tenant("h");
  await loadSampleCatalog(t.db, tenantId, { showInEstimator: true });
  await updateEstimatorSettings(t.db, tenantId, { businessName: "Summit Ramps", contactPhone: "(801) 555-0143", taxRateBp: 725 });
  const products = await listProducts(t.db, tenantId);
  const id = (name: string) => products.find((p) => p.name === name)!.id;
  return { tenantId, id };
}

function publicHandler(tenantId: string | undefined, options: Partial<CreateEstimatorHandlersOptions> = {}) {
  const handlers = createEstimatorHandlers({ db: t.db, ...(tenantId ? { tenantId } : {}), ...options });
  const call = (method: "GET" | "POST" | "OPTIONS", path: string, body?: unknown, headers: Record<string, string> = {}) =>
    handlers.handle(
      new Request(`${BASE}${path}`, {
        method,
        headers: { ...(method === "POST" ? { "content-type": "application/json", "sec-fetch-site": "same-origin" } : {}), ...headers },
        ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
      }),
    );
  return { handlers, call };
}

const lead = (productId: string, extra: Record<string, unknown> = {}) => ({
  name: "Pat Lee",
  email: "pat@example.test",
  items: [{ productId, inputs: { steps: 3 } }],
  website: "",
  fillMs: 5000,
  ...extra,
});

describe("the error table", () => {
  it("every wire code has the contract's status", () => {
    const by = (status: number) => Object.entries(WIRE_ERROR_STATUS).filter(([, s]) => s === status).map(([code]) => code).sort();
    expect(by(400)).toEqual(
      [
        "invalid", "spam_suspected", "photo_invalid", "photo_limit", "product_unavailable", "product_not_estimatable",
        "invalid_measurement", "invalid_options", "invalid_supply_basis", "invalid_recipe_config", "invalid_price_range",
        "discount_exceeds_subtotal", "empty_estimate", "no_customer_email", "unpriced_lines", "photo_unavailable",
        "takeoff_unavailable", "item_unavailable", "option_unavailable", "option_value_unavailable", "component_unavailable",
      ].sort(),
    );
    expect(by(401)).toEqual(["unauthorized"]);
    expect(by(403)).toEqual(["estimates_closed", "forbidden", "origin_not_allowed", "photos_disabled"]);
    expect(by(404)).toEqual(["not_found"]);
    expect(by(409)).toEqual([
      "already_answered",
      "managed_externally",
      "not_changeable",
      "quote_changed",
      "quote_expired",
      "sample_already_loaded",
      "settings_incomplete",
      "transition_not_allowed",
    ]);
    expect(by(429)).toEqual(["rate_limited"]);
    expect(by(500)).toEqual(["internal"]);
  });
});

describe("public: every route", () => {
  it("config, options, calculate, photo, takeoff, submit, and the quote routes", async () => {
    const { tenantId, id } = await shop();
    const store = memoryPhotoStore();
    const model = fakeModel();
    const { call } = publicHandler(tenantId, { photoStore: store, takeoff: { model }, onEvent: () => undefined });
    const config = await call("GET", "/v1/config");
    expect(config.status).toBe(200);
    expect(config.headers.get("cache-control")).toBe("no-store");
    expect(config.headers.get("access-control-allow-origin")).toBeNull(); // same-origin: no CORS
    const body = await readJson(config);
    expect(body).toMatchObject({ businessName: "Summit Ramps", emailsEnabled: true, minFillMs: 2000, photos: { attach: true, reading: true, maxEdgePx: 768, maxBytes: 600_000, jpegQuality: 0.8 } });
    expect(body.products.map((p: { name: string }) => p.name)).toEqual(["Modular aluminum ramp", "Threshold ramp", "Concrete landing pad", "Handrail only", "Something else"]);
    expect(body.products[1]).toMatchObject({ recipe: "count", quantity: null, photo: { reading: false }, measurementMode: "unit" });
    expect(JSON.stringify(body)).not.toMatch(/unitCost|"cost"|markup|labor|supplies/i);

    expect((await readJson(await call("POST", "/v1/options", { productId: id("Modular aluminum ramp") }))).options.map((o: { name: string }) => o.name)).toEqual(["Surface", "Layout"]);
    expect(await readJson(await call("POST", "/v1/options", {}))).toEqual({ options: [] });
    expect(await readJson(await call("POST", "/v1/calculate", { productId: id("Modular aluminum ramp"), inputs: {} }))).toEqual({
      status: "needs_inputs",
      missing: ["steps"],
      price: null,
      result: null,
    });
    expect((await readJson(await call("POST", "/v1/calculate", { productId: id("Something else") }))).status).toBe("quote_only");
    const bad = await call("POST", "/v1/calculate", { productId: id("Modular aluminum ramp"), inputs: { steps: 0 } });
    expect(bad.status).toBe(400);
    expect((await readJson(bad)).error).toMatchObject({ code: "invalid", issues: [{ path: ["inputs", "steps"], message: "Enter a whole number from 1 to 20." }] });

    const kept = await call("POST", "/v1/photo", photo("kept"));
    expect(kept.status).toBe(201);
    expect(await readJson(kept)).toEqual({ photoId: expect.any(String) });
    const read = await call("POST", "/v1/takeoff", { productId: id("Modular aluminum ramp"), ...photo("read") });
    expect(read.status).toBe(200);
    expect((await readJson(read)).status).toBe("unreadable");

    const submitted = await call("POST", "/v1/submit", lead(id("Modular aluminum ramp")));
    expect(submitted.status).toBe(201);
    const created = await readJson(submitted);
    expect(created).toMatchObject({ range: { low: 647_262, high: 714_588, single: false }, emailed: true, subtotal: 692_146 });
    expect(created.id).toBe(created.estimateId);

    await sendQuote(t.db, tenantId, created.estimateId, {});
    const token = await insertQuoteToken(t.db, tenantId, created.estimateId);
    for (const [method, path] of [["GET", `/v1/quote/${token}`], ["POST", `/v1/quote/${token}/decline`]] as const) {
      const response = await call(method, path, method === "POST" ? { version: 1 } : undefined);
      expect(response.status).toBe(200);
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-robots-tag")).toBe("noindex");
    }
    const missing = await call("GET", "/v1/quote/not-a-real-token-at-all-xxxxxxx");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("referrer-policy")).toBe("no-referrer");
    expect((await call("POST", `/v1/quote/${token}/accept`, { website: "spam" })).status).toBe(400); // the honeypot
    expect((await call("GET", "/v1/nope")).status).toBe(404);
  });

  it("estimates closed, photos off, too large a body", async () => {
    const { tenantId, id } = await shop();
    const { call } = publicHandler(tenantId); // no photo store
    expect((await readJson(await call("POST", "/v1/photo", photo("x")))).error.code).toBe("photos_disabled");
    expect((await call("POST", "/v1/photo", photo("x"))).status).toBe(403);
    const huge = await call("POST", "/v1/calculate", JSON.stringify({ productId: id("Modular aluminum ramp"), pad: "x".repeat(25_000) }));
    expect(huge.status).toBe(400);
    expect((await readJson(huge)).error).toEqual({ code: "invalid", message: "Request body is too large." });
    await updateEstimatorSettings(t.db, tenantId, { instantEstimatesEnabled: false });
    expect((await readJson(await call("GET", "/v1/config"))).products).toEqual([]);
    for (const path of ["/v1/calculate", "/v1/submit"]) {
      const closed = await call("POST", path, path === "/v1/submit" ? lead(id("Modular aluminum ramp")) : { productId: id("Modular aluminum ramp"), inputs: { steps: 3 } });
      expect(closed.status).toBe(403);
      expect((await readJson(closed)).error.code).toBe("estimates_closed");
    }
  });

  it("an unexpected error is a 500 with a fixed message, reported to onError, never its own text", async () => {
    const reported: Array<{ route: string; message: string }> = [];
    const handlers = createEstimatorHandlers({
      db: t.db,
      resolveTenant: () => {
        throw new Error("secret connection string postgres://user:pw@host");
      },
      onError: (error, context) => void reported.push({ route: context.route, message: (error as Error).message }),
    });
    const res = await handlers.handle(new Request(`${BASE}/v1/config`));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: { code: "internal", message: "Something went wrong. Please try again." } });
    expect(text).not.toContain("postgres");
    expect(reported).toEqual([{ route: "config", message: expect.stringContaining("secret") }]);
  });
});

describe("public: who is asking", () => {
  it("keyed: an unknown or revoked key is 401; a key from a website it isn't for is 403; CORS echoes the page", async () => {
    const { tenantId, id } = await shop();
    const { call } = publicHandler(undefined); // keyed only, like 0.2
    const open = await issueClientKey(t.db, { tenantId, label: "anywhere" });
    const pinned = await issueClientKey(t.db, { tenantId, label: "site", allowedOrigins: ["https://summitramps.test"] });
    const keyed = (key: string, origin?: string) => ({ "x-adminigloo-key": key, ...(origin ? { origin } : {}) });

    const ok = await call("GET", "/v1/config", undefined, keyed(pinned.key, "https://summitramps.test"));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://summitramps.test");
    expect(ok.headers.get("vary")).toBe("Origin");
    const noOrigin = await call("GET", "/v1/config", undefined, keyed(pinned.key));
    expect(noOrigin.status).toBe(200); // a server or curl: no Origin
    expect(noOrigin.headers.get("access-control-allow-origin")).toBe("*");
    const elsewhere = await call("GET", "/v1/config", undefined, keyed(pinned.key, "https://evil.test"));
    expect(elsewhere.status).toBe(403);
    expect((await readJson(elsewhere)).error).toEqual({ code: "origin_not_allowed", message: "This estimator isn't set up for this website." });
    expect(elsewhere.headers.get("access-control-allow-origin")).toBe("https://evil.test"); // so the widget can read the error
    expect((await call("GET", "/v1/config", undefined, keyed(open.key, "https://anywhere.test"))).status).toBe(200);

    const unknown = await call("GET", "/v1/config", undefined, keyed("esk_nope"));
    expect(unknown.status).toBe(401);
    expect((await readJson(unknown)).error).toEqual({ code: "unauthorized", message: "This estimator key isn't valid. Ask the business for a new one." });
    await revokeClientKey(t.db, tenantId, open.id);
    expect((await call("GET", "/v1/config", undefined, keyed(open.key))).status).toBe(401);
    // No key and no tenant configured: keyed-only.
    expect((await call("GET", "/v1/config")).status).toBe(401);
    // A keyed POST needs no same-site check (the key is the credential, no cookie rides).
    const crossSite = await call("POST", "/v1/calculate", { productId: id("Modular aluminum ramp"), inputs: { steps: 3 } }, { ...keyed(pinned.key, "https://summitramps.test"), "sec-fetch-site": "cross-site" });
    expect(crossSite.status).toBe(200);
  });

  it("OPTIONS: 204, echoing the page's origin (a preflight carries no key)", async () => {
    const { call } = publicHandler("any");
    const preflight = await call("OPTIONS", "/v1/submit", undefined, { origin: "https://summitramps.test" });
    expect(preflight.status).toBe(204);
    expect(Object.fromEntries(preflight.headers)).toMatchObject({
      "access-control-allow-origin": "https://summitramps.test",
      vary: "Origin",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-adminigloo-key",
      "access-control-max-age": "86400",
    });
    expect((await call("OPTIONS", "/v1/submit")).headers.get("access-control-allow-origin")).toBeNull();
  });

  it("unkeyed: resolveTenant null is 404; the CSRF matrix on every POST", async () => {
    const nobody = createEstimatorHandlers({ db: t.db, resolveTenant: () => null });
    expect((await nobody.handle(new Request(`${BASE}/v1/config`))).status).toBe(404);
    const { tenantId, id } = await shop();
    const handlers = createEstimatorHandlers({ db: t.db, tenantId });
    const post = (headers: Record<string, string>) =>
      handlers.handle(
        new Request(`${BASE}/v1/calculate`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ productId: id("Modular aluminum ramp"), inputs: { steps: 3 } }),
        }),
      );
    const cases: Array<[Record<string, string>, number]> = [
      [{ "sec-fetch-site": "same-origin" }, 200],
      [{ "sec-fetch-site": "same-site" }, 200],
      [{ "sec-fetch-site": "none" }, 200],
      [{ "sec-fetch-site": "cross-site" }, 403],
      [{ origin: "null" }, 403],
      [{ origin: "https://summit.test" }, 200],
      [{ origin: "https://evil.test" }, 403],
      [{ origin: "https://www.summit.example", "x-forwarded-host": "www.summit.example" }, 200],
      [{ referer: "https://summit.test/estimate" }, 200],
      [{ referer: "https://evil.test/page" }, 403],
      [{}, 200], // not a browser
      [{ "sec-fetch-mode": "cors" }, 403], // a browser we can't vouch for
    ];
    for (const [headers, status] of cases) {
      const res = await post(headers);
      expect(res.status, JSON.stringify(headers)).toBe(status);
      if (status === 403) expect((await readJson(res)).error.code).toBe("forbidden");
    }
  });
});

describe("public: limits, spam and 0.1 widgets", () => {
  it("each route's bucket; a throwing limiter is a 429", async () => {
    const { tenantId, id } = await shop();
    const seen: Array<[string, EstimatorRateLimitBucket, string | null]> = [];
    let fail: EstimatorRateLimitBucket | null = null;
    const { call } = publicHandler(tenantId, {
      photoStore: memoryPhotoStore(),
      rateLimit: (req, bucket, context) => {
        seen.push([new URL(req.url).pathname.replace("/api/estimator", ""), bucket, context.keyId]);
        if (bucket === fail) throw new Error("redis is down");
        return true;
      },
    });
    const ramp = id("Modular aluminum ramp");
    await call("GET", "/v1/config");
    await call("POST", "/v1/options", { productId: ramp });
    await call("POST", "/v1/calculate", { productId: ramp, inputs: { steps: 3 } });
    await call("POST", "/v1/photo", photo("b"));
    await call("POST", "/v1/takeoff", { productId: ramp, ...photo("c") });
    await call("POST", "/v1/submit", lead(ramp));
    await call("GET", "/v1/quote/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG");
    await call("POST", "/v1/quote/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG/accept", {});
    await call("POST", "/v1/quote/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG/decline", {});
    expect(seen.map(([path, bucket]) => `${path} ${bucket}`)).toEqual([
      "/v1/config read",
      "/v1/options read",
      "/v1/calculate calculate",
      "/v1/photo photo",
      "/v1/takeoff takeoff",
      "/v1/submit submit",
      "/v1/quote/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG read",
      "/v1/quote/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG/accept respond",
      "/v1/quote/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG/decline respond",
    ]);
    for (const bucket of ["calculate", "submit"] as const) {
      fail = bucket;
      const res = await call("POST", `/v1/${bucket}`, bucket === "submit" ? lead(ramp) : { productId: ramp, inputs: { steps: 3 } });
      expect(res.status).toBe(429);
      expect((await readJson(res)).error).toEqual({ code: "rate_limited", message: "Too many requests. Please slow down and try again shortly." });
    }
  });

  it("spam: the honeypot and the fill time — a 0.1 widget's keyed body without fillMs passes; same-origin doesn't", async () => {
    const { tenantId, id } = await shop();
    const { call } = publicHandler(tenantId);
    const ramp = id("Modular aluminum ramp");
    const rows = async () => (await t.db.select().from(estimatorEstimates).where(eq(estimatorEstimates.tenantId, tenantId))).length;
    const before = await rows();
    for (const body of [lead(ramp, { website: "https://spam.test" }), lead(ramp, { fillMs: 500 }), { ...lead(ramp), fillMs: undefined }]) {
      const res = await call("POST", "/v1/submit", body);
      expect(res.status).toBe(400);
      expect((await readJson(res)).error).toEqual({
        code: "spam_suspected",
        message: "That was quicker than a person can fill in the form. Please check your details and send it again.",
      });
    }
    expect(await rows()).toBe(before);
    const { key } = await issueClientKey(t.db, { tenantId, label: "site" });
    const legacy = await call(
      "POST",
      "/v1/submit",
      { customerName: "Lee", customerEmail: "lee@example.test", jobAddress: "1 Main St", items: [{ productId: id("Handrail only"), measurement: { linearFt: 20 } }] },
      { "x-adminigloo-key": key },
    );
    expect(legacy.status).toBe(201);
    const strict = createEstimatorHandlers({ db: t.db, allowLegacyWidgetBodies: false });
    const refused = await strict.handle(
      new Request(`${BASE}/v1/submit`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-adminigloo-key": key },
        body: JSON.stringify({ customerName: "Lee", customerEmail: "lee@example.test", items: [{ productId: id("Handrail only"), measurement: { linearFt: 20 } }] }),
      }),
    );
    expect(refused.status).toBe(400);
  });

  it("0.1 bodies (measurement, customerName) still price and save, answering 0.2's result; issues come back in the wire's names", async () => {
    const { tenantId, id } = await shop();
    const { call } = publicHandler(tenantId);
    const calc = await readJson(await call("POST", "/v1/calculate", { productId: id("Handrail only"), measurement: { linearFt: 20 }, quantity: 1 }));
    expect(calc.status).toBe("priced");
    expect(calc.result).toEqual({ sqFt: 0, linearFt: 20, units: 1, subtotal: calc.price.low, estimateLow: calc.price.low, estimateHigh: calc.price.high });
    const missingName = await call("POST", "/v1/submit", { email: "x@y.test", items: [{ productId: id("Handrail only"), inputs: { length: 20 } }], fillMs: 5000 });
    expect((await readJson(missingName)).error.issues[0].path).toEqual(["name"]);
    const noContact = await call("POST", "/v1/submit", { name: "Pat", items: [{ productId: id("Handrail only"), inputs: { length: 20 } }], fillMs: 5000 });
    expect((await readJson(noContact)).error.issues[0]).toEqual({ path: ["email"], message: "Enter an email or a phone number so we can reach you.", code: "custom" });
  });
});

describe("admin: permissions", () => {
  // The contract's table (8.3), route by route.
  const TABLE: Array<["GET" | "POST", string, EstimatorPermission]> = [
    ["GET", "status", "estimator.view"],
    ["GET", "usage", "estimator.costs.view"],
    ["GET", "settings", "estimator.view"],
    ["POST", "settings", "estimator.settings.manage"],
    ["GET", "products", "estimator.view"],
    ["POST", "products", "estimator.pricebook.manage"],
    ["POST", "products/reorder", "estimator.pricebook.manage"],
    ["POST", "products/preview", "estimator.view"],
    ["GET", "products/p1", "estimator.view"],
    ["POST", "products/p1", "estimator.pricebook.manage"],
    ["POST", "products/p1/deactivate", "estimator.pricebook.manage"],
    ["POST", "products/p1/reactivate", "estimator.pricebook.manage"],
    ["POST", "products/p1/supplies", "estimator.pricebook.manage"],
    ["POST", "products/p1/supplies/a1", "estimator.pricebook.manage"],
    ["POST", "products/p1/supplies/a1/remove", "estimator.pricebook.manage"],
    ["POST", "products/p1/options", "estimator.pricebook.manage"],
    ["POST", "options/o1", "estimator.pricebook.manage"],
    ["POST", "options/o1/remove", "estimator.pricebook.manage"],
    ["POST", "options/o1/values", "estimator.pricebook.manage"],
    ["POST", "option-values/v1", "estimator.pricebook.manage"],
    ["POST", "option-values/v1/default", "estimator.pricebook.manage"],
    ["POST", "option-values/v1/remove", "estimator.pricebook.manage"],
    ["GET", "supplies", "estimator.costs.view"],
    ["POST", "supplies", "estimator.pricebook.manage"],
    ["POST", "supplies/s1", "estimator.pricebook.manage"],
    ["POST", "supplies/s1/deactivate", "estimator.pricebook.manage"],
    ["POST", "supplies/s1/reactivate", "estimator.pricebook.manage"],
    ["POST", "sample-catalog", "estimator.pricebook.manage"],
    ["GET", "estimates", "estimator.view"],
    ["POST", "estimates", "estimator.estimates.manage"],
    ["GET", "estimates/e1", "estimator.view"],
    ["POST", "estimates/e1", "estimator.estimates.manage"],
    ["POST", "estimates/e1/items", "estimator.estimates.manage"],
    ["POST", "estimates/e1/items/i1", "estimator.estimates.manage"],
    ["POST", "estimates/e1/items/i1/remove", "estimator.estimates.manage"],
    ["POST", "estimates/e1/photos", "estimator.estimates.manage"],
    ["POST", "estimates/e1/photos/f1/remove", "estimator.estimates.manage"],
    ["POST", "estimates/e1/send", "estimator.estimates.manage"],
    ["POST", "estimates/e1/resend", "estimator.estimates.manage"],
    ["POST", "estimates/e1/revise", "estimator.estimates.manage"],
    ["POST", "estimates/e1/status", "estimator.estimates.manage"],
    ["POST", "estimates/e1/link", "estimator.estimates.manage"],
    ["POST", "estimates/e1/archive", "estimator.estimates.manage"],
    ["POST", "estimates/e1/unarchive", "estimator.estimates.manage"],
    ["POST", "estimates/e1/duplicate", "estimator.estimates.manage"],
    ["POST", "estimates/e1/convert", "estimator.estimates.manage"],
    ["POST", "expire", "estimator.estimates.manage"],
    ["GET", "keys", "estimator.settings.manage"],
    ["POST", "keys", "estimator.settings.manage"],
    ["POST", "keys/k1", "estimator.settings.manage"],
    ["POST", "keys/k1/revoke", "estimator.settings.manage"],
  ];

  it("each route asks authorize for exactly the permission in the table; false is 403 and does nothing", async () => {
    const asked: EstimatorPermission[] = [];
    const handlers = createEstimatorAdminHandlers({
      db: t.db,
      tenantId: "perm",
      authorize: (_req, permission) => {
        asked.push(permission);
        return false;
      },
    });
    for (const [method, path, permission] of TABLE) {
      asked.length = 0;
      const res = await handlers.handle(new Request(`${ADMIN}/${path}`, { method, ...(method === "POST" ? { body: "{}", headers: { "sec-fetch-site": "same-origin" } } : {}) }));
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(asked, `${method} ${path}`).toEqual([permission]);
      expect((await readJson(res)).error).toEqual({ code: "forbidden", message: "You don't have permission to do that." });
    }
    expect(new Set(Object.values(ESTIMATOR_ADMIN_ROUTE_PERMISSIONS)).size).toBe(5);
    expect(Object.keys(ESTIMATOR_ADMIN_ROUTE_PERMISSIONS)).toHaveLength(TABLE.length); // one kind per row of the table
  });

  it("an authorize Response is returned as is; OPTIONS has no CORS; a cross-site POST is refused first", async () => {
    const handlers = createEstimatorAdminHandlers({
      db: t.db,
      tenantId: "perm",
      authorize: () => new Response("sign in", { status: 401, headers: { "x-from": "host" } }),
    });
    const res = await handlers.handle(new Request(`${ADMIN}/status`));
    expect(res.status).toBe(401);
    expect(res.headers.get("x-from")).toBe("host");
    const options = await handlers.handle(new Request(`${ADMIN}/status`, { method: "OPTIONS", headers: { origin: "https://evil.test" } }));
    expect(options.status).toBe(204);
    expect(options.headers.get("access-control-allow-origin")).toBeNull();
    const forged = await handlers.handle(new Request(`${ADMIN}/settings`, { method: "POST", body: "{}", headers: { "sec-fetch-site": "cross-site" } }));
    expect(forged.status).toBe(403);
    expect((await handlers.handle(new Request(`${ADMIN}/nope`))).status).toBe(404);
  });
});

describe("admin: costs only with estimator.costs.view", () => {
  function staff(tenantId: string, roles: { costs: boolean }, extra: Partial<CreateEstimatorAdminHandlersOptions> = {}) {
    const handlers = createEstimatorAdminHandlers({
      db: t.db,
      tenantId,
      photoReading: true,
      authorize: (_req, permission) => (permission === "estimator.costs.view" ? roles.costs : { userId: "u-1" }),
      ...extra,
    });
    return (method: "GET" | "POST", path: string, body?: unknown) =>
      handlers.handle(new Request(`${ADMIN}/${path}`, { method, ...(method === "POST" ? { body: JSON.stringify(body ?? {}), headers: { "sec-fetch-site": "same-origin" } } : {}) }));
  }

  it("products, preview, estimate detail and status spend are stripped; supplies need the permission", async () => {
    const { tenantId, id } = await shop();
    const created = await createEstimate(t.db, { tenantId, items: [{ productId: id("Modular aluminum ramp"), inputs: { steps: 3 } }] });
    await t.db.insert(estimatorTakeoffs).values({ tenantId, productId: id("Modular aluminum ramp"), recipe: "ramp_over_steps", photoHash: "h", status: "read", costMicros: 900, model: "claude-haiku-4-5" });
    const owner = staff(tenantId, { costs: true });
    const member = staff(tenantId, { costs: false });

    const full = (await readJson(await owner("GET", `products/${id("Modular aluminum ramp")}`))).product;
    expect(full.supplies[0].unitCost).toBe(9_500);
    expect(full.labor.rateCents).toBe(6_500);
    const stripped = (await readJson(await member("GET", `products/${id("Modular aluminum ramp")}`))).product;
    expect(stripped.supplies[0].unitCost).toBeNull();
    expect(stripped.labor).toMatchObject({ rateCents: null, effectiveRateCents: null });
    expect(stripped.lumpCosts).toBeNull();
    expect(stripped.supplies[0]).toMatchObject({ name: "Aluminum ramp section", quantityMilli: 1000, per: "rampFt", perLabel: "per ft of ramp" });

    const preview = (path: typeof owner) => path("POST", "products/preview", { productId: id("Modular aluminum ramp"), inputs: { steps: 3 } });
    expect((await readJson(await preview(owner))).breakdown.point).toBe(692_146);
    const memberPreview = await readJson(await preview(member));
    expect(memberPreview.breakdown).toBeNull();
    expect(memberPreview.customerView.low).toBe(647_262);

    expect((await readJson(await owner("GET", `estimates/${created.id}`))).estimate.cost).toEqual(expect.any(Number));
    const memberDetail = (await readJson(await member("GET", `estimates/${created.id}`))).estimate;
    expect(memberDetail.cost).toBeNull();
    expect(memberDetail.marginBp).toBeNull();
    expect(memberDetail.lines[0].cost).toBeNull();

    expect((await readJson(await owner("GET", "status"))).spend).toMatchObject({ readingsToday: expect.any(Number), costMonthMicros: 900, dailyBudgetCents: 100 });
    expect((await readJson(await member("GET", "status"))).spend).toBeNull();
    const supplies = await readJson(await owner("GET", "supplies"));
    expect(supplies.supplies.find((s: { name: string }) => s.name === "Handrail").usedBy.map((p: { name: string }) => p.name)).toEqual(["Handrail only", "Modular aluminum ramp"]);
    const memberSupplies = createEstimatorAdminHandlers({
      db: t.db,
      tenantId,
      authorize: (_req, permission) => permission !== "estimator.costs.view",
    });
    expect((await memberSupplies.handle(new Request(`${ADMIN}/supplies`))).status).toBe(403);
  });

  it("status: the notices, in order", async () => {
    const tenantId = tenant("status");
    const owner = staff(tenantId, { costs: true });
    const status = await readJson(await owner("GET", "status"));
    expect(status.notices.map((n: { code: string }) => n.code)).toEqual(["settings_not_saved", "no_products", "tax_default", "emails_off", "photos_no_store"]);
    expect(status.notices[0].message).toBe(
      "Your estimate page is closed, and quotes can't be sent, until you save your business name and tax rate in Settings.",
    );
    // The form shows the rate EMPTY until it is saved, so the notice never
    // quotes a default the screen doesn't show (review T2A-BO-06).
    expect(status.notices[2].message).toBe("Your sales tax rate isn't saved yet. Enter it in Estimate settings.");
    await issueClientKey(t.db, { tenantId, label: "site" });
    const withKey = await readJson(await staff(tenantId, { costs: true }, { photoReading: false })("GET", "status"));
    expect(withKey.notices.map((n: { code: string }) => n.code)).toContain("reading_off");
    expect(withKey.notices.at(-1)).toEqual({ code: "keys_without_origins", message: "1 website key works on any website. Add your site's address to it." });
    expect(withKey).toMatchObject({ settingsSaved: false, products: { active: 0, public: 0 }, keys: { active: 1, withoutOrigins: 1 }, delivery: { emails: false, followUps: false, note: null } });
  });

  it("usage: readings and cost per UTC day", async () => {
    const { tenantId, id } = await shop();
    const today = new Date();
    await t.db.insert(estimatorTakeoffs).values([
      { tenantId, productId: id("Modular aluminum ramp"), recipe: "ramp_over_steps", photoHash: "u1", status: "read", costMicros: 900, model: "claude-haiku-4-5", createdAt: today },
      { tenantId, productId: id("Modular aluminum ramp"), recipe: "ramp_over_steps", photoHash: "u2", status: "unreadable", costMicros: 700, model: "claude-haiku-4-5", createdAt: today },
    ]);
    const usage = await readJson(await staff(tenantId, { costs: true })("GET", "usage?days=7"));
    expect(usage.model).toBe("claude-haiku-4-5");
    expect(usage.days).toHaveLength(7);
    expect(usage.days.at(-1)).toEqual({ date: today.toISOString().slice(0, 10), readings: 2, costMicros: 1_600 });
    expect(usage.totals).toEqual({ readings: 2, costMicros: 1_600, averageCostMicros: 800 });
    expect((await staff(tenantId, { costs: true })("GET", "usage?days=91")).status).toBe(400);
  });
});

describe("admin: seams, keys and the sweep", () => {
  it("link and convert are 404 without their seams; link needs a sent quote", async () => {
    const { tenantId } = await shop();
    const created = await createEstimate(t.db, { tenantId, customerEmail: "a@x.test", items: [{ description: "Work", unitPrice: 100 }] });
    const bare = createEstimatorAdminHandlers({ db: t.db, tenantId, authorize: () => true });
    const post = (handlers: typeof bare, path: string) => handlers.handle(new Request(`${ADMIN}/${path}`, { method: "POST", body: "{}", headers: { "sec-fetch-site": "same-origin" } }));
    expect((await post(bare, `estimates/${created.id}/link`)).status).toBe(404);
    expect((await post(bare, `estimates/${created.id}/convert`)).status).toBe(404);
    const linked = createEstimatorAdminHandlers({ db: t.db, tenantId, authorize: () => true, quoteUrl: (token) => `https://summit.test/quote/${token}` });
    const early = await post(linked, `estimates/${created.id}/link`);
    expect(early.status).toBe(409);
    expect((await readJson(early)).error).toEqual({ code: "not_changeable", message: "Send the quote first." });
    await sendQuote(t.db, tenantId, created.id, {});
    const url = (await readJson(await post(linked, `estimates/${created.id}/link`))).url as string;
    expect(url).toMatch(/^https:\/\/summit\.test\/quote\/[A-Za-z0-9_-]{43}$/);
    const detail = (await readJson(await linked.handle(new Request(`${ADMIN}/estimates/${created.id}`)))).estimate;
    expect(detail.actions).toEqual(["resend", "revise", "mark_accepted", "mark_declined", "copy_link", "duplicate", "archive"]);
    expect(detail.links).toEqual({ bookVisitUrl: null, visits: [], invoice: null });
  });

  it("keys: issued once with the plaintext, listed without it, websites edited, revoked", async () => {
    const tenantId = tenant("keys");
    const handlers = createEstimatorAdminHandlers({ db: t.db, tenantId, authorize: () => true });
    const post = (path: string, body: unknown) => handlers.handle(new Request(`${ADMIN}/${path}`, { method: "POST", body: JSON.stringify(body), headers: { "sec-fetch-site": "same-origin" } }));
    const bad = await post("keys", { label: "Site", allowedOrigins: ["summitramps.com/estimate"] });
    expect(bad.status).toBe(400);
    expect((await readJson(bad)).error.issues).toEqual([{ path: ["allowedOrigins", 0], message: "Use the site's address, like https://summitramps.com", code: "custom" }]);
    const issued = await readJson(await post("keys", { label: "Site", allowedOrigins: ["https://SummitRamps.com/"] }));
    expect(issued.plaintext).toMatch(/^esk_[0-9a-f]{40}$/);
    expect(issued.key).toMatchObject({ label: "Site", allowedOrigins: ["https://summitramps.com"], revokedAt: null, keyPrefix: issued.plaintext.slice(0, 12) });
    const list = await readJson(await handlers.handle(new Request(`${ADMIN}/keys`)));
    expect(JSON.stringify(list)).not.toContain(issued.plaintext);
    const edited = await readJson(await post(`keys/${issued.key.id}`, { allowedOrigins: ["https://summitramps.com", "http://localhost:3200"] }));
    expect(edited.key.allowedOrigins).toEqual(["https://summitramps.com", "http://localhost:3200"]);
    const revoked = await readJson(await post(`keys/${issued.key.id}/revoke`, {}));
    expect(revoked.key.revokedAt).toEqual(expect.any(String));
    expect((await post("keys/nope/revoke", {})).status).toBe(404);
  });

  it("the estimates list expires overdue quotes, at most once a minute per tenant", async () => {
    const tenantId = tenant("sweep");
    await updateEstimatorSettings(t.db, tenantId, { businessName: "Summit Ramps" });
    let now = new Date("2026-11-02T15:00:00Z");
    const handlers = createEstimatorAdminHandlers({ db: t.db, tenantId, authorize: () => true, now: () => now });
    const list = async () => readJson(await handlers.handle(new Request(`${ADMIN}/estimates?filter=all`)));
    const make = async () => {
      const created = await createEstimate(t.db, { tenantId, customerEmail: "a@x.test", items: [{ description: "Work", unitPrice: 100 }] });
      await sendQuote(t.db, tenantId, created.id, { validDays: 1 }, { now });
      return created.id;
    };
    await make();
    now = new Date(now.getTime() + 2 * 24 * 3600_000);
    expect((await list()).counts.expired).toBe(1);
    await sendQuote(t.db, tenantId, (await createEstimate(t.db, { tenantId, customerEmail: "a@x.test", items: [{ description: "W", unitPrice: 1 }] })).id, { validDays: 1 }, { now: new Date(now.getTime() - 2 * 24 * 3600_000) });
    expect((await list()).counts.expired).toBe(1); // within the minute: no second sweep
    now = new Date(now.getTime() + 61_000);
    expect((await list()).counts.expired).toBe(2);
  });
});
