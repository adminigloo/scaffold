import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  attachComponent,
  createComponent,
  createOption,
  createOptionValue,
  createProduct,
  deactivateComponent,
  deactivateOption,
  deactivateOptionValue,
  getProductDetail,
  listComponents,
  listProducts,
  productsUsingComponent,
  reactivateComponent,
  reactivateProduct,
  deactivateProduct,
  reorderProducts,
  toAdminProduct,
  updateAttachment,
  updateComponent,
  updateOption,
  updateOptionValue,
  updateProduct,
} from "../catalog.js";
import { createEstimatorHandlers } from "../handlers.js";
import { loadSampleCatalog, SAMPLE_CATALOG } from "../sample.js";
import {
  estimatorComponents,
  estimatorOptionValues,
  estimatorOptions,
  estimatorProductComponents,
  estimatorProducts,
  estimatorSettings,
} from "../schema.js";
import { getEstimatorSettings } from "../settings.js";
import { EstimatorInputError } from "../types.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/** The price book (6.2, 6.3): products, supplies, what each uses and per what, options — tenant-scoped throughout. */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EstimatorInputError) return error.code;
    throw error;
  }
  throw new Error("expected an EstimatorInputError");
}

describe("products", () => {
  it("0.3's defaults: a measured range, no 'how many', the recipe written and the mode kept in step", async () => {
    const tenantId = tenant();
    const ramp = await createProduct(t.db, { tenantId, name: "Ramp", recipe: "ramp_over_steps" });
    expect(ramp).toMatchObject({ recipe: "ramp_over_steps", measurementMode: "linear", rangeMode: "measured", allowMultiple: false, pricingBasis: "markup", maxQuantity: 10 });
    const pad = await createProduct(t.db, { tenantId, name: "Pad" });
    expect(pad).toMatchObject({ recipe: "area", measurementMode: "area" });
    // A 0.2 caller that names only a mode keeps its kind of product; a mode that disagrees with a recipe is ignored.
    expect(await createProduct(t.db, { tenantId, name: "Fence", measurementMode: "linear" })).toMatchObject({ recipe: "linear", measurementMode: "linear" });
    expect(await createProduct(t.db, { tenantId, name: "Bars", recipe: "count", measurementMode: "area" })).toMatchObject({ recipe: "count", measurementMode: "unit" });
  });

  it("a recipe config is checked key by key, merged on update, and as a whole", async () => {
    const tenantId = tenant();
    const ramp = await createProduct(t.db, { tenantId, name: "Ramp", recipe: "ramp_over_steps", recipeConfig: { stepsLabel: "Steps to the porch?" } });
    const updated = await updateProduct(t.db, tenantId, ramp.id, { recipeConfig: { maxSteps: 12 } });
    expect(updated?.recipeConfig).toEqual({ stepsLabel: "Steps to the porch?", maxSteps: 12 });
    const detail = await getProductDetail(t.db, tenantId, ramp.id);
    expect(detail?.fields[0]).toMatchObject({ label: "Steps to the porch?", max: 12 });
    let zod: unknown;
    try {
      await updateProduct(t.db, tenantId, ramp.id, { recipeConfig: { slopeRatio: 4 } });
    } catch (error) {
      zod = error;
    }
    expect((zod as ZodError).issues[0]!.path).toEqual(["recipeConfig", "slopeRatio"]);
    const pad = await createProduct(t.db, { tenantId, name: "Pad", recipe: "area" });
    expect(await refusal(updateProduct(t.db, tenantId, pad.id, { recipeConfig: { maxWidth: 5000 } }))).toBe("invalid_recipe_config");
    expect((await updateProduct(t.db, tenantId, pad.id, { recipeConfig: { unit: "in", maxWidth: 5000 } }))?.recipeConfig).toEqual({ unit: "in", maxWidth: 5000 });
  });

  it("a recipe change is refused while a supply is priced by a measurement the new recipe doesn't have", async () => {
    const tenantId = tenant();
    const ramp = await createProduct(t.db, { tenantId, name: "Ramp", recipe: "ramp_over_steps" });
    const section = await createComponent(t.db, { tenantId, name: "Ramp section", unitType: "per_linear_ft", unitCost: 9_500 });
    const permit = await createComponent(t.db, { tenantId, name: "Permit", unitType: "flat", unitCost: 15_000 });
    await attachComponent(t.db, tenantId, { productId: ramp.id, componentId: section.id, per: "rampFt" });
    await attachComponent(t.db, tenantId, { productId: ramp.id, componentId: permit.id, per: "job" });
    let caught: unknown;
    try {
      await updateProduct(t.db, tenantId, ramp.id, { recipe: "area" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EstimatorInputError);
    expect((caught as EstimatorInputError).code).toBe("invalid_supply_basis");
    expect((caught as EstimatorInputError).message).toContain("Ramp section");
    expect((caught as EstimatorInputError).message).not.toContain("Permit");
    expect((await getProductDetail(t.db, tenantId, ramp.id))?.recipe).toBe("ramp_over_steps");
    // A recipe the supplies fit is fine.
    const job = await createProduct(t.db, { tenantId, name: "Service", recipe: "count" });
    await attachComponent(t.db, tenantId, { productId: job.id, componentId: permit.id, per: "job" });
    expect((await updateProduct(t.db, tenantId, job.id, { recipe: "linear" }))?.measurementMode).toBe("linear");
  });

  it("another tenant's product changes nothing; retire, restore, reorder", async () => {
    const tenantId = tenant();
    const other = tenant();
    const a = await createProduct(t.db, { tenantId, name: "A" });
    const b = await createProduct(t.db, { tenantId, name: "B" });
    const c = await createProduct(t.db, { tenantId, name: "C" });
    expect(await updateProduct(t.db, other, a.id, { name: "Hijacked" })).toBeNull();
    expect(await deactivateProduct(t.db, other, a.id)).toBe(false);
    expect(await deactivateProduct(t.db, tenantId, a.id)).toBe(true);
    expect((await listProducts(t.db, tenantId)).map((p) => p.name)).toEqual(["B", "C"]);
    expect((await listProducts(t.db, tenantId, { includeInactive: true })).map((p) => p.name)).toEqual(["A", "B", "C"]);
    expect(await reactivateProduct(t.db, tenantId, a.id)).toBe(true);
    await reorderProducts(t.db, tenantId, [c.id, a.id, "not-mine", b.id]);
    expect((await listProducts(t.db, tenantId)).map((p) => [p.name, p.sortOrder])).toEqual([
      ["C", 0],
      ["A", 10],
      ["B", 30],
    ]);
  });
});

describe("supplies and attachments", () => {
  it("update, retire and restore a supply — answering the products it re-prices", async () => {
    const tenantId = tenant();
    const rail = await createComponent(t.db, { tenantId, name: "Handrail", unitType: "per_linear_ft", unitCost: 1_800, supplier: "Metro Supply", sku: "HR-1" });
    const ramp = await createProduct(t.db, { tenantId, name: "Ramp", recipe: "ramp_over_steps" });
    const railOnly = await createProduct(t.db, { tenantId, name: "Handrail only", recipe: "linear" });
    const retired = await createProduct(t.db, { tenantId, name: "Old ramp", recipe: "ramp_over_steps" });
    for (const product of [ramp, railOnly, retired]) await attachComponent(t.db, tenantId, { productId: product.id, componentId: rail.id });
    await deactivateProduct(t.db, tenantId, retired.id);
    const updated = await updateComponent(t.db, tenantId, rail.id, { unitCost: 1_900, note: "Price as of Oct 2026" });
    expect(updated?.component).toMatchObject({ unitCost: 1_900, supplier: "Metro Supply", sku: "HR-1", note: "Price as of Oct 2026" });
    expect(updated?.affectedProducts.map((p) => p.name)).toEqual(["Handrail only", "Ramp"]);
    expect((await productsUsingComponent(t.db, tenantId, rail.id)).map((p) => [p.name, p.isActive])).toEqual([
      ["Handrail only", true],
      ["Old ramp", false],
      ["Ramp", true],
    ]);
    expect(await updateComponent(t.db, tenant(), rail.id, { unitCost: 1 })).toBeNull();
    expect(await deactivateComponent(t.db, tenantId, rail.id)).toBe(true);
    expect(await listComponents(t.db, tenantId)).toHaveLength(0);
    expect(await listComponents(t.db, tenantId, { includeInactive: true })).toHaveLength(1);
    expect(await reactivateComponent(t.db, tenantId, rail.id)).toBe(true);
    expect(await reactivateComponent(t.db, tenant(), rail.id)).toBe(false);
  });

  it("an attach's per: the default for the supplier's unit, checked against the recipe", async () => {
    const tenantId = tenant();
    const ramp = await createProduct(t.db, { tenantId, name: "Ramp", recipe: "ramp_over_steps" });
    const perFt = await createComponent(t.db, { tenantId, name: "Section", unitType: "per_linear_ft", unitCost: 1 });
    const flat = await createComponent(t.db, { tenantId, name: "Permit", unitType: "flat", unitCost: 1 });
    const each = await createComponent(t.db, { tenantId, name: "Post", unitType: "per_unit", unitCost: 1 });
    const sqft = await createComponent(t.db, { tenantId, name: "Concrete", unitType: "per_sqft", unitCost: 1 });
    await attachComponent(t.db, tenantId, { productId: ramp.id, componentId: perFt.id });
    await attachComponent(t.db, tenantId, { productId: ramp.id, componentId: flat.id });
    await attachComponent(t.db, tenantId, { productId: ramp.id, componentId: each.id });
    expect(await refusal(attachComponent(t.db, tenantId, { productId: ramp.id, componentId: sqft.id }))).toBe("invalid_supply_basis");
    expect(await refusal(attachComponent(t.db, tenantId, { productId: ramp.id, componentId: sqft.id, per: "sqFt" }))).toBe("invalid_supply_basis");
    const detail = await getProductDetail(t.db, tenantId, ramp.id);
    expect(detail?.components.map((c) => [c.component.name, c.per, c.perLabel])).toEqual([
      ["Section", "rampFt", "per ft of ramp"],
      ["Permit", "job", "once per job"],
      ["Post", "item", "per item"],
    ]);
    const post = detail!.components[2]!;
    expect(await updateAttachment(t.db, tenantId, post.assignmentId, { per: "rampFt", quantityMilli: 250, sortOrder: 5 })).toBe(true);
    expect(await refusal(updateAttachment(t.db, tenantId, post.assignmentId, { per: "perimeterFt" }))).toBe("invalid_supply_basis");
    expect(await updateAttachment(t.db, tenant(), post.assignmentId, { quantityMilli: 1 })).toBe(false);
    const after = await getProductDetail(t.db, tenantId, ramp.id);
    expect(after?.components.find((c) => c.assignmentId === post.assignmentId)).toMatchObject({ per: "rampFt", quantityMilli: 250, sortOrder: 5 });
    // A product from before 0.3 keeps 0.2's "by the supply's unit" when no per is named.
    const [legacy] = await t.db.insert(estimatorProducts).values({ tenantId, name: "Old door", measurementMode: "area" }).returning();
    await attachComponent(t.db, tenantId, { productId: legacy!.id, componentId: sqft.id });
    const [link] = await t.db.select().from(estimatorProductComponents).where(eq(estimatorProductComponents.productId, legacy!.id));
    expect(link!.per).toBeNull();
  });

  it("the admin view strips every cost without costs.view", async () => {
    const tenantId = tenant();
    const ramp = await createProduct(t.db, { tenantId, name: "Ramp", recipe: "ramp_over_steps", laborRateCents: 6_500, basePrice: 100 });
    const rail = await createComponent(t.db, { tenantId, name: "Rail", unitType: "per_linear_ft", unitCost: 1_800 });
    await attachComponent(t.db, tenantId, { productId: ramp.id, componentId: rail.id });
    const detail = (await getProductDetail(t.db, tenantId, ramp.id))!;
    const settings = await getEstimatorSettings(t.db, tenantId);
    const full = toAdminProduct(detail, { settings, includeCosts: true });
    expect(full.supplies[0]!.unitCost).toBe(1_800);
    expect(full.labor).toMatchObject({ rateCents: 6_500, effectiveRateCents: 6_500 });
    expect(full.lumpCosts).toMatchObject({ basePrice: 100 });
    expect(full.recipeInfo.label).toBe("Steps up to a door (ramp)");
    const stripped = toAdminProduct(detail, { settings, includeCosts: false });
    expect(stripped.supplies[0]!.unitCost).toBeNull();
    expect(stripped.labor).toMatchObject({ rateCents: null, effectiveRateCents: null });
    expect(stripped.lumpCosts).toBeNull();
  });
});

describe("options and values", () => {
  it("update and remove options and values, scoped through option → product", async () => {
    const tenantId = tenant();
    const other = tenant();
    const ramp = await createProduct(t.db, { tenantId, name: "Ramp", recipe: "ramp_over_steps" });
    const surface = await createOption(t.db, tenantId, { productId: ramp.id, name: "Surface" });
    const standard = await createOptionValue(t.db, tenantId, { optionId: surface.id, label: "Standard", isDefault: true });
    const heavy = await createOptionValue(t.db, tenantId, { optionId: surface.id, label: "Heavy-duty", priceModifier: 12_000 });

    expect(await updateOption(t.db, other, surface.id, { name: "Hijack" })).toBe(false);
    expect(await updateOptionValue(t.db, other, heavy.id, { priceModifier: 1 })).toBe(false);
    expect(await deactivateOptionValue(t.db, other, standard.id)).toBe(false);
    expect(await deactivateOption(t.db, other, surface.id)).toBe(false);

    expect(await updateOption(t.db, tenantId, surface.id, { name: "Ramp surface", showInEstimator: false })).toBe(true);
    expect(await updateOptionValue(t.db, tenantId, heavy.id, { label: "Heavy-duty grit", priceModifier: 15_000 })).toBe(true);
    expect(await deactivateOptionValue(t.db, tenantId, standard.id)).toBe(true); // the default: none left
    const detail = await getProductDetail(t.db, tenantId, ramp.id);
    expect(detail?.options[0]!.option).toMatchObject({ name: "Ramp surface", showInEstimator: false });
    expect(detail?.options[0]!.values.map((v) => [v.label, v.priceModifier, v.isDefault])).toEqual([["Heavy-duty grit", 15_000, false]]);
    expect(await deactivateOption(t.db, tenantId, surface.id)).toBe(true);
    expect((await getProductDetail(t.db, tenantId, ramp.id))?.options).toEqual([]);
    expect(await refusal(createOption(t.db, other, { productId: ramp.id, name: "X" }))).toBe("product_unavailable");
  });
});

describe("the sample catalog (on request only)", () => {
  it("loads once, in one locked transaction, with the data of 6.3, OFF the website until the owner turns each on", async () => {
    const tenantId = tenant();
    t.queries.length = 0;
    expect(await loadSampleCatalog(t.db, tenantId)).toEqual({ products: 5, supplies: 10 });
    const inTx = t.queries.filter((q) => q.inTransaction);
    expect(inTx[0]!.sql).toMatch(/pg_advisory_xact_lock\(hashtext\(\$1\)\)/);
    expect(inTx[0]!.params).toEqual([`estimator-sample:${tenantId}`]);
    expect(t.queries.filter((q) => !q.inTransaction && !/^(begin|commit)/i.test(q.sql))).toHaveLength(0);

    // Nothing made-up reaches a customer (review EST-R01).
    expect(await listProducts(t.db, tenantId, { publicOnly: true })).toEqual([]);
    const products = await listProducts(t.db, tenantId);
    expect(products.every((p) => p.showInEstimator === false)).toBe(true);
    expect(products.map((p) => [p.name, p.recipe, p.isEstimatable])).toEqual([
      ["Modular aluminum ramp", "ramp_over_steps", true],
      ["Threshold ramp", "count", true],
      ["Concrete landing pad", "area", true],
      ["Handrail only", "linear", true],
      ["Something else", "count", false],
    ]);
    const ramp = (await getProductDetail(t.db, tenantId, products[0]!.id))!;
    expect(ramp.components.map((c) => [c.component.name, c.component.unitCost, c.quantityMilli, c.per, c.roundUp])).toEqual([
      ["Aluminum ramp section", 9_500, 1000, "rampFt", false],
      ["Handrail", 1_800, 2000, "rampFt", false],
      ["Support post & footing", 4_200, 250, "rampFt", true],
      ["Top landing platform (5 × 5 ft)", 64_000, 1000, "job", true],
      ["Resting landing platform (5 × 5 ft)", 64_000, 1000, "landings", true],
      ["Permit & inspection", 15_000, 1000, "job", false],
      ["Delivery", 8_500, 1000, "job", false],
    ]);
    expect(ramp.product).toMatchObject({ laborHoursPerUnitMilli: 350, laborSetupHoursMilli: 2000, laborRateCents: 6_500, wasteBp: 500, markupBp: 4_000, minimumCharge: 150_000, rangeMode: "measured" });
    expect(ramp.options.map((o) => [o.option.name, o.values.map((v) => [v.label, v.priceModifier, v.isDefault])])).toEqual([
      ["Surface", [["Standard grit", 0, true], ["Heavy-duty grit", 12_000, false]]],
      ["Layout", [["Straight run", 0, true], ["One switchback", 45_000, false]]],
    ]);
    const supplies = await listComponents(t.db, tenantId);
    expect(supplies).toHaveLength(10);
    expect(supplies.every((s) => s.supplier === "Your supplier" && s.note === "Sample price: change it to yours.")).toBe(true);
    expect(SAMPLE_CATALOG.products).toHaveLength(5);

    expect(await refusal(loadSampleCatalog(t.db, tenantId))).toBe("sample_already_loaded");
    expect(await listProducts(t.db, tenantId)).toHaveLength(5);
  });

  it("nothing else creates products: a public config on an empty tenant writes no row", async () => {
    const tenantId = tenant();
    const handlers = createEstimatorHandlers({ db: t.db, tenantId });
    const res = await handlers.handle(new Request("https://x.test/api/estimator/v1/config"));
    expect((await res.json()).products).toEqual([]);
    expect(await t.db.select().from(estimatorProducts).where(eq(estimatorProducts.tenantId, tenantId))).toHaveLength(0);
    expect(await t.db.select().from(estimatorComponents).where(eq(estimatorComponents.tenantId, tenantId))).toHaveLength(0);
    expect(await t.db.select().from(estimatorSettings).where(eq(estimatorSettings.tenantId, tenantId))).toHaveLength(0);
    const options = await t.db
      .select()
      .from(estimatorOptions)
      .innerJoin(estimatorProducts, eq(estimatorProducts.id, estimatorOptions.productId))
      .where(and(eq(estimatorProducts.tenantId, tenantId)));
    expect(options).toHaveLength(0);
    expect(await t.db.select().from(estimatorOptionValues).limit(0)).toHaveLength(0);
  });
});
