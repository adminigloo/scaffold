import { eq, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { seoReports } from "./schema.js";

/**
 * FORGET ONE COMPANY (create-app's "delete a company"): every search check of the
 * company's pages and websites.
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
  counts["seo_reports"] = (await db.delete(seoReports).where(eq(seoReports.tenantId, tenantId)).returning(one)).length;
  return counts;
}
