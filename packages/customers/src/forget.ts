import { eq, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { customerAddresses, customerLinks, customerMerges, customerNotices, customers } from "./schema.js";

/**
 * FORGET ONE COMPANY (create-app's "delete a company"): its customer list — every
 * customer, their addresses, the timeline links, merges and the notices about
 * possible duplicates.
 * Each statement is filtered by the company's id, children first. Run it on
 * the deletion's transaction.
 *
 * Returns how many rows went from each table. Refuses an empty id and the
 * site's own ("*"): those are never one company's.
 */
export async function forgetTenant(db: PgDatabase<any, any, any>, tenantId: string): Promise<Readonly<Record<string, number>>> {
  if (typeof tenantId !== "string" || tenantId.trim() === "" || tenantId === "*") {
    throw new Error("forgetTenant needs one company's id; the site's own rows (\"*\") are never forgotten.");
  }
  const one = { one: sql<number>`1` };
  const counts: Record<string, number> = {};
  counts["customer_links"] = (await db.delete(customerLinks).where(eq(customerLinks.tenantId, tenantId)).returning(one)).length;
  counts["customer_addresses"] = (await db.delete(customerAddresses).where(eq(customerAddresses.tenantId, tenantId)).returning(one)).length;
  counts["customer_notices"] = (await db.delete(customerNotices).where(eq(customerNotices.tenantId, tenantId)).returning(one)).length;
  counts["customer_merges"] = (await db.delete(customerMerges).where(eq(customerMerges.tenantId, tenantId)).returning(one)).length;
  counts["customers"] = (await db.delete(customers).where(eq(customers.tenantId, tenantId)).returning(one)).length;
  return counts;
}
