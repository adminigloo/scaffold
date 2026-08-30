export { formatMinor, defaultVariant, priceRange } from "./pricing.js";
export type { PriceRange, VariantPricing } from "./pricing.js";

export {
  validateProduct,
  canPublish,
  grantConfigSchemas,
} from "./validation.js";
export type {
  GrantDraft,
  Problem,
  ProblemCode,
  ProductDraft,
  ValidateProductInput,
  VariantDraft,
} from "./validation.js";

export { planStripeSync, StripeAmountOutOfRangeError } from "./stripe-sync.js";
export type {
  CachedStripePrice,
  CachedStripeProduct,
  PlanStripeSyncInput,
  PriceField,
  StripeCache,
  SyncPlan,
  SyncProduct,
  SyncStep,
  SyncVariant,
} from "./stripe-sync.js";

export { catalogPermissions } from "./permissions.js";
export type { CatalogPermission } from "./permissions.js";

/**
 * Tables are reachable ONLY from "@adminigloo/catalog/schema", matching auth,
 * billing, commerce, stripe, permissions and tenancy.
 *
 * Re-exporting them here costs twice. The root entry becomes a static import of
 * drizzle-orm/pg-core, so a client component importing `formatMinor` — which is
 * a price on a product card and the single most likely thing in this package to
 * run in a browser — drags the whole query builder into the bundle, and with no
 * `sideEffects: false` anywhere in the repo a bundler must assume the chunk
 * matters and cannot drop it. Worse, tsup does not code-split CJS: the same
 * `pgTable` call is emitted into BOTH dist/index.cjs and dist/schema.cjs, so a
 * CJS consumer holds two distinct objects for one physical table and reference
 * equality — which Drizzle relations and getTableConfig rely on — silently
 * fails.
 *
 * Types are safe to re-export: they erase at build time and pull in nothing.
 */
export type {
  GrantConfig,
  GrantKind,
  ProductImage,
  ProductKind,
  ProductMetadata,
  ProductStatus,
  VariantInterval,
} from "./schema.js";
