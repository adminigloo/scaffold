import { eq, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { aeoChecks, aeoProfiles, aeoQueries } from "./schema.js";

/**
 * FORGET ONE COMPANY (create-app's "delete a company"): the questions its customers
 * ask, who it is, and every answer an AI assistant gave about it.
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
  counts["aeo_checks"] = (await db.delete(aeoChecks).where(eq(aeoChecks.tenantId, tenantId)).returning(one)).length;
  counts["aeo_queries"] = (await db.delete(aeoQueries).where(eq(aeoQueries.tenantId, tenantId)).returning(one)).length;
  counts["aeo_profiles"] = (await db.delete(aeoProfiles).where(eq(aeoProfiles.tenantId, tenantId)).returning(one)).length;
  return counts;
}
