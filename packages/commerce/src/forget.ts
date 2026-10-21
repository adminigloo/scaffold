import { eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { discountCodes, orderItems, orders, orderShipments, storeAlerts, storeCheckouts, storeSettings } from "./schema.js";

/**
 * FORGET ONE COMPANY (create-app's "delete a company"): the company's store —
 * its orders with their items and shipments, its checkouts, the payments that
 * needed its owner, its discount codes and its store settings — children
 * first, each statement filtered by the company's id. Run it on the
 * deletion's transaction; its products are catalog's. The site's own orders
 * ("*") are never one company's.
 *
 * Returns how many rows went from each table.
 */
export async function forgetTenant(db: PgDatabase<any, any, any>, tenantId: string): Promise<Readonly<Record<string, number>>> {
  if (typeof tenantId !== "string" || tenantId.trim() === "" || tenantId === "*") {
    throw new Error("forgetTenant needs one company's id; the site's own rows (\"*\") are never forgotten.");
  }
  const one = { one: sql<number>`1` };
  const mine = db.select({ id: orders.id }).from(orders).where(eq(orders.tenantId, tenantId));
  const counts: Record<string, number> = {};
  counts["order_items"] = (await db.delete(orderItems).where(inArray(orderItems.orderId, mine)).returning(one)).length;
  counts["order_shipments"] = (await db.delete(orderShipments).where(inArray(orderShipments.orderId, mine)).returning(one)).length;
  counts["store_alerts"] = (await db.delete(storeAlerts).where(eq(storeAlerts.tenantId, tenantId)).returning(one)).length;
  counts["store_checkouts"] = (await db.delete(storeCheckouts).where(eq(storeCheckouts.tenantId, tenantId)).returning(one)).length;
  counts["orders"] = (await db.delete(orders).where(eq(orders.tenantId, tenantId)).returning(one)).length;
  counts["discount_codes"] = (await db.delete(discountCodes).where(eq(discountCodes.tenantId, tenantId)).returning(one)).length;
  counts["store_settings"] = (await db.delete(storeSettings).where(eq(storeSettings.tenantId, tenantId)).returning(one)).length;
  return counts;
}
