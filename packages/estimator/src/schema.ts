import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
} from "drizzle-orm/pg-core";
import { createdAt, idColumn, updatedAt } from "@adminigloo/db";

/**
 * The estimator's data model (0.1.0) — a priceable catalog and the estimates
 * built from it, generalized from the SG Glass & Metal estimator to serve any
 * trade (ramps, glass, fencing, decks).
 *
 * Money is `bigint` minor units (cents) throughout — the house money rule —
 * marshalled to plain numbers (`mode: "number"`) because an estimate is far
 * inside the safe-integer range and the pricing engine works in numbers.
 * Ratios and percentages are integer basis points (bp): 10_000 = 100%.
 *
 * `tenantId` / `createdBy` are plain text with no foreign key — the
 * cross-package rule every schema here follows, so a consumer is never forced
 * to also install @adminigloo/tenancy or /auth. Catalog rows deactivate rather
 * than delete, so an old estimate's line items never dangle.
 */

/** cents, non-null, defaults to 0. */
const money = (name: string) => bigint(name, { mode: "number" }).notNull().default(0);
/** cents, nullable — an unset per-unit rate. */
const moneyNull = (name: string) => bigint(name, { mode: "number" });

/**
 * A priceable thing: a shower door, a section of ramp, a fence panel. Carries
 * every knob the engine reads. `measurementMode` tells the UI (and the photo
 * takeoff) which measurements to ask for.
 */
export const estimatorProducts = pgTable(
  "estimator_products",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    category: text("category"),
    name: text("name").notNull(),
    description: text("description"),
    /** "area" (width×height), "linear" (linear feet), or "unit" (a count). */
    measurementMode: text("measurement_mode").notNull().default("area"),
    basePrice: money("base_price"),
    pricePerSqFt: moneyNull("price_per_sqft"),
    pricePerLinearFt: moneyNull("price_per_linear_ft"),
    laborCost: money("labor_cost"),
    /** Material waste/overage, bp of the material subtotal. */
    wasteBp: integer("waste_bp").notNull().default(0),
    /** Markup on cost, bp. */
    markupBp: integer("markup_bp").notNull().default(0),
    /** Never quote this product below this, cents. */
    minimumCharge: money("minimum_charge"),
    estimateLowBp: integer("estimate_low_bp").notNull().default(9000),
    estimateHighBp: integer("estimate_high_bp").notNull().default(11500),
    /** In the public instant-estimate tool, or staff-only. */
    showInEstimator: boolean("show_in_estimator").notNull().default(true),
    /** false = "request a quote" (no math, book a call). */
    isEstimatable: boolean("is_estimatable").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("estimator_products_tenant_idx").on(t.tenantId, t.isActive)],
);

/** A reusable material with a unit cost: caulk (per_linear_ft), a permit (flat), railing (per_linear_ft). */
export const estimatorComponents = pgTable(
  "estimator_components",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    /** per_sqft | per_linear_ft | per_unit | flat */
    unitType: text("unit_type").notNull().default("flat"),
    unitCost: money("unit_cost"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("estimator_components_tenant_idx").on(t.tenantId, t.isActive)],
);

/** A component attached to a product (the bill of materials), with how many of it. */
export const estimatorProductComponents = pgTable(
  "estimator_product_components",
  {
    id: idColumn(),
    productId: text("product_id").notNull(),
    componentId: text("component_id").notNull(),
    /** Thousandths: 1000 = 1.0 unit of the component. */
    quantityMilli: integer("quantity_milli").notNull().default(1000),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("estimator_product_components_product_idx").on(t.productId)],
);

/** A choice offered on a product: glass type, hardware finish, railing style. */
export const estimatorOptions = pgTable(
  "estimator_options",
  {
    id: idColumn(),
    productId: text("product_id").notNull(),
    name: text("name").notNull(),
    /** Free-form (glass_type, finish, style…) — no enum, so any trade fits. */
    optionType: text("option_type").notNull().default("custom"),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("estimator_options_product_idx").on(t.productId)],
);

/** One selectable value of an option, with the flat cents it adds. */
export const estimatorOptionValues = pgTable(
  "estimator_option_values",
  {
    id: idColumn(),
    optionId: text("option_id").notNull(),
    label: text("label").notNull(),
    priceModifier: money("price_modifier"),
    isDefault: boolean("is_default").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("estimator_option_values_option_idx").on(t.optionId)],
);

/** A measurement captured on an estimate line — whatever the trade needed. */
export interface EstimateItemMeasurement {
  widthIn?: number;
  heightIn?: number;
  sqFt?: number;
  linearFt?: number;
  units?: number;
}

/** A saved estimate. Money in cents; status is its lifecycle. */
export const estimatorEstimates = pgTable(
  "estimator_estimates",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    estimateNumber: text("estimate_number").notNull(),
    /** draft | sent | viewed | approved | rejected | expired | converted */
    status: text("status").notNull().default("draft"),
    customerName: text("customer_name"),
    customerEmail: text("customer_email"),
    customerPhone: text("customer_phone"),
    jobAddress: text("job_address"),
    subtotal: money("subtotal"),
    taxRateBp: integer("tax_rate_bp").notNull().default(825),
    taxAmount: money("tax_amount"),
    discount: money("discount"),
    total: money("total"),
    notes: text("notes"),
    internalNotes: text("internal_notes"),
    /** How it arrived: "public_tool", "photo", "staff". */
    source: text("source").notNull().default("staff"),
    /** The photo a customer uploaded for a takeoff, if any. */
    photoUrl: text("photo_url"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("estimator_estimates_tenant_idx").on(t.tenantId, t.status),
    index("estimator_estimates_number_idx").on(t.tenantId, t.estimateNumber),
  ],
);

/** A line on an estimate. Measurement is jsonb (quantities, not money). */
export const estimatorEstimateItems = pgTable(
  "estimator_estimate_items",
  {
    id: idColumn(),
    estimateId: text("estimate_id").notNull(),
    productId: text("product_id"),
    description: text("description").notNull(),
    measurement: jsonb("measurement").$type<EstimateItemMeasurement>(),
    quantity: integer("quantity").notNull().default(1),
    unitPrice: money("unit_price"),
    laborPrice: money("labor_price"),
    total: money("total"),
    /** optionId → optionValueId chosen. */
    selectedOptions: jsonb("selected_options").$type<Record<string, string>>(),
    sortOrder: integer("sort_order").notNull().default(0),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [index("estimator_estimate_items_estimate_idx").on(t.estimateId)],
);
