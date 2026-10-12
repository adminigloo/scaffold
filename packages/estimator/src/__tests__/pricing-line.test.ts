import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { attachComponent, createComponent, createOption, createOptionValue, createProduct, listProducts } from "../catalog.js";
import { previewProductPrice, priceProduct, toPublicPrice, type PricedProduct } from "../price-product.js";
import { loadSampleCatalog } from "../sample.js";
import { estimatorTakeoffs } from "../schema.js";
import { getEstimatorSettings, updateEstimatorSettings } from "../settings.js";
import { EstimatorInputError } from "../types.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/** Pricing a line (6.4): one place for every audience, so the number saved is the number shown. */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

async function sample() {
  const tenantId = tenant();
  await loadSampleCatalog(t.db, tenantId, { showInEstimator: true });
  await updateEstimatorSettings(t.db, tenantId, { businessName: "Summit Ramps", taxRateBp: 825 });
  const products = await listProducts(t.db, tenantId);
  const id = (name: string) => products.find((p) => p.name === name)!.id;
  return { tenantId, id };
}

async function reading(tenantId: string, productId: string, observation: Record<string, unknown>, confidence: string, status = "read") {
  const [row] = await t.db
    .insert(estimatorTakeoffs)
    .values({ tenantId, productId, recipe: "ramp_over_steps", photoHash: `${Math.random()}`, status, observation, confidence })
    .returning();
  return row!.id;
}

const priced = (result: Awaited<ReturnType<typeof priceProduct>>): PricedProduct => {
  if (result.status !== "priced") throw new Error(`expected a price, got ${result.status}`);
  return result;
};

describe("priceProduct", () => {
  it("the sample ramp, as the customer sees it", async () => {
    const { tenantId, id } = await sample();
    const result = priced(await priceProduct(t.db, tenantId, { productId: id("Modular aluminum ramp"), inputs: { steps: 3 } }, { audience: "public" }));
    // The range is 21–24 ft; the line is priced at the typical 7.5 in, 23 ft (review EST-R05), posts bought whole (EST-R09).
    expect([result.build.estimateLow, result.build.estimateHigh, result.build.lineTotal]).toEqual([647_262, 714_588, 692_146]);
    expect(result.legacyMeasurement).toEqual({ linearFt: 23 });
    const settings = await getEstimatorSettings(t.db, tenantId);
    expect(toPublicPrice(result, settings)).toEqual({
      low: 647_262,
      high: 714_588,
      single: false,
      currency: "USD",
      explanation: ["3 steps × 7–8 in each (estimated) = 21–24 in rise", "ADA 1:12 slope (1 ft of ramp per inch of rise) → 21–24 ft of ramp"],
      assumption: "Based on an estimated step height of 7–8 in. Measure one step and enter it for a tighter estimate.",
      resultPhrase: "That's about a 21–24 ft ramp.",
      reasons: ["Step height 7–8 in (estimated)"],
      taxNote: "Plus 8.25% sales tax.",
    });
    expect(JSON.stringify(toPublicPrice(result, settings))).not.toMatch(/cost|margin|supply/i);
  });

  it("needs_inputs for a half-typed form, quote_only for a product a person prices, ZodError on a bad value", async () => {
    const { tenantId, id } = await sample();
    expect(await priceProduct(t.db, tenantId, { productId: id("Modular aluminum ramp"), inputs: {} }, { audience: "public" })).toEqual({
      status: "needs_inputs",
      missing: ["steps"],
    });
    expect((await priceProduct(t.db, tenantId, { productId: id("Something else") }, { audience: "public" })).status).toBe("quote_only");
    let error: unknown;
    try {
      await priceProduct(t.db, tenantId, { productId: id("Modular aluminum ramp"), inputs: { steps: 99 } }, { audience: "public" });
    } catch (caught) {
      error = caught;
    }
    expect((error as ZodError).issues[0]!.path).toEqual(["inputs", "steps"]);
  });

  it("public vs staff: a staff-only product and a staff-only option are the staff's", async () => {
    const tenantId = tenant();
    const back = await createProduct(t.db, { tenantId, name: "Backroom", recipe: "count", showInEstimator: false, basePrice: 1_000 });
    const front = await createProduct(t.db, { tenantId, name: "Front", recipe: "count", basePrice: 1_000 });
    const rush = await createOption(t.db, tenantId, { productId: front.id, name: "Rush", showInEstimator: false });
    const yes = await createOptionValue(t.db, tenantId, { optionId: rush.id, label: "Rush", priceModifier: 5_000 });
    await expect(priceProduct(t.db, tenantId, { productId: back.id, inputs: { count: 1 } }, { audience: "public" })).rejects.toBeInstanceOf(EstimatorInputError);
    expect(priced(await priceProduct(t.db, tenantId, { productId: back.id, inputs: { count: 1 } })).build.point).toBe(1_000);
    const pub = priced(await priceProduct(t.db, tenantId, { productId: front.id, inputs: { count: 1 }, optionValueIds: [yes.id] }, { audience: "public" }));
    const staff = priced(await priceProduct(t.db, tenantId, { productId: front.id, inputs: { count: 1 }, optionValueIds: [yes.id] }));
    expect(pub.build.point).toBe(1_000);
    expect(staff.build.point).toBe(6_000);
    await expect(priceProduct(t.db, tenant(), { productId: front.id, inputs: { count: 1 } })).rejects.toMatchObject({ code: "product_unavailable" });
  });

  it("0.2 measurements still arrive: an area in inches, a length, a count's quantity", async () => {
    const tenantId = tenant();
    const panel = await createProduct(t.db, { tenantId, name: "Panel", measurementMode: "area", pricePerSqFt: 2_000, rangeMode: "percent" });
    const area = priced(await priceProduct(t.db, tenantId, { productId: panel.id, measurement: { widthIn: 72, heightIn: 36 } }, { audience: "public" }));
    expect(area.inputs).toEqual({ width: 6, length: 3 }); // a 0.3 area is in feet: 72 in → 6 ft
    expect(area.build.point).toBe(36_000);
    const fence = await createProduct(t.db, { tenantId, name: "Fence", measurementMode: "linear", pricePerLinearFt: 1_000 });
    expect(priced(await priceProduct(t.db, tenantId, { productId: fence.id, measurement: { linearFt: 24 } }, { audience: "public" })).build.point).toBe(24_000);
    const posts = await createProduct(t.db, { tenantId, name: "Posts", measurementMode: "unit", basePrice: 5_000 });
    const three = priced(await priceProduct(t.db, tenantId, { productId: posts.id, measurement: {}, quantity: 3 }, { audience: "public" }));
    expect([three.inputs, three.quantity, three.build.point]).toEqual([{ count: 3 }, 3, 15_000]);
    // A 0.1 widget's `units` (any value) is dropped before anything checks it.
    const units = priced(await priceProduct(t.db, tenantId, { productId: posts.id, measurement: { units: 0 }, quantity: 3 }, { audience: "public" }));
    expect(units.build.point).toBe(15_000);
    // Staff keep 0.2's way for a full measurement (units included).
    const legacy = priced(await priceProduct(t.db, tenantId, { productId: posts.id, measurement: { units: 2 }, quantity: 1 }));
    expect(legacy.inputs).toBeNull();
    expect(legacy.derivation.explanation).toEqual([]);
  });

  it("'How many ramps?' only where offered: ignored otherwise; capped at the product's maximum for customers", async () => {
    const tenantId = tenant();
    const single = await createProduct(t.db, { tenantId, name: "Ramp", recipe: "ramp_over_steps", basePrice: 100_000 });
    const multi = await createProduct(t.db, { tenantId, name: "Gate", recipe: "linear", basePrice: 10_000, allowMultiple: true, maxQuantity: 3 });
    expect(priced(await priceProduct(t.db, tenantId, { productId: single.id, inputs: { totalRiseIn: 20 }, quantity: 4 }, { audience: "public" })).quantity).toBe(1);
    expect(priced(await priceProduct(t.db, tenantId, { productId: multi.id, inputs: { length: 4 }, quantity: 3 }, { audience: "public" })).build.point).toBe(30_000);
    await expect(priceProduct(t.db, tenantId, { productId: multi.id, inputs: { length: 4 }, quantity: 4 }, { audience: "public" })).rejects.toBeInstanceOf(ZodError);
    expect(priced(await priceProduct(t.db, tenantId, { productId: single.id, inputs: { totalRiseIn: 20 }, quantity: 4 })).quantity).toBe(4); // staff
  });

  it("a reading prices only at medium/high confidence, only without a typed height, only this tenant's and product's", async () => {
    const { tenantId, id } = await sample();
    const ramp = id("Modular aluminum ramp");
    const medium = await reading(tenantId, ramp, { recipe: "ramp_over_steps", seen: true, risers: 3, riserHeightIn: { low: 7.5, high: 8.5 }, confidence: "medium" }, "medium");
    const low = await reading(tenantId, ramp, { recipe: "ramp_over_steps", seen: true, risers: 3, riserHeightIn: { low: 7.5, high: 8.5 }, confidence: "low" }, "low");
    const at = async (inputs: Record<string, number>, takeoffId: string | null, strict = false) =>
      priced(await priceProduct(t.db, tenantId, { productId: ramp, inputs, takeoffId }, { audience: "public", strictTakeoff: strict }));
    expect((await at({ steps: 3 }, medium)).derivation.basis).toBe("photo");
    expect((await at({ steps: 3 }, low)).derivation.basis).toBe("assumed");
    expect((await at({ steps: 3, stepHeightIn: 7 }, medium)).derivation.basis).toBe("measured");
    expect((await at({ steps: 4 }, medium)).corrections).toEqual([{ field: "steps", label: "Steps", from: 3, to: 4 }]);

    const other = await sample();
    const foreign = await reading(other.tenantId, other.id("Modular aluminum ramp"), { recipe: "ramp_over_steps", seen: true, risers: 3, riserHeightIn: { low: 7.5, high: 8.5 }, confidence: "high" }, "high");
    expect((await at({ steps: 3 }, foreign)).derivation.basis).toBe("assumed"); // ignored on calculate
    await expect(at({ steps: 3 }, foreign, true)).rejects.toMatchObject({ code: "takeoff_unavailable" }); // refused on submit
    const pending = await reading(tenantId, ramp, {}, "high", "pending");
    await expect(at({ steps: 3 }, pending, true)).rejects.toMatchObject({ code: "takeoff_unavailable" });
  });

  it("labor at the settings' rate when the product names none; contingency from the settings", async () => {
    const tenantId = tenant();
    await updateEstimatorSettings(t.db, tenantId, { defaultLaborRateCents: 5_000, contingencyBp: 1_000 });
    const job = await createProduct(t.db, { tenantId, name: "Job", recipe: "count", laborHoursPerUnitMilli: 2_000 });
    const result = priced(await priceProduct(t.db, tenantId, { productId: job.id, inputs: { count: 1 } }));
    expect(result.build.point).toBe(10_000);
    expect([result.build.estimateLow, result.build.estimateHigh]).toEqual([9_000, 11_000]);
    const settings = await getEstimatorSettings(t.db, tenantId);
    expect(toPublicPrice(result, settings).reasons).toEqual(["Contingency ±10%"]);
  });

  it("a percent-band product (0.2's) explains itself in a customer's words", async () => {
    const tenantId = tenant();
    const old = await createProduct(t.db, { tenantId, name: "Old", recipe: "count", basePrice: 10_000, rangeMode: "percent" });
    const result = priced(await priceProduct(t.db, tenantId, { productId: old.id, inputs: { count: 1 } }));
    expect(result.build.reasons).toEqual(["Price band 90%–115% of the price (your setting)"]);
    expect(toPublicPrice(result, await getEstimatorSettings(t.db, tenantId)).reasons).toEqual(["Estimates are shown as 90%–115% of the price"]);
  });
});

describe("previewProductPrice: the price-book editor's live preview", () => {
  async function counts(): Promise<string> {
    const rows = await t.client.query(
      "select (select count(*) from estimator_products) p, (select count(*) from estimator_components) c, (select count(*) from estimator_product_components) pc, (select count(*) from estimator_options) o, (select count(*) from estimator_estimates) e, (select count(*) from estimator_settings) s",
    );
    return JSON.stringify(rows.rows);
  }

  it("prices a draft over a saved product, and writes nothing", async () => {
    const { tenantId, id } = await sample();
    const ramp = id("Modular aluminum ramp");
    const before = await counts();
    const asSaved = await previewProductPrice(t.db, tenantId, { productId: ramp, inputs: { steps: 3 } });
    expect(asSaved.customerView).toMatchObject({ low: 647_262, high: 714_588 });
    const draft = await previewProductPrice(t.db, tenantId, {
      productId: ramp,
      inputs: { steps: 3 },
      draft: { pricingBasis: "margin", marginBp: 3_500, recipeConfig: { stepsLabel: "Steps up to your door?" } },
    });
    expect(draft.build?.point).toBe(760_600); // 23 ft at cost $4,943.90 ÷ (1 − 35%)
    expect(draft.fields[0]).toMatchObject({ label: "Steps up to your door?" });
    expect(await counts()).toBe(before);
  });

  it("a new product: the fields for its recipe, its draft supplies and options (by their default)", async () => {
    const tenantId = tenant();
    const kit = await createComponent(t.db, { tenantId, name: "Kit", unitType: "per_unit", unitCost: 4_500 });
    const asked = await previewProductPrice(t.db, tenantId, { draft: { recipe: "count", recipeConfig: { countLabel: "How many bars?" } } });
    expect(asked).toMatchObject({ status: "needs_inputs", missing: ["count"], fields: [{ key: "count", label: "How many bars?" }] });
    const priced = await previewProductPrice(t.db, tenantId, {
      inputs: { count: 2 },
      draft: {
        recipe: "count",
        markupBp: 10_000,
        supplies: [{ supplyId: kit.id, quantityMilli: 1000, per: "item" }],
        options: [{ name: "Finish", values: [{ label: "Stainless", priceModifier: 0 }, { label: "Brass", priceModifier: 3_000, isDefault: true }] }],
      },
    });
    expect(priced.build?.point).toBe(2 * 9_000 + 2 * 3_000);
    expect(priced.build?.breakdown.map((l) => l.label)).toEqual(["Kit", "Markup 100%", "Finish: Brass"]);
    await expect(
      previewProductPrice(t.db, tenantId, { draft: { recipe: "count", supplies: [{ supplyId: kit.id, quantityMilli: 1000, per: "rampFt" }] }, inputs: { count: 1 } }),
    ).rejects.toMatchObject({ code: "invalid_supply_basis" });
    await expect(previewProductPrice(t.db, tenant(), { draft: { supplies: [{ supplyId: kit.id, quantityMilli: 1, per: "sqFt" }] }, inputs: { width: 1, length: 1 } })).rejects.toMatchObject({
      code: "component_unavailable",
    });
  });
});
