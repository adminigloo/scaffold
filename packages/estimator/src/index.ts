import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  calculateEstimatePrice,
  calculateTotals,
  midpointOf,
  type ComponentUnitType,
  type EstimatePriceResult,
  type Measurement,
} from "./pricing.js";
import {
  estimatorComponents,
  estimatorEstimateItems,
  estimatorEstimates,
  estimatorOptionValues,
  estimatorOptions,
  estimatorProductComponents,
  estimatorProducts,
  type EstimateItemMeasurement,
} from "./schema.js";

export * from "./pricing.js";
export {
  estimatorComponents,
  estimatorEstimateItems,
  estimatorEstimates,
  estimatorOptionValues,
  estimatorOptions,
  estimatorProductComponents,
  estimatorProducts,
  type EstimateItemMeasurement,
} from "./schema.js";

/**
 * All correctness lives here so a consumer's tRPC/route layer stays a thin gate.
 * A permissive DB type keeps the package free of a Drizzle schema-generic
 * mismatch across versions — the same pattern the other @adminigloo packages use.
 */
export type EstimatorDb = PgDatabase<any, any, any>;

const UNIT_TYPES = ["per_sqft", "per_linear_ft", "per_unit", "flat"] as const;
const centsField = z.number().int().min(0);
const bpField = z.number().int().min(0).max(1_000_000);

const measurementSchema = z.object({
  widthIn: z.number().min(0).optional(),
  heightIn: z.number().min(0).optional(),
  sqFt: z.number().min(0).optional(),
  linearFt: z.number().min(0).optional(),
  units: z.number().min(0).optional(),
});

// --- Catalog: products -----------------------------------------------------

export const createProductSchema = z.object({
  tenantId: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  category: z.string().max(120).nullish(),
  description: z.string().max(2000).nullish(),
  measurementMode: z.enum(["area", "linear", "unit"]).default("area"),
  basePrice: centsField.default(0),
  pricePerSqFt: centsField.nullish(),
  pricePerLinearFt: centsField.nullish(),
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

export type ProductRow = typeof estimatorProducts.$inferSelect;
export type ComponentRow = typeof estimatorComponents.$inferSelect;
export type OptionRow = typeof estimatorOptions.$inferSelect;
export type OptionValueRow = typeof estimatorOptionValues.$inferSelect;
export type EstimateRow = typeof estimatorEstimates.$inferSelect;
export type EstimateItemRow = typeof estimatorEstimateItems.$inferSelect;

export async function createProduct(
  db: EstimatorDb,
  input: CreateProductInput,
): Promise<ProductRow> {
  const values = createProductSchema.parse(input);
  const [row] = await db.insert(estimatorProducts).values(values).returning();
  return row as ProductRow;
}

export async function updateProduct(
  db: EstimatorDb,
  id: string,
  patch: Partial<CreateProductInput>,
): Promise<ProductRow | null> {
  const [row] = await db
    .update(estimatorProducts)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(estimatorProducts.id, id))
    .returning();
  return (row as ProductRow) ?? null;
}

export async function deactivateProduct(db: EstimatorDb, id: string): Promise<boolean> {
  const [row] = await db
    .update(estimatorProducts)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(estimatorProducts.id, id))
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

/** A product with its active bill-of-materials and options, for the builder UI. */
export async function getProductDetail(
  db: EstimatorDb,
  productId: string,
): Promise<ProductDetail | null> {
  const [product] = await db
    .select()
    .from(estimatorProducts)
    .where(eq(estimatorProducts.id, productId))
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

export async function createOptionValue(
  db: EstimatorDb,
  input: CreateOptionValueInput,
): Promise<OptionValueRow> {
  const values = createOptionValueSchema.parse(input);
  const [row] = await db.insert(estimatorOptionValues).values(values).returning();
  return row as OptionValueRow;
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
 * Price a product against a measurement and chosen options — the query behind
 * the live "$X – $Y" the instant-estimate tool shows on every keystroke. Loads
 * the product's config, its active bill of materials, and the selected option
 * modifiers, then runs the pure engine. Returns null for an unknown or
 * non-estimatable product (the UI shows "request a quote" instead).
 */
export async function calculateEstimate(
  db: EstimatorDb,
  input: CalculateEstimateInput,
): Promise<EstimatePriceResult | null> {
  const parsed = calculateEstimateSchema.parse(input);
  const [product] = await db
    .select()
    .from(estimatorProducts)
    .where(eq(estimatorProducts.id, parsed.productId))
    .limit(1);
  if (!product || !(product as ProductRow).isActive || !(product as ProductRow).isEstimatable) {
    return null;
  }
  const p = product as ProductRow;

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
        eq(estimatorProductComponents.productId, p.id),
        eq(estimatorProductComponents.isActive, true),
        eq(estimatorComponents.isActive, true),
      ),
    );

  let optionModifiers: number[] = [];
  if (parsed.optionValueIds.length > 0) {
    const values = await db
      .select({ priceModifier: estimatorOptionValues.priceModifier })
      .from(estimatorOptionValues)
      .where(
        and(
          inArray(estimatorOptionValues.id, parsed.optionValueIds),
          eq(estimatorOptionValues.isActive, true),
        ),
      );
    optionModifiers = (values as { priceModifier: number }[]).map((v) => v.priceModifier);
  }

  return calculateEstimatePrice({
    basePrice: p.basePrice,
    pricePerSqFt: p.pricePerSqFt,
    pricePerLinearFt: p.pricePerLinearFt,
    laborCost: p.laborCost,
    measurement: parsed.measurement as Measurement,
    quantity: parsed.quantity,
    optionModifiers,
    components: (components as Array<{ unitCost: number; unitType: string; quantityMilli: number }>).map(
      (c) => ({
        unitCost: c.unitCost,
        unitType: c.unitType as ComponentUnitType,
        quantityMilli: c.quantityMilli,
        isActive: true,
      }),
    ),
    wasteBp: p.wasteBp,
    markupBp: p.markupBp,
    minimumCharge: p.minimumCharge,
    estimateLowBp: p.estimateLowBp,
    estimateHighBp: p.estimateHighBp,
  });
}

// --- Estimates -------------------------------------------------------------

/** `EST-2026-0001`, sequential per tenant per year (best-effort). */
export async function nextEstimateNumber(db: EstimatorDb, tenantId: string): Promise<string> {
  const year = new Date().getUTCFullYear();
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(estimatorEstimates)
    .where(
      and(
        eq(estimatorEstimates.tenantId, tenantId),
        sql`extract(year from ${estimatorEstimates.createdAt}) = ${year}`,
      ),
    );
  const next = ((row as { n: number } | undefined)?.n ?? 0) + 1;
  return `EST-${year}-${String(next).padStart(4, "0")}`;
}

export const createEstimateItemSchema = z.object({
  productId: z.string().nullish(),
  description: z.string().min(1).max(500),
  measurement: measurementSchema.nullish(),
  quantity: z.number().int().min(1).max(1000).default(1),
  /** Cents; if omitted and productId is set, computed as the range midpoint. */
  unitPrice: centsField.nullish(),
  laborPrice: centsField.default(0),
  optionValueIds: z.array(z.string()).max(50).default([]),
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
  taxRateBp: bpField.default(825),
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

/**
 * Persist an estimate and its lines, pricing any line that came in without a
 * unit price (a public submit) as the midpoint of that product's range, then
 * rolling the lines into subtotal/tax/total. The server owns the arithmetic —
 * a client never sends a total it made up.
 */
export async function createEstimate(
  db: EstimatorDb,
  input: CreateEstimateInput,
  createdBy?: string,
): Promise<CreatedEstimate> {
  const parsed = createEstimateSchema.parse(input);

  const priced = [] as Array<{
    productId: string | null;
    description: string;
    measurement: EstimateItemMeasurement | null;
    quantity: number;
    unitPrice: number;
    laborPrice: number;
    selectedOptions: Record<string, string> | null;
    notes: string | null;
    total: number;
  }>;

  for (const item of parsed.items) {
    let unitPrice = item.unitPrice ?? null;
    if (unitPrice === null && item.productId) {
      const result = await calculateEstimate(db, {
        productId: item.productId,
        measurement: item.measurement ?? {},
        quantity: item.quantity,
        optionValueIds: item.optionValueIds,
      });
      unitPrice = result ? midpointOf(result.estimateLow, result.estimateHigh) : 0;
    }
    const finalUnit = unitPrice ?? 0;
    const laborPrice = item.laborPrice ?? 0;
    const total = (finalUnit + laborPrice) * item.quantity;
    priced.push({
      productId: item.productId ?? null,
      description: item.description,
      measurement: (item.measurement ?? null) as EstimateItemMeasurement | null,
      quantity: item.quantity,
      unitPrice: finalUnit,
      laborPrice,
      selectedOptions: (item.selectedOptions ?? null) as Record<string, string> | null,
      notes: item.notes ?? null,
      total,
    });
  }

  const totals = calculateTotals({
    itemTotals: priced.map((p) => p.total),
    taxRateBp: parsed.taxRateBp,
    discount: parsed.discount,
  });

  const estimateNumber = await nextEstimateNumber(db, parsed.tenantId);

  const email = parsed.customerEmail === "" ? null : parsed.customerEmail ?? null;

  const [estimate] = await db
    .insert(estimatorEstimates)
    .values({
      tenantId: parsed.tenantId,
      estimateNumber,
      status: "draft",
      customerName: parsed.customerName ?? null,
      customerEmail: email,
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
    })
    .returning();

  const estimateId = (estimate as EstimateRow).id;

  await db.insert(estimatorEstimateItems).values(
    priced.map((p, index) => ({
      estimateId,
      productId: p.productId,
      description: p.description,
      measurement: p.measurement,
      quantity: p.quantity,
      unitPrice: p.unitPrice,
      laborPrice: p.laborPrice,
      total: p.total,
      selectedOptions: p.selectedOptions,
      sortOrder: index,
      notes: p.notes,
    })),
  );

  return {
    id: estimateId,
    estimateNumber,
    subtotal: totals.subtotal,
    taxAmount: totals.taxAmount,
    total: totals.total,
  };
}

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

export async function getEstimate(
  db: EstimatorDb,
  id: string,
): Promise<EstimateDetail | null> {
  const [estimate] = await db
    .select()
    .from(estimatorEstimates)
    .where(eq(estimatorEstimates.id, id))
    .limit(1);
  if (!estimate) return null;
  const items = await db
    .select()
    .from(estimatorEstimateItems)
    .where(eq(estimatorEstimateItems.estimateId, id))
    .orderBy(asc(estimatorEstimateItems.sortOrder));
  return { estimate: estimate as EstimateRow, items: items as EstimateItemRow[] };
}

const ESTIMATE_STATUSES = [
  "draft",
  "sent",
  "viewed",
  "approved",
  "rejected",
  "expired",
  "converted",
] as const;

export const setEstimateStatusSchema = z.object({
  id: z.string().min(1),
  status: z.enum(ESTIMATE_STATUSES),
});

export async function setEstimateStatus(
  db: EstimatorDb,
  input: z.infer<typeof setEstimateStatusSchema>,
): Promise<boolean> {
  const parsed = setEstimateStatusSchema.parse(input);
  const [row] = await db
    .update(estimatorEstimates)
    .set({ status: parsed.status, updatedAt: new Date() })
    .where(eq(estimatorEstimates.id, parsed.id))
    .returning({ id: estimatorEstimates.id });
  return row !== undefined;
}
