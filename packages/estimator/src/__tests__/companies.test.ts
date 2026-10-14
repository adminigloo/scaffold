import { commsMessages } from "@adminigloo/comms";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listProducts, createProduct } from "../catalog.js";
import { createEstimatorCommsListener } from "../comms.js";
import { createEstimate } from "../estimates.js";
import {
  createEstimatorAdminHandlers,
  createEstimatorHandlers,
  ESTIMATOR_ADMIN_ROUTE_PERMISSIONS,
  ESTIMATOR_ADMIN_ROUTES,
  ESTIMATOR_PUBLIC_ROUTES,
  estimatorChecklistItems,
  estimatorPermissions,
  resolveEstimatorSettings,
  type EstimatorCompany,
  type EstimatorPermission,
  type EstimatorRoute,
} from "../index.js";
import { issueClientKey, revokeClientKey } from "../keys.js";
import { insertQuoteToken, sendQuote } from "../quotes.js";
import { loadSampleCatalog } from "../sample.js";
import {
  estimatorClientKeys,
  estimatorComponents,
  estimatorEstimateItems,
  estimatorEstimates,
  estimatorOptionValues,
  estimatorOptions,
  estimatorPhotos,
  estimatorProductComponents,
  estimatorProducts,
  estimatorQuoteTokens,
  estimatorSettings,
} from "../schema.js";
import { updateEstimatorSettings } from "../settings.js";
import { fakeModel, memoryPhotoStore, photo, recordingSender } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * The estimator inside companies (Tenancy 2a, 13.3), two tenants on one real
 * Postgres: the company's basics overlaid on config, quotes and settings;
 * the closed answer on BOTH paths (web address and embed key) before any
 * estimator work; the per-company ceiling on photo reading where the money is
 * spent; async links and a per-company inbox; the route tables; and company
 * B getting not-found, or nothing of company A's, through every route.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb({ comms: true });
});
afterAll(async () => {
  await t.close();
});

const COMPANIES = new Map<string, EstimatorCompany>();
const company = (tenantId: string) => COMPANIES.get(tenantId) ?? null;
function companyFor(tenantId: string, extra: Partial<EstimatorCompany> = {}): EstimatorCompany {
  const value: EstimatorCompany = {
    name: "Green Acres",
    timeZone: "America/Denver",
    contactEmail: "gail@greenacres.test",
    contactPhone: "(801) 555-0100",
    logoUrl: "https://cdn.test/green.png",
    brandColor: "#1f7a3a",
    ...extra,
  };
  COMPANIES.set(tenantId, value);
  return value;
}

const ALL = Object.keys(estimatorPermissions) as EstimatorPermission[];
const photoStore = memoryPhotoStore();

function staffAs(member: string, extra: Partial<Parameters<typeof createEstimatorAdminHandlers>[0]> = {}) {
  return createEstimatorAdminHandlers({
    db: t.db,
    resolveTenant: (req) => /\/api\/app\/([^/]+)\//.exec(new URL(req.url).pathname)?.[1] ?? null,
    authorize: (_req, permission, tenantId) =>
      tenantId === member && ALL.includes(permission)
        ? { userId: `user-of-${member}` }
        : new Response(JSON.stringify({ error: { code: "forbidden", message: "You're not part of this company." } }), { status: 403 }),
    company,
    companySettingsHref: "/settings/company#details",
    photoStore,
    quoteUrl: async (token, id) => `https://app.test/t/${id}/quote/${token}`,
    ...extra,
  });
}

function publicFor(extra: Partial<Parameters<typeof createEstimatorHandlers>[0]> = {}) {
  return createEstimatorHandlers({
    db: t.db,
    resolveTenant: (req) => /\/api\/t\/([^/]+)\//.exec(new URL(req.url).pathname)?.[1] ?? null,
    company,
    minFillMs: 0,
    ...extra,
  });
}

function fill(text: string, rows: Record<string, string>): string {
  return text.replace(/\{([a-z-]+)\}/g, (_m, entity: string) => rows[entity] ?? `{${entity}}`);
}

function request(base: string, route: EstimatorRoute, rows: Record<string, string>, headers: Record<string, string> = {}): Request {
  const query = route.query ? `?${new URLSearchParams(Object.fromEntries(Object.entries(route.query).map(([k, v]) => [k, fill(v, rows)])))}` : "";
  return new Request(`${base}${fill(route.path, rows)}${query}`, {
    method: route.method,
    headers: { "sec-fetch-site": "same-origin", ...(route.method === "POST" ? { "content-type": "application/json" } : {}), ...headers },
    ...(route.method === "POST" ? { body: fill(JSON.stringify(route.body ?? {}), rows) } : {}),
  });
}

const get = (h: { handle: (r: Request) => Promise<Response> }, url: string, headers: Record<string, string> = {}) =>
  h.handle(new Request(url, { headers: { "sec-fetch-site": "same-origin", ...headers } }));
const post = (h: { handle: (r: Request) => Promise<Response> }, url: string, body: unknown, headers: Record<string, string> = {}) =>
  h.handle(new Request(url, { method: "POST", headers: { "sec-fetch-site": "same-origin", "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));

async function shop(label = "green") {
  const tenantId = tenant(label);
  await loadSampleCatalog(t.db, tenantId, { showInEstimator: true });
  await updateEstimatorSettings(t.db, tenantId, { businessName: "Stored Name", contactEmail: "stored@x.test", taxRateBp: 725, brandColor: "#000000" });
  const products = await listProducts(t.db, tenantId);
  const ramp = products.find((p) => p.name === "Modular aluminum ramp")!.id;
  return { tenantId, ramp };
}

describe("the company's basics (D5, D6)", () => {
  it("config, quotes and settings carry the company's name, contact, zone, colour and logo", async () => {
    const { tenantId } = await shop();
    companyFor(tenantId);
    const config = (await (await get(publicFor(), `https://app.test/api/t/${tenantId}/estimator/v1/config`)).json()) as Record<string, unknown>;
    expect(config).toMatchObject({
      businessName: "Green Acres",
      contactEmail: "gail@greenacres.test",
      contactPhone: "(801) 555-0100",
      timeZone: "America/Denver",
      brandColor: "#1f7a3a",
      logoUrl: "https://cdn.test/green.png",
      instantEstimatesEnabled: true,
    });
    const created = await createEstimate(t.db, { tenantId, customerEmail: "pat@example.test", items: [{ description: "Work", unitPrice: 100 }] });
    await sendQuote(t.db, tenantId, created.id, {});
    const token = await insertQuoteToken(t.db, tenantId, created.id);
    const quote = (await (await get(publicFor(), `https://app.test/api/t/${tenantId}/estimator/v1/quote/${token}`)).json()) as { quote: Record<string, unknown> };
    expect(quote.quote).toMatchObject({ businessName: "Green Acres", brandColor: "#1f7a3a", logoUrl: "https://cdn.test/green.png", timeZone: "America/Denver" });
    const settings = (await (await get(staffAs(tenantId), `https://app.test/api/app/${tenantId}/estimator/v1/admin/settings`)).json()) as { settings: Record<string, unknown> };
    expect(settings.settings).toMatchObject({ businessName: "Green Acres", brandColor: "#1f7a3a", managedByCompany: { href: "/settings/company#details" }, aiBudgetCeilingCents: null });
  });

  it("without a seam: 0.3's settings, logoUrl null, managedByCompany null", async () => {
    const { tenantId } = await shop();
    const config = (await (await get(createEstimatorHandlers({ db: t.db, tenantId }), "https://app.test/x/v1/config")).json()) as Record<string, unknown>;
    expect(config).toMatchObject({ businessName: "Stored Name", logoUrl: null, brandColor: "#000000" });
  });

  it("a company zone of null keeps the stored zone; a throwing seam reads the stored settings and is reported", async () => {
    const { tenantId } = await shop();
    await updateEstimatorSettings(t.db, tenantId, { timeZone: "America/Chicago" });
    companyFor(tenantId, { timeZone: null });
    expect((await resolveEstimatorSettings(t.db, tenantId, { company })).timeZone).toBe("America/Chicago");
    const errors: unknown[] = [];
    const s = await resolveEstimatorSettings(t.db, tenantId, {
      company: () => {
        throw new Error("down");
      },
      onError: (e) => errors.push(e),
    });
    expect(s).toMatchObject({ businessName: "Stored Name", managedByCompany: false });
    expect(errors).toHaveLength(1);
  });

  it("with a company, the estimator opens once its settings are saved (the tax rate and quote rules)", async () => {
    const tenantId = tenant();
    await loadSampleCatalog(t.db, tenantId, { showInEstimator: true });
    companyFor(tenantId);
    const before = (await (await get(publicFor(), `https://app.test/api/t/${tenantId}/estimator/v1/config`)).json()) as Record<string, unknown>;
    expect(before.instantEstimatesEnabled).toBe(false);
    await updateEstimatorSettings(t.db, tenantId, { taxRateBp: 725 });
    const after = (await (await get(publicFor(), `https://app.test/api/t/${tenantId}/estimator/v1/config`)).json()) as Record<string, unknown>;
    expect(after.instantEstimatesEnabled).toBe(true);
  });

  it("until then, the staff notice asks a company for its tax rate only — never a name its settings show read-only", async () => {
    const notices = async (tenantId: string, h = staffAs(tenantId)) =>
      ((await (await get(h, `https://app.test/api/app/${tenantId}/estimator/v1/admin/status`)).json()) as { notices: { code: string; message: string }[] }).notices;
    const managed = tenant();
    companyFor(managed);
    expect((await notices(managed)).find((n) => n.code === "settings_not_saved")?.message).toBe(
      "Your estimate page is closed, and quotes can't be sent, until you save your tax rate in Estimate settings.",
    );
    // A host with no company seam owns the name itself: it is still asked for.
    const own = tenant();
    const plain = createEstimatorAdminHandlers({ db: t.db, tenantId: own, authorize: () => ({ userId: "owner" }), photoStore, quoteUrl: (token) => `https://app.test/quote/${token}` });
    expect((await notices(own, plain)).find((n) => n.code === "settings_not_saved")?.message).toBe(
      "Your estimate page is closed, and quotes can't be sent, until you save your business name and tax rate in Settings.",
    );
  });

  it("settings-update drops the company-owned keys; a body of only them changes nothing", async () => {
    const { tenantId } = await shop();
    companyFor(tenantId);
    const h = staffAs(tenantId);
    const [before] = await t.db.select().from(estimatorSettings).where(eq(estimatorSettings.tenantId, tenantId));
    const only = await post(h, `https://app.test/api/app/${tenantId}/estimator/v1/admin/settings`, {
      businessName: "Hacked",
      contactEmail: "evil@x.test",
      contactPhone: "000",
      timeZone: "Asia/Tokyo",
      brandColor: "#ff0000",
    });
    expect(only.status).toBe(200);
    expect(((await only.json()) as { settings: Record<string, unknown> }).settings).toMatchObject({ businessName: "Green Acres", brandColor: "#1f7a3a" });
    const [after] = await t.db.select().from(estimatorSettings).where(eq(estimatorSettings.tenantId, tenantId));
    expect(after).toEqual(before);
    await post(h, `https://app.test/api/app/${tenantId}/estimator/v1/admin/settings`, { businessName: "Hacked", taxRateBp: 800 });
    const [stored] = await t.db.select().from(estimatorSettings).where(eq(estimatorSettings.tenantId, tenantId));
    expect(stored).toMatchObject({ businessName: "Stored Name", taxRateBp: 800 });
  });
});

describe("admission on both paths (D7)", () => {
  const message = "Green Acres isn't taking requests online right now. Call (801) 555-0100.";

  it("closed through a web address: 409 estimates_closed, before the route, the rate limit and any estimator query", async () => {
    const { tenantId } = await shop();
    let limited = 0;
    const h = publicFor({ admit: () => ({ open: false, message }), rateLimit: () => (limited++, true) });
    for (const route of ESTIMATOR_PUBLIC_ROUTES) {
      t.queries.length = 0;
      const res = await h.handle(request(`https://app.test/api/t/${tenantId}/estimator/`, route, { product: "p", "quote-token": "x".repeat(43) }));
      expect(res.status, route.kind).toBe(409);
      expect(await res.json(), route.kind).toEqual({ error: { code: "estimates_closed", message } });
      expect(t.queries, route.kind).toHaveLength(0);
    }
    // Even a path that names no route: admission comes first.
    expect((await get(h, `https://app.test/api/t/${tenantId}/estimator/v1/nothing`)).status).toBe(409);
    expect(limited).toBe(0);
  });

  it("closed through an embed key: the same answer, with CORS so the business's own site can show it", async () => {
    const { tenantId } = await shop();
    const { key } = await issueClientKey(t.db, { tenantId, label: "site" });
    const admitted: string[] = [];
    const h = createEstimatorHandlers({ db: t.db, admit: (id) => (admitted.push(id), { open: false, message }) });
    t.queries.length = 0;
    const res = await get(h, "https://app.test/api/estimator/v1/config", { "x-adminigloo-key": key, origin: "https://greenacres.test" });
    expect(res.status).toBe(409);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://greenacres.test");
    expect(await res.json()).toEqual({ error: { code: "estimates_closed", message } });
    expect(admitted).toEqual([tenantId]);
    // Only the key's own lookup ran: nothing about products, settings or estimates.
    expect(t.queries.some((q) => /estimator_(products|settings|estimates)/.test(q.sql))).toBe(false);
  });

  it("open: the routes answer as before", async () => {
    const { tenantId } = await shop();
    const res = await get(publicFor({ admit: () => ({ open: true }) }), `https://app.test/api/t/${tenantId}/estimator/v1/config`);
    expect(res.status).toBe(200);
  });
});

describe("the AI ceiling (D14)", () => {
  it("a stored budget above the ceiling is spent only up to the ceiling, in the takeoff itself", async () => {
    const { tenantId, ramp } = await shop();
    companyFor(tenantId);
    await updateEstimatorSettings(t.db, tenantId, { aiDailyBudgetCents: 100, photosEnabled: true });
    const model = fakeModel();
    // 1 cent ceiling: each fake reading costs 4 250 micro-dollars, the call's ceiling 2 750 → two readings, then paused.
    const h = publicFor({ takeoff: { model }, aiBudgetCeilingCents: 1 });
    const read = async (tag: string) =>
      ((await (await post(h, `https://app.test/api/t/${tenantId}/estimator/v1/takeoff`, { productId: ramp, ...photo(tag) })).json()) as { status: string }).status;
    expect(await read("c1")).not.toBe("paused");
    expect(await read("c2")).not.toBe("paused");
    expect(await read("c3")).toBe("paused");
    expect(model.calls).toHaveLength(2);
    // The same business without the ceiling would have kept reading.
    const uncapped = publicFor({ takeoff: { model } });
    const status = ((await (await post(uncapped, `https://app.test/api/t/${tenantId}/estimator/v1/takeoff`, { productId: ramp, ...photo("c4") })).json()) as { status: string }).status;
    expect(status).not.toBe("paused");
  });

  it("the ceiling is shown, and a save above it is refused on aiDailyBudgetCents with the sentence", async () => {
    const { tenantId } = await shop();
    await updateEstimatorSettings(t.db, tenantId, { aiDailyBudgetCents: 500 });
    const h = staffAs(tenantId, { aiBudgetCeilingCents: 100 });
    const wire = (await (await get(h, `https://app.test/api/app/${tenantId}/estimator/v1/admin/settings`)).json()) as { settings: Record<string, unknown> };
    expect(wire.settings).toMatchObject({ aiDailyBudgetCents: 100, aiBudgetCeilingCents: 100 });
    const res = await post(h, `https://app.test/api/app/${tenantId}/estimator/v1/admin/settings`, { aiDailyBudgetCents: 500 });
    expect(res.status).toBe(400);
    const sentence = "This site allows up to $1.00 a day of photo reading per business.";
    expect(await res.json()).toEqual({ error: { code: "invalid", message: sentence, issues: [{ path: ["aiDailyBudgetCents"], message: sentence }] } });
    expect((await post(h, `https://app.test/api/app/${tenantId}/estimator/v1/admin/settings`, { aiDailyBudgetCents: 50 })).status).toBe(200);
    const status = (await (await get(h, `https://app.test/api/app/${tenantId}/estimator/v1/admin/status`)).json()) as Record<string, unknown>;
    expect(status.aiBudgetCeilingCents).toBe(100);
  });
});

describe("async links and the company's inbox", () => {
  it("quote links resolve per company (async); the copy-link route awaits them", async () => {
    const { tenantId } = await shop();
    const created = await createEstimate(t.db, { tenantId, customerEmail: "pat@example.test", items: [{ description: "Work", unitPrice: 100 }] });
    await sendQuote(t.db, tenantId, created.id, {});
    const res = await post(staffAs(tenantId), `https://app.test/api/app/${tenantId}/estimator/v1/admin/estimates/${created.id}/link`, {});
    const body = (await res.json()) as { url: string };
    expect(body.url).toMatch(new RegExp(`^https://app.test/t/${tenantId}/quote/[A-Za-z0-9_-]{43}$`));
  });

  it("the comms listener: async quote, admin and book links; the office emails go to the company's inbox", async () => {
    const { tenantId, ramp } = await shop();
    companyFor(tenantId);
    const mail = recordingSender();
    const inboxAsked: string[] = [];
    const listener = createEstimatorCommsListener({
      db: t.db,
      senders: mail.senders,
      quoteUrl: async (token, id) => `https://app.test/t/${id}/quote/${token}`,
      adminEstimateUrl: async (estimateId, id) => `https://app.test/app/switch/${id}?next=/app/estimates/${estimateId}`,
      bookUrl: async (estimate, id) => `https://app.test/t/${id}/book-visit?estimate=${estimate.id}`,
      staffEmails: async (id) => (inboxAsked.push(id), [`inbox@${id}.test`]),
      company,
    });
    const h = publicFor({ onEvent: listener.onEvent });
    const res = await post(h, `https://app.test/api/t/${tenantId}/estimator/v1/submit`, {
      name: "Pat Lee",
      email: "pat@example.test",
      items: [{ productId: ramp, inputs: { steps: 3 } }],
      fillMs: 5000,
    });
    expect(res.status).toBe(201);
    const office = mail.sent.find((m) => m.to === `inbox@${tenantId}.test`);
    expect(office).toBeDefined();
    expect(office!.body).toContain(`https://app.test/app/switch/${tenantId}?next=/app/estimates/`);
    expect(inboxAsked).toEqual([tenantId]);
    const customer = mail.sent.find((m) => m.to === "pat@example.test");
    expect(customer?.body).toContain("Green Acres");
  });

  it("a throwing link function is reported and the email still goes", async () => {
    const { tenantId } = await shop();
    const mail = recordingSender();
    const errors: Array<{ step: string }> = [];
    const listener = createEstimatorCommsListener({
      db: t.db,
      senders: mail.senders,
      quoteUrl: async () => {
        throw new Error("no web address");
      },
      onError: (_e, context) => errors.push(context),
    });
    const created = await createEstimate(t.db, { tenantId, customerEmail: "pat@example.test", items: [{ description: "Work", unitPrice: 100 }] });
    await sendQuote(t.db, tenantId, created.id, {}, { onEvent: listener.onEvent });
    expect(mail.sent.some((m) => m.to === "pat@example.test")).toBe(true);
    expect(errors.some((e) => e.step === "links")).toBe(true);
    const log = await t.db.select().from(commsMessages).where(eq(commsMessages.tenantId, tenantId));
    expect(log.length).toBeGreaterThan(0);
  });
});

describe("route tables (3.1)", () => {
  it("every staff row routes to its kind and asks its permission", async () => {
    const { tenantId } = await shop();
    for (const route of ESTIMATOR_ADMIN_ROUTES) {
      const asked: string[] = [];
      const h = createEstimatorAdminHandlers({ db: t.db, tenantId, authorize: (_r, permission) => (asked.push(permission), false) });
      const res = await h.handle(request("https://app.test/api/x/", route, {}));
      expect(res.status, route.kind).toBe(403);
      expect(asked, route.kind).toEqual([ESTIMATOR_ADMIN_ROUTE_PERMISSIONS[route.kind]]);
    }
    expect(new Set(ESTIMATOR_ADMIN_ROUTES.map((r) => r.kind)).size).toBe(Object.keys(ESTIMATOR_ADMIN_ROUTE_PERMISSIONS).length);
    expect(Object.isFrozen(ESTIMATOR_ADMIN_ROUTES) && Object.isFrozen(ESTIMATOR_PUBLIC_ROUTES)).toBe(true);
  });

  it("every public row routes to its kind (its rate-limit bucket)", async () => {
    const { tenantId } = await shop();
    const expected: Record<string, string> = { config: "read", options: "read", calculate: "calculate", photo: "photo", takeoff: "takeoff", submit: "submit", quote: "read", accept: "respond", decline: "respond" };
    for (const route of ESTIMATOR_PUBLIC_ROUTES) {
      const buckets: string[] = [];
      const h = publicFor({ rateLimit: (_req, bucket) => (buckets.push(bucket), false) });
      const res = await h.handle(request(`https://app.test/api/t/${tenantId}/estimator/`, route, { product: "p", "quote-token": "x".repeat(43) }));
      expect(res.status, route.kind).toBe(429);
      expect(buckets, route.kind).toEqual([expected[route.kind]]);
    }
  });

  it("every example reaches its lookup: on an EMPTY company a path placeholder is 404, the rest below 500", async () => {
    const empty = tenant("empty");
    const made: Record<string, string> = {};
    for (const entity of ["product", "supply", "attachment", "option", "option-value", "estimate", "line", "photo", "key"]) made[entity] = crypto.randomUUID();
    made["quote-token"] = "q".repeat(43);
    const h = staffAs(empty);
    for (const route of ESTIMATOR_ADMIN_ROUTES) {
      const res = await h.handle(request(`https://app.test/api/app/${empty}/estimator/`, route, made));
      const text = await res.text();
      if (/\{[a-z-]+\}/.test(route.path)) {
        expect(res.status, `${route.kind}: ${text}`).toBe(404);
        expect(JSON.parse(text).error.code, route.kind).toBe("not_found");
      } else expect(res.status, `${route.kind}: ${text}`).toBeLessThan(500);
    }
    const pub = publicFor({ photoStore });
    for (const route of ESTIMATOR_PUBLIC_ROUTES) {
      const res = await pub.handle(request(`https://app.test/api/t/${empty}/estimator/`, route, made));
      const text = await res.text();
      if (/\{[a-z-]+\}/.test(route.path)) expect(res.status, `${route.kind}: ${text}`).toBe(404);
      else expect(res.status, `${route.kind}: ${text}`).toBeLessThan(500);
    }
  });
});

describe("two companies, every route", () => {
  async function plant(label: string) {
    const { tenantId } = await shop(label.toLowerCase());
    const own = await createProduct(t.db, { tenantId, name: `${label} special mowing`, recipe: "count", basePrice: 1000 } as never);
    const products = await listProducts(t.db, tenantId);
    const withOption = (await t.db.select().from(estimatorOptions).where(inArray(estimatorOptions.productId, products.map((p) => p.id))))[0]!;
    const value = (await t.db.select().from(estimatorOptionValues).where(eq(estimatorOptionValues.optionId, withOption.id)))[0]!;
    const attachment = (await t.db.select().from(estimatorProductComponents).where(inArray(estimatorProductComponents.productId, products.map((p) => p.id))))[0]!;
    const supply = (await t.db.select().from(estimatorComponents).where(eq(estimatorComponents.tenantId, tenantId)))[0]!;
    const created = await createEstimate(t.db, {
      tenantId,
      customerName: `${label} Customer`,
      customerEmail: `${label.toLowerCase()}@example.test`,
      items: [{ description: `${label} hedge work`, unitPrice: 1234 }],
    });
    const [line] = await t.db.select().from(estimatorEstimateItems).where(eq(estimatorEstimateItems.estimateId, created.id));
    await post(staffAs(tenantId), `https://app.test/api/app/${tenantId}/estimator/v1/admin/estimates/${created.id}/photos`, photo(`${label}-photo`));
    const [kept] = await t.db.select().from(estimatorPhotos).where(eq(estimatorPhotos.estimateId, created.id));
    await sendQuote(t.db, tenantId, created.id, {});
    const token = await insertQuoteToken(t.db, tenantId, created.id);
    const key = await issueClientKey(t.db, { tenantId, label: `${label} website` });
    return {
      tenantId,
      key: key.key,
      rows: {
        product: own.id,
        supply: supply.id,
        attachment: attachment.id,
        option: withOption.id,
        "option-value": value.id,
        estimate: created.id,
        line: line!.id,
        photo: kept!.id,
        key: key.id,
        "quote-token": token,
      } as Record<string, string>,
      strings: [own.id, created.id, line!.id, kept!.id, key.id, token, key.key, `${label} special mowing`, `${label} Customer`, `${label.toLowerCase()}@example.test`, `${label} hedge work`, `${label} website`],
    };
  }

  async function snapshot(tenantId: string) {
    const products = await t.db.select().from(estimatorProducts).where(eq(estimatorProducts.tenantId, tenantId)).orderBy(estimatorProducts.id);
    const productIds = products.map((p) => p.id);
    const options = productIds.length ? await t.db.select().from(estimatorOptions).where(inArray(estimatorOptions.productId, productIds)).orderBy(estimatorOptions.id) : [];
    const values = options.length ? await t.db.select().from(estimatorOptionValues).where(inArray(estimatorOptionValues.optionId, options.map((o) => o.id))).orderBy(estimatorOptionValues.id) : [];
    const attachments = productIds.length ? await t.db.select().from(estimatorProductComponents).where(inArray(estimatorProductComponents.productId, productIds)).orderBy(estimatorProductComponents.id) : [];
    const estimates = await t.db.select().from(estimatorEstimates).where(eq(estimatorEstimates.tenantId, tenantId)).orderBy(estimatorEstimates.id);
    const items = estimates.length ? await t.db.select().from(estimatorEstimateItems).where(inArray(estimatorEstimateItems.estimateId, estimates.map((e) => e.id))).orderBy(estimatorEstimateItems.id) : [];
    const rest = await Promise.all([
      t.db.select().from(estimatorComponents).where(eq(estimatorComponents.tenantId, tenantId)).orderBy(estimatorComponents.id),
      t.db.select().from(estimatorClientKeys).where(eq(estimatorClientKeys.tenantId, tenantId)).orderBy(estimatorClientKeys.id),
      t.db.select().from(estimatorPhotos).where(eq(estimatorPhotos.tenantId, tenantId)).orderBy(estimatorPhotos.id),
      t.db.select().from(estimatorQuoteTokens).where(eq(estimatorQuoteTokens.tenantId, tenantId)).orderBy(estimatorQuoteTokens.id),
      t.db.select().from(estimatorSettings).where(eq(estimatorSettings.tenantId, tenantId)),
    ]);
    return JSON.stringify([products, options, values, attachments, estimates, items, ...rest]);
  }

  it("B gets 403 with A's id, and 404 or nothing of A's with A's rows; A is unchanged", async () => {
    const A = await plant("Alpha");
    const B = await plant("Bravo");
    const before = await snapshot(A.tenantId);
    const asB = staffAs(B.tenantId);
    for (const route of ESTIMATOR_ADMIN_ROUTES) {
      const viaA = await asB.handle(request(`https://app.test/api/app/${A.tenantId}/estimator/`, route, A.rows));
      expect(viaA.status, route.kind).toBe(403);
      const res = await asB.handle(request(`https://app.test/api/app/${B.tenantId}/estimator/`, route, A.rows));
      const text = await res.text();
      if (/\{[a-z-]+\}/.test(route.path)) expect(res.status, `${route.kind}: ${text}`).toBe(404);
      else expect(res.status, `${route.kind}: ${text}`).toBeLessThan(500);
      for (const s of A.strings) expect(text, `${route.kind} leaked ${s}`).not.toContain(s);
    }
    const pub = publicFor({ photoStore });
    for (const route of ESTIMATOR_PUBLIC_ROUTES) {
      const res = await pub.handle(request(`https://app.test/api/t/${B.tenantId}/estimator/`, route, A.rows));
      const text = await res.text();
      if (/\{[a-z-]+\}/.test(route.path)) expect(res.status, `${route.kind}: ${text}`).toBe(404);
      else expect(res.status, `${route.kind}: ${text}`).toBeLessThan(500);
      for (const s of A.strings) expect(text, `${route.kind} leaked ${s}`).not.toContain(s);
    }
    expect(await snapshot(A.tenantId)).toBe(before);
  });

  it("A's embed key under B's web address is \"not found\": the address decides, never the key (review SEC-2A-04)", async () => {
    const A = await plant("Alpha");
    const B = await plant("Bravo");
    companyFor(A.tenantId, { name: "Alpha Lawn" });
    companyFor(B.tenantId, { name: "Bravo Roofing" });
    const headers = { "x-adminigloo-key": A.key, origin: "https://alpha.test" };
    const config = await get(publicFor(), `https://app.test/api/t/${B.tenantId}/estimator/v1/config`, headers);
    expect(config.status).toBe(404);
    const quote = await get(publicFor(), `https://app.test/api/t/${B.tenantId}/estimator/v1/quote/${A.rows["quote-token"]}`, headers);
    expect(quote.status).toBe(404);
    const text = (await config.text()) + (await quote.text());
    for (const s of [...A.strings, "Alpha Lawn"]) expect(text, `leaked ${s}`).not.toContain(s);
    // A's key wasn't used for anything: its "last used" is left alone.
    const [keyRow] = await t.db.select().from(estimatorClientKeys).where(eq(estimatorClientKeys.id, A.rows["key"]!));
    expect(keyRow?.lastUsedAt).toBeNull();
    // Under A's own address, A's key still works.
    const own = await get(publicFor(), `https://app.test/api/t/${A.tenantId}/estimator/v1/config`, headers);
    expect(((await own.json()) as { businessName: string }).businessName).toBe("Alpha Lawn");
    await revokeClientKey(t.db, A.tenantId, A.rows["key"]!);
  });
});

describe("the checklist items (7.6)", () => {
  it("prices, settings and the embed: not done → done, tenant-scoped", async () => {
    const a = tenant();
    const b = tenant();
    const [prices, settings, embed] = estimatorChecklistItems({ priceBook: "/app/price-book", settings: "/app/estimates/settings", embed: "/app/estimates/settings#embed" });
    expect([prices!.key, settings!.key, embed!.key]).toEqual(["estimator.prices", "estimator.settings", "estimator.embed"]);
    expect([prices!.order, settings!.order, embed!.order]).toEqual([60, 70, 90]);
    expect(embed!.href).toBe("/app/estimates/settings#embed");
    // In an owner's words, and honest about a pasted button: it leaves no key,
    // so the item says to dismiss it once the button is up (review T2A-BO-02).
    expect([embed!.title, embed!.actionLabel]).toEqual(["Add an estimate button to your website", "Get the button"]);
    expect(embed!.description).toContain("Wix, Squarespace, WordPress");
    expect(embed!.description).toContain("Once it is on your website, or if customers only use your page here, dismiss this.");
    expect(embed!.description).not.toMatch(/key|snippet|developer/i);
    for (const item of [prices!, settings!, embed!]) expect(await item.isDone({ db: t.db, tenantId: a })).toBe(false);
    await loadSampleCatalog(t.db, a, { showInEstimator: true });
    expect(await prices!.isDone({ db: t.db, tenantId: a })).toBe(true);
    // Loading the sample writes a settings row but doesn't SAVE settings.
    expect(await settings!.isDone({ db: t.db, tenantId: a })).toBe(false);
    await updateEstimatorSettings(t.db, a, { taxRateBp: 600 });
    expect(await settings!.isDone({ db: t.db, tenantId: a })).toBe(true);
    const key = await issueClientKey(t.db, { tenantId: a, label: "site" });
    expect(await embed!.isDone({ db: t.db, tenantId: a })).toBe(true);
    await revokeClientKey(t.db, a, key.id);
    expect(await embed!.isDone({ db: t.db, tenantId: a })).toBe(false);
    for (const item of [prices!, settings!, embed!]) expect(await item.isDone({ db: t.db, tenantId: b })).toBe(false);
  });
});

describe("turning a quote into an invoice needs the INVOICE permission (review SEC-2A-02)", () => {
  async function acceptedQuote() {
    const { tenantId } = await shop();
    companyFor(tenantId);
    const created = await createEstimate(t.db, { tenantId, customerEmail: "pat@example.test", items: [{ description: "Work", unitPrice: 100 }] });
    await sendQuote(t.db, tenantId, created.id, {});
    const token = await insertQuoteToken(t.db, tenantId, created.id);
    const quote = (await (await get(publicFor(), `https://app.test/api/t/${tenantId}/estimator/v1/quote/${token}`)).json()) as { quote: { version: number } };
    const accepted = await post(publicFor(), `https://app.test/api/t/${tenantId}/estimator/v1/quote/${token}/accept`, { version: quote.quote.version, name: "Pat" });
    expect(accepted.status).toBe(200);
    return { tenantId, id: created.id };
  }

  function withInvoiceRights(tenantId: string, rights: { view: boolean; manage: boolean }) {
    const asked: string[] = [];
    let converted = 0;
    const h = staffAs(tenantId, {
      invoiceAccess: (_req, need) => (asked.push(need), rights[need] ? { userId: "u" } : false),
      convertToInvoice: async ({ tenantId: id, estimateId }) => {
        converted += 1;
        const { markEstimateConverted } = await import("../estimates.js");
        await markEstimateConverted(t.db, id, estimateId);
        return { id: "inv-1", number: "INV-0001", status: "draft", url: "/app/invoices/inv-1" };
      },
      links: { invoice: async () => ({ id: "inv-1", number: "INV-0001", status: "draft", url: "/app/invoices/inv-1" }) },
    });
    return { h, asked, converted: () => converted };
  }

  it("a member whose invoice rights were taken away can't convert: 403 in plain words, nothing written", async () => {
    const { tenantId, id } = await acceptedQuote();
    const { h, converted } = withInvoiceRights(tenantId, { view: false, manage: false });
    const res = await post(h, `https://app.test/api/app/${tenantId}/estimator/v1/admin/estimates/${id}/convert`, {});
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      "You can't raise invoices, so this quote can't be turned into one.",
    );
    expect(converted()).toBe(0);
    // And the estimate's page doesn't offer it, or show an invoice.
    const page = (await (await get(h, `https://app.test/api/app/${tenantId}/estimator/v1/admin/estimates/${id}`)).json()) as {
      estimate: { links: { invoice: unknown }; actions?: Record<string, unknown> };
    };
    expect(page.estimate.links.invoice).toBeNull();
    expect(JSON.stringify(page)).not.toContain("INV-0001");
  });

  it("with invoices.manage it converts, and the page shows the invoice", async () => {
    const { tenantId, id } = await acceptedQuote();
    const { h, converted, asked } = withInvoiceRights(tenantId, { view: true, manage: true });
    const res = await post(h, `https://app.test/api/app/${tenantId}/estimator/v1/admin/estimates/${id}/convert`, {});
    expect(res.status).toBe(200);
    expect(converted()).toBe(1);
    expect(JSON.stringify(await res.json())).toContain("INV-0001");
    // Asked once per request, not once per use.
    expect(asked.filter((n) => n === "manage")).toHaveLength(1);
  });

  it("a host Response (signed out) from the invoice ask is returned as it is", async () => {
    const { tenantId, id } = await acceptedQuote();
    const h = staffAs(tenantId, {
      invoiceAccess: () => new Response(JSON.stringify({ error: { code: "forbidden", message: "You've been signed out." } }), { status: 401 }),
      convertToInvoice: async () => {
        throw new Error("must not run");
      },
    });
    const res = await post(h, `https://app.test/api/app/${tenantId}/estimator/v1/admin/estimates/${id}/convert`, {});
    expect(res.status).toBe(401);
  });
});

describe("the SITE's daily ceiling on photo reading (review SEC-2A-07)", () => {
  it("every company's readings count toward one site total; past it, every company pauses", async () => {
    // A day of its own (2031), so only this test's readings are in the site's sum.
    const day = new Date("2031-01-02T15:00:00Z");
    const a = await shop("site-a");
    const b = await shop("site-b");
    for (const { tenantId } of [a, b]) {
      companyFor(tenantId);
      await updateEstimatorSettings(t.db, tenantId, { aiDailyBudgetCents: 100, photosEnabled: true });
    }
    const model = fakeModel();
    // 1 cent for the whole site: each fake reading costs 4 250 micro-dollars and
    // claims 2 750 up front → two readings across BOTH companies, then paused.
    const h = publicFor({ takeoff: { model }, aiBudgetCeilingCents: 100, aiSiteBudgetCents: 1, now: () => day });
    const read = async (shopOf: { tenantId: string; ramp: string }, tag: string) =>
      (
        (await (
          await post(h, `https://app.test/api/t/${shopOf.tenantId}/estimator/v1/takeoff`, { productId: shopOf.ramp, ...photo(tag) })
        ).json()) as { status: string }
      ).status;
    expect(await read(a, "s1")).not.toBe("paused");
    expect(await read(b, "s2")).not.toBe("paused");
    expect(await read(a, "s3")).toBe("paused");
    expect(await read(b, "s4")).toBe("paused");
    expect(model.calls).toHaveLength(2);
    // Each company's own dollar would have kept both reading without it.
    const perCompanyOnly = publicFor({ takeoff: { model }, aiBudgetCeilingCents: 100, now: () => day });
    const status = (
      (await (await post(perCompanyOnly, `https://app.test/api/t/${a.tenantId}/estimator/v1/takeoff`, { productId: a.ramp, ...photo("s5") })).json()) as {
        status: string;
      }
    ).status;
    expect(status).not.toBe("paused");
  });
});

describe("a sample price book for the owner's trade (review T2A-BO-10)", () => {
  it("lawn care and cleaning samples load, valid and priced, with nothing about ramps", async () => {
    const { SAMPLE_CATALOGS, SAMPLE_TRADES } = await import("../sample.js");
    const { recipeConfigProblem, resolveRecipeConfig, isValidSupplyBasis } = await import("../recipes.js");
    expect([...SAMPLE_TRADES]).toEqual(["lawn", "cleaning", "ramps"]);
    // estimator-widget's trade picker (SAMPLE_TRADES) says these counts; its test holds the same numbers.
    expect(Object.fromEntries(SAMPLE_TRADES.map((trade) => [trade, [SAMPLE_CATALOGS[trade].products.length, SAMPLE_CATALOGS[trade].supplies.length]]))).toEqual({
      lawn: [5, 8],
      cleaning: [5, 5],
      ramps: [5, 10],
    });
    for (const trade of SAMPLE_TRADES) {
      const catalog = SAMPLE_CATALOGS[trade];
      for (const product of catalog.products) {
        const merged = resolveRecipeConfig(product.recipe, product.recipeConfig) as unknown as Record<string, unknown>;
        expect(recipeConfigProblem(product.recipe, merged), `${trade}: ${product.name}`).toBeNull();
        for (const use of product.supplies) {
          expect(isValidSupplyBasis(product.recipe, use.per), `${trade}: ${product.name} per ${use.per}`).toBe(true);
          expect(catalog.supplies.some((s) => s.key === use.supply), `${trade}: ${use.supply}`).toBe(true);
        }
      }
    }
    for (const trade of ["lawn", "cleaning"] as const) {
      const tenantId = tenant(trade);
      companyFor(tenantId);
      const res = await post(staffAs(tenantId), `https://app.test/api/app/${tenantId}/estimator/v1/admin/sample-catalog`, { trade });
      expect(res.status, trade).toBe(200);
      expect(await res.json()).toEqual({ products: SAMPLE_CATALOGS[trade].products.length, supplies: SAMPLE_CATALOGS[trade].supplies.length });
      const names = (await listProducts(t.db, tenantId)).map((p) => p.name);
      expect(names.join(" "), trade).not.toMatch(/ramp/i);
      // Every product a customer can price has a price: no "$0" notice after loading.
      const status = (await (await get(staffAs(tenantId), `https://app.test/api/app/${tenantId}/estimator/v1/admin/status`)).json()) as {
        notices: { code: string }[];
      };
      expect(status.notices.map((n) => n.code), trade).not.toContain("products_unpriced");
      expect(status.notices.map((n) => n.code), trade).not.toContain("labor_rate_zero");
    }
    const lawn = (await listProducts(t.db, tenant("lawn-check"))).length;
    expect(lawn).toBe(0);
  });

  it("a trade it doesn't know is refused on `trade`; no body is 0.3's ramps sample", async () => {
    const odd = tenant();
    const refused = await post(staffAs(odd), `https://app.test/api/app/${odd}/estimator/v1/admin/sample-catalog`, { trade: "plumbing" });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { issues: { path: string[] }[] } }).error.issues[0]!.path).toEqual(["trade"]);
    const plain = tenant();
    expect((await post(staffAs(plain), `https://app.test/api/app/${plain}/estimator/v1/admin/sample-catalog`, {})).status).toBe(200);
    expect((await listProducts(t.db, plain)).map((p) => p.name)).toContain("Modular aluminum ramp");
  });
});

describe("the site's own setup gaps, in a company's words (review T2A-BO-05)", () => {
  const notices = async (tenantId: string, h: { handle: (r: Request) => Promise<Response> }) =>
    ((await (await get(h, `https://app.test/api/app/${tenantId}/estimator/v1/admin/status`)).json()) as { notices: { code: string; message: string }[] }).notices;
  // No file storage and no AI key on this SITE: something only the site's
  // developer can change, so a company is told what it means, never a
  // variable name or "ask your developer".
  const gapsFor = (tenantId: string, siteNotices?: "company") =>
    createEstimatorAdminHandlers({
      db: t.db,
      tenantId,
      authorize: () => ({ userId: "owner" }),
      company,
      photoReading: false,
      photoReadingOff: "no_key",
      ...(siteNotices ? { siteNotices } : {}),
    });

  it("siteNotices \"company\": photo storage and reading are 'not available on this site yet'", async () => {
    const id = tenant();
    companyFor(id);
    const shown = await notices(id, gapsFor(id, "company"));
    expect(shown.find((n) => n.code === "photos_no_store")?.message).toBe(
      "Photos customers send can't be kept on this site yet, so they aren't saved with the estimate.",
    );
    expect(shown.find((n) => n.code === "reading_off")?.message).toBe(
      "Photo reading isn't available on this site yet, so customers are asked to count and measure themselves.",
    );
    for (const notice of shown) expect(notice.message).not.toMatch(/ANTHROPIC|_KEY|developer|file storage|pnpm/i);
  });

  it("without it, the developer's words stay: the variable to set is named", async () => {
    const id = tenant();
    companyFor(id);
    const shown = await notices(id, gapsFor(id));
    expect(shown.find((n) => n.code === "photos_no_store")?.message).toBe("Photos can't be kept: no file storage is connected.");
    expect(shown.find((n) => n.code === "reading_off")?.message).toContain("ANTHROPIC_API_KEY");
  });
});
