import { eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { productGrants, products, productVariants } from "./schema.js";

/**
 * FORGET ONE COMPANY (create-app's "delete a company"): the company's own
 * products for its store, with their prices, stock and what each grants —
 * children first, each statement filtered by the company's id. Run it on the
 * deletion's transaction. The site's own plans and products ("*") are never
 * one company's. Products' photos are storage's to delete.
 *
 * Returns how many rows went from each table.
 */
export async function forgetTenant(db: PgDatabase<any, any, any>, tenantId: string): Promise<Readonly<Record<string, number>>> {
  if (typeof tenantId !== "string" || tenantId.trim() === "" || tenantId === "*") {
    throw new Error("forgetTenant needs one company's id; the site's own rows (\"*\") are never forgotten.");
  }
  const one = { one: sql<number>`1` };
  const mine = db.select({ id: products.id }).from(products).where(eq(products.tenantId, tenantId));
  const variants = db.select({ id: productVariants.id }).from(productVariants).where(inArray(productVariants.productId, mine));
  const counts: Record<string, number> = {};
  counts["product_grants"] = (await db.delete(productGrants).where(inArray(productGrants.variantId, variants)).returning(one)).length;
  counts["product_variants"] = (await db.delete(productVariants).where(inArray(productVariants.productId, mine)).returning(one)).length;
  counts["products"] = (await db.delete(products).where(eq(products.tenantId, tenantId)).returning(one)).length;
  return counts;
}
