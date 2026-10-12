import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import {
  customerFieldsFor,
  defaultSupplyBasis,
  effectiveRecipe,
  isValidSupplyBasis,
  measurementModeFor,
  quantityQuestion,
  RECIPE_KEYS,
  recipeConfigProblem,
  recipeConfigSchema,
  recipeInfoFor,
  resolveRecipeConfig,
  supplyBasisLabel,
} from "./recipes.js";
import {
  estimatorComponents,
  estimatorOptionValues,
  estimatorOptions,
  estimatorProductComponents,
  estimatorProducts,
} from "./schema.js";
import type { EstimatorSettings } from "./settings.js";
import {
  EstimatorInputError,
  type ComponentRow,
  type EstimatorDb,
  type OptionRow,
  type OptionValueRow,
  type ProductRow,
} from "./types.js";
import type {
  AdminProduct,
  ProductExample,
  CustomerField,
  PublicProductOption,
  RecipeConfig,
  RecipeKey,
  SupplyWire,
  UnitType,
} from "./wire.js";

/**
 * The price book: products, the supplies library, what each product uses,
 * and the options a customer picks (section 6.2 of the 0.3 contract).
 *
 * Every function is tenant-scoped: an id that isn't the tenant's changes
 * nothing (null / false, or `EstimatorInputError` for a create), so a caller
 * can neither reach nor probe another workspace's price book. Rows deactivate
 * ("retire") rather than delete, so an old estimate never points at nothing.
 */

const UNIT_TYPES = ["per_sqft", "per_linear_ft", "per_unit", "flat"] as const;
const MEASUREMENT_MODES = ["area", "linear", "unit"] as const;
const centsField = z.number().int().min(0);
const bpField = z.number().int().min(0).max(1_000_000);
const blankToNull = (value: unknown): unknown => (typeof value === "string" && value.trim() === "" ? null : value);
const optionalText = (max: number) => z.preprocess(blankToNull, z.string().trim().max(max).nullish());

// --- Products ------------------------------------------------------------------

/**
 * A product's editable fields with NO defaults. The create schema layers its
 * defaults over this; the update schema is this, all-optional. Deriving the
 * update schema from the create one (`.omit().partial()`) is the trap: under
 * zod 4 a `.default()` survives `.partial()`, so a patch of `{ name }` would
 * have reset the price book's knobs to their defaults.
 */
const productShape = {
  name: z.string().trim().min(1, "Give the product a name.").max(200),
  category: optionalText(120),
  description: optionalText(2000),
  measurementMode: z.enum(MEASUREMENT_MODES),
  recipe: z.enum(RECIPE_KEYS as unknown as [RecipeKey, ...RecipeKey[]]),
  /** A partial config; checked against the recipe's own schema in `createProduct` / `updateProduct`. */
  recipeConfig: z.record(z.string(), z.unknown()),
  allowMultiple: z.boolean(),
  multipleLabel: optionalText(120),
  maxQuantity: z.number().int().min(1, "Allow at least 1.").max(100, "Allow at most 100."),
  laborHoursPerUnitMilli: z.number().int().min(0).max(1_000_000),
  laborSetupHoursMilli: z.number().int().min(0).max(1_000_000),
  laborRateCents: centsField.max(1_000_000).nullish(),
  basePrice: centsField,
  pricePerSqFt: centsField.nullish(),
  pricePerLinearFt: centsField.nullish(),
  laborCost: centsField,
  wasteBp: bpField,
  pricingBasis: z.enum(["markup", "margin"]),
  markupBp: bpField,
  marginBp: z.number().int().min(0).max(9500, "A target margin can be at most 95%."),
  minimumCharge: centsField,
  rangeMode: z.enum(["measured", "percent"]),
  contingencyBp: z.number().int().min(0).max(5000, "Use 0% to 50%.").nullish(),
  estimateLowBp: bpField,
  estimateHighBp: bpField,
  showInEstimator: z.boolean(),
  isEstimatable: z.boolean(),
  sortOrder: z.number().int(),
};

/**
 * A new product. 0.3's defaults set 0.3's behaviour: the range comes from the
 * measurement (`measured`), "How many?" is off (`allowMultiple: false`).
 *
 * `measurementMode` is optional and follows the recipe. CONTRACT: when a
 * caller gives `measurementMode` and NO recipe (a 0.2 caller), the recipe is
 * derived from it (linear → linear, unit → count, area → area) rather than
 * defaulting to an area, so a 0.2 "linear" product is still a length.
 */
export const createProductSchema = z.object({
  tenantId: z.string().min(1).max(200),
  ...productShape,
  measurementMode: z.enum(MEASUREMENT_MODES).optional(),
  recipe: productShape.recipe.optional(),
  recipeConfig: productShape.recipeConfig.optional(),
  allowMultiple: z.boolean().default(false),
  maxQuantity: productShape.maxQuantity.default(10),
  laborHoursPerUnitMilli: productShape.laborHoursPerUnitMilli.default(0),
  laborSetupHoursMilli: productShape.laborSetupHoursMilli.default(0),
  basePrice: centsField.default(0),
  laborCost: centsField.default(0),
  wasteBp: bpField.default(0),
  pricingBasis: productShape.pricingBasis.default("markup"),
  markupBp: bpField.default(0),
  marginBp: productShape.marginBp.default(0),
  minimumCharge: centsField.default(0),
  rangeMode: productShape.rangeMode.default("measured"),
  estimateLowBp: bpField.default(9000),
  estimateHighBp: bpField.default(11500),
  showInEstimator: z.boolean().default(true),
  isEstimatable: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});
export type CreateProductInput = z.input<typeof createProductSchema>;

/**
 * A partial product edit. No `tenantId` (a patch cannot move a product to
 * another workspace) and no defaults (see `productShape`). Unknown keys are
 * dropped. `recipeConfig` is MERGED over the stored one: a patch of
 * `{ recipeConfig: { stepsLabel } }` keeps the rest.
 */
export const updateProductSchema = z
  .object(productShape)
  .partial()
  .refine(
    (p) => p.estimateLowBp === undefined || p.estimateHighBp === undefined || p.estimateLowBp <= p.estimateHighBp,
    { message: "estimateLowBp must not exceed estimateHighBp", path: ["estimateLowBp"] },
  );
export type UpdateProductInput = z.input<typeof updateProductSchema>;

/**
 * An inverted range (low 12000 bp, high 9000 bp) quotes "$1,200 – $900": the
 * customer sees nonsense and the saved midpoint is still computed from it.
 */
function assertRangeOrdered(lowBp: number, highBp: number): void {
  if (lowBp > highBp) {
    throw new EstimatorInputError(
      "invalid_price_range",
      `The low end of the price band (${lowBp / 100}%) can't be above the high end (${highBp / 100}%).`,
    );
  }
}

function recipeFromMode(mode: string | undefined): RecipeKey {
  return mode === "linear" ? "linear" : mode === "unit" ? "count" : "area";
}

/**
 * A recipe config patch, checked: each key against its limits (a ZodError on
 * `recipeConfig.<key>`), then the merged whole (`invalid_recipe_config`).
 */
function checkedConfig(recipe: RecipeKey, base: Record<string, unknown>, patch: unknown): Record<string, unknown> {
  const parsed = recipeConfigSchema(recipe).safeParse(patch ?? {});
  if (!parsed.success) {
    throw new z.ZodError(
      parsed.error.issues.map((issue) => ({ ...issue, path: ["recipeConfig", ...issue.path] })) as never,
    );
  }
  const merged = { ...base, ...(parsed.data as Record<string, unknown>) };
  const resolved = { ...(resolveRecipeConfig(recipe, {}) as unknown as Record<string, unknown>), ...merged };
  const problem = recipeConfigProblem(recipe, resolved);
  if (problem) throw new EstimatorInputError("invalid_recipe_config", problem);
  return merged;
}

export async function createProduct(db: EstimatorDb, input: CreateProductInput): Promise<ProductRow> {
  const parsed = createProductSchema.parse(input);
  assertRangeOrdered(parsed.estimateLowBp, parsed.estimateHighBp);
  const recipe = parsed.recipe ?? recipeFromMode(parsed.measurementMode);
  const recipeConfig = parsed.recipeConfig ? checkedConfig(recipe, {}, parsed.recipeConfig) : null;
  const [row] = await db
    .insert(estimatorProducts)
    .values({
      ...parsed,
      recipe,
      recipeConfig,
      measurementMode: measurementModeFor(recipe),
      category: parsed.category ?? null,
      description: parsed.description ?? null,
      multipleLabel: parsed.multipleLabel ?? null,
      laborRateCents: parsed.laborRateCents ?? null,
      pricePerSqFt: parsed.pricePerSqFt ?? null,
      pricePerLinearFt: parsed.pricePerLinearFt ?? null,
      contingencyBp: parsed.contingencyBp ?? null,
    })
    .returning();
  return row as ProductRow;
}

async function productRow(db: EstimatorDb, tenantId: string, id: string): Promise<ProductRow | null> {
  const [row] = await db
    .select()
    .from(estimatorProducts)
    .where(and(eq(estimatorProducts.id, id), eq(estimatorProducts.tenantId, tenantId)))
    .limit(1);
  return (row as ProductRow | undefined) ?? null;
}

/** This tenant's product row (any state), or null. */
export async function getProductRow(db: EstimatorDb, tenantId: string, id: string): Promise<ProductRow | null> {
  return productRow(db, tenantId, id);
}

/** The active supplies on a product with a `per` that the recipe doesn't have, by name. */
async function supplyBasisConflicts(db: EstimatorDb, productId: string, recipe: RecipeKey): Promise<string[]> {
  const rows = (await db
    .select({ per: estimatorProductComponents.per, name: estimatorComponents.name })
    .from(estimatorProductComponents)
    .innerJoin(estimatorComponents, eq(estimatorComponents.id, estimatorProductComponents.componentId))
    .where(and(eq(estimatorProductComponents.productId, productId), eq(estimatorProductComponents.isActive, true)))) as Array<{
    per: string | null;
    name: string;
  }>;
  return rows.filter((row) => !isValidSupplyBasis(recipe, row.per)).map((row) => row.name);
}

/**
 * Edit one of this tenant's products. Returns null when the id is not the
 * tenant's (or does not exist) — the same answer, so an id cannot be probed.
 *
 * Changing the RECIPE checks the product's active supplies: one whose `per`
 * the new recipe doesn't have (a supply per "ft of ramp" on what is now an
 * area) is refused `invalid_supply_basis`, naming the supplies, so a price
 * never silently loses a line. The stored config belonged to the old recipe
 * and is replaced by the patch's (or the new recipe's defaults).
 */
export async function updateProduct(
  db: EstimatorDb,
  tenantId: string,
  id: string,
  patch: UpdateProductInput,
): Promise<ProductRow | null> {
  const parsed = updateProductSchema.parse(patch);
  const current = await productRow(db, tenantId, id);
  if (!current) return null;

  // Only one end of the range moved: check it against the stored other end,
  // or a patch of just `{ estimateLowBp: 12000 }` inverts a 9000–11500 range
  // that the schema-level check (both ends present) never sees.
  assertRangeOrdered(parsed.estimateLowBp ?? current.estimateLowBp, parsed.estimateHighBp ?? current.estimateHighBp);

  const values: Record<string, unknown> = { ...parsed };
  delete values["recipe"];
  delete values["recipeConfig"];
  delete values["measurementMode"];

  // A product from before 0.3 (no recipe) adopts its implied recipe the first
  // time an edit touches the recipe or its config.
  const nextRecipe =
    parsed.recipe ?? (current.recipe !== null || parsed.recipeConfig !== undefined ? effectiveRecipe(current) : null);
  if (parsed.recipe && parsed.recipe !== effectiveRecipe(current)) {
    const conflicts = await supplyBasisConflicts(db, current.id, parsed.recipe);
    if (conflicts.length > 0) {
      throw new EstimatorInputError(
        "invalid_supply_basis",
        `Change or remove these supplies first; they're priced by a measurement the new recipe doesn't have: ${conflicts.join(", ")}.`,
      );
    }
  }
  if (nextRecipe) {
    const sameRecipe = parsed.recipe === undefined || parsed.recipe === effectiveRecipe(current);
    // A legacy area is in inches (0.2's unit); adopting it must not move it to feet.
    const legacyBase: Record<string, unknown> = current.recipe === null && nextRecipe === "area" ? { unit: "in" } : {};
    const base =
      sameRecipe && current.recipeConfig && typeof current.recipeConfig === "object"
        ? { ...legacyBase, ...current.recipeConfig }
        : sameRecipe
          ? legacyBase
          : {};
    if (parsed.recipe !== undefined || parsed.recipeConfig !== undefined) {
      values["recipe"] = nextRecipe;
      values["recipeConfig"] = checkedConfig(nextRecipe, base as Record<string, unknown>, parsed.recipeConfig ?? {});
    }
    // From 0.3 the mode follows the recipe; a given one that disagrees is ignored.
    values["measurementMode"] = measurementModeFor(nextRecipe);
  } else if (parsed.measurementMode !== undefined) {
    // A product from before 0.3 (no recipe): 0.2's mode edit still works.
    values["measurementMode"] = parsed.measurementMode;
  }

  const [row] = await db
    .update(estimatorProducts)
    .set({ ...values, updatedAt: new Date() })
    .where(and(eq(estimatorProducts.id, id), eq(estimatorProducts.tenantId, tenantId)))
    .returning();
  return (row as ProductRow) ?? null;
}

/** Soft-deactivate ("retire") one of this tenant's products; false if it is not theirs. */
export async function deactivateProduct(db: EstimatorDb, tenantId: string, id: string): Promise<boolean> {
  const [row] = await db
    .update(estimatorProducts)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(estimatorProducts.id, id), eq(estimatorProducts.tenantId, tenantId)))
    .returning({ id: estimatorProducts.id });
  return row !== undefined;
}

/** Bring a retired product back; false if it is not theirs. */
export async function reactivateProduct(db: EstimatorDb, tenantId: string, id: string): Promise<boolean> {
  const [row] = await db
    .update(estimatorProducts)
    .set({ isActive: true, updatedAt: new Date() })
    .where(and(eq(estimatorProducts.id, id), eq(estimatorProducts.tenantId, tenantId)))
    .returning({ id: estimatorProducts.id });
  return row !== undefined;
}

/**
 * Put this tenant's products in the order given (`sort_order` = index × 10,
 * leaving room to slot one in by hand). Ids that aren't the tenant's are
 * ignored; products not named keep their order.
 */
export async function reorderProducts(db: EstimatorDb, tenantId: string, ids: readonly string[]): Promise<void> {
  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))].slice(0, 500);
  if (unique.length === 0) return;
  await db.transaction(async (tx) => {
    for (const [index, id] of unique.entries()) {
      await tx
        .update(estimatorProducts)
        .set({ sortOrder: index * 10, updatedAt: new Date() })
        .where(and(eq(estimatorProducts.id, id), eq(estimatorProducts.tenantId, tenantId)));
    }
  });
}

export async function listProducts(
  db: EstimatorDb,
  tenantId: string,
  options: { publicOnly?: boolean; includeInactive?: boolean } = {},
): Promise<ProductRow[]> {
  const conditions = [eq(estimatorProducts.tenantId, tenantId)];
  if (!options.includeInactive || options.publicOnly) conditions.push(eq(estimatorProducts.isActive, true));
  if (options.publicOnly) conditions.push(eq(estimatorProducts.showInEstimator, true));
  return (await db
    .select()
    .from(estimatorProducts)
    .where(and(...conditions))
    .orderBy(asc(estimatorProducts.sortOrder), asc(estimatorProducts.name))) as ProductRow[];
}

export interface ProductOptionView {
  option: OptionRow;
  values: OptionValueRow[];
}

export interface ProductDetailComponent {
  assignmentId: string;
  quantityMilli: number;
  /** Bought whole: rounded up to a whole supplier unit per item (0.3). */
  roundUp: boolean;
  /** What the quantity is per (0.3): a recipe quantity key, "item", "job", or null (0.2: by the supply's unit). */
  per: string | null;
  /** "per ft of ramp", "once per job". */
  perLabel: string;
  sortOrder: number;
  component: ComponentRow;
}

export interface ProductDetail {
  product: ProductRow;
  /** The recipe it prices with, and its resolved config (0.3). */
  recipe: RecipeKey;
  recipeConfig: RecipeConfig;
  /** Exactly what the customer is asked. */
  fields: CustomerField[];
  /** "How many ramps?", or null. */
  quantity: { label: string; max: number } | null;
  components: ProductDetailComponent[];
  options: ProductOptionView[];
}

/** Resolve a product row's recipe and config (legacy rows read 0.2's units). */
export function recipeOf(product: Pick<ProductRow, "recipe" | "measurementMode" | "recipeConfig">): {
  recipe: RecipeKey;
  config: RecipeConfig;
} {
  const recipe = effectiveRecipe(product);
  return { recipe, config: resolveRecipeConfig(recipe, product.recipeConfig, { legacy: product.recipe === null }) };
}

/**
 * One of this tenant's products with its active supplies (and what each is
 * per), ALL its active options (staff-only ones included), its recipe and the
 * fields the customer is asked, for the price-book editor. Null when the
 * product is not the tenant's. Public surfaces use `listPublicOptions`.
 */
export async function getProductDetail(db: EstimatorDb, tenantId: string, productId: string): Promise<ProductDetail | null> {
  const product = await productRow(db, tenantId, productId);
  if (!product) return null;
  const { recipe, config } = recipeOf(product);

  const componentRows = (await db
    .select({
      assignmentId: estimatorProductComponents.id,
      quantityMilli: estimatorProductComponents.quantityMilli,
      roundUp: estimatorProductComponents.roundUp,
      per: estimatorProductComponents.per,
      sortOrder: estimatorProductComponents.sortOrder,
      component: estimatorComponents,
    })
    .from(estimatorProductComponents)
    .innerJoin(estimatorComponents, eq(estimatorComponents.id, estimatorProductComponents.componentId))
    .where(
      and(
        eq(estimatorProductComponents.productId, productId),
        eq(estimatorProductComponents.isActive, true),
        eq(estimatorComponents.isActive, true),
        eq(estimatorComponents.tenantId, tenantId),
      ),
    )) as Array<Omit<ProductDetailComponent, "perLabel">>;

  const optionRows = (await db
    .select()
    .from(estimatorOptions)
    .where(and(eq(estimatorOptions.productId, productId), eq(estimatorOptions.isActive, true)))
    .orderBy(asc(estimatorOptions.sortOrder))) as OptionRow[];

  const optionIds = optionRows.map((o) => o.id);
  const valueRows =
    optionIds.length === 0
      ? []
      : ((await db
          .select()
          .from(estimatorOptionValues)
          .where(and(inArray(estimatorOptionValues.optionId, optionIds), eq(estimatorOptionValues.isActive, true)))
          .orderBy(asc(estimatorOptionValues.sortOrder))) as OptionValueRow[]);

  return {
    product,
    recipe,
    recipeConfig: config,
    fields: customerFieldsFor(recipe, config),
    quantity: quantityQuestion(recipe, config, product),
    components: componentRows
      .map((row) => ({
        ...row,
        perLabel: supplyBasisLabel(recipe, row.per, { config, unitType: row.component.unitType }),
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder),
    options: optionRows.map((option) => ({
      option,
      values: valueRows.filter((v) => v.optionId === option.id),
    })),
  };
}

/**
 * The admin's view of a product (`AdminProduct`). Without `includeCosts`
 * (the caller lacks `estimator.costs.view`) every supply cost, labor rate,
 * lump cost, waste, markup and margin is null: staff who quote see prices,
 * not what the work costs or what the business makes on it (review ADV-3:
 * the markup and margin came back to everyone).
 */
export function toAdminProduct(
  detail: ProductDetail,
  options: { settings: Pick<EstimatorSettings, "defaultLaborRateCents">; includeCosts: boolean; example?: ProductExample | null },
): AdminProduct {
  const p = detail.product;
  const costs = options.includeCosts;
  return {
    id: p.id,
    name: p.name,
    category: p.category,
    description: p.description,
    recipe: detail.recipe,
    recipeInfo: recipeInfoFor(detail.recipe, detail.recipeConfig),
    recipeConfig: detail.recipeConfig,
    fields: detail.fields,
    allowMultiple: p.allowMultiple,
    multipleLabel: p.multipleLabel,
    maxQuantity: p.maxQuantity,
    supplies: detail.components.map((c) => ({
      assignmentId: c.assignmentId,
      supplyId: c.component.id,
      name: c.component.name,
      unitType: c.component.unitType as UnitType,
      unitCost: costs ? c.component.unitCost : null,
      quantityMilli: c.quantityMilli,
      per: c.per,
      perLabel: c.perLabel,
      sortOrder: c.sortOrder,
      roundUp: c.roundUp,
    })),
    labor: {
      hoursPerUnitMilli: p.laborHoursPerUnitMilli,
      setupHoursMilli: p.laborSetupHoursMilli,
      rateCents: costs ? p.laborRateCents : null,
      effectiveRateCents: costs ? (p.laborRateCents ?? options.settings.defaultLaborRateCents) : null,
    },
    wasteBp: costs ? p.wasteBp : null,
    pricingBasis: p.pricingBasis === "margin" ? "margin" : "markup",
    markupBp: costs ? p.markupBp : null,
    marginBp: costs ? p.marginBp : null,
    minimumCharge: p.minimumCharge,
    rangeMode: p.rangeMode === "measured" ? "measured" : "percent",
    contingencyBp: p.contingencyBp,
    estimateLowBp: p.estimateLowBp,
    estimateHighBp: p.estimateHighBp,
    example: options.example ?? null,
    lumpCosts: costs
      ? { basePrice: p.basePrice, pricePerSqFt: p.pricePerSqFt, pricePerLinearFt: p.pricePerLinearFt, laborCost: p.laborCost }
      : null,
    showInEstimator: p.showInEstimator,
    isEstimatable: p.isEstimatable,
    sortOrder: p.sortOrder,
    isActive: p.isActive,
    options: detail.options.map(({ option, values }) => ({
      id: option.id,
      name: option.name,
      optionType: option.optionType,
      showInEstimator: option.showInEstimator,
      sortOrder: option.sortOrder,
      values: values.map((v) => ({
        id: v.id,
        label: v.label,
        priceModifier: v.priceModifier,
        isDefault: v.isDefault,
        sortOrder: v.sortOrder,
      })),
    })),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

// --- Public options ------------------------------------------------------------

/**
 * The customer-facing options of one of this tenant's public products — the
 * one read both the embed and the business's own page use, so the "what may
 * the public see" rule lives in one place. Staff-only options
 * (`showInEstimator: false`) and inactive rows are left out; a product that
 * is not the tenant's, inactive, or hidden from the estimator answers [].
 */
export async function listPublicOptions(db: EstimatorDb, tenantId: string, productId: string): Promise<PublicProductOption[]> {
  const [product] = await db
    .select({ id: estimatorProducts.id })
    .from(estimatorProducts)
    .where(
      and(
        eq(estimatorProducts.id, productId),
        eq(estimatorProducts.tenantId, tenantId),
        eq(estimatorProducts.isActive, true),
        eq(estimatorProducts.showInEstimator, true),
      ),
    )
    .limit(1);
  if (!product) return [];
  return (await publicOptionsFor(db, [productId])).get(productId) ?? [];
}

/** The public options of several products, in two queries (the config route lists them all). */
export async function publicOptionsFor(
  db: EstimatorDb,
  productIds: readonly string[],
): Promise<Map<string, PublicProductOption[]>> {
  const out = new Map<string, PublicProductOption[]>();
  if (productIds.length === 0) return out;
  const optionRows = (await db
    .select()
    .from(estimatorOptions)
    .where(
      and(
        inArray(estimatorOptions.productId, [...productIds]),
        eq(estimatorOptions.isActive, true),
        eq(estimatorOptions.showInEstimator, true),
      ),
    )
    .orderBy(asc(estimatorOptions.sortOrder))) as OptionRow[];
  if (optionRows.length === 0) return out;
  const valueRows = (await db
    .select()
    .from(estimatorOptionValues)
    .where(
      and(
        inArray(
          estimatorOptionValues.optionId,
          optionRows.map((o) => o.id),
        ),
        eq(estimatorOptionValues.isActive, true),
      ),
    )
    .orderBy(asc(estimatorOptionValues.sortOrder))) as OptionValueRow[];
  for (const o of optionRows) {
    const list = out.get(o.productId) ?? [];
    list.push({
      id: o.id,
      name: o.name,
      values: valueRows
        .filter((v) => v.optionId === o.id)
        .map((v) => ({ id: v.id, label: v.label, priceModifier: v.priceModifier, isDefault: v.isDefault })),
    });
    out.set(o.productId, list);
  }
  return out;
}

// --- Supplies (components) --------------------------------------------------------

export const createComponentSchema = z.object({
  tenantId: z.string().min(1).max(200),
  name: z.string().trim().min(1, "Give the supply a name.").max(200),
  unitType: z.enum(UNIT_TYPES).default("flat"),
  unitCost: centsField.max(100_000_000).default(0),
  supplier: optionalText(120),
  sku: optionalText(80),
  note: optionalText(500),
});
export type CreateComponentInput = z.input<typeof createComponentSchema>;

export const updateComponentSchema = z
  .object({
    name: z.string().trim().min(1, "Give the supply a name.").max(200),
    unitType: z.enum(UNIT_TYPES),
    unitCost: centsField.max(100_000_000),
    supplier: optionalText(120),
    sku: optionalText(80),
    note: optionalText(500),
  })
  .partial();
export type UpdateComponentInput = z.input<typeof updateComponentSchema>;

/**
 * A supply the host's own price list owns: its cost can't be changed in the
 * admin (`managed_externally`), because the next sync would silently undo
 * the change (review RL-02).
 */
function managedRefusal(row: Pick<ComponentRow, "name">): EstimatorInputError {
  return new EstimatorInputError(
    "managed_externally",
    `${row.name}'s cost comes from your own price list, so change it there. It updates here on the next sync.`,
  );
}

export async function createComponent(db: EstimatorDb, input: CreateComponentInput): Promise<ComponentRow> {
  const values = createComponentSchema.parse(input);
  const [row] = await db
    .insert(estimatorComponents)
    .values({ ...values, supplier: values.supplier ?? null, sku: values.sku ?? null, note: values.note ?? null })
    .returning();
  return row as ComponentRow;
}

export async function listComponents(
  db: EstimatorDb,
  tenantId: string,
  options: { includeInactive?: boolean } = {},
): Promise<ComponentRow[]> {
  const conditions = [eq(estimatorComponents.tenantId, tenantId)];
  if (!options.includeInactive) conditions.push(eq(estimatorComponents.isActive, true));
  return (await db
    .select()
    .from(estimatorComponents)
    .where(and(...conditions))
    .orderBy(asc(estimatorComponents.name))) as ComponentRow[];
}

async function componentRow(db: EstimatorDb, tenantId: string, id: string): Promise<ComponentRow | null> {
  const [row] = await db
    .select()
    .from(estimatorComponents)
    .where(and(eq(estimatorComponents.id, id), eq(estimatorComponents.tenantId, tenantId)))
    .limit(1);
  return (row as ComponentRow | undefined) ?? null;
}

/** This tenant's supply (any state), or null. */
export async function getComponent(db: EstimatorDb, tenantId: string, id: string): Promise<ComponentRow | null> {
  return componentRow(db, tenantId, id);
}

/**
 * The products a supply is on (an active attachment), by name — what changing
 * its cost or retiring it affects. "Updated. This changes the price of: …".
 */
export async function productsUsingComponent(
  db: EstimatorDb,
  tenantId: string,
  id: string,
): Promise<Array<{ id: string; name: string; isActive: boolean }>> {
  return (await db
    .select({ id: estimatorProducts.id, name: estimatorProducts.name, isActive: estimatorProducts.isActive })
    .from(estimatorProductComponents)
    .innerJoin(estimatorProducts, eq(estimatorProducts.id, estimatorProductComponents.productId))
    .where(
      and(
        eq(estimatorProductComponents.componentId, id),
        eq(estimatorProductComponents.isActive, true),
        eq(estimatorProducts.tenantId, tenantId),
      ),
    )
    .orderBy(asc(estimatorProducts.name))) as Array<{ id: string; name: string; isActive: boolean }>;
}

/** For several supplies at once: supply id → the active products using it. */
export async function productsUsingComponents(
  db: EstimatorDb,
  tenantId: string,
  ids: readonly string[],
): Promise<Map<string, Array<{ id: string; name: string }>>> {
  const out = new Map<string, Array<{ id: string; name: string }>>();
  if (ids.length === 0) return out;
  const rows = (await db
    .select({ componentId: estimatorProductComponents.componentId, id: estimatorProducts.id, name: estimatorProducts.name })
    .from(estimatorProductComponents)
    .innerJoin(estimatorProducts, eq(estimatorProducts.id, estimatorProductComponents.productId))
    .where(
      and(
        inArray(estimatorProductComponents.componentId, [...ids]),
        eq(estimatorProductComponents.isActive, true),
        eq(estimatorProducts.tenantId, tenantId),
        eq(estimatorProducts.isActive, true),
      ),
    )
    .orderBy(asc(estimatorProducts.name))) as Array<{ componentId: string; id: string; name: string }>;
  for (const row of rows) {
    const list = out.get(row.componentId) ?? [];
    if (!list.some((p) => p.id === row.id)) list.push({ id: row.id, name: row.name });
    out.set(row.componentId, list);
  }
  return out;
}

/**
 * Edit one of this tenant's supplies; null when it is not theirs. Answers the
 * ACTIVE products it is on, so the screen can say what the change re-prices.
 * A supply the host's price list owns (`managedExternally`) keeps its cost
 * and unit (`managed_externally`); its name and notes can still change.
 */
export async function updateComponent(
  db: EstimatorDb,
  tenantId: string,
  id: string,
  patch: UpdateComponentInput,
): Promise<{ component: ComponentRow; affectedProducts: Array<{ id: string; name: string }> } | null> {
  const parsed = updateComponentSchema.parse(patch);
  if (parsed.unitCost !== undefined || parsed.unitType !== undefined) {
    const current = await componentRow(db, tenantId, id);
    if (!current) return null;
    const changes =
      (parsed.unitCost !== undefined && parsed.unitCost !== current.unitCost) ||
      (parsed.unitType !== undefined && parsed.unitType !== current.unitType);
    if (current.managedExternally && changes) throw managedRefusal(current);
  }
  const [row] = await db
    .update(estimatorComponents)
    .set({ ...parsed, updatedAt: new Date() })
    .where(and(eq(estimatorComponents.id, id), eq(estimatorComponents.tenantId, tenantId)))
    .returning();
  if (!row) return null;
  const affected = (await productsUsingComponent(db, tenantId, id))
    .filter((p) => p.isActive)
    .map(({ id: productId, name }) => ({ id: productId, name }));
  return { component: row as ComponentRow, affectedProducts: affected };
}

/**
 * Retire one of this tenant's supplies; false when it is not theirs. It used
 * to take any id, so one workspace could pull a supply out of another's
 * prices. A retired supply drops out of every price it was in (the admin
 * route reads `productsUsingComponent` first, to say which).
 */
export async function deactivateComponent(db: EstimatorDb, tenantId: string, id: string): Promise<boolean> {
  const [row] = await db
    .update(estimatorComponents)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(estimatorComponents.id, id), eq(estimatorComponents.tenantId, tenantId)))
    .returning({ id: estimatorComponents.id });
  return row !== undefined;
}

/** Bring a retired supply back (into every price it is still attached to); false when it is not theirs. */
export async function reactivateComponent(db: EstimatorDb, tenantId: string, id: string): Promise<boolean> {
  const [row] = await db
    .update(estimatorComponents)
    .set({ isActive: true, updatedAt: new Date() })
    .where(and(eq(estimatorComponents.id, id), eq(estimatorComponents.tenantId, tenantId)))
    .returning({ id: estimatorComponents.id });
  return row !== undefined;
}

export const upsertComponentByRefSchema = z.object({
  name: z.string().trim().min(1, "Give the supply a name.").max(200),
  unitType: z.enum(UNIT_TYPES),
  unitCost: centsField.max(100_000_000),
  supplier: optionalText(120),
  sku: optionalText(80),
  note: optionalText(500),
});
export type UpsertComponentByRefInput = z.input<typeof upsertComponentByRefSchema>;

const refSchema = z.string().trim().min(1, "Give the reference.").max(120);

/** One of this tenant's supplies by the host's own reference (`externalRef`), or null. */
export async function getComponentByRef(db: EstimatorDb, tenantId: string, externalRef: string): Promise<ComponentRow | null> {
  const ref = refSchema.parse(externalRef);
  const [row] = await db
    .select()
    .from(estimatorComponents)
    .where(and(eq(estimatorComponents.tenantId, tenantId), eq(estimatorComponents.externalRef, ref)))
    .limit(1);
  return (row as ComponentRow | undefined) ?? null;
}

/**
 * Create or update one of this tenant's supplies BY THE HOST'S OWN REFERENCE
 * (a SKU, a service code): the one-way sync from a price list the business
 * already keeps (review RL-02).
 *
 *   for (const service of await services.list()) {
 *     await upsertComponentByRef(db, tenantId, service.code, { name: service.name, unitType: "per_unit", unitCost: service.costCents });
 *   }
 *
 * One statement (`INSERT … ON CONFLICT (tenant_id, external_ref) DO UPDATE`),
 * so a nightly run is idempotent and two runs can't make two rows. The row is
 * marked `managedExternally` (unless `{ managed: false }`): the price book
 * shows it as coming from your list and refuses a cost change in the admin.
 * Attach it to products once, in the price book; every price that uses it
 * moves when the sync changes its cost. A retired supply stays retired.
 *
 * Costs, not prices: `unitCost` is what the business PAYS, and the product's
 * markup or margin is added on top.
 */
export async function upsertComponentByRef(
  db: EstimatorDb,
  tenantId: string,
  externalRef: string,
  input: UpsertComponentByRefInput,
  options: { managed?: boolean; now?: Date } = {},
): Promise<ComponentRow> {
  const ref = refSchema.parse(externalRef);
  const values = upsertComponentByRefSchema.parse(input);
  const now = options.now ?? new Date();
  const managed = options.managed !== false;
  const fields = { ...values, supplier: values.supplier ?? null, sku: values.sku ?? null, note: values.note ?? null };
  const [row] = await db
    .insert(estimatorComponents)
    .values({ tenantId, externalRef: ref, managedExternally: managed, ...fields, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [estimatorComponents.tenantId, estimatorComponents.externalRef],
      set: { ...fields, managedExternally: managed, updatedAt: now },
    })
    .returning();
  return row as ComponentRow;
}

/** A supply as the admin shows it. Without `includeCosts` its cost is null. */
export function toSupplyWire(
  row: ComponentRow,
  usedBy: Array<{ id: string; name: string }>,
  includeCosts: boolean,
): SupplyWire {
  return {
    id: row.id,
    name: row.name,
    unitType: row.unitType as UnitType,
    unitCost: includeCosts ? row.unitCost : null,
    supplier: row.supplier,
    sku: row.sku,
    note: row.note,
    isActive: row.isActive,
    usedBy,
    externalRef: row.externalRef ?? null,
    managedExternally: row.managedExternally,
    createdAt: row.createdAt.toISOString(),
    updatedAt: (row.updatedAt ?? row.createdAt).toISOString(),
  };
}

// --- Attachments (a supply on a product) ---------------------------------------------

export const attachComponentSchema = z.object({
  productId: z.string().min(1),
  componentId: z.string().min(1),
  quantityMilli: z.number().int().min(1).max(100_000_000).default(1000),
  /** What the quantity is per (0.3). Omitted: the default for the supply's unit (`defaultSupplyBasis`). */
  per: z.string().trim().min(1).max(40).optional(),
  /** Bought whole (0.3). Omitted: on for an "each" supply, off otherwise. */
  roundUp: z.boolean().optional(),
  sortOrder: z.number().int().default(0),
});
export type AttachComponentInput = z.input<typeof attachComponentSchema>;

function basisRefusal(recipe: RecipeKey, per: string): EstimatorInputError {
  return new EstimatorInputError(
    "invalid_supply_basis",
    `"${per}" isn't something this product is measured in. Pick one of: ${recipeInfoFor(recipe, resolveRecipeConfig(recipe, {}))
      .bases.map((b) => b.label)
      .join(", ")}.`,
  );
}

/**
 * Put one of the tenant's supplies on one of the tenant's products, with how
 * much of it per what. Both are checked (it used to insert any pair, so a
 * workspace could add a cost to another's prices): `product_unavailable` /
 * `component_unavailable`. `per` must be one of the product recipe's bases
 * (`invalid_supply_basis`).
 *
 * CONTRACT: an attach that names no `per` gets `defaultSupplyBasis` on a 0.3
 * product; on a product from before 0.3 (no recipe) it stays null, 0.2's
 * "by the supply's unit", so a 0.2 caller's prices don't move.
 */
export async function attachComponent(db: EstimatorDb, tenantId: string, input: AttachComponentInput): Promise<string> {
  const values = attachComponentSchema.parse(input);
  const product = await productRow(db, tenantId, values.productId);
  if (!product) throw new EstimatorInputError("product_unavailable", "That product isn't in this price book.");
  const component = await componentRow(db, tenantId, values.componentId);
  if (!component) throw new EstimatorInputError("component_unavailable", "That supply isn't in this price book.");
  const recipe = effectiveRecipe(product);
  let per: string | null = values.per ?? null;
  if (per === null && product.recipe !== null) {
    per = defaultSupplyBasis(recipe, component.unitType);
    if (per === null) {
      throw new EstimatorInputError(
        "invalid_supply_basis",
        `A supply priced per sq ft needs an area to go by; say what "${component.name}" is per.`,
      );
    }
  }
  if (per !== null && !isValidSupplyBasis(recipe, per)) throw basisRefusal(recipe, per);
  // Posts, brackets and sections come whole (review EST-R09): an "each"
  // supply rounds up unless the caller says otherwise.
  const roundUp = values.roundUp ?? component.unitType === "per_unit";
  const [row] = await db
    .insert(estimatorProductComponents)
    .values({ productId: product.id, componentId: component.id, quantityMilli: values.quantityMilli, per, roundUp, sortOrder: values.sortOrder })
    .returning({ id: estimatorProductComponents.id });
  return (row as { id: string }).id;
}

/** The product an active attachment is on, if the product is this tenant's. */
export async function productIdForAttachment(db: EstimatorDb, tenantId: string, assignmentId: string): Promise<string | null> {
  const [row] = (await db
    .select({ productId: estimatorProducts.id })
    .from(estimatorProductComponents)
    .innerJoin(estimatorProducts, eq(estimatorProducts.id, estimatorProductComponents.productId))
    .where(and(eq(estimatorProductComponents.id, assignmentId), eq(estimatorProducts.tenantId, tenantId)))
    .limit(1)) as Array<{ productId: string }>;
  return row?.productId ?? null;
}

export const updateAttachmentSchema = z
  .object({
    quantityMilli: z.number().int().min(1).max(100_000_000),
    per: z.string().trim().min(1).max(40),
    roundUp: z.boolean(),
    sortOrder: z.number().int(),
  })
  .partial();

/** Change how much of a supply a product uses, per what, or its order; false when it isn't on a product of this tenant's. */
export async function updateAttachment(
  db: EstimatorDb,
  tenantId: string,
  assignmentId: string,
  patch: z.input<typeof updateAttachmentSchema>,
): Promise<boolean> {
  const parsed = updateAttachmentSchema.parse(patch);
  const [owned] = (await db
    .select({ id: estimatorProductComponents.id, recipe: estimatorProducts.recipe, measurementMode: estimatorProducts.measurementMode })
    .from(estimatorProductComponents)
    .innerJoin(estimatorProducts, eq(estimatorProducts.id, estimatorProductComponents.productId))
    .where(and(eq(estimatorProductComponents.id, assignmentId), eq(estimatorProducts.tenantId, tenantId)))
    .limit(1)) as Array<{ id: string; recipe: string | null; measurementMode: string }>;
  if (!owned) return false;
  if (parsed.per !== undefined) {
    const recipe = effectiveRecipe(owned);
    if (!isValidSupplyBasis(recipe, parsed.per)) throw basisRefusal(recipe, parsed.per);
  }
  if (Object.keys(parsed).length === 0) return true;
  const [row] = await db
    .update(estimatorProductComponents)
    .set(parsed)
    .where(eq(estimatorProductComponents.id, assignmentId))
    .returning({ id: estimatorProductComponents.id });
  return row !== undefined;
}

/**
 * Take a supply off one of this tenant's products; false when the assignment
 * is not on a product of theirs. Scoped through the product, so a stray link to
 * another workspace's supply (a pre-0.2.0 attach) can still be removed.
 */
export async function detachComponent(db: EstimatorDb, tenantId: string, assignmentId: string): Promise<boolean> {
  const productId = await productIdForAttachment(db, tenantId, assignmentId);
  if (!productId) return false;
  const [row] = await db
    .update(estimatorProductComponents)
    .set({ isActive: false })
    .where(eq(estimatorProductComponents.id, assignmentId))
    .returning({ id: estimatorProductComponents.id });
  return row !== undefined;
}

// --- Options ---------------------------------------------------------------------

/** Is this product the tenant's? Any state — staff build one before showing it. */
async function ownsProduct(db: EstimatorDb, tenantId: string, productId: string): Promise<boolean> {
  return (await productRow(db, tenantId, productId)) !== null;
}

export const createOptionSchema = z.object({
  productId: z.string().min(1),
  name: z.string().trim().min(1, "Give the option a name.").max(120),
  optionType: z.string().max(60).default("custom"),
  /** false = staff-only: never shown in, nor priced by, the public tool. */
  showInEstimator: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});
export type CreateOptionInput = z.input<typeof createOptionSchema>;

/** Add an option to one of this tenant's products. Refuses `product_unavailable`. */
export async function createOption(db: EstimatorDb, tenantId: string, input: CreateOptionInput): Promise<OptionRow> {
  const values = createOptionSchema.parse(input);
  if (!(await ownsProduct(db, tenantId, values.productId))) {
    throw new EstimatorInputError("product_unavailable", "That product isn't in this price book.");
  }
  const [row] = await db.insert(estimatorOptions).values(values).returning();
  return row as OptionRow;
}

/** The product an option is on, if the product is this tenant's. */
export async function productIdForOption(db: EstimatorDb, tenantId: string, optionId: string): Promise<string | null> {
  const [row] = (await db
    .select({ productId: estimatorProducts.id })
    .from(estimatorOptions)
    .innerJoin(estimatorProducts, eq(estimatorProducts.id, estimatorOptions.productId))
    .where(and(eq(estimatorOptions.id, optionId), eq(estimatorProducts.tenantId, tenantId)))
    .limit(1)) as Array<{ productId: string }>;
  return row?.productId ?? null;
}

/** The product and option an option value is on, if the product is this tenant's. */
export async function productIdForOptionValue(
  db: EstimatorDb,
  tenantId: string,
  valueId: string,
): Promise<{ productId: string; optionId: string } | null> {
  const [row] = (await db
    .select({ productId: estimatorProducts.id, optionId: estimatorOptions.id })
    .from(estimatorOptionValues)
    .innerJoin(estimatorOptions, eq(estimatorOptions.id, estimatorOptionValues.optionId))
    .innerJoin(estimatorProducts, eq(estimatorProducts.id, estimatorOptions.productId))
    .where(and(eq(estimatorOptionValues.id, valueId), eq(estimatorProducts.tenantId, tenantId)))
    .limit(1)) as Array<{ productId: string; optionId: string }>;
  return row ?? null;
}

export const updateOptionSchema = z
  .object({
    name: z.string().trim().min(1, "Give the option a name.").max(120),
    optionType: z.string().max(60),
    showInEstimator: z.boolean(),
    sortOrder: z.number().int(),
  })
  .partial();

/** Rename an option, make it staff-only or public, or move it; false when it isn't this tenant's. */
export async function updateOption(
  db: EstimatorDb,
  tenantId: string,
  optionId: string,
  patch: z.input<typeof updateOptionSchema>,
): Promise<boolean> {
  const parsed = updateOptionSchema.parse(patch);
  if (!(await productIdForOption(db, tenantId, optionId))) return false;
  if (Object.keys(parsed).length === 0) return true;
  const [row] = await db
    .update(estimatorOptions)
    .set(parsed)
    .where(eq(estimatorOptions.id, optionId))
    .returning({ id: estimatorOptions.id });
  return row !== undefined;
}

/** Remove an option (and so every value of it) from the price book; false when it isn't this tenant's. */
export async function deactivateOption(db: EstimatorDb, tenantId: string, optionId: string): Promise<boolean> {
  if (!(await productIdForOption(db, tenantId, optionId))) return false;
  const [row] = await db
    .update(estimatorOptions)
    .set({ isActive: false })
    .where(eq(estimatorOptions.id, optionId))
    .returning({ id: estimatorOptions.id });
  return row !== undefined;
}

export const createOptionValueSchema = z.object({
  optionId: z.string().min(1),
  label: z.string().trim().min(1, "Give the choice a name.").max(120),
  /** Cents the customer pays on top (a price, not marked up). */
  priceModifier: centsField.max(100_000_000).default(0),
  isDefault: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
});
export type CreateOptionValueInput = z.input<typeof createOptionValueSchema>;

/**
 * Lock one of this tenant's options for the transaction; false (nothing
 * locked) when it is not theirs. The lock serializes default-setters on one
 * option, so two concurrent "make this the default" calls queue instead of each
 * clearing the others and both landing as the default. `of` keeps the lock on
 * the option row, not the joined product.
 */
async function lockOption(tx: EstimatorDb, tenantId: string, optionId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: estimatorOptions.id })
    .from(estimatorOptions)
    .innerJoin(estimatorProducts, eq(estimatorProducts.id, estimatorOptions.productId))
    .where(and(eq(estimatorOptions.id, optionId), eq(estimatorProducts.tenantId, tenantId)))
    .for("update", { of: estimatorOptions });
  return row !== undefined;
}

/**
 * Add a value to one of this tenant's options. Refuses `option_unavailable`.
 * A value created as the default takes the default over — the option's other
 * defaults are cleared in the same transaction — because the tool pre-selects
 * "the" default, and with two it picked whichever sorted first.
 */
export async function createOptionValue(db: EstimatorDb, tenantId: string, input: CreateOptionValueInput): Promise<OptionValueRow> {
  const values = createOptionValueSchema.parse(input);
  return db.transaction(async (tx) => {
    if (!(await lockOption(tx, tenantId, values.optionId))) {
      throw new EstimatorInputError("option_unavailable", "That option isn't in this price book.");
    }
    if (values.isDefault) {
      await tx
        .update(estimatorOptionValues)
        .set({ isDefault: false })
        .where(and(eq(estimatorOptionValues.optionId, values.optionId), eq(estimatorOptionValues.isDefault, true)));
    }
    const [row] = await tx.insert(estimatorOptionValues).values(values).returning();
    return row as OptionValueRow;
  });
}

/**
 * Make an existing value its option's single default (clearing the others in
 * one transaction). Scoped through option → product to the tenant; false when
 * the value is not the tenant's or is inactive.
 */
export async function setDefaultOptionValue(db: EstimatorDb, tenantId: string, valueId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: estimatorOptionValues.id, optionId: estimatorOptionValues.optionId })
      .from(estimatorOptionValues)
      .innerJoin(estimatorOptions, eq(estimatorOptions.id, estimatorOptionValues.optionId))
      .innerJoin(estimatorProducts, eq(estimatorProducts.id, estimatorOptions.productId))
      .where(
        and(
          eq(estimatorOptionValues.id, valueId),
          eq(estimatorOptionValues.isActive, true),
          eq(estimatorProducts.tenantId, tenantId),
        ),
      )
      .limit(1);
    if (!target) return false;
    const { optionId } = target as { id: string; optionId: string };
    await lockOption(tx, tenantId, optionId);
    await tx
      .update(estimatorOptionValues)
      .set({ isDefault: false })
      .where(
        and(
          eq(estimatorOptionValues.optionId, optionId),
          ne(estimatorOptionValues.id, valueId),
          eq(estimatorOptionValues.isDefault, true),
        ),
      );
    await tx.update(estimatorOptionValues).set({ isDefault: true }).where(eq(estimatorOptionValues.id, valueId));
    return true;
  });
}

export const updateOptionValueSchema = z
  .object({
    label: z.string().trim().min(1, "Give the choice a name.").max(120),
    priceModifier: centsField.max(100_000_000),
    sortOrder: z.number().int(),
  })
  .partial();

/** Rename a value, change what it adds, or move it; false when it isn't this tenant's. */
export async function updateOptionValue(
  db: EstimatorDb,
  tenantId: string,
  valueId: string,
  patch: z.input<typeof updateOptionValueSchema>,
): Promise<boolean> {
  const parsed = updateOptionValueSchema.parse(patch);
  if (!(await productIdForOptionValue(db, tenantId, valueId))) return false;
  if (Object.keys(parsed).length === 0) return true;
  const [row] = await db
    .update(estimatorOptionValues)
    .set(parsed)
    .where(eq(estimatorOptionValues.id, valueId))
    .returning({ id: estimatorOptionValues.id });
  return row !== undefined;
}

/**
 * Remove a value; false when it isn't this tenant's. Removing the default
 * leaves the option with no default (the tool picks the first).
 */
export async function deactivateOptionValue(db: EstimatorDb, tenantId: string, valueId: string): Promise<boolean> {
  if (!(await productIdForOptionValue(db, tenantId, valueId))) return false;
  const [row] = await db
    .update(estimatorOptionValues)
    .set({ isActive: false, isDefault: false })
    .where(eq(estimatorOptionValues.id, valueId))
    .returning({ id: estimatorOptionValues.id });
  return row !== undefined;
}
