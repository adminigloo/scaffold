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
 *
 * Tenancy 2a: it is now ONE of three — lawn care, cleaning and ramps
 * (`SAMPLE_CATALOGS`) — and the owner picks the one for their trade.
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
 * The trades a sample price book is offered for (Tenancy 2a review
 * T2A-BO-10). The 0.3 sample was a wheelchair-ramp company's, which a lawn
 * or cleaning business read as "this isn't for my kind of business" — and
 * the two-company scenario's lawn company ended up "selling" a threshold
 * ramp. The owner now picks the trade the sample is for.
 */
export type SampleTrade = "lawn" | "cleaning" | "ramps";
export const SAMPLE_TRADES: readonly SampleTrade[] = Object.freeze(["lawn", "cleaning", "ramps"]);

const SAMPLE_NOTE = "Sample price: change it to yours.";

/** A lawn and landscape company's: mowing by the visit, aeration by yard size, mulch by the square foot, edging by the foot. */
const LAWN_SAMPLE: SampleCatalog = {
  supplier: "Your supplier",
  note: SAMPLE_NOTE,
  supplies: [
    { key: "fuel", name: "Fuel and equipment wear, per visit", unitType: "per_unit", unitCost: 400 },
    { key: "seed", name: "Grass seed", unitType: "per_sqft", unitCost: 4 },
    { key: "fertilizer", name: "Starter fertilizer", unitType: "per_sqft", unitCost: 2 },
    { key: "mulch", name: "Mulch, delivered (3 in deep)", unitType: "per_sqft", unitCost: 90 },
    { key: "fabric", name: "Weed barrier fabric", unitType: "per_sqft", unitCost: 15 },
    { key: "edging", name: "Steel landscape edging", unitType: "per_linear_ft", unitCost: 350 },
    { key: "stake", name: "Edging stake", unitType: "per_unit", unitCost: 150 },
    { key: "disposal", name: "Green waste disposal", unitType: "flat", unitCost: 3_500 },
  ],
  products: [
    {
      name: "Lawn mowing",
      category: "Lawn",
      description: "Mow, trim and edge, and blow the clippings off hard surfaces. Priced per visit by yard size.",
      recipe: "count",
      recipeConfig: { countLabel: "How many visits?", noun: { one: "visit", many: "visits" }, maxCount: 52 },
      allowMultiple: false,
      isEstimatable: true,
      supplies: [{ supply: "fuel", quantityMilli: 1000, per: "item" }],
      laborHoursPerUnitMilli: 750,
      laborSetupHoursMilli: 0,
      laborRateCents: 5_500,
      wasteBp: 0,
      markupBp: 3_000,
      minimumCharge: 4_500,
      options: [
        {
          name: "Yard size",
          values: [
            { label: "Small (up to 1/4 acre)", priceModifier: 0, isDefault: true },
            { label: "Medium (1/4 to 1/2 acre)", priceModifier: 2_500, isDefault: false },
            { label: "Large (1/2 to 1 acre)", priceModifier: 5_500, isDefault: false },
          ],
        },
      ],
    },
    {
      name: "Aeration and overseeding",
      category: "Lawn",
      description: "Core aeration, then seed and starter fertilizer over the whole lawn.",
      recipe: "area",
      recipeConfig: {
        unit: "ft",
        presets: [
          { label: "Small yard (50 × 50 ft)", width: 50, length: 50 },
          { label: "Medium yard (50 × 100 ft)", width: 50, length: 100 },
          { label: "Large yard (100 × 100 ft)", width: 100, length: 100 },
        ],
      },
      allowMultiple: false,
      isEstimatable: true,
      supplies: [
        { supply: "seed", quantityMilli: 1000, per: "sqFt" },
        { supply: "fertilizer", quantityMilli: 1000, per: "sqFt" },
      ],
      laborHoursPerUnitMilli: 0,
      laborSetupHoursMilli: 1_500,
      laborRateCents: 5_500,
      wasteBp: 500,
      markupBp: 4_000,
      minimumCharge: 9_500,
      options: [],
    },
    {
      name: "Mulch installation",
      category: "Beds",
      description: "Weed barrier and fresh mulch in your beds, old debris hauled away.",
      recipe: "area",
      recipeConfig: {
        unit: "ft",
        presets: [
          { label: "One bed (10 × 4 ft)", width: 10, length: 4 },
          { label: "Front beds (30 × 4 ft)", width: 30, length: 4 },
          { label: "Whole yard (60 × 5 ft)", width: 60, length: 5 },
        ],
      },
      allowMultiple: false,
      isEstimatable: true,
      supplies: [
        { supply: "mulch", quantityMilli: 1000, per: "sqFt" },
        { supply: "fabric", quantityMilli: 1000, per: "sqFt" },
        { supply: "disposal", quantityMilli: 1000, per: "job" },
      ],
      laborHoursPerUnitMilli: 15,
      laborSetupHoursMilli: 500,
      laborRateCents: 5_500,
      wasteBp: 1_000,
      markupBp: 3_500,
      minimumCharge: 15_000,
      options: [],
    },
    {
      name: "Bed edging",
      category: "Beds",
      description: "Steel edging set along your bed lines, staked every three feet.",
      recipe: "linear",
      recipeConfig: { lengthLabel: "How many feet of edging?", resultNoun: { one: "edge", many: "edges" } },
      allowMultiple: false,
      isEstimatable: true,
      supplies: [
        { supply: "edging", quantityMilli: 1000, per: "linearFt" },
        { supply: "stake", quantityMilli: 333, per: "linearFt" },
      ],
      laborHoursPerUnitMilli: 60,
      laborSetupHoursMilli: 500,
      laborRateCents: 5_500,
      wasteBp: 500,
      markupBp: 4_000,
      minimumCharge: 20_000,
      options: [],
    },
    {
      name: "Something else",
      category: "Lawn",
      description: "Tree work, drainage, a full redesign or anything unusual: we'll call to talk it through.",
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
};

/** A home cleaning company's: regular cleans by home size, deep cleans by the square foot, windows and carpets by the count. */
const CLEANING_SAMPLE: SampleCatalog = {
  supplier: "Your supplier",
  note: SAMPLE_NOTE,
  supplies: [
    { key: "kit", name: "Cleaning supplies, per visit", unitType: "per_unit", unitCost: 800 },
    { key: "deepSupplies", name: "Deep-clean supplies", unitType: "per_sqft", unitCost: 2 },
    { key: "windowSupplies", name: "Window cleaning supplies, per window", unitType: "per_unit", unitCost: 50 },
    { key: "carpetSolution", name: "Carpet cleaning solution, per room", unitType: "per_unit", unitCost: 300 },
    { key: "trip", name: "Trip charge", unitType: "flat", unitCost: 1_500 },
  ],
  products: [
    {
      name: "Standard home cleaning",
      category: "Cleaning",
      description: "Kitchens, bathrooms, dusting, floors and tidying. Priced per visit by home size.",
      recipe: "count",
      recipeConfig: { countLabel: "How many visits?", noun: { one: "visit", many: "visits" }, maxCount: 52 },
      allowMultiple: false,
      isEstimatable: true,
      supplies: [{ supply: "kit", quantityMilli: 1000, per: "item" }],
      laborHoursPerUnitMilli: 2_500,
      laborSetupHoursMilli: 0,
      laborRateCents: 4_000,
      wasteBp: 0,
      markupBp: 3_000,
      minimumCharge: 11_000,
      options: [
        {
          name: "Home size",
          values: [
            { label: "1 to 2 bedrooms", priceModifier: 0, isDefault: true },
            { label: "3 bedrooms", priceModifier: 4_000, isDefault: false },
            { label: "4 or more bedrooms", priceModifier: 8_500, isDefault: false },
          ],
        },
      ],
    },
    {
      name: "Deep cleaning",
      category: "Cleaning",
      description: "Top-to-bottom: inside cabinets and appliances, baseboards, vents and grout.",
      recipe: "area",
      recipeConfig: {
        unit: "ft",
        presets: [
          { label: "Apartment (about 800 sq ft)", width: 20, length: 40 },
          { label: "House (about 1,800 sq ft)", width: 30, length: 60 },
          { label: "Large house (about 3,000 sq ft)", width: 50, length: 60 },
        ],
      },
      allowMultiple: false,
      isEstimatable: true,
      supplies: [
        { supply: "deepSupplies", quantityMilli: 1000, per: "sqFt" },
        { supply: "trip", quantityMilli: 1000, per: "job" },
      ],
      laborHoursPerUnitMilli: 3,
      laborSetupHoursMilli: 500,
      laborRateCents: 4_000,
      wasteBp: 0,
      markupBp: 3_500,
      minimumCharge: 25_000,
      options: [],
    },
    {
      name: "Window cleaning",
      category: "Windows",
      description: "Inside and out, screens and sills wiped.",
      recipe: "count",
      recipeConfig: { countLabel: "How many windows?", noun: { one: "window", many: "windows" }, maxCount: 100 },
      allowMultiple: false,
      isEstimatable: true,
      supplies: [
        { supply: "windowSupplies", quantityMilli: 1000, per: "item" },
        { supply: "trip", quantityMilli: 1000, per: "job" },
      ],
      laborHoursPerUnitMilli: 150,
      laborSetupHoursMilli: 250,
      laborRateCents: 4_000,
      wasteBp: 0,
      markupBp: 4_000,
      minimumCharge: 9_000,
      options: [],
    },
    {
      name: "Carpet cleaning",
      category: "Carpets",
      description: "Hot-water extraction, priced by the room.",
      recipe: "count",
      recipeConfig: { countLabel: "How many rooms?", noun: { one: "room", many: "rooms" }, maxCount: 20 },
      allowMultiple: false,
      isEstimatable: true,
      supplies: [
        { supply: "carpetSolution", quantityMilli: 1000, per: "item" },
        { supply: "trip", quantityMilli: 1000, per: "job" },
      ],
      laborHoursPerUnitMilli: 500,
      laborSetupHoursMilli: 500,
      laborRateCents: 4_000,
      wasteBp: 0,
      markupBp: 4_000,
      minimumCharge: 12_000,
      options: [],
    },
    {
      name: "Something else",
      category: "Cleaning",
      description: "Move-out, post-construction or anything unusual: we'll call to talk it through.",
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
};

/** Every trade's sample price book. `SAMPLE_CATALOG` (the ramps one) stays for 0.3 callers. */
export const SAMPLE_CATALOGS: Readonly<Record<SampleTrade, Readonly<SampleCatalog>>> = Object.freeze({
  lawn: Object.freeze(LAWN_SAMPLE),
  cleaning: Object.freeze(CLEANING_SAMPLE),
  ramps: SAMPLE_CATALOG,
});

/**
 * Load the sample catalog into this tenant's price book, once. In ONE
 * transaction under `pg_advisory_xact_lock(hashtext('estimator-sample:' ||
 * tenant))`, so two clicks can't load it twice: refused
 * `sample_already_loaded` when `sample_loaded_at` is set; otherwise the
 * supplies, products (OFF the website until the owner turns each on),
 * attachments and options, and `sample_loaded_at` — inserting the settings row
 * if there is none, every other field at its default and `saved_at` left
 * null, so the admin still asks for the business's details.
 *
 * `trade` picks whose sample (Tenancy 2a review T2A-BO-10); default "ramps",
 * 0.3's catalog, for callers that name none.
 */
export async function loadSampleCatalog(
  db: EstimatorDb,
  tenantId: string,
  options: { now?: Date; showInEstimator?: boolean; trade?: SampleTrade } = {},
): Promise<{ products: number; supplies: number }> {
  const now = options.now ?? new Date();
  const showInEstimator = options.showInEstimator === true;
  // An unknown trade (plain JS) gets 0.3's ramps sample; the admin route refuses one first.
  const catalog = SAMPLE_CATALOGS[options.trade ?? "ramps"] ?? SAMPLE_CATALOG;
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
    for (const supply of catalog.supplies) {
      const [row] = (await tx
        .insert(estimatorComponents)
        .values({
          tenantId,
          name: supply.name,
          unitType: supply.unitType,
          unitCost: supply.unitCost,
          supplier: catalog.supplier,
          sku: null,
          note: catalog.note,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: estimatorComponents.id })) as Array<{ id: string }>;
      supplyIds.set(supply.key, (row as { id: string }).id);
    }

    for (const [index, product] of catalog.products.entries()) {
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
        const supply = catalog.supplies.find((s) => s.key === use.supply);
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

    return { products: catalog.products.length, supplies: catalog.supplies.length };
  });
}
