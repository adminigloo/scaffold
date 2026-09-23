import { and, asc, desc, eq, inArray, isNull, like, ne, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  calculateEstimatePrice,
  calculateItemTotal,
  calculateTotals,
  DEFAULT_TAX_RATE_BP,
  measurementFitsMode,
  midpointOf,
  type ComponentUnitType,
  type EstimatePriceResult,
  type Measurement,
} from "./pricing.js";
import {
  estimatorClientKeys,
  estimatorComponents,
  estimatorEstimateItems,
  estimatorEstimates,
  estimatorOptionValues,
  estimatorOptions,
  estimatorProductComponents,
  estimatorProducts,
  type EstimateItemMeasurement,
  type EstimateItemOptionSnapshot,
} from "./schema.js";

export * from "./pricing.js";
export * from "./takeoff.js";
export * from "./platform.js";
export {
  estimatorClientKeys,
  estimatorComponents,
  estimatorEstimateItems,
  estimatorEstimates,
  estimatorOptionValues,
  estimatorOptions,
  estimatorProductComponents,
  estimatorProducts,
  type EstimateItemMeasurement,
  type EstimateItemOptionSnapshot,
} from "./schema.js";

/**
 * All correctness lives here so a consumer's tRPC/route layer stays a thin gate.
 * A permissive DB type keeps the package free of a Drizzle schema-generic
 * mismatch across versions — the same pattern the other @adminigloo packages use.
 *
 * TENANT SCOPING (0.2.0). Every read or write that names a row by id also takes
 * the tenant and filters by it — `getEstimate`, `getProductDetail`,
 * `updateProduct`, `deactivateProduct`, `setEstimateStatus`. Before, a caller
 * holding any id could read or change another workspace's row, and the only
 * guard was each consumer remembering to compare `tenantId` afterwards.
 */
export type EstimatorDb = PgDatabase<any, any, any>;

/**
 * An input the estimator refuses — a product that is not this tenant's live
 * product, a measurement the product cannot be priced from, a discount bigger
 * than the work. A caller maps it to a 400; it is never a server fault.
 */
export type EstimatorRefusal =
  | "product_unavailable"
  | "product_not_estimatable"
  | "invalid_measurement"
  | "invalid_options"
  | "invalid_price_range"
  | "discount_exceeds_subtotal";

export class EstimatorInputError extends Error {
  readonly name = "EstimatorInputError";
  constructor(
    readonly code: EstimatorRefusal,
    message: string,
  ) {
    super(message);
  }
}

const UNIT_TYPES = ["per_sqft", "per_linear_ft", "per_unit", "flat"] as const;
const MEASUREMENT_MODES = ["area", "linear", "unit"] as const;
const centsField = z.number().int().min(0);
const bpField = z.number().int().min(0).max(1_000_000);

/**
 * The largest measurement any line accepts. Generous for every trade here (a
 * 1,000 ft wall, a ~23 acre lot, ~19 miles of fence) and small enough that a
 * typo or a hostile number can't price a line past the safe-integer range of
 * the bigint-as-number money columns.
 */
export const MEASUREMENT_LIMITS = {
  widthIn: 12_000,
  heightIn: 12_000,
  sqFt: 1_000_000,
  linearFt: 100_000,
  units: 100_000,
} as const;

const measurementSchema = z.object({
  widthIn: z.number().min(0).max(MEASUREMENT_LIMITS.widthIn).optional(),
  heightIn: z.number().min(0).max(MEASUREMENT_LIMITS.heightIn).optional(),
  sqFt: z.number().min(0).max(MEASUREMENT_LIMITS.sqFt).optional(),
  linearFt: z.number().min(0).max(MEASUREMENT_LIMITS.linearFt).optional(),
  units: z.number().min(0).max(MEASUREMENT_LIMITS.units).optional(),
});

// --- Catalog: products -----------------------------------------------------

/**
 * A product's editable fields with NO defaults. The create schema layers its
 * defaults over this; the update schema is this, all-optional. Deriving the
 * update schema from the create one (`.omit().partial()`) is the trap: under
 * zod 4 a `.default()` survives `.partial()`, so a patch of `{ name }` would
 * have reset basePrice, waste, markup and the range to their defaults.
 */
const productShape = {
  name: z.string().min(1).max(200),
  category: z.string().max(120).nullish(),
  description: z.string().max(2000).nullish(),
  measurementMode: z.enum(MEASUREMENT_MODES),
  basePrice: centsField,
  pricePerSqFt: centsField.nullish(),
  pricePerLinearFt: centsField.nullish(),
  laborCost: centsField,
  wasteBp: bpField,
  markupBp: bpField,
  minimumCharge: centsField,
  estimateLowBp: bpField,
  estimateHighBp: bpField,
  showInEstimator: z.boolean(),
  isEstimatable: z.boolean(),
  sortOrder: z.number().int(),
};

export const createProductSchema = z.object({
  tenantId: z.string().min(1).max(200),
  ...productShape,
  measurementMode: z.enum(MEASUREMENT_MODES).default("area"),
  basePrice: centsField.default(0),
  laborCost: centsField.default(0),
  wasteBp: bpField.default(0),
  markupBp: bpField.default(0),
  minimumCharge: centsField.default(0),
  estimateLowBp: bpField.default(9000),
  estimateHighBp: bpField.default(11500),
  showInEstimator: z.boolean().default(true),
  isEstimatable: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});
export type CreateProductInput = z.input<typeof createProductSchema>;

/**
 * A partial product edit. No `tenantId` (a patch cannot move a product to
 * another workspace — the old `Partial<CreateProductInput>` could) and no
 * defaults (see `productShape`). Unknown keys are dropped.
 */
export const updateProductSchema = z
  .object(productShape)
  .partial()
  .refine(
    (p) =>
      p.estimateLowBp === undefined ||
      p.estimateHighBp === undefined ||
      p.estimateLowBp <= p.estimateHighBp,
    { message: "estimateLowBp must not exceed estimateHighBp", path: ["estimateLowBp"] },
  );
export type UpdateProductInput = z.input<typeof updateProductSchema>;

export type ProductRow = typeof estimatorProducts.$inferSelect;
export type ComponentRow = typeof estimatorComponents.$inferSelect;
export type OptionRow = typeof estimatorOptions.$inferSelect;
export type OptionValueRow = typeof estimatorOptionValues.$inferSelect;
export type EstimateRow = typeof estimatorEstimates.$inferSelect;
export type EstimateItemRow = typeof estimatorEstimateItems.$inferSelect;

/**
 * An inverted range (low 12000 bp, high 9000 bp) quotes "$1,200 – $900": the
 * customer sees nonsense and the saved midpoint is still computed from it.
 */
function assertRangeOrdered(lowBp: number, highBp: number): void {
  if (lowBp > highBp) {
    throw new EstimatorInputError(
      "invalid_price_range",
      `estimateLowBp (${lowBp}) must not exceed estimateHighBp (${highBp})`,
    );
  }
}

export async function createProduct(
  db: EstimatorDb,
  input: CreateProductInput,
): Promise<ProductRow> {
  const values = createProductSchema.parse(input);
  assertRangeOrdered(values.estimateLowBp, values.estimateHighBp);
  const [row] = await db.insert(estimatorProducts).values(values).returning();
  return row as ProductRow;
}

/**
 * Edit one of this tenant's products. Returns null when the id is not the
 * tenant's (or does not exist) — the same answer, so an id cannot be probed.
 */
export async function updateProduct(
  db: EstimatorDb,
  tenantId: string,
  id: string,
  patch: UpdateProductInput,
): Promise<ProductRow | null> {
  const parsed = updateProductSchema.parse(patch);
  const scoped = and(eq(estimatorProducts.id, id), eq(estimatorProducts.tenantId, tenantId));

  // Only one end of the range moved: check it against the stored other end,
  // or a patch of just `{ estimateLowBp: 12000 }` inverts a 9000–11500 range
  // that the schema-level check (both ends present) never sees.
  if ((parsed.estimateLowBp === undefined) !== (parsed.estimateHighBp === undefined)) {
    const [current] = await db
      .select({
        estimateLowBp: estimatorProducts.estimateLowBp,
        estimateHighBp: estimatorProducts.estimateHighBp,
      })
      .from(estimatorProducts)
      .where(scoped)
      .limit(1);
    if (!current) return null;
    const stored = current as { estimateLowBp: number; estimateHighBp: number };
    assertRangeOrdered(
      parsed.estimateLowBp ?? stored.estimateLowBp,
      parsed.estimateHighBp ?? stored.estimateHighBp,
    );
  }

  const [row] = await db
    .update(estimatorProducts)
    .set({ ...parsed, updatedAt: new Date() })
    .where(scoped)
    .returning();
  return (row as ProductRow) ?? null;
}

/** Soft-deactivate one of this tenant's products; false if it is not theirs. */
export async function deactivateProduct(
  db: EstimatorDb,
  tenantId: string,
  id: string,
): Promise<boolean> {
  const [row] = await db
    .update(estimatorProducts)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(estimatorProducts.id, id), eq(estimatorProducts.tenantId, tenantId)))
    .returning({ id: estimatorProducts.id });
  return row !== undefined;
}

export async function listProducts(
  db: EstimatorDb,
  tenantId: string,
  options: { publicOnly?: boolean } = {},
): Promise<ProductRow[]> {
  const where = options.publicOnly
    ? and(
        eq(estimatorProducts.tenantId, tenantId),
        eq(estimatorProducts.isActive, true),
        eq(estimatorProducts.showInEstimator, true),
      )
    : and(eq(estimatorProducts.tenantId, tenantId), eq(estimatorProducts.isActive, true));
  return (await db
    .select()
    .from(estimatorProducts)
    .where(where)
    .orderBy(asc(estimatorProducts.sortOrder), asc(estimatorProducts.name))) as ProductRow[];
}

export interface ProductOptionView {
  option: OptionRow;
  values: OptionValueRow[];
}

export interface ProductDetail {
  product: ProductRow;
  components: Array<{ assignmentId: string; quantityMilli: number; component: ComponentRow }>;
  options: ProductOptionView[];
}

/**
 * One of this tenant's products with its active bill-of-materials and ALL its
 * active options (staff-only ones included), for the builder UI. Null when the
 * product is not the tenant's. Public surfaces use `listPublicOptions`.
 */
export async function getProductDetail(
  db: EstimatorDb,
  tenantId: string,
  productId: string,
): Promise<ProductDetail | null> {
  const [product] = await db
    .select()
    .from(estimatorProducts)
    .where(and(eq(estimatorProducts.id, productId), eq(estimatorProducts.tenantId, tenantId)))
    .limit(1);
  if (!product) return null;

  const componentRows = await db
    .select({
      assignmentId: estimatorProductComponents.id,
      quantityMilli: estimatorProductComponents.quantityMilli,
      component: estimatorComponents,
    })
    .from(estimatorProductComponents)
    .innerJoin(
      estimatorComponents,
      eq(estimatorComponents.id, estimatorProductComponents.componentId),
    )
    .where(
      and(
        eq(estimatorProductComponents.productId, productId),
        eq(estimatorProductComponents.isActive, true),
        eq(estimatorComponents.isActive, true),
        eq(estimatorComponents.tenantId, tenantId),
      ),
    );

  const optionRows = await db
    .select()
    .from(estimatorOptions)
    .where(and(eq(estimatorOptions.productId, productId), eq(estimatorOptions.isActive, true)))
    .orderBy(asc(estimatorOptions.sortOrder));

  const optionIds = optionRows.map((o) => o.id);
  const valueRows =
    optionIds.length === 0
      ? []
      : await db
          .select()
          .from(estimatorOptionValues)
          .where(
            and(
              inArray(estimatorOptionValues.optionId, optionIds),
              eq(estimatorOptionValues.isActive, true),
            ),
          )
          .orderBy(asc(estimatorOptionValues.sortOrder));

  return {
    product: product as ProductRow,
    components: componentRows as ProductDetail["components"],
    options: (optionRows as OptionRow[]).map((option) => ({
      option,
      values: (valueRows as OptionValueRow[]).filter((v) => v.optionId === option.id),
    })),
  };
}

/** What a public surface may show about one option value — no cost inputs. */
export interface PublicOptionValue {
  id: string;
  label: string;
  priceModifier: number;
  isDefault: boolean;
}

export interface PublicProductOption {
  id: string;
  name: string;
  values: PublicOptionValue[];
}

/**
 * The customer-facing options of one of this tenant's public products — the
 * one read both the embed (`/v1/options`) and a same-origin tool use, so the
 * "what may the public see" rule lives in one place. Staff-only options
 * (`showInEstimator: false`) and inactive rows are left out; a product that is
 * not the tenant's, inactive, or hidden from the estimator answers [].
 */
export async function listPublicOptions(
  db: EstimatorDb,
  tenantId: string,
  productId: string,
): Promise<PublicProductOption[]> {
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

  const optionRows = (await db
    .select()
    .from(estimatorOptions)
    .where(
      and(
        eq(estimatorOptions.productId, productId),
        eq(estimatorOptions.isActive, true),
        eq(estimatorOptions.showInEstimator, true),
      ),
    )
    .orderBy(asc(estimatorOptions.sortOrder))) as OptionRow[];
  if (optionRows.length === 0) return [];

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

  return optionRows.map((o) => ({
    id: o.id,
    name: o.name,
    values: valueRows
      .filter((v) => v.optionId === o.id)
      .map((v) => ({
        id: v.id,
        label: v.label,
        priceModifier: v.priceModifier,
        isDefault: v.isDefault,
      })),
  }));
}

// --- Catalog: components & options -----------------------------------------

export const createComponentSchema = z.object({
  tenantId: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  unitType: z.enum(UNIT_TYPES).default("flat"),
  unitCost: centsField.default(0),
});
export type CreateComponentInput = z.input<typeof createComponentSchema>;

export async function createComponent(
  db: EstimatorDb,
  input: CreateComponentInput,
): Promise<ComponentRow> {
  const values = createComponentSchema.parse(input);
  const [row] = await db.insert(estimatorComponents).values(values).returning();
  return row as ComponentRow;
}

export async function listComponents(db: EstimatorDb, tenantId: string): Promise<ComponentRow[]> {
  return (await db
    .select()
    .from(estimatorComponents)
    .where(and(eq(estimatorComponents.tenantId, tenantId), eq(estimatorComponents.isActive, true)))
    .orderBy(asc(estimatorComponents.name))) as ComponentRow[];
}

export async function deactivateComponent(db: EstimatorDb, id: string): Promise<boolean> {
  const [row] = await db
    .update(estimatorComponents)
    .set({ isActive: false })
    .where(eq(estimatorComponents.id, id))
    .returning({ id: estimatorComponents.id });
  return row !== undefined;
}

export const attachComponentSchema = z.object({
  productId: z.string().min(1),
  componentId: z.string().min(1),
  quantityMilli: z.number().int().min(1).default(1000),
});
export type AttachComponentInput = z.input<typeof attachComponentSchema>;

export async function attachComponent(
  db: EstimatorDb,
  input: AttachComponentInput,
): Promise<string> {
  const values = attachComponentSchema.parse(input);
  const [row] = await db
    .insert(estimatorProductComponents)
    .values(values)
    .returning({ id: estimatorProductComponents.id });
  return (row as { id: string }).id;
}

export async function detachComponent(db: EstimatorDb, assignmentId: string): Promise<boolean> {
  const [row] = await db
    .update(estimatorProductComponents)
    .set({ isActive: false })
    .where(eq(estimatorProductComponents.id, assignmentId))
    .returning({ id: estimatorProductComponents.id });
  return row !== undefined;
}

export const createOptionSchema = z.object({
  productId: z.string().min(1),
  name: z.string().min(1).max(120),
  optionType: z.string().max(60).default("custom"),
  /** false = staff-only: never shown in, nor priced by, the public tool. */
  showInEstimator: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});
export type CreateOptionInput = z.input<typeof createOptionSchema>;

export async function createOption(db: EstimatorDb, input: CreateOptionInput): Promise<OptionRow> {
  const values = createOptionSchema.parse(input);
  const [row] = await db.insert(estimatorOptions).values(values).returning();
  return row as OptionRow;
}

export const createOptionValueSchema = z.object({
  optionId: z.string().min(1),
  label: z.string().min(1).max(120),
  priceModifier: centsField.default(0),
  isDefault: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
});
export type CreateOptionValueInput = z.input<typeof createOptionValueSchema>;

/**
 * Serialize default-setters on one option: the option row is locked for the
 * transaction, so two concurrent "make this the default" calls queue instead
 * of each clearing the others and both landing as the default.
 */
async function lockOption(tx: EstimatorDb, optionId: string): Promise<void> {
  await tx
    .select({ id: estimatorOptions.id })
    .from(estimatorOptions)
    .where(eq(estimatorOptions.id, optionId))
    .for("update");
}

/**
 * Add a value to an option. A value created as the default takes the default
 * over — the option's other defaults are cleared in the same transaction —
 * because the tool pre-selects "the" default, and with two it picked whichever
 * sorted first, which is not what the operator just said.
 */
export async function createOptionValue(
  db: EstimatorDb,
  input: CreateOptionValueInput,
): Promise<OptionValueRow> {
  const values = createOptionValueSchema.parse(input);
  if (!values.isDefault) {
    const [row] = await db.insert(estimatorOptionValues).values(values).returning();
    return row as OptionValueRow;
  }
  return db.transaction(async (tx) => {
    await lockOption(tx, values.optionId);
    await tx
      .update(estimatorOptionValues)
      .set({ isDefault: false })
      .where(
        and(
          eq(estimatorOptionValues.optionId, values.optionId),
          eq(estimatorOptionValues.isDefault, true),
        ),
      );
    const [row] = await tx.insert(estimatorOptionValues).values(values).returning();
    return row as OptionValueRow;
  });
}

/**
 * Make an existing value its option's single default (clearing the others in
 * one transaction). Scoped through option → product to the tenant; false when
 * the value is not the tenant's or is inactive.
 */
export async function setDefaultOptionValue(
  db: EstimatorDb,
  tenantId: string,
  valueId: string,
): Promise<boolean> {
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
    await lockOption(tx, optionId);
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
    await tx
      .update(estimatorOptionValues)
      .set({ isDefault: true })
      .where(eq(estimatorOptionValues.id, valueId));
    return true;
  });
}

// --- Pricing at read time --------------------------------------------------

export const calculateEstimateSchema = z.object({
  productId: z.string().min(1),
  measurement: measurementSchema,
  quantity: z.number().int().min(1).max(1000).default(1),
  optionValueIds: z.array(z.string()).max(50).default([]),
});
export type CalculateEstimateInput = z.input<typeof calculateEstimateSchema>;

/**
 * Who a price is for. "public" — the instant-estimate tool and the embed: the
 * product must be shown in the estimator, and staff-only options are ignored
 * (a value the customer was never shown adds nothing). "staff" (the default) —
 * the builder and staff-created estimates: any active product and option.
 */
export type PricingAudience = "public" | "staff";

export interface EstimatorPricingScope {
  /**
   * Price only this tenant's products. Every caller in this package passes it;
   * omit it only in a single-tenant host that has already checked ownership.
   */
  tenantId?: string;
  audience?: PricingAudience;
}

type LineRefusal = Exclude<EstimatorRefusal, "invalid_price_range" | "discount_exceeds_subtotal">;

type PricedLine =
  | {
      ok: true;
      product: ProductRow;
      result: EstimatePriceResult;
      selections: EstimateItemOptionSnapshot[];
    }
  | { ok: false; reason: LineRefusal; product: ProductRow | null };

/**
 * The product a line may be priced against, or null. Not found, inactive,
 * another tenant's, and (for the public) hidden from the estimator all answer
 * the same null, so a public caller cannot probe which ids exist.
 */
async function loadPriceableProduct(
  db: EstimatorDb,
  productId: string,
  scope: EstimatorPricingScope,
): Promise<ProductRow | null> {
  const conditions = [eq(estimatorProducts.id, productId), eq(estimatorProducts.isActive, true)];
  if (scope.tenantId !== undefined) conditions.push(eq(estimatorProducts.tenantId, scope.tenantId));
  if (scope.audience === "public") conditions.push(eq(estimatorProducts.showInEstimator, true));
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
 * option are refused (null) — the saved optionId→valueId map could only hold
 * one of the two modifiers that were priced.
 */
async function resolveOptionSelections(
  db: EstimatorDb,
  product: ProductRow,
  optionValueIds: readonly string[],
  audience: PricingAudience,
): Promise<EstimateItemOptionSnapshot[] | null> {
  const ids = [...new Set(optionValueIds)];
  if (ids.length === 0) return [];
  const conditions = [
    inArray(estimatorOptionValues.id, ids),
    eq(estimatorOptionValues.isActive, true),
    eq(estimatorOptions.productId, product.id),
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

/**
 * The one place a line is priced — the live range, a staff line and a public
 * submit all come through here, so the number saved is the number shown.
 */
async function priceLine(
  db: EstimatorDb,
  input: z.output<typeof calculateEstimateSchema>,
  scope: EstimatorPricingScope,
): Promise<PricedLine> {
  const audience = scope.audience ?? "staff";
  const product = await loadPriceableProduct(db, input.productId, scope);
  if (!product) return { ok: false, reason: "product_unavailable", product: null };
  if (!product.isEstimatable) return { ok: false, reason: "product_not_estimatable", product };
  if (!measurementFitsMode(product.measurementMode, input.measurement as Measurement)) {
    return { ok: false, reason: "invalid_measurement", product };
  }

  const selections = await resolveOptionSelections(db, product, input.optionValueIds, audience);
  if (selections === null) return { ok: false, reason: "invalid_options", product };

  const components = await db
    .select({
      unitCost: estimatorComponents.unitCost,
      unitType: estimatorComponents.unitType,
      quantityMilli: estimatorProductComponents.quantityMilli,
    })
    .from(estimatorProductComponents)
    .innerJoin(
      estimatorComponents,
      eq(estimatorComponents.id, estimatorProductComponents.componentId),
    )
    .where(
      and(
        eq(estimatorProductComponents.productId, product.id),
        eq(estimatorProductComponents.isActive, true),
        eq(estimatorComponents.isActive, true),
        // A material is priced only from the product's own workspace, whatever
        // an attach call once linked.
        eq(estimatorComponents.tenantId, product.tenantId),
      ),
    );

  const result = calculateEstimatePrice({
    basePrice: product.basePrice,
    pricePerSqFt: product.pricePerSqFt,
    pricePerLinearFt: product.pricePerLinearFt,
    laborCost: product.laborCost,
    measurement: input.measurement as Measurement,
    quantity: input.quantity,
    optionModifiers: selections.map((s) => s.priceModifier),
    components: (components as Array<{ unitCost: number; unitType: string; quantityMilli: number }>).map(
      (c) => ({
        unitCost: c.unitCost,
        unitType: c.unitType as ComponentUnitType,
        quantityMilli: c.quantityMilli,
        isActive: true,
      }),
    ),
    wasteBp: product.wasteBp,
    markupBp: product.markupBp,
    minimumCharge: product.minimumCharge,
    estimateLowBp: product.estimateLowBp,
    estimateHighBp: product.estimateHighBp,
  });
  // A price book extreme enough to leave the safe-integer range would store a
  // silently rounded total; refuse it as an unpriceable measurement instead.
  if (!Number.isSafeInteger(result.estimateHigh)) {
    return { ok: false, reason: "invalid_measurement", product };
  }
  return { ok: true, product, result, selections };
}

/**
 * Price a product against a measurement and chosen options — the query behind
 * the live "$X – $Y" the instant-estimate tool shows on every keystroke. Loads
 * the product's config, its active bill of materials, and the selected option
 * modifiers, then runs the pure engine.
 *
 * Returns null — the UI shows "request a quote" or "enter a measurement" — for
 * a product that is unknown, inactive, another tenant's (with `scope.tenantId`),
 * hidden from a public caller, or not estimatable; for a measurement the
 * product's mode cannot price (an area product needs width×height or sqFt > 0,
 * a linear one linearFt > 0, a unit one units > 0); and for two values of one
 * option.
 */
export async function calculateEstimate(
  db: EstimatorDb,
  input: CalculateEstimateInput,
  scope: EstimatorPricingScope = {},
): Promise<EstimatePriceResult | null> {
  const parsed = calculateEstimateSchema.parse(input);
  const priced = await priceLine(db, parsed, scope);
  return priced.ok ? priced.result : null;
}

// --- Estimates -------------------------------------------------------------

/**
 * `EST-2026-0001`, sequential per tenant per year.
 *
 * The next number is one past the tenant's highest this year — not the row
 * count, which a missing row (a hand-deleted test estimate) turns into a number
 * that already exists, forever. Two submits in the same instant can still read
 * the same highest; the unique (tenant, number) index makes the loser fail and
 * `createEstimate` retries it, so this stays a plain read.
 */
export async function nextEstimateNumber(db: EstimatorDb, tenantId: string): Promise<string> {
  const year = new Date().getUTCFullYear();
  const [row] = await db
    // ::int — the serverless driver returns bigger integer types as a STRING,
    // so an uncast `n` makes `n + 1` string-concatenate ("5"+1 = "51"),
    // corrupting the sequence (EST-2026-0051 for the 6th estimate). The regex
    // takes at most 9 digits, so the cast can never overflow on a hand-typed
    // number.
    .select({
      n: sql<number>`coalesce(max(substring(${estimatorEstimates.estimateNumber} from '^EST-[0-9]{4}-([0-9]{1,9})$')::int), 0)::int`,
    })
    .from(estimatorEstimates)
    .where(
      and(
        eq(estimatorEstimates.tenantId, tenantId),
        like(estimatorEstimates.estimateNumber, `EST-${year}-%`),
      ),
    );
  const next = Number((row as { n: number | string } | undefined)?.n ?? 0) + 1;
  return `EST-${year}-${String(next).padStart(4, "0")}`;
}

export const createEstimateItemSchema = z.object({
  /** "" is treated as no product (a free-text line). */
  productId: z.string().max(200).nullish(),
  description: z.string().min(1).max(500),
  measurement: measurementSchema.nullish(),
  quantity: z.number().int().min(1).max(1000).default(1),
  /**
   * Staff-set cents for ONE of the line. Omitted with a productId, the server
   * prices the line at its real quantity (the saved total is the midpoint of
   * the range the engine quotes for that quantity).
   */
  unitPrice: centsField.nullish(),
  laborPrice: centsField.default(0),
  optionValueIds: z.array(z.string().min(1).max(200)).max(50).default([]),
  /**
   * @deprecated Ignored since 0.2.0. The saved optionId→valueId map is resolved
   * from `optionValueIds` against the product's own options; a caller's map
   * named whatever it liked, priced or not.
   */
  selectedOptions: z.record(z.string(), z.string()).nullish(),
  notes: z.string().max(1000).nullish(),
});

export const createEstimateSchema = z.object({
  tenantId: z.string().min(1).max(200),
  customerName: z.string().max(200).nullish(),
  customerEmail: z.string().email().max(320).nullish().or(z.literal("")),
  customerPhone: z.string().max(60).nullish(),
  jobAddress: z.string().max(500).nullish(),
  notes: z.string().max(2000).nullish(),
  source: z.enum(["public_tool", "photo", "staff"]).default("staff"),
  photoUrl: z.string().max(2000).nullish(),
  taxRateBp: bpField.default(DEFAULT_TAX_RATE_BP),
  discount: centsField.default(0),
  items: z.array(createEstimateItemSchema).min(1).max(100),
});
export type CreateEstimateInput = z.input<typeof createEstimateSchema>;

export interface CreatedEstimate {
  id: string;
  estimateNumber: string;
  subtotal: number;
  taxAmount: number;
  total: number;
}

/** Written on a public line for a quote-only product: priced by a person, not at $0. */
export const QUOTE_REQUEST_NOTE =
  "Quote requested — this product is priced by a person, not the instant estimate.";

/** A line ready to insert, priced. `total` is authoritative. */
interface PricedItem {
  productId: string | null;
  description: string;
  measurement: EstimateItemMeasurement | null;
  quantity: number;
  unitPrice: number;
  laborPrice: number;
  total: number;
  selectedOptions: Record<string, string> | null;
  optionSnapshot: EstimateItemOptionSnapshot[] | null;
  notes: string | null;
}

function selectionMap(selections: EstimateItemOptionSnapshot[]): Record<string, string> {
  return Object.fromEntries(selections.map((s) => [s.optionId, s.valueId]));
}

function refuseLine(reason: LineRefusal, productId: string): EstimatorInputError {
  const messages: Record<LineRefusal, string> = {
    product_unavailable: `product ${productId} is not available`,
    product_not_estimatable: `product ${productId} is quote-only; give the line a unitPrice`,
    invalid_measurement: `product ${productId} cannot be priced from that measurement`,
    invalid_options: `product ${productId}: choose at most one value per option`,
  };
  return new EstimatorInputError(reason, messages[reason]);
}

/**
 * A server-priced line: the line total IS the midpoint of the range quoted at
 * the line's real quantity. It used to be priced at quantity 1 and multiplied,
 * which is a different number whenever a minimum charge or a per-unit material
 * is involved — the customer saw $180–$230 for three and was saved at $615.
 * `unitPrice` is that total ÷ quantity, rounded, for display only.
 */
function lineFromPrice(
  priced: Extract<PricedLine, { ok: true }>,
  quantity: number,
): { unitPrice: number; lineTotal: number } {
  const lineTotal = midpointOf(priced.result.estimateLow, priced.result.estimateHigh);
  return { unitPrice: Math.round(lineTotal / quantity), lineTotal };
}

async function priceStaffItem(
  db: EstimatorDb,
  tenantId: string,
  item: z.output<typeof createEstimateItemSchema>,
): Promise<PricedItem> {
  const productId = item.productId || null;
  const base = {
    productId,
    description: item.description,
    measurement: (item.measurement ?? null) as EstimateItemMeasurement | null,
    quantity: item.quantity,
    laborPrice: item.laborPrice,
    notes: item.notes ?? null,
  };

  if (!productId) {
    // A free-text staff line: the staff member's own numbers.
    const unitPrice = item.unitPrice ?? 0;
    return {
      ...base,
      unitPrice,
      total: calculateItemTotal(unitPrice, item.laborPrice, item.quantity),
      selectedOptions: null,
      optionSnapshot: null,
    };
  }

  if (item.unitPrice != null) {
    // A staff-set price on a catalog product. The price is theirs, but the
    // product reference must still be this tenant's live product (it used to
    // accept any id at all), and the recorded options are resolved, not typed.
    const product = await loadPriceableProduct(db, productId, { tenantId, audience: "staff" });
    if (!product) throw refuseLine("product_unavailable", productId);
    const selections = await resolveOptionSelections(db, product, item.optionValueIds, "staff");
    if (selections === null) throw refuseLine("invalid_options", productId);
    return {
      ...base,
      unitPrice: item.unitPrice,
      total: calculateItemTotal(item.unitPrice, item.laborPrice, item.quantity),
      selectedOptions: selectionMap(selections),
      optionSnapshot: selections,
    };
  }

  // Server-priced. An unavailable product, a quote-only one, or a measurement
  // it cannot price is REFUSED — it used to be saved as a $0 line.
  const priced = await priceLine(
    db,
    {
      productId,
      measurement: item.measurement ?? {},
      quantity: item.quantity,
      optionValueIds: item.optionValueIds,
    },
    { tenantId, audience: "staff" },
  );
  if (!priced.ok) throw refuseLine(priced.reason, productId);
  const { unitPrice, lineTotal } = lineFromPrice(priced, item.quantity);
  return {
    ...base,
    unitPrice,
    total: lineTotal + item.laborPrice * item.quantity,
    selectedOptions: selectionMap(priced.selections),
    optionSnapshot: priced.selections,
  };
}

/** Postgres unique_violation, wherever the driver or Drizzle nested it. */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

const ESTIMATE_NUMBER_ATTEMPTS = 5;

/**
 * Number and insert an estimate with its lines, atomically.
 *
 * ONE TRANSACTION, so a failed line insert cannot leave a numbered estimate
 * with no lines (it used to: the header committed first). RETRIED ON 23505,
 * because two concurrent submits can read the same highest number — the unique
 * index rejects the loser, the whole transaction rolls back, and the next
 * attempt reads a fresh number. The retry is around the transaction, not inside
 * it: after a unique violation Postgres aborts the transaction, so nothing more
 * can run in it.
 */
async function insertEstimate(
  db: EstimatorDb,
  header: Omit<typeof estimatorEstimates.$inferInsert, "estimateNumber">,
  items: PricedItem[],
): Promise<{ id: string; estimateNumber: string }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        const estimateNumber = await nextEstimateNumber(tx, header.tenantId);
        const [estimate] = await tx
          .insert(estimatorEstimates)
          .values({ ...header, estimateNumber })
          .returning({ id: estimatorEstimates.id });
        const estimateId = (estimate as { id: string }).id;
        await tx.insert(estimatorEstimateItems).values(
          items.map((item, index) => ({ ...item, estimateId, sortOrder: index })),
        );
        return { id: estimateId, estimateNumber };
      });
    } catch (error) {
      if (isUniqueViolation(error) && attempt < ESTIMATE_NUMBER_ATTEMPTS) continue;
      throw error;
    }
  }
}

/**
 * Persist a STAFF estimate and its lines.
 *
 * This is the trusted path: `unitPrice`, `laborPrice`, `discount`, `taxRateBp`
 * and `photoUrl` are taken as given, because a staff member setting a price is
 * the point. A browser must never reach it — the public tool and the embed use
 * `createPublicEstimate`, which accepts none of those. (This comment used to
 * claim "a client never sends a total it made up" while the public submit
 * passed a client's unitPrice straight through here.)
 *
 * A line with a productId and no unitPrice is priced by the server at its real
 * quantity; an unavailable product, a quote-only one, or an unpriceable
 * measurement is refused (EstimatorInputError), never saved at $0. A discount
 * larger than the subtotal is refused too.
 */
export async function createEstimate(
  db: EstimatorDb,
  input: CreateEstimateInput,
  createdBy?: string,
): Promise<CreatedEstimate> {
  const parsed = createEstimateSchema.parse(input);

  const items: PricedItem[] = [];
  for (const item of parsed.items) items.push(await priceStaffItem(db, parsed.tenantId, item));

  const subtotal = items.reduce((sum, item) => sum + item.total, 0);
  if (parsed.discount > subtotal) {
    throw new EstimatorInputError(
      "discount_exceeds_subtotal",
      `a discount of ${parsed.discount} exceeds the subtotal of ${subtotal}`,
    );
  }
  const totals = calculateTotals({
    itemTotals: items.map((item) => item.total),
    taxRateBp: parsed.taxRateBp,
    discount: parsed.discount,
  });

  const created = await insertEstimate(
    db,
    {
      tenantId: parsed.tenantId,
      status: "draft",
      customerName: parsed.customerName ?? null,
      customerEmail: parsed.customerEmail === "" ? null : parsed.customerEmail ?? null,
      customerPhone: parsed.customerPhone ?? null,
      jobAddress: parsed.jobAddress ?? null,
      subtotal: totals.subtotal,
      taxRateBp: parsed.taxRateBp,
      taxAmount: totals.taxAmount,
      discount: parsed.discount,
      total: totals.total,
      notes: parsed.notes ?? null,
      source: parsed.source,
      photoUrl: parsed.photoUrl ?? null,
      createdBy: createdBy ?? null,
    },
    items,
  );

  return {
    ...created,
    subtotal: totals.subtotal,
    taxAmount: totals.taxAmount,
    total: totals.total,
  };
}

// --- Public submit ---------------------------------------------------------

/**
 * One line of a public submit: WHAT the customer wants, never what it costs.
 * No unitPrice, laborPrice or notes — unknown keys are dropped, never trusted.
 */
export const publicSubmitItemSchema = z.object({
  productId: z.string().min(1).max(200),
  /** Defaults to the product's name. */
  description: z.string().trim().min(1).max(500).nullish(),
  measurement: measurementSchema.nullish(),
  quantity: z.number().int().min(1).max(1000).default(1),
  optionValueIds: z.array(z.string().min(1).max(200)).max(50).default([]),
});

/**
 * A lead from the public instant-estimate tool or the embed. There is no
 * tenantId, discount, taxRateBp or photoUrl here: the tenant and its tax rate
 * come from the server (`createPublicEstimate`'s config), and a discount is a
 * staff decision. A lead needs a name and a way to reach them — an email or a
 * phone — or nobody can follow it up.
 */
export const publicSubmitSchema = z
  .object({
    customerName: z.string().trim().min(1).max(200),
    customerEmail: z.string().trim().max(320).email().nullish().or(z.literal("")),
    customerPhone: z.string().trim().max(60).nullish(),
    jobAddress: z.string().trim().max(500).nullish(),
    notes: z.string().trim().max(2000).nullish(),
    source: z.enum(["public_tool", "photo"]).default("public_tool"),
    items: z.array(publicSubmitItemSchema).min(1).max(20),
  })
  .refine((v) => Boolean(v.customerEmail) || Boolean(v.customerPhone), {
    message: "an email or a phone number is required",
    path: ["customerEmail"],
  });
export type PublicSubmitInput = z.input<typeof publicSubmitSchema>;

const publicEstimateConfigSchema = z.object({
  tenantId: z.string().min(1).max(200),
  /**
   * The tenant's sales-tax rate in bp (825 = 8.25%). Omitted, the documented
   * default `DEFAULT_TAX_RATE_BP` applies — set it for your jurisdiction.
   */
  taxRateBp: z.number().int().min(0).max(10_000).default(DEFAULT_TAX_RATE_BP),
});
/** Server-side facts about the tenant a public submit is for — never from the body. */
export type PublicEstimateConfig = z.input<typeof publicEstimateConfigSchema>;

/**
 * Save a customer's estimate from the public tool or the embed — the lead.
 *
 * The server prices every line: each is priced ONCE at its real quantity, for
 * the public audience (the product must be this tenant's, active and shown in
 * the estimator; staff-only options are ignored), and the saved total is the
 * midpoint of that range — the number the customer was shown. Labor is inside
 * the engine's price, the discount is 0, and the tax rate is the tenant's
 * (`config.taxRateBp`). None of those can be set from the body.
 *
 * A quote-only product (`isEstimatable: false`) is the tool's "request a quote"
 * path, so its line is kept — at $0 with `QUOTE_REQUEST_NOTE`, so the queue
 * says a person must price it. Anything else unpriceable is refused
 * (EstimatorInputError), never saved at $0.
 */
export async function createPublicEstimate(
  db: EstimatorDb,
  input: PublicSubmitInput,
  config: PublicEstimateConfig,
): Promise<CreatedEstimate> {
  const parsed = publicSubmitSchema.parse(input);
  const { tenantId, taxRateBp } = publicEstimateConfigSchema.parse(config);

  const items: PricedItem[] = [];
  for (const item of parsed.items) {
    const measurement = item.measurement ?? {};
    const priced = await priceLine(
      db,
      {
        productId: item.productId,
        measurement,
        quantity: item.quantity,
        optionValueIds: item.optionValueIds,
      },
      { tenantId, audience: "public" },
    );
    const base = {
      productId: item.productId,
      measurement: (item.measurement ?? null) as EstimateItemMeasurement | null,
      quantity: item.quantity,
      laborPrice: 0,
    };
    if (priced.ok) {
      const { unitPrice, lineTotal } = lineFromPrice(priced, item.quantity);
      items.push({
        ...base,
        description: item.description ?? priced.product.name,
        unitPrice,
        total: lineTotal,
        selectedOptions: selectionMap(priced.selections),
        optionSnapshot: priced.selections,
        notes: null,
      });
    } else if (priced.reason === "product_not_estimatable" && priced.product) {
      items.push({
        ...base,
        description: item.description ?? priced.product.name,
        unitPrice: 0,
        total: 0,
        selectedOptions: null,
        optionSnapshot: null,
        notes: QUOTE_REQUEST_NOTE,
      });
    } else {
      throw refuseLine(priced.reason, item.productId);
    }
  }

  const totals = calculateTotals({
    itemTotals: items.map((item) => item.total),
    taxRateBp,
    discount: 0,
  });

  const created = await insertEstimate(
    db,
    {
      tenantId,
      status: "draft",
      customerName: parsed.customerName,
      customerEmail: parsed.customerEmail ? parsed.customerEmail : null,
      customerPhone: parsed.customerPhone ? parsed.customerPhone : null,
      jobAddress: parsed.jobAddress ? parsed.jobAddress : null,
      subtotal: totals.subtotal,
      taxRateBp,
      taxAmount: totals.taxAmount,
      discount: 0,
      total: totals.total,
      notes: parsed.notes ? parsed.notes : null,
      source: parsed.source,
      photoUrl: null,
      createdBy: null,
    },
    items,
  );

  return {
    ...created,
    subtotal: totals.subtotal,
    taxAmount: totals.taxAmount,
    total: totals.total,
  };
}

// --- Reading & moving estimates ---------------------------------------------

export async function listEstimates(
  db: EstimatorDb,
  tenantId: string,
  limit = 100,
): Promise<EstimateRow[]> {
  return (await db
    .select()
    .from(estimatorEstimates)
    .where(eq(estimatorEstimates.tenantId, tenantId))
    .orderBy(desc(estimatorEstimates.createdAt), desc(estimatorEstimates.id))
    .limit(limit)) as EstimateRow[];
}

export interface EstimateDetail {
  estimate: EstimateRow;
  items: EstimateItemRow[];
}

/** One of this tenant's estimates with its lines; null when it is not theirs. */
export async function getEstimate(
  db: EstimatorDb,
  tenantId: string,
  id: string,
): Promise<EstimateDetail | null> {
  const [estimate] = await db
    .select()
    .from(estimatorEstimates)
    .where(and(eq(estimatorEstimates.id, id), eq(estimatorEstimates.tenantId, tenantId)))
    .limit(1);
  if (!estimate) return null;
  const items = await db
    .select()
    .from(estimatorEstimateItems)
    .where(eq(estimatorEstimateItems.estimateId, id))
    .orderBy(asc(estimatorEstimateItems.sortOrder));
  return { estimate: estimate as EstimateRow, items: items as EstimateItemRow[] };
}

export const ESTIMATE_STATUSES = [
  "draft",
  "sent",
  "viewed",
  "approved",
  "rejected",
  "expired",
  "converted",
] as const;
export type EstimateStatus = (typeof ESTIMATE_STATUSES)[number];

/**
 * The only moves an estimate's status can make. draft → sent → viewed →
 * approved | rejected | expired (a sent estimate can be answered unviewed);
 * approved → converted; a rejected or expired quote can be reopened to draft
 * and revised. `converted` is TERMINAL: it means an invoice exists, so an
 * estimate that could leave it could be invoiced twice. Before this table any
 * status could be set from any other — converted back to approved included.
 */
export const ESTIMATE_STATUS_TRANSITIONS: Readonly<
  Record<EstimateStatus, readonly EstimateStatus[]>
> = {
  draft: ["sent"],
  sent: ["viewed", "approved", "rejected", "expired"],
  viewed: ["approved", "rejected", "expired"],
  approved: ["converted"],
  rejected: ["draft"],
  expired: ["draft"],
  converted: [],
};

/** Where an estimate in `from` may move next ([] for an unknown status). */
export function allowedNextStatuses(from: string): readonly EstimateStatus[] {
  return (ESTIMATE_STATUS_TRANSITIONS as Record<string, readonly EstimateStatus[] | undefined>)[
    from
  ] ?? [];
}

export function canTransitionEstimate(from: string, to: string): boolean {
  return allowedNextStatuses(from).includes(to as EstimateStatus);
}

export const setEstimateStatusSchema = z.object({
  id: z.string().min(1),
  status: z.enum(ESTIMATE_STATUSES),
});

/**
 * Move one of this tenant's estimates to a new status along
 * `ESTIMATE_STATUS_TRANSITIONS`. The check is in the UPDATE's WHERE (the
 * current status must be one that may move to the target), so it is atomic —
 * no read-then-write window for two staff clicks to race through. False when
 * the estimate is not the tenant's or the move is not allowed from its current
 * status (a same-status "move" included).
 */
export async function setEstimateStatus(
  db: EstimatorDb,
  tenantId: string,
  input: z.input<typeof setEstimateStatusSchema>,
): Promise<boolean> {
  const parsed = setEstimateStatusSchema.parse(input);
  const from = ESTIMATE_STATUSES.filter((s) =>
    ESTIMATE_STATUS_TRANSITIONS[s].includes(parsed.status),
  );
  if (from.length === 0) return false;
  const [row] = await db
    .update(estimatorEstimates)
    .set({ status: parsed.status, updatedAt: new Date() })
    .where(
      and(
        eq(estimatorEstimates.id, parsed.id),
        eq(estimatorEstimates.tenantId, tenantId),
        inArray(estimatorEstimates.status, from),
      ),
    )
    .returning({ id: estimatorEstimates.id });
  return row !== undefined;
}

/**
 * Claim an estimate for invoicing — the invoicing bridge's once-only step.
 *
 * One conditional UPDATE (`… WHERE status <> 'converted' RETURNING *`), so of
 * two concurrent "create invoice from this estimate" calls exactly one gets the
 * row back and the other gets null. Read-check-then-write let both through and
 * the estimate was invoiced twice. Call it inside the transaction that creates
 * the invoice, and treat null as "already converted (or not this tenant's)":
 * do not invoice.
 */
export async function markEstimateConverted(
  db: EstimatorDb,
  tenantId: string,
  id: string,
): Promise<EstimateRow | null> {
  const [row] = await db
    .update(estimatorEstimates)
    .set({ status: "converted", updatedAt: new Date() })
    .where(
      and(
        eq(estimatorEstimates.id, id),
        eq(estimatorEstimates.tenantId, tenantId),
        ne(estimatorEstimates.status, "converted"),
      ),
    )
    .returning();
  return (row as EstimateRow | undefined) ?? null;
}

// --- Embed keys: the widget licence ---------------------------------------

/** `esk_…` — an estimator embed key. The prefix triages a leaked string at a glance. */
export const ESTIMATOR_KEY_PREFIX = "esk_";
/** The header the widget sends its key in — shared with the other adminigloo widgets. */
export const ESTIMATOR_KEY_HEADER = "x-adminigloo-key";

function randomHexToken(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 20 random bytes as hex behind the prefix; the plaintext exists only in the issuance response. */
export function generateClientKey(): string {
  return randomHexToken(ESTIMATOR_KEY_PREFIX);
}

export async function hashClientKey(key: string): Promise<string> {
  return sha256Hex(key);
}

export interface IssuedClientKey {
  id: string;
  tenantId: string;
  label: string;
  /** The one and only time the plaintext is available. */
  key: string;
}

export async function issueClientKey(
  db: EstimatorDb,
  input: { tenantId: string; label: string },
): Promise<IssuedClientKey> {
  const key = generateClientKey();
  const keyHash = await hashClientKey(key);
  const [row] = await db
    .insert(estimatorClientKeys)
    .values({
      tenantId: input.tenantId,
      label: input.label,
      keyPrefix: key.slice(0, 12),
      keyHash,
    })
    .returning({ id: estimatorClientKeys.id });
  if (!row) throw new Error("key insert returned no row");
  return { id: (row as { id: string }).id, tenantId: input.tenantId, label: input.label, key };
}

export async function revokeClientKey(db: EstimatorDb, keyId: string): Promise<void> {
  await db
    .update(estimatorClientKeys)
    .set({ revokedAt: new Date() })
    .where(eq(estimatorClientKeys.id, keyId));
}

export interface ClientKeyRow {
  id: string;
  label: string;
  keyPrefix: string;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

/** The keys for a tenant — never the hash, never the plaintext. */
export async function listClientKeys(db: EstimatorDb, tenantId: string): Promise<ClientKeyRow[]> {
  return (await db
    .select({
      id: estimatorClientKeys.id,
      label: estimatorClientKeys.label,
      keyPrefix: estimatorClientKeys.keyPrefix,
      revokedAt: estimatorClientKeys.revokedAt,
      lastUsedAt: estimatorClientKeys.lastUsedAt,
      createdAt: estimatorClientKeys.createdAt,
    })
    .from(estimatorClientKeys)
    .where(eq(estimatorClientKeys.tenantId, tenantId))
    .orderBy(desc(estimatorClientKeys.createdAt))) as ClientKeyRow[];
}

export interface VerifiedClientKey {
  keyId: string;
  tenantId: string;
}

/**
 * Resolve a key to its tenant, or null — which the caller turns into a 401,
 * never a guessed tenant. Touches lastUsedAt so a dead key is visible in the
 * admin. The prefix check short-circuits a token meant for another widget.
 */
export async function verifyClientKey(
  db: EstimatorDb,
  key: string,
): Promise<VerifiedClientKey | null> {
  if (!key.startsWith(ESTIMATOR_KEY_PREFIX)) return null;
  const keyHash = await hashClientKey(key);
  const [row] = await db
    .select({ id: estimatorClientKeys.id, tenantId: estimatorClientKeys.tenantId })
    .from(estimatorClientKeys)
    .where(and(eq(estimatorClientKeys.keyHash, keyHash), isNull(estimatorClientKeys.revokedAt)))
    .limit(1);
  if (!row) return null;
  const verified = row as { id: string; tenantId: string };
  await db
    .update(estimatorClientKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(estimatorClientKeys.id, verified.id));
  return { keyId: verified.id, tenantId: verified.tenantId };
}
