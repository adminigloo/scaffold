/**
 * @adminigloo/estimator — instant prices from the owner's own supplies, photo
 * estimates whose numbers come from code (never the AI), quotes customers
 * accept online, follow-ups, and the staff side to run it all.
 *
 *   .           functions, types, permission keys, the two handler factories
 *   ./schema    the drizzle pgTables, for an app's drizzle config to glob
 *   ./comms     createEstimatorCommsListener and the default email templates
 *   ./anthropic createAnthropicTakeoffRunner: the photo reading on Claude
 *
 * Every function is tenant-scoped (an id that is not the tenant's answers the
 * same null as one that does not exist), money is integer cents and ratios
 * basis points, and every number a customer or the business reads is computed
 * by named, unit-tested functions: recipes.ts turns what a customer can count
 * or measure into the quantities priced, build.ts prices them from the
 * owner's supplies, and a photo reading contributes only what the model SAW.
 */

export * from "./types.js";
export * from "./wire.js";
export * from "./pricing.js";
export * from "./recipes.js";
export * from "./build.js";
export * from "./takeoff.js";
export * from "./image.js";
export * from "./settings.js";
export * from "./permissions.js";
export * from "./catalog.js";
export * from "./sample.js";
export * from "./price-product.js";
export * from "./events.js";
export * from "./estimates.js";
export * from "./quotes.js";
export * from "./photos.js";
export * from "./takeoff-run.js";
export * from "./keys.js";
export * from "./handlers.js";
export * from "./admin-handlers.js";
export { generateToken, hashToken, looksLikeToken } from "./tokens.js";
export { HttpError, isCrossSiteRequest, WIRE_ERROR_STATUS, wireIssues } from "./http.js";
export {
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
  type EstimateItemMeasurement,
  type EstimateItemOptionSnapshot,
} from "./schema.js";
