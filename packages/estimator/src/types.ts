import type { PgDatabase } from "drizzle-orm/pg-core";
import type {
  estimatorClientKeys,
  estimatorComponents,
  estimatorEstimateItems,
  estimatorEstimates,
  estimatorOptionValues,
  estimatorOptions,
  estimatorPhotos,
  estimatorProductComponents,
  estimatorProducts,
  estimatorQuoteTokens,
  estimatorSettings,
  estimatorTakeoffs,
} from "./schema.js";

/**
 * The types every module shares. All correctness lives in the package's
 * functions so a consumer's route layer stays a thin gate. A permissive DB
 * type keeps the package free of a Drizzle schema-generic mismatch across
 * versions — the same pattern the other @adminigloo packages use.
 *
 * TENANT SCOPING (0.2.0, kept). Every read or write that names a row by id
 * also takes the tenant and filters by it; an id that is not the tenant's
 * answers the same null / false as one that does not exist, so a caller can
 * neither reach nor probe another workspace's rows.
 */
export type EstimatorDb = PgDatabase<any, any, any>;

/**
 * An input the estimator refuses: a product that is not this tenant's live
 * product, a measurement the product cannot be priced from, a discount bigger
 * than the work, a quote that has expired. A caller maps it to a 4xx; it is
 * never a server fault. Every message is one plain sentence a business owner
 * (or, on a public route, a customer) can act on.
 */
export type EstimatorRefusal =
  | "product_unavailable"
  | "product_not_estimatable"
  | "invalid_measurement"
  | "invalid_options"
  | "invalid_price_range"
  | "discount_exceeds_subtotal"
  /** A catalog write named an option that is not this tenant's. */
  | "option_unavailable"
  /** A catalog write named a material (supply) that is not this tenant's. */
  | "component_unavailable"
  // --- 0.3 ---
  /** A supply's `per` is not a quantity of the product's recipe. */
  | "invalid_supply_basis"
  /** A recipe's settings don't fit together (a maximum above the unit's ceiling, a step height out of order). */
  | "invalid_recipe_config"
  /** The estimate is not a draft (sent, answered, …): revise it first. */
  | "not_changeable"
  | "empty_estimate"
  | "no_customer_email"
  | "unpriced_lines"
  | "quote_expired"
  | "already_answered"
  | "photo_invalid"
  | "photo_unavailable"
  | "photo_limit"
  | "photos_disabled"
  | "takeoff_unavailable"
  | "estimates_closed"
  | "sample_already_loaded"
  | "item_unavailable"
  | "option_value_unavailable"
  /** A status move the lifecycle doesn't allow (an invoice from an unaccepted quote). */
  | "transition_not_allowed"
  /** The business hasn't saved its name and settings: nothing reaches a customer yet. */
  | "settings_incomplete"
  /** The customer answered a version of the quote that has since been revised. */
  | "quote_changed"
  /** A supply whose cost comes from the host's own price list. */
  | "managed_externally";

export class EstimatorInputError extends Error {
  readonly name = "EstimatorInputError";
  constructor(
    readonly code: EstimatorRefusal,
    message: string,
  ) {
    super(message);
  }
}

export type ProductRow = typeof estimatorProducts.$inferSelect;
export type ComponentRow = typeof estimatorComponents.$inferSelect;
export type AttachmentRow = typeof estimatorProductComponents.$inferSelect;
export type OptionRow = typeof estimatorOptions.$inferSelect;
export type OptionValueRow = typeof estimatorOptionValues.$inferSelect;
export type EstimateRow = typeof estimatorEstimates.$inferSelect;
export type EstimateItemRow = typeof estimatorEstimateItems.$inferSelect;
export type ClientKeyDbRow = typeof estimatorClientKeys.$inferSelect;
export type SettingsRow = typeof estimatorSettings.$inferSelect;
export type QuoteTokenRow = typeof estimatorQuoteTokens.$inferSelect;
export type PhotoRow = typeof estimatorPhotos.$inferSelect;
export type TakeoffRow = typeof estimatorTakeoffs.$inferSelect;
