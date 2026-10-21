import { eq, inArray, sql } from "drizzle-orm";
import {
  estimatorClientKeys,
  estimatorComponents,
  estimatorEstimateItems,
  estimatorEstimates,
  estimatorOptions,
  estimatorOptionValues,
  estimatorPhotos,
  estimatorProductComponents,
  estimatorProducts,
  estimatorQuoteTokens,
  estimatorSettings,
  estimatorTakeoffs,
} from "./schema.js";
import type { EstimatorDb } from "./types.js";

/**
 * FORGET ONE COMPANY (create-app's "delete a company"): every row the
 * estimator keeps for `tenantId` — its price book, estimates and their lines,
 * quote links, photos' records, measurements, website keys and settings —
 * children first, each statement filtered by the company's id. Run it on the
 * deletion's transaction. The photos' FILES are storage's to delete (their
 * rows here only point at them).
 *
 * Returns how many rows went from each table. Refuses an empty id and the
 * site's own ("*"): those are never one company's.
 */
export async function forgetTenant(db: EstimatorDb, tenantId: string): Promise<Readonly<Record<string, number>>> {
  if (typeof tenantId !== "string" || tenantId.trim() === "" || tenantId === "*") {
    throw new Error("forgetTenant needs one company's id; the site's own rows (\"*\") are never forgotten.");
  }
  const one = { one: sql<number>`1` };
  const estimates = db.select({ id: estimatorEstimates.id }).from(estimatorEstimates).where(eq(estimatorEstimates.tenantId, tenantId));
  const products = db.select({ id: estimatorProducts.id }).from(estimatorProducts).where(eq(estimatorProducts.tenantId, tenantId));
  const options = db.select({ id: estimatorOptions.id }).from(estimatorOptions).where(inArray(estimatorOptions.productId, products));
  const counts: Record<string, number> = {};
  counts["estimator_estimate_items"] = (
    await db.delete(estimatorEstimateItems).where(inArray(estimatorEstimateItems.estimateId, estimates)).returning(one)
  ).length;
  counts["estimator_quote_tokens"] = (await db.delete(estimatorQuoteTokens).where(eq(estimatorQuoteTokens.tenantId, tenantId)).returning(one)).length;
  counts["estimator_photos"] = (await db.delete(estimatorPhotos).where(eq(estimatorPhotos.tenantId, tenantId)).returning(one)).length;
  counts["estimator_takeoffs"] = (await db.delete(estimatorTakeoffs).where(eq(estimatorTakeoffs.tenantId, tenantId)).returning(one)).length;
  counts["estimator_estimates"] = (await db.delete(estimatorEstimates).where(eq(estimatorEstimates.tenantId, tenantId)).returning(one)).length;
  counts["estimator_option_values"] = (
    await db.delete(estimatorOptionValues).where(inArray(estimatorOptionValues.optionId, options)).returning(one)
  ).length;
  counts["estimator_options"] = (await db.delete(estimatorOptions).where(inArray(estimatorOptions.productId, products)).returning(one)).length;
  counts["estimator_product_components"] = (
    await db.delete(estimatorProductComponents).where(inArray(estimatorProductComponents.productId, products)).returning(one)
  ).length;
  counts["estimator_products"] = (await db.delete(estimatorProducts).where(eq(estimatorProducts.tenantId, tenantId)).returning(one)).length;
  counts["estimator_components"] = (await db.delete(estimatorComponents).where(eq(estimatorComponents.tenantId, tenantId)).returning(one)).length;
  counts["estimator_client_keys"] = (await db.delete(estimatorClientKeys).where(eq(estimatorClientKeys.tenantId, tenantId)).returning(one)).length;
  counts["estimator_settings"] = (await db.delete(estimatorSettings).where(eq(estimatorSettings.tenantId, tenantId)).returning(one)).length;
  return counts;
}
