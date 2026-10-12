import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  calculateEstimate,
  createEstimatorHandlers,
  ESTIMATOR_KEY_HEADER,
  issueClientKey,
  midpointOf,
  type CreateEstimatorHandlersOptions,
} from "../index.js";
import {
  estimatorComponents,
  estimatorEstimateItems,
  estimatorEstimates,
  estimatorOptionValues,
  estimatorOptions,
  estimatorProductComponents,
  estimatorProducts,
} from "../schema.js";
import { eq } from "drizzle-orm";
import { updateEstimatorSettings } from "../settings.js";
import { fakeModel, photo } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * 0.2's embed suite, MOVED to PGlite in 0.3 (the 0.3 handler reads settings,
 * keys and the reading ledger with SQL the in-memory fake doesn't speak): the
 * key resolves the tenant, and the wire body cannot set a price, a tax rate or
 * a discount.
 *
 * Deliberate 0.3 changes (each in the changeset): an error body is
 * `{ error: { code, message, issues? } }` (0.2: `{ error: "product_unavailable" }`);
 * a submit answers 201 (0.2: 200); another tenant's product on calculate is a
 * 400 `product_unavailable` (0.2: `{ result: null }`); a measurement the
 * product can't be priced from is `needs_inputs` with `result: null`; and
 * `runTakeoff` is gone — a photo is read with `takeoff: { model }`, and only
 * ever for a live, public product of the key's tenant.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

async function setup(options: Partial<CreateEstimatorHandlersOptions> & { taxRateBp?: number } = {}) {
  const A = tenant("a");
  const B = tenant("b");
  // A 0.2 host upgrading saves its business name and tax rate once (Settings);
  // until then the embed says estimates aren't available (review EST-R02).
  const { taxRateBp, ...handlerOptions } = options;
  await updateEstimatorSettings(t.db, A, { businessName: "Acme Ramps", taxRateBp: taxRateBp ?? 825 });
  const id = (name: string) => `${A}-${name}`;
  await t.db.insert(estimatorProducts).values([
    { id: id("ramp"), tenantId: A, name: "Ramp", measurementMode: "linear", pricePerLinearFt: 12_000 },
    { id: id("b-ramp"), tenantId: B, name: "B ramp", measurementMode: "linear", pricePerLinearFt: 1 },
  ]);
  await t.db.insert(estimatorOptions).values([
    { id: id("rail"), productId: id("ramp"), name: "Railing" },
    { id: id("permit"), productId: id("ramp"), name: "Permit handling", showInEstimator: false },
  ]);
  await t.db.insert(estimatorOptionValues).values([
    { id: id("rail-yes"), optionId: id("rail"), label: "Both sides", priceModifier: 20_000 },
    { id: id("permit-yes"), optionId: id("permit"), label: "We pull it", priceModifier: 15_000 },
  ]);
  const { key } = await issueClientKey(t.db, { tenantId: A, label: "Acme site" });
  const handlers = createEstimatorHandlers({ db: t.db, ...handlerOptions });
  const post = (path: string, body: unknown) =>
    handlers.handle(
      new Request(`https://host.example/api/estimator/embed${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", [ESTIMATOR_KEY_HEADER]: key },
        body: JSON.stringify(body),
      }),
    );
  const rows = async () => (await t.db.select().from(estimatorEstimates).where(eq(estimatorEstimates.tenantId, A))) as Array<typeof estimatorEstimates.$inferSelect>;
  return { A, B, id, post, rows };
}

const submitBody = (productId: string, item: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  customerName: "Pat",
  customerEmail: "pat@example.com",
  source: "public_tool",
  items: [{ productId, description: "Ramp", measurement: { linearFt: 24 }, quantity: 1, ...item }],
  ...extra,
});

describe("POST /v1/submit", () => {
  it("prices on the server whatever unitPrice, discount or taxRateBp the body carries", async () => {
    const { A, id, post, rows } = await setup({ taxRateBp: 700 });
    const res = await post("/v1/submit", submitBody(id("ramp"), { unitPrice: 1, laborPrice: 0 }, { discount: 50_000, taxRateBp: 0, photoUrl: "x" }));
    expect(res.status).toBe(201); // 0.3: 201 (0.1 widgets check res.ok)
    const shown = await calculateEstimate(t.db, { productId: id("ramp"), measurement: { linearFt: 24 } }, { tenantId: A });
    const [estimate] = await rows();
    const [item] = await t.db.select().from(estimatorEstimateItems).where(eq(estimatorEstimateItems.estimateId, estimate!.id));
    expect(item!.total).toBe(midpointOf(shown!.estimateLow, shown!.estimateHigh));
    expect(estimate).toMatchObject({ tenantId: A, discount: 0, taxRateBp: 700, photoUrl: null });
  });

  it("refuses another tenant's product with a 400 that names the refusal", async () => {
    const { id, post, rows } = await setup();
    const res = await post("/v1/submit", submitBody(id("b-ramp"), {}) /* tenant B's product */);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("product_unavailable"); // 0.3: { error: { code, message } }
    expect(await rows()).toHaveLength(0);
  });

  it("answers 400 for a lead with no way to reach the customer, and saves nothing", async () => {
    const { id, post, rows } = await setup();
    const res = await post("/v1/submit", submitBody(id("ramp"), {}, { customerEmail: null, customerPhone: null }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; issues: Array<{ path: string[] }> } };
    expect(body.error.code).toBe("invalid");
    expect(body.error.issues[0]!.path).toEqual(["email"]); // the wire's name
    expect(await rows()).toHaveLength(0);
  });

  it("calls onLead after a save, and a throwing listener does not fail the submit", async () => {
    const leads: unknown[] = [];
    const { A, id, post } = await setup({ onLead: (lead) => void leads.push(lead) });
    const res = await post("/v1/submit", submitBody(id("ramp"), {}));
    const created = (await res.json()) as { id: string; estimateNumber: string };
    expect(leads).toEqual([{ tenantId: A, estimateId: created.id, estimateNumber: created.estimateNumber }]);

    const broken = await setup({
      onLead: () => {
        throw new Error("mailer down");
      },
    });
    expect((await broken.post("/v1/submit", submitBody(broken.id("ramp"), {}))).status).toBe(201);
  });
});

describe("POST /v1/options and /v1/calculate", () => {
  it("never sends a staff-only option, and prices as if it were not chosen", async () => {
    const { id, post } = await setup();
    const options = (await (await post("/v1/options", { productId: id("ramp") })).json()) as { options: Array<{ name: string }> };
    expect(options.options.map((o) => o.name)).toEqual(["Railing"]);

    const calc = async (optionValueIds: string[]) =>
      ((await (await post("/v1/calculate", { productId: id("ramp"), measurement: { linearFt: 24 }, optionValueIds })).json()) as {
        result: { subtotal: number } | null;
      }).result;
    const bare = await calc([]);
    expect((await calc([id("permit-yes")]))!.subtotal).toBe(bare!.subtotal);
    expect((await calc([id("rail-yes")]))!.subtotal).toBe(bare!.subtotal + 20_000);
  });

  it("prices nothing for another tenant's product: 0.3 answers 400 product_unavailable", async () => {
    const { B, post } = await setup();
    const [other] = await t.db.select().from(estimatorProducts).where(eq(estimatorProducts.tenantId, B));
    const res = await post("/v1/calculate", { productId: other!.id, measurement: { linearFt: 24 } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("product_unavailable");
  });
});

describe("the embed prices a measurement the way the tool asks for it", () => {
  type Priced = { status: string; result: { subtotal: number } | null };

  it("ignores measurement.units — estimator-widget 0.1.0 sends units: quantity", async () => {
    const { A, id, post } = await setup();
    // $80 gate + one $20 latch per gate (per_unit).
    await t.db.insert(estimatorProducts).values([{ id: id("gate"), tenantId: A, name: "Gate", measurementMode: "unit", basePrice: 8_000 }]);
    await t.db.insert(estimatorComponents).values([{ id: id("latch"), tenantId: A, name: "Latch", unitType: "per_unit", unitCost: 2_000 }]);
    await t.db.insert(estimatorProductComponents).values([{ productId: id("gate"), componentId: id("latch"), quantityMilli: 1000 }]);
    const calc = async (measurement: object) =>
      ((await (await post("/v1/calculate", { productId: id("gate"), measurement, quantity: 2 })).json()) as Priced).result;

    const bare = await calc({});
    expect(bare!.subtotal).toBe(20_000);
    for (const units of [1e-4, 0, 2]) expect(await calc({ units })).toEqual(bare);

    const res = await post("/v1/submit", submitBody(id("gate"), { measurement: { units: 1e-4 }, quantity: 2 }));
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };
    const [item] = await t.db.select().from(estimatorEstimateItems).where(eq(estimatorEstimateItems.estimateId, created.id));
    expect(item!.total).toBe(20_500);
  });

  it("a bare sqFt for an area product is needs_inputs (it priced the perimeter at 0)", async () => {
    const { A, id, post, rows } = await setup();
    await t.db
      .insert(estimatorProducts)
      .values([{ id: id("panel"), tenantId: A, name: "Panel", measurementMode: "area", pricePerSqFt: 2_000, pricePerLinearFt: 1_500 }]);
    const calc = (await (await post("/v1/calculate", { productId: id("panel"), measurement: { sqFt: 18 } })).json()) as Priced;
    expect(calc).toMatchObject({ status: "needs_inputs", result: null });
    const res = await post("/v1/submit", submitBody(id("panel"), { measurement: { sqFt: 18 } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_measurement");
    expect(await rows()).toHaveLength(0);
  });
});

describe("POST /v1/takeoff", () => {
  it("reads only for a live, public product of the key's tenant (0.3: `takeoff: { model }`, not `runTakeoff`)", async () => {
    const model = fakeModel();
    const { A, B, id, post } = await setup({ takeoff: { model } });
    await t.db.insert(estimatorProducts).values([
      { id: id("hidden"), tenantId: A, name: "Hidden", measurementMode: "unit", showInEstimator: false },
      { id: id("gone"), tenantId: A, name: "Gone", measurementMode: "unit", isActive: false },
      { id: id("steps"), tenantId: A, name: "Steps", recipe: "ramp_over_steps", measurementMode: "linear" },
    ]);
    const [other] = await t.db.select().from(estimatorProducts).where(eq(estimatorProducts.tenantId, B));
    for (const productId of [other!.id, id("hidden"), id("gone")]) {
      const res = await post("/v1/takeoff", { productId, ...photo(`refused-${productId}`) });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("product_unavailable");
    }
    expect(model.calls).toHaveLength(0);
    const res = await post("/v1/takeoff", { productId: id("steps"), ...photo("ok") });
    expect(res.status).toBe(200);
    expect(model.calls).toHaveLength(1);
  });
});
