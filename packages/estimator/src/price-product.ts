import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { buildPrice, pct, type BuildSupply, type PriceBuild, type SupplyUnitType } from "./build.js";
import { getProductRow, recipeOf } from "./catalog.js";
import { measurementFitsMode, type EstimatePriceResult, type Measurement } from "./pricing.js";
import {
  customerFieldsFor,
  deriveQuantities,
  effectiveRecipe,
  isValidSupplyBasis,
  legacyDerivation,
  legacyInputs,
  measurementModeFor,
  MEASUREMENT_RECIPES,
  parseCustomerInputs,
  RECIPE_KEYS,
  RECIPE_QUANTITY_KEYS,
  recipeConfigProblem,
  recipeConfigSchema,
  resolveRecipeConfig,
  round2,
  type LineDerivation,
  type NormalizedObservation,
  type QuantityKind,
} from "./recipes.js";
import {
  estimatorComponents,
  estimatorOptionValues,
  estimatorOptions,
  estimatorProductComponents,
  estimatorProducts,
  estimatorTakeoffs,
  type EstimateItemMeasurement,
  type EstimateItemOptionSnapshot,
} from "./schema.js";
import { effectiveTaxRateBp, getEstimatorSettings, type EstimatorSettings } from "./settings.js";
import { correctionsFor, normalizeObservation, suggestFromObservation, type ReadingRecipe } from "./takeoff.js";
import { EstimatorInputError, type ComponentRow, type EstimatorDb, type ProductRow, type TakeoffRow } from "./types.js";
import type {
  AreaRecipeConfig,
  Correction,
  CustomerField,
  CustomerInputs,
  LegacyRange,
  ProductDraft,
  PublicPrice,
  RecipeConfig,
  RecipeKey,
} from "./wire.js";

/**
 * Pricing a line (section 6.4 of the 0.3 contract): the ONE place a line is
 * priced for every audience — the customer's live price, the lead they save,
 * a staff line, the price-book preview — so the number saved is the number
 * shown.
 *
 *   load the product → its recipe and config → the customer's inputs (or a
 *   0.2 measurement) → the photo reading, if one is attached → the derivation
 *   (recipes.ts) → the options → the supplies → the settings (labor rate,
 *   contingency) → the build (build.ts)
 */

/**
 * The largest measurement any 0.2-shaped line accepts. Generous for every
 * trade here and small enough that a typo or a hostile number can't price a
 * line past the safe-integer range of the money columns.
 */
export const MEASUREMENT_LIMITS = {
  widthIn: 12_000,
  heightIn: 12_000,
  sqFt: 1_000_000,
  linearFt: 100_000,
  units: 100_000,
} as const;

export const measurementSchema = z.object({
  widthIn: z.number().min(0).max(MEASUREMENT_LIMITS.widthIn).optional(),
  heightIn: z.number().min(0).max(MEASUREMENT_LIMITS.heightIn).optional(),
  sqFt: z.number().min(0).max(MEASUREMENT_LIMITS.sqFt).optional(),
  linearFt: z.number().min(0).max(MEASUREMENT_LIMITS.linearFt).optional(),
  /**
   * Sub-units in ONE of the product (the hinges on a door): a whole number ≥ 1.
   * Staff only: a public line ignores it.
   */
  units: z.number().int().min(1).max(MEASUREMENT_LIMITS.units).optional(),
});

/**
 * A measurement from the PUBLIC: no `units`. The key is stripped, not refused
 * (zod drops unknown keys), so the estimator-widget 0.1 embeds already on
 * customers' sites, which send `units: quantity`, keep working.
 */
export const publicMeasurementSchema = measurementSchema.omit({ units: true });

/** The customer's answers on the wire: numbers or null, by field key. */
export const customerInputsSchema = z.record(z.string().max(40), z.union([z.number(), z.null()]));

/**
 * Who a price is for. "public" — the instant-estimate tool and the embed: the
 * product must be shown in the estimator, staff-only options are ignored, a
 * 0.2 measurement is mapped to the recipe's inputs, and "how many" is capped
 * at the product's maximum. "staff" (the default) — the editor and staff
 * estimates: any active product and option, any quantity up to 1000, and a
 * full 0.2 measurement is still priced the 0.2 way.
 */
export type PricingAudience = "public" | "staff";

export interface PriceProductInput {
  productId: string;
  inputs?: CustomerInputs | null;
  /** 0.2's shape (a 0.1 widget, a 0.2 host). */
  measurement?: Measurement | null;
  /** 1–max_quantity (ignored unless allowMultiple; count recipe: inputs.count). */
  quantity?: number;
  optionValueIds?: string[];
  takeoffId?: string | null;
}

const priceProductInputSchema = z.object({
  productId: z.string().min(1).max(200),
  inputs: customerInputsSchema.nullish(),
  measurement: measurementSchema.nullish(),
  quantity: z.number().int("Use a whole number.").min(1, "At least 1.").max(1000).optional(),
  optionValueIds: z.array(z.string().min(1).max(200)).max(50).default([]),
  takeoffId: z.string().max(200).nullish(),
});
/** The public's: a 0.2 `units` is dropped before anything checks it (0.1 widgets send `units: quantity`). */
const publicPriceProductInputSchema = priceProductInputSchema.extend({ measurement: publicMeasurementSchema.nullish() });

/** The photo reading a line used, as loaded. */
export interface LineReading {
  takeoffId: string;
  status: "read" | "unreadable";
  observation: NormalizedObservation | null;
  row: TakeoffRow;
}

export interface PricedProduct {
  status: "priced";
  product: ProductRow;
  recipe: RecipeKey;
  config: RecipeConfig;
  /** The inputs as priced; null for a staff line priced from a 0.2 measurement. */
  inputs: CustomerInputs | null;
  derivation: LineDerivation;
  build: PriceBuild;
  selections: EstimateItemOptionSnapshot[];
  /** 0.2's measurement shape, for the line's `measurement` column (null where none exists). */
  legacyMeasurement: EstimateItemMeasurement | null;
  /** Items on the line (a count: the count). */
  quantity: number;
  reading: LineReading | null;
  /** Where the customer's answer differs from what the reading suggested. */
  corrections: Correction[];
  settings: EstimatorSettings;
}

export type PriceProductResult =
  | PricedProduct
  | { status: "needs_inputs"; missing: string[] }
  | { status: "quote_only"; product: ProductRow };

/**
 * The product a line may be priced against, or null. Not found, inactive,
 * another tenant's, and (for the public) hidden from the estimator all answer
 * the same null, so a public caller cannot probe which ids exist.
 */
async function loadPriceableProduct(
  db: EstimatorDb,
  tenantId: string,
  productId: string,
  audience: PricingAudience,
): Promise<ProductRow | null> {
  const conditions = [
    eq(estimatorProducts.id, productId),
    eq(estimatorProducts.isActive, true),
    eq(estimatorProducts.tenantId, tenantId),
  ];
  if (audience === "public") conditions.push(eq(estimatorProducts.showInEstimator, true));
  const [row] = await db
    .select()
    .from(estimatorProducts)
    .where(and(...conditions))
    .limit(1);
  return (row as ProductRow | undefined) ?? null;
}

/**
 * Resolve caller-supplied option value ids to the product's own options.
 *
 * Scoped to THIS product's active options (a public embed passes the ids
 * straight through, so without the join a request could fold another
 * product's — or another tenant's — modifier into this estimate). An id that
 * resolves to nothing is ignored, not refused: the tools keep a choice per
 * option across product switches and send them all. Two values of the SAME
 * option are refused (null).
 */
export async function resolveOptionSelections(
  db: EstimatorDb,
  productId: string,
  optionValueIds: readonly string[],
  audience: PricingAudience,
): Promise<EstimateItemOptionSnapshot[] | null> {
  const ids = [...new Set(optionValueIds)];
  if (ids.length === 0) return [];
  const conditions = [
    inArray(estimatorOptionValues.id, ids),
    eq(estimatorOptionValues.isActive, true),
    eq(estimatorOptions.productId, productId),
    eq(estimatorOptions.isActive, true),
  ];
  if (audience === "public") conditions.push(eq(estimatorOptions.showInEstimator, true));
  const rows = (await db
    .select({
      optionId: estimatorOptions.id,
      optionName: estimatorOptions.name,
      valueId: estimatorOptionValues.id,
      valueLabel: estimatorOptionValues.label,
      priceModifier: estimatorOptionValues.priceModifier,
    })
    .from(estimatorOptionValues)
    .innerJoin(estimatorOptions, eq(estimatorOptions.id, estimatorOptionValues.optionId))
    .where(and(...conditions))) as EstimateItemOptionSnapshot[];

  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.optionId)) return null;
    seen.add(row.optionId);
  }
  // Caller order, so the saved snapshot reads the way the choices were made.
  return rows.sort((a, b) => ids.indexOf(a.valueId) - ids.indexOf(b.valueId));
}

/** The product's active supplies, priced only from the product's own workspace whatever an attach once linked. */
async function loadSupplies(db: EstimatorDb, product: Pick<ProductRow, "id" | "tenantId">): Promise<BuildSupply[]> {
  const rows = (await db
    .select({
      assignmentId: estimatorProductComponents.id,
      supplyId: estimatorComponents.id,
      name: estimatorComponents.name,
      unitType: estimatorComponents.unitType,
      unitCost: estimatorComponents.unitCost,
      quantityMilli: estimatorProductComponents.quantityMilli,
      per: estimatorProductComponents.per,
      roundUp: estimatorProductComponents.roundUp,
      sortOrder: estimatorProductComponents.sortOrder,
    })
    .from(estimatorProductComponents)
    .innerJoin(estimatorComponents, eq(estimatorComponents.id, estimatorProductComponents.componentId))
    .where(
      and(
        eq(estimatorProductComponents.productId, product.id),
        eq(estimatorProductComponents.isActive, true),
        eq(estimatorComponents.isActive, true),
        eq(estimatorComponents.tenantId, product.tenantId),
      ),
    )) as Array<Omit<BuildSupply, "unitType"> & { unitType: string }>;
  return rows.map((row) => ({ ...row, unitType: row.unitType as SupplyUnitType }));
}

/**
 * The reading a `takeoffId` names, for this tenant and product, if it was read
 * (or found unreadable). Anything else — another tenant's, another product's,
 * still pending, failed — is null.
 */
export async function loadReading(
  db: EstimatorDb,
  tenantId: string,
  productId: string,
  takeoffId: string,
): Promise<LineReading | null> {
  const [row] = (await db
    .select()
    .from(estimatorTakeoffs)
    .where(
      and(
        eq(estimatorTakeoffs.id, takeoffId),
        eq(estimatorTakeoffs.tenantId, tenantId),
        eq(estimatorTakeoffs.productId, productId),
        inArray(estimatorTakeoffs.status, ["read", "unreadable"]),
      ),
    )
    .limit(1)) as TakeoffRow[];
  if (!row) return null;
  const recipe = row.recipe === "count" ? "count" : "ramp_over_steps";
  return {
    takeoffId: row.id,
    status: row.status === "read" ? "read" : "unreadable",
    observation: row.status === "read" ? normalizeObservation(recipe, row.observation) : null,
    row,
  };
}

/** 0.2's measurement shape for the line, where one exists (2.6). */
function legacyMeasurementFor(
  recipe: RecipeKey,
  config: RecipeConfig,
  inputs: CustomerInputs,
  derivation: LineDerivation,
): EstimateItemMeasurement | null {
  const point = derivation.quantities.point;
  switch (recipe) {
    case "ramp_over_steps":
    case "linear":
      return { linearFt: point["linearFt"] ?? 0 };
    case "area":
      return (config as AreaRecipeConfig).unit === "in"
        ? { widthIn: inputs["width"] ?? 0, heightIn: inputs["length"] ?? 0 }
        : { sqFt: point["sqFt"] ?? 0 };
    case "count":
      return null;
  }
}

function requiredKeys(recipe: RecipeKey, config: RecipeConfig): string[] {
  return customerFieldsFor(recipe, config)
    .filter((field) => field.required)
    .map((field) => field.key);
}

function quantityKinds(recipe: RecipeKey): Record<string, QuantityKind> {
  return Object.fromEntries(RECIPE_QUANTITY_KEYS[recipe].map((q) => [q.key, q.kind]));
}

interface PriceCore {
  product: ProductRow;
  recipe: RecipeKey;
  config: RecipeConfig;
  supplies: BuildSupply[];
  selections: EstimateItemOptionSnapshot[];
  settings: EstimatorSettings;
}

type InputsOutcome =
  | { kind: "inputs"; inputs: CustomerInputs; quantity: number }
  | { kind: "legacy"; measurement: Measurement; quantity: number }
  | { kind: "missing"; missing: string[] };

/** Which inputs a line is priced from, and how many of it. */
function resolveInputs(
  recipe: RecipeKey,
  config: RecipeConfig,
  product: ProductRow,
  parsed: { inputs?: CustomerInputs | null; measurement?: Measurement | null; quantity?: number },
  audience: PricingAudience,
): InputsOutcome {
  const wanted = parsed.quantity ?? 1;
  let quantity: number;
  if (audience === "public") {
    if (recipe !== "count" && product.allowMultiple && wanted > product.maxQuantity) {
      throw new z.ZodError([
        { code: "custom", path: ["quantity"], message: `Up to ${product.maxQuantity}.`, input: undefined },
      ] as never);
    }
    quantity = recipe !== "count" && product.allowMultiple ? wanted : 1;
  } else {
    // CONTRACT: staff may price any quantity up to 1000 on any product; the
    // product's "How many?" switch and maximum are what CUSTOMERS are offered.
    quantity = wanted;
  }

  if (parsed.inputs) {
    const result = parseCustomerInputs(recipe, config, parsed.inputs);
    if (!result.ok) return { kind: "missing", missing: result.missing };
    return { kind: "inputs", inputs: result.inputs, quantity: recipe === "count" ? (result.inputs["count"] as number) : quantity };
  }
  if (audience === "staff" && parsed.measurement) {
    // A STAFF line that carries a full 0.2 measurement and no inputs is priced
    // the 0.2 way (units, a bare sqFt or linearFt included).
    if (!measurementFitsMode(product.measurementMode, parsed.measurement)) {
      return { kind: "missing", missing: requiredKeys(recipe, config) };
    }
    return { kind: "legacy", measurement: parsed.measurement, quantity };
  }
  // A 0.1 widget (or a 0.2 host) sends `measurement` instead of `inputs`.
  // A count's 0.2 "how many" IS the count, whatever the product's multiples switch says.
  const mapped = legacyInputs(recipe, config, parsed.measurement ?? {}, recipe === "count" ? wanted : quantity);
  if (!mapped) return { kind: "missing", missing: requiredKeys(recipe, config) };
  const result = parseCustomerInputs(recipe, config, mapped.inputs);
  if (!result.ok) return { kind: "missing", missing: result.missing };
  return {
    kind: "inputs",
    inputs: result.inputs,
    quantity: recipe === "count" ? (result.inputs["count"] as number) : mapped.quantity,
  };
}

function priceWith(
  core: PriceCore,
  outcome: Extract<InputsOutcome, { kind: "inputs" | "legacy" }>,
  reading: LineReading | null,
): PricedProduct {
  const { product, recipe, config, supplies, selections, settings } = core;
  const derivation =
    outcome.kind === "inputs"
      ? deriveQuantities(recipe, config, outcome.inputs, { reading: reading?.observation ?? null, quantity: outcome.quantity })
      : legacyDerivation(recipe, outcome.measurement);
  const build = buildPrice({
    quantities: derivation.quantities,
    primaryKey: MEASUREMENT_RECIPES[recipe].primaryKey,
    quantityKinds: quantityKinds(recipe),
    supplies,
    lump: {
      basePrice: product.basePrice,
      pricePerSqFt: product.pricePerSqFt,
      pricePerLinearFt: product.pricePerLinearFt,
      laborCost: product.laborCost,
    },
    labor: {
      hoursPerUnitMilli: product.laborHoursPerUnitMilli,
      setupHoursMilli: product.laborSetupHoursMilli,
      rateCents: product.laborRateCents ?? settings.defaultLaborRateCents,
    },
    wasteBp: product.wasteBp,
    pricing:
      product.pricingBasis === "margin"
        ? { basis: "margin", marginBp: product.marginBp }
        : { basis: "markup", markupBp: product.markupBp },
    optionModifiers: selections.map((s) => s.priceModifier),
    optionLabels: selections.map((s) => `${s.optionName}: ${s.valueLabel}`),
    quantity: outcome.quantity,
    minimumCharge: product.minimumCharge,
    range:
      product.rangeMode === "measured"
        ? { mode: "measured", contingencyBp: product.contingencyBp ?? settings.contingencyBp }
        : { mode: "percent", lowBp: product.estimateLowBp, highBp: product.estimateHighBp },
    currency: settings.currency,
    locale: settings.locale,
  });
  // A price book extreme enough to leave the safe-integer range would store a
  // silently rounded total; refuse it as an unpriceable measurement instead.
  if (![build.low, build.high, build.estimateHigh, build.cost].every(Number.isSafeInteger)) {
    throw new EstimatorInputError("invalid_measurement", `${product.name} can't be priced from that measurement.`);
  }
  let corrections: Correction[] = [];
  if (reading?.observation && outcome.kind === "inputs" && (recipe === "ramp_over_steps" || recipe === "count")) {
    const suggestion = suggestFromObservation(recipe as ReadingRecipe, config, reading.observation);
    corrections = correctionsFor(recipe, suggestion.suggested, outcome.inputs);
  }
  return {
    status: "priced",
    product,
    recipe,
    config,
    inputs: outcome.kind === "inputs" ? outcome.inputs : null,
    derivation,
    build,
    selections,
    legacyMeasurement:
      outcome.kind === "inputs"
        ? legacyMeasurementFor(recipe, config, outcome.inputs, derivation)
        : (outcome.measurement as EstimateItemMeasurement),
    quantity: outcome.quantity,
    reading,
    corrections,
    settings,
  };
}

/**
 * Price one product for a customer (`audience: "public"`) or for staff. Never
 * calls the model: a photo reading is only ever READ here, by `takeoffId`.
 *
 *   - `{ status: "needs_inputs", missing }` — a required answer is missing (a
 *     half-typed form; not an error).
 *   - `{ status: "quote_only" }` — the product is priced by a person.
 *   - Throws `EstimatorInputError` `product_unavailable` / `invalid_options`
 *     (and, with `strictTakeoff`, `takeoff_unavailable`), and a ZodError for a
 *     malformed input (issue paths `["inputs", key]`).
 */
export async function priceProduct(
  db: EstimatorDb,
  tenantId: string,
  input: PriceProductInput,
  options: { audience?: PricingAudience; settings?: EstimatorSettings; strictTakeoff?: boolean } = {},
): Promise<PriceProductResult> {
  const audience = options.audience ?? "staff";
  const parsed = (audience === "public" ? publicPriceProductInputSchema : priceProductInputSchema).parse(input);
  const measurement = parsed.measurement as Measurement | null | undefined;
  const product = await loadPriceableProduct(db, tenantId, parsed.productId, audience);
  if (!product) {
    throw new EstimatorInputError("product_unavailable", "That product isn't available. Refresh the page and pick again.");
  }
  if (!product.isEstimatable) return { status: "quote_only", product };
  const { recipe, config } = recipeOf(product);

  const outcome = resolveInputs(
    recipe,
    config,
    product,
    { inputs: parsed.inputs ?? null, measurement: measurement ?? null, ...(parsed.quantity !== undefined ? { quantity: parsed.quantity } : {}) },
    audience,
  );
  if (outcome.kind === "missing") return { status: "needs_inputs", missing: outcome.missing };

  const selections = await resolveOptionSelections(db, product.id, parsed.optionValueIds, audience);
  if (selections === null) {
    throw new EstimatorInputError("invalid_options", "Choose one value for each option.");
  }

  let reading: LineReading | null = null;
  if (parsed.takeoffId) {
    reading = await loadReading(db, tenantId, product.id, parsed.takeoffId);
    if (!reading && options.strictTakeoff) {
      throw new EstimatorInputError(
        "takeoff_unavailable",
        "That photo reading isn't available any more. Send your estimate again without it.",
      );
    }
  }

  const settings = options.settings ?? (await getEstimatorSettings(db, tenantId));
  const supplies = await loadSupplies(db, product);
  const priced = priceWith({ product, recipe, config, supplies, selections, settings }, outcome, reading);
  // NEVER A PUBLIC $0 (review EST-R01). A product whose price works out to
  // nothing (saved before its supplies or labor rate were added) is priced
  // by a person: the customer leaves their details, the lead is a "quote
  // requested" line, and the admin names the product ("prices at $0").
  if (audience === "public" && priced.build.point <= 0) return { status: "quote_only", product };
  return priced;
}

/** Pricing's own reasons, in words a CUSTOMER reads. */
function customerPricingReasons(product: ProductRow, build: PriceBuild, settings: EstimatorSettings): string[] {
  if (product.rangeMode === "measured") {
    const c = product.contingencyBp ?? settings.contingencyBp;
    return c > 0 ? [`Contingency ±${pct(c)}`] : [];
  }
  // CONTRACT: the percent band's reason as the contract writes it ("…(your
  // setting)") is the OWNER's; a customer reads this instead.
  void build;
  return [`Estimates are shown as ${pct(product.estimateLowBp)}–${pct(product.estimateHighBp)} of the price`];
}

/** "Plus 7.25% sales tax."; null at 0%. */
export function taxNoteFor(taxRateBp: number): string | null {
  return taxRateBp > 0 ? `Plus ${pct(taxRateBp)} sales tax.` : null;
}

/**
 * What the customer sees for a priced line (`PublicPrice`): the range, the
 * code's sentences, the assumption, why it's a range. Never a cost.
 */
export function toPublicPrice(priced: PricedProduct, settings: EstimatorSettings, taxRateBp?: number): PublicPrice {
  const { build, derivation } = priced;
  const reasons = build.single ? [] : [...derivation.reasons, ...customerPricingReasons(priced.product, build, settings)];
  return {
    low: build.estimateLow,
    high: build.estimateHigh,
    single: build.single,
    currency: settings.currency,
    explanation: [...derivation.explanation],
    assumption: derivation.assumption,
    resultPhrase: derivation.resultPhrase,
    reasons,
    taxNote: taxNoteFor(taxRateBp ?? effectiveTaxRateBp(settings)),
  };
}

/** The staff wording of why a line is a range: the derivation's reasons, then pricing's. */
export function lineReasons(priced: PricedProduct): string[] {
  return priced.build.single ? [] : [...priced.derivation.reasons, ...priced.build.reasons];
}

/** 0.2's `result` (for 0.1 widgets): the point quantities and the shown range. */
export function toLegacyRange(priced: PricedProduct): LegacyRange {
  const point = priced.derivation.quantities.point;
  return {
    sqFt: round2(point["sqFt"] ?? 0),
    linearFt: round2(point["linearFt"] ?? 0),
    units: point["units"] ?? 1,
    subtotal: priced.build.point,
    estimateLow: priced.build.estimateLow,
    estimateHigh: priced.build.estimateHigh,
  };
}

// --- The price-book preview ("test a quote", "what your customer sees") -----------------

const draftSupplySchema = z.object({
  supplyId: z.string().min(1).max(200),
  quantityMilli: z.number().int().min(1).max(100_000_000),
  per: z.string().trim().min(1).max(40),
  roundUp: z.boolean().optional(),
});
const draftOptionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  values: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(120),
        priceModifier: z.number().int().min(0).max(100_000_000),
        isDefault: z.boolean().optional(),
      }),
    )
    .max(50),
});

const draftSchema = z.object({
  name: z.string().trim().max(200).optional(),
  recipe: z.enum(RECIPE_KEYS as unknown as [RecipeKey, ...RecipeKey[]]).optional(),
  recipeConfig: z.record(z.string(), z.unknown()).optional(),
  allowMultiple: z.boolean().optional(),
  multipleLabel: z.string().trim().max(120).nullish(),
  maxQuantity: z.number().int().min(1).max(100).optional(),
  laborHoursPerUnitMilli: z.number().int().min(0).max(1_000_000).optional(),
  laborSetupHoursMilli: z.number().int().min(0).max(1_000_000).optional(),
  laborRateCents: z.number().int().min(0).max(1_000_000).nullish(),
  wasteBp: z.number().int().min(0).max(1_000_000).optional(),
  pricingBasis: z.enum(["markup", "margin"]).optional(),
  markupBp: z.number().int().min(0).max(1_000_000).optional(),
  marginBp: z.number().int().min(0).max(9500, "A target margin can be at most 95%.").optional(),
  minimumCharge: z.number().int().min(0).optional(),
  rangeMode: z.enum(["measured", "percent"]).optional(),
  contingencyBp: z.number().int().min(0).max(5000).nullish(),
  estimateLowBp: z.number().int().min(0).max(1_000_000).optional(),
  estimateHighBp: z.number().int().min(0).max(1_000_000).optional(),
  basePrice: z.number().int().min(0).optional(),
  pricePerSqFt: z.number().int().min(0).nullish(),
  pricePerLinearFt: z.number().int().min(0).nullish(),
  laborCost: z.number().int().min(0).optional(),
  showInEstimator: z.boolean().optional(),
  isEstimatable: z.boolean().optional(),
  supplies: z.array(draftSupplySchema).max(100).optional(),
  options: z.array(draftOptionSchema).max(50).optional(),
});

export interface PreviewProductPriceInput {
  /** An existing product, or none (a new one). */
  productId?: string | null;
  /** Unsaved edits layered over it: recipe, config, supplies, labor, pricing, range, options. */
  draft?: ProductDraft | null;
  inputs?: CustomerInputs | null;
  quantity?: number;
  optionValueIds?: string[];
}

export interface ProductPreview {
  fields: CustomerField[];
  status: "priced" | "needs_inputs" | "quote_only";
  missing: string[];
  /** Exactly what the customer would see. */
  customerView: PublicPrice | null;
  build: PriceBuild | null;
  derivation: LineDerivation | null;
}

function blankProduct(tenantId: string, now: Date): ProductRow {
  return {
    id: "preview",
    tenantId,
    category: null,
    name: "New product",
    description: null,
    measurementMode: "area",
    recipe: "area",
    recipeConfig: null,
    allowMultiple: false,
    multipleLabel: null,
    maxQuantity: 10,
    basePrice: 0,
    pricePerSqFt: null,
    pricePerLinearFt: null,
    laborCost: 0,
    laborHoursPerUnitMilli: 0,
    laborSetupHoursMilli: 0,
    laborRateCents: null,
    wasteBp: 0,
    pricingBasis: "markup",
    markupBp: 0,
    marginBp: 0,
    minimumCharge: 0,
    rangeMode: "measured",
    contingencyBp: null,
    estimateLowBp: 9000,
    estimateHighBp: 11500,
    showInEstimator: true,
    isEstimatable: true,
    sortOrder: 0,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Price a product — as saved, or with unsaved edits (`draft`) layered over it
 * — for the price-book editor: the live "what your customer is asked" and the
 * "test a quote" panel. WRITES NOTHING. Draft supplies replace the product's;
 * draft options are chosen by their default.
 */
export async function previewProductPrice(
  db: EstimatorDb,
  tenantId: string,
  input: PreviewProductPriceInput,
): Promise<ProductPreview> {
  const draft = draftSchema.parse(input.draft ?? {});
  const now = new Date();
  let base: ProductRow;
  if (input.productId) {
    const found = await getProductRow(db, tenantId, input.productId);
    if (!found) throw new EstimatorInputError("product_unavailable", "That product isn't in this price book.");
    base = found;
  } else {
    base = blankProduct(tenantId, now);
  }

  const storedRecipe = effectiveRecipe(base);
  const recipe = draft.recipe ?? storedRecipe;
  let configBase: Record<string, unknown> = {};
  if (recipe === storedRecipe && base.recipeConfig && typeof base.recipeConfig === "object") configBase = { ...base.recipeConfig };
  if (base.recipe === null && recipe === "area" && configBase["unit"] === undefined) configBase["unit"] = "in";
  if (draft.recipeConfig) {
    const parsed = recipeConfigSchema(recipe).safeParse(draft.recipeConfig);
    if (!parsed.success) {
      throw new z.ZodError(parsed.error.issues.map((issue) => ({ ...issue, path: ["draft", "recipeConfig", ...issue.path] })) as never);
    }
    configBase = { ...configBase, ...(parsed.data as Record<string, unknown>) };
  }
  const problem = recipeConfigProblem(recipe, {
    ...(resolveRecipeConfig(recipe, {}) as unknown as Record<string, unknown>),
    ...configBase,
  });
  if (problem) throw new EstimatorInputError("invalid_recipe_config", problem);

  const { supplies: draftSupplies, options: draftOptions, recipeConfig: _config, ...fields } = draft;
  const product: ProductRow = {
    ...base,
    ...(Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<ProductRow>),
    recipe,
    recipeConfig: configBase,
    measurementMode: measurementModeFor(recipe),
  };
  const config = resolveRecipeConfig(recipe, configBase);
  const customerFields = customerFieldsFor(recipe, config);
  const settings = await getEstimatorSettings(db, tenantId);

  if (!product.isEstimatable) {
    return { fields: customerFields, status: "quote_only", missing: [], customerView: null, build: null, derivation: null };
  }

  const outcome = resolveInputs(
    recipe,
    config,
    product,
    // No inputs yet is "nothing answered" (never 0.2's count-from-quantity).
    { inputs: input.inputs ?? {}, measurement: null, ...(input.quantity !== undefined ? { quantity: input.quantity } : {}) },
    "public",
  );
  if (outcome.kind === "missing") {
    return { fields: customerFields, status: "needs_inputs", missing: outcome.missing, customerView: null, build: null, derivation: null };
  }

  let supplies: BuildSupply[];
  if (draftSupplies) {
    const ids = [...new Set(draftSupplies.map((s) => s.supplyId))];
    const rows =
      ids.length === 0
        ? []
        : ((await db
            .select()
            .from(estimatorComponents)
            .where(and(inArray(estimatorComponents.id, ids), eq(estimatorComponents.tenantId, tenantId)))) as ComponentRow[]);
    supplies = draftSupplies.map((s, index) => {
      const row = rows.find((r) => r.id === s.supplyId);
      if (!row) throw new EstimatorInputError("component_unavailable", "One of those supplies isn't in this price book.");
      if (!isValidSupplyBasis(recipe, s.per)) {
        throw new EstimatorInputError("invalid_supply_basis", `"${row.name}" is priced by something this product isn't measured in.`);
      }
      return {
        assignmentId: `draft-${index}`,
        supplyId: row.id,
        name: row.name,
        unitType: row.unitType as SupplyUnitType,
        unitCost: row.unitCost,
        quantityMilli: s.quantityMilli,
        per: s.per,
        roundUp: s.roundUp ?? row.unitType === "per_unit",
        sortOrder: index,
      };
    });
  } else if (input.productId) {
    supplies = await loadSupplies(db, base);
  } else {
    supplies = [];
  }

  let selections: EstimateItemOptionSnapshot[];
  if (draftOptions) {
    selections = draftOptions.flatMap((option, index) => {
      const chosen = option.values.find((v) => v.isDefault);
      return chosen
        ? [{ optionId: `draft-${index}`, optionName: option.name, valueId: `draft-${index}`, valueLabel: chosen.label, priceModifier: chosen.priceModifier }]
        : [];
    });
  } else if (input.productId) {
    const resolved = await resolveOptionSelections(db, base.id, input.optionValueIds ?? [], "public");
    if (resolved === null) throw new EstimatorInputError("invalid_options", "Choose one value for each option.");
    selections = resolved;
  } else {
    selections = [];
  }

  const priced = priceWith({ product, recipe, config, supplies, selections, settings }, outcome, null);
  return {
    fields: customerFields,
    status: "priced",
    missing: [],
    customerView: toPublicPrice(priced, settings),
    build: priced.build,
    derivation: priced.derivation,
  };
}

// --- 0.2's calculateEstimate --------------------------------------------------------------

export const calculateEstimateSchema = z.object({
  productId: z.string().min(1),
  measurement: measurementSchema.default({}),
  /** 0.3: the customer's answers, by field key (preferred over `measurement`). */
  inputs: customerInputsSchema.nullish(),
  quantity: z.number().int().min(1).max(1000).default(1),
  optionValueIds: z.array(z.string()).max(50).default([]),
  takeoffId: z.string().max(200).nullish(),
});
export type CalculateEstimateInput = z.input<typeof calculateEstimateSchema>;

/**
 * The public live-range input: `measurement.units` is dropped (see
 * `publicMeasurementSchema`). A host validating a public route's body up
 * front (a tRPC `.input`) uses this one.
 */
export const publicCalculateEstimateSchema = calculateEstimateSchema.extend({
  measurement: publicMeasurementSchema.default({}),
});

export interface EstimatorPricingScope {
  /** Price only this tenant's products. Every caller in this package passes it. */
  tenantId?: string;
  audience?: PricingAudience;
}

/**
 * 0.2's live price, kept with its signature: `priceProduct` underneath,
 * answered in 0.2's shape (`subtotal` = the point price, the range as shown).
 * Null — the UI shows "request a quote" or "enter a measurement" — for a
 * product that is unknown, inactive, another tenant's, hidden from a public
 * caller or quote-only; for a measurement the product can't be priced from;
 * and for two values of one option. A malformed input still throws.
 *
 * @deprecated — use `priceProduct`, which answers `needs_inputs` and the
 * customer's sentences.
 */
export async function calculateEstimate(
  db: EstimatorDb,
  input: CalculateEstimateInput,
  scope: EstimatorPricingScope = {},
): Promise<EstimatePriceResult | null> {
  const audience = scope.audience ?? "staff";
  const parsed = (audience === "public" ? publicCalculateEstimateSchema : calculateEstimateSchema).parse(input);
  let tenantId = scope.tenantId;
  if (tenantId === undefined) {
    // 0.2 allowed an unscoped call from a single-tenant host that had already
    // checked ownership: price it as the product's own tenant.
    const [owner] = (await db
      .select({ tenantId: estimatorProducts.tenantId })
      .from(estimatorProducts)
      .where(eq(estimatorProducts.id, parsed.productId))
      .limit(1)) as Array<{ tenantId: string }>;
    if (!owner) return null;
    tenantId = owner.tenantId;
  }
  try {
    const priced = await priceProduct(
      db,
      tenantId,
      {
        productId: parsed.productId,
        measurement: Object.keys(parsed.measurement).length > 0 || !parsed.inputs ? (parsed.measurement as Measurement) : null,
        inputs: parsed.inputs ?? null,
        quantity: parsed.quantity,
        optionValueIds: parsed.optionValueIds,
        takeoffId: parsed.takeoffId ?? null,
      },
      { audience },
    );
    if (priced.status !== "priced") return null;
    const legacy = toLegacyRange(priced);
    return {
      sqFt: legacy.sqFt,
      linearFt: legacy.linearFt,
      units: legacy.units,
      subtotal: legacy.subtotal,
      estimateLow: legacy.estimateLow,
      estimateHigh: legacy.estimateHigh,
    };
  } catch (error) {
    if (error instanceof EstimatorInputError) return null;
    throw error;
  }
}
