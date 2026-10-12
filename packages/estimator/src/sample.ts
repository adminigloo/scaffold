import { eq, sql } from "drizzle-orm";
import { measurementModeFor, type RecipeKey } from "./recipes.js";
import {
  estimatorComponents,
  estimatorOptionValues,
  estimatorOptions,
  estimatorProductComponents,
  estimatorProducts,
  estimatorSettings,
} from "./schema.js";
import { EstimatorInputError, type EstimatorDb, type SettingsRow } from "./types.js";

/**
 * The sample catalog (section 6.3 of the 0.3 contract): a wheelchair-ramp
 * company's price book, loaded ONLY when an owner clicks "Load a sample
 * catalog". Nothing else in the package ever creates products — 0.2's host
 * seeded a demo catalog the first time anyone opened the public page (ES-V1),
 * so a real business's customers were quoted from made-up prices.
 *
 * It shows the 0.3 way of pricing: real supply lines (ramp sections and
 * handrail per foot of ramp, posts every four feet, a landing per job and
 * per resting landing, the permit and delivery once), labor hours per foot
 * plus setup, waste on what is bought by the foot, and a markup — every price
 * marked "Sample price: change it to yours." Posts and platforms are bought
 * whole, so they round up (6 posts on a 21-ft ramp, not 5.25).
 *
 * LOADED OFF THE WEBSITE (review EST-R01). The products arrive with "Show on
 * your website" off: made-up prices must not reach a customer the moment the
 * owner clicks "Load the sample". The owner changes the prices to theirs and
 * turns each product on. (`showInEstimator: true` is for a test or a demo.)
 */

export type SampleUnitType = "per_linear_ft" | "per_sqft" | "per_unit" | "flat";

export interface SampleSupply {
  key: string;
  name: string;
  unitType: SampleUnitType;
  /** Cents per supplier unit. */
  unitCost: number;
}

export interface SampleProduct {
  name: string;
  category: string;
  description: string;
  recipe: RecipeKey;
  recipeConfig: Record<string, unknown> | null;
  allowMultiple: boolean;
  isEstimatable: boolean;
  /** Supply key, thousandths, per. */
  supplies: Array<{ supply: string; quantityMilli: number; per: string }>;
  laborHoursPerUnitMilli: number;
  laborSetupHoursMilli: number;
  laborRateCents: number | null;
  wasteBp: number;
  markupBp: number;
  minimumCharge: number;
  options: Array<{ name: string; values: Array<{ label: string; priceModifier: number; isDefault: boolean }> }>;
}

export interface SampleCatalog {
  supplier: string;
  note: string;
  supplies: readonly SampleSupply[];
  products: readonly SampleProduct[];
}

export const SAMPLE_CATALOG: Readonly<SampleCatalog> = Object.freeze({
  supplier: "Your supplier",
  note: "Sample price: change it to yours.",
  supplies: [
    { key: "section", name: "Aluminum ramp section", unitType: "per_linear_ft", unitCost: 9_500 },
    { key: "handrail", name: "Handrail", unitType: "per_linear_ft", unitCost: 1_800 },
    { key: "post", name: "Support post & footing", unitType: "per_unit", unitCost: 4_200 },
    { key: "topLanding", name: "Top landing platform (5 × 5 ft)", unitType: "per_unit", unitCost: 64_000 },
    { key: "restingLanding", name: "Resting landing platform (5 × 5 ft)", unitType: "per_unit", unitCost: 64_000 },
    { key: "permit", name: "Permit & inspection", unitType: "flat", unitCost: 15_000 },
    { key: "delivery", name: "Delivery", unitType: "flat", unitCost: 8_500 },
    { key: "threshold", name: "Rubber threshold ramp", unitType: "per_unit", unitCost: 3_800 },
    { key: "concrete", name: "Concrete, placed", unitType: "per_sqft", unitCost: 650 },
    { key: "forms", name: "Forms & rebar", unitType: "per_sqft", unitCost: 175 },
  ],
  products: [
    {
      name: "Modular aluminum ramp",
      category: "Ramps",
      description: "An ADA-sloped aluminum ramp with handrails both sides, a top landing, permit and delivery.",
      recipe: "ramp_over_steps",
      recipeConfig: null,
      allowMultiple: false,
      isEstimatable: true,
      supplies: [
        { supply: "section", quantityMilli: 1000, per: "rampFt" },
        { supply: "handrail", quantityMilli: 2000, per: "rampFt" },
        { supply: "post", quantityMilli: 250, per: "rampFt" },
        { supply: "topLanding", quantityMilli: 1000, per: "job" },
        { supply: "restingLanding", quantityMilli: 1000, per: "landings" },
        { supply: "permit", quantityMilli: 1000, per: "job" },
        { supply: "delivery", quantityMilli: 1000, per: "job" },
      ],
      laborHoursPerUnitMilli: 350,
      laborSetupHoursMilli: 2000,
      laborRateCents: 6_500,
      wasteBp: 500,
      markupBp: 4_000,
      minimumCharge: 150_000,
      options: [
        {
          name: "Surface",
          values: [
            { label: "Standard grit", priceModifier: 0, isDefault: true },
            { label: "Heavy-duty grit", priceModifier: 12_000, isDefault: false },
          ],
        },
        {
          name: "Layout",
          values: [
            { label: "Straight run", priceModifier: 0, isDefault: true },
            { label: "One switchback", priceModifier: 45_000, isDefault: false },
          ],
        },
      ],
    },
    {
      name: "Threshold ramp",
      category: "Ramps",
      description: "A rubber ramp for a doorway sill or one low step.",
      recipe: "count",
      recipeConfig: { countLabel: "How many doorways need one?", noun: { one: "doorway", many: "doorways" }, maxCount: 10 },
      allowMultiple: false,
      isEstimatable: true,
      supplies: [{ supply: "threshold", quantityMilli: 1000, per: "item" }],
      laborHoursPerUnitMilli: 500,
      laborSetupHoursMilli: 1000,
      laborRateCents: 6_500,
      wasteBp: 0,
      markupBp: 6_000,
      minimumCharge: 15_000,
      options: [],
    },
    {
      name: "Concrete landing pad",
      category: "Concrete",
      description: "A poured pad at the bottom of a ramp or by a door.",
      recipe: "area",
      recipeConfig: {
        unit: "ft",
        presets: [
          { label: "4 × 4 ft", width: 4, length: 4 },
          { label: "5 × 5 ft", width: 5, length: 5 },
          { label: "6 × 8 ft", width: 6, length: 8 },
        ],
      },
      allowMultiple: false,
      isEstimatable: true,
      supplies: [
        { supply: "concrete", quantityMilli: 1000, per: "sqFt" },
        { supply: "forms", quantityMilli: 1000, per: "sqFt" },
      ],
      laborHoursPerUnitMilli: 80,
      laborSetupHoursMilli: 2000,
      laborRateCents: 6_500,
      wasteBp: 800,
      markupBp: 3_500,
      minimumCharge: 60_000,
      options: [],
    },
    {
      name: "Handrail only",
      category: "Ramps",
      description: "Handrail added to existing steps.",
      recipe: "linear",
      recipeConfig: { lengthLabel: "How many feet of handrail?", resultNoun: { one: "rail", many: "rails" } },
      allowMultiple: false,
      isEstimatable: true,
      supplies: [
        { supply: "handrail", quantityMilli: 1000, per: "linearFt" },
        { supply: "post", quantityMilli: 250, per: "linearFt" },
      ],
      laborHoursPerUnitMilli: 200,
      laborSetupHoursMilli: 1000,
      laborRateCents: 6_500,
      wasteBp: 500,
      markupBp: 4_000,
      minimumCharge: 35_000,
      options: [],
    },
    {
      name: "Something else",
      category: "Ramps",
      description: "Platform lifts, multi-level access or anything unusual: we'll call to talk it through.",
      recipe: "count",
      recipeConfig: null,
      allowMultiple: false,
      isEstimatable: false,
      supplies: [],
      laborHoursPerUnitMilli: 0,
      laborSetupHoursMilli: 0,
      laborRateCents: null,
      wasteBp: 0,
      markupBp: 0,
      minimumCharge: 0,
      options: [],
    },
  ],
}) as SampleCatalog;

/**
 * Load the sample catalog into this tenant's price book, once. In ONE
 * transaction under `pg_advisory_xact_lock(hashtext('estimator-sample:' ||
 * tenant))`, so two clicks can't load it twice: refused
 * `sample_already_loaded` when `sample_loaded_at` is set; otherwise the
 * supplies, products (OFF the website until the owner turns each on),
 * attachments and options, and `sample_loaded_at` — inserting the settings row
 * if there is none, every other field at its default and `saved_at` left
 * null, so the admin still asks for the business's details.
 */
export async function loadSampleCatalog(
  db: EstimatorDb,
  tenantId: string,
  options: { now?: Date; showInEstimator?: boolean } = {},
): Promise<{ products: number; supplies: number }> {
  const now = options.now ?? new Date();
  const showInEstimator = options.showInEstimator === true;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`estimator-sample:${tenantId}`}))`);
    const [settings] = (await tx
      .select()
      .from(estimatorSettings)
      .where(eq(estimatorSettings.tenantId, tenantId))
      .limit(1)) as SettingsRow[];
    if (settings?.sampleLoadedAt) {
      throw new EstimatorInputError("sample_already_loaded", "The sample catalog is already in your price book.");
    }

    const supplyIds = new Map<string, string>();
    for (const supply of SAMPLE_CATALOG.supplies) {
      const [row] = (await tx
        .insert(estimatorComponents)
        .values({
          tenantId,
          name: supply.name,
          unitType: supply.unitType,
          unitCost: supply.unitCost,
          supplier: SAMPLE_CATALOG.supplier,
          sku: null,
          note: SAMPLE_CATALOG.note,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: estimatorComponents.id })) as Array<{ id: string }>;
      supplyIds.set(supply.key, (row as { id: string }).id);
    }

    for (const [index, product] of SAMPLE_CATALOG.products.entries()) {
      const [row] = (await tx
        .insert(estimatorProducts)
        .values({
          tenantId,
          name: product.name,
          category: product.category,
          description: product.description,
          recipe: product.recipe,
          recipeConfig: product.recipeConfig,
          measurementMode: measurementModeFor(product.recipe),
          allowMultiple: product.allowMultiple,
          maxQuantity: 10,
          laborHoursPerUnitMilli: product.laborHoursPerUnitMilli,
          laborSetupHoursMilli: product.laborSetupHoursMilli,
          laborRateCents: product.laborRateCents,
          wasteBp: product.wasteBp,
          pricingBasis: "markup",
          markupBp: product.markupBp,
          minimumCharge: product.minimumCharge,
          rangeMode: "measured",
          contingencyBp: null,
          showInEstimator,
          isEstimatable: product.isEstimatable,
          sortOrder: index * 10,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: estimatorProducts.id })) as Array<{ id: string }>;
      const productId = (row as { id: string }).id;
      for (const [order, use] of product.supplies.entries()) {
        const supply = SAMPLE_CATALOG.supplies.find((s) => s.key === use.supply);
        await tx.insert(estimatorProductComponents).values({
          productId,
          componentId: supplyIds.get(use.supply) as string,
          quantityMilli: use.quantityMilli,
          per: use.per,
          roundUp: supply?.unitType === "per_unit",
          sortOrder: order * 10,
        });
      }
      for (const [order, option] of product.options.entries()) {
        const [optionRow] = (await tx
          .insert(estimatorOptions)
          .values({ productId, name: option.name, sortOrder: order * 10 })
          .returning({ id: estimatorOptions.id })) as Array<{ id: string }>;
        await tx.insert(estimatorOptionValues).values(
          option.values.map((value, valueOrder) => ({
            optionId: (optionRow as { id: string }).id,
            label: value.label,
            priceModifier: value.priceModifier,
            isDefault: value.isDefault,
            sortOrder: valueOrder * 10,
          })),
        );
      }
    }

    await tx
      .insert(estimatorSettings)
      .values({ tenantId, sampleLoadedAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: estimatorSettings.tenantId, set: { sampleLoadedAt: now, updatedAt: now } });

    return { products: SAMPLE_CATALOG.products.length, supplies: SAMPLE_CATALOG.supplies.length };
  });
}
