import { eq, getTableName, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { audienceTables, type AudienceTables } from "./schema.js";

/**
 * FORGET ONE COMPANY (create-app's "delete a company"): who the company left
 * out of its numbers — its rules, the people and visitors marked, the links
 * between them and the record of each clean-up — each statement filtered by
 * the company's id. Run it on the deletion's transaction. `tables`: the set
 * the project defined (`defineAudienceTables`), default `aig_audience_*`.
 *
 * Returns how many rows went from each table. Refuses an empty id and the
 * site's own ("*").
 */
export async function forgetTenant(
  db: PgDatabase<any, any, any>,
  tenantId: string,
  options: { readonly tables?: AudienceTables } = {},
): Promise<Readonly<Record<string, number>>> {
  if (typeof tenantId !== "string" || tenantId.trim() === "" || tenantId === "*") {
    throw new Error("forgetTenant needs one company's id; the site's own rows (\"*\") are never forgotten.");
  }
  const { rules, marks, links, runs } = options.tables ?? audienceTables;
  const one = { one: sql<number>`1` };
  const counts: Record<string, number> = {};
  counts[getTableName(marks)] = (await db.delete(marks).where(eq(marks.tenantId, tenantId)).returning(one)).length;
  counts[getTableName(links)] = (await db.delete(links).where(eq(links.tenantId, tenantId)).returning(one)).length;
  counts[getTableName(runs)] = (await db.delete(runs).where(eq(runs.tenantId, tenantId)).returning(one)).length;
  counts[getTableName(rules)] = (await db.delete(rules).where(eq(rules.tenantId, tenantId)).returning(one)).length;
  return counts;
}
