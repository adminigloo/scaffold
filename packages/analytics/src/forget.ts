import { eq, getTableName, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { analyticsTables, type AnalyticsTables } from "./schema.js";

/**
 * FORGET ONE COMPANY (create-app's "delete a company"): every visit the
 * company's pages and websites counted — sessions, page views and events,
 * crawler visits, its rate counters, its websites and their keys, its notes
 * on the chart and when its counting began — children first, each statement
 * filtered by the company's id. Run it on the deletion's transaction. The
 * day salts are no company's and are left alone. `tables`: the set the
 * project defined (`defineAnalyticsTables`), default the 0.1 names.
 *
 * Returns how many rows went from each table. Refuses an empty id and the
 * site's own ("*").
 */
export async function forgetTenant(
  db: PgDatabase<any, any, any>,
  tenantId: string,
  options: { readonly tables?: AnalyticsTables } = {},
): Promise<Readonly<Record<string, number>>> {
  if (typeof tenantId !== "string" || tenantId.trim() === "" || tenantId === "*") {
    throw new Error("forgetTenant needs one company's id; the site's own rows (\"*\") are never forgotten.");
  }
  const t = options.tables ?? analyticsTables;
  const one = { one: sql<number>`1` };
  const counts: Record<string, number> = {};
  counts[getTableName(t.events)] = (await db.delete(t.events).where(eq(t.events.tenantId, tenantId)).returning(one)).length;
  counts[getTableName(t.pageViews)] = (await db.delete(t.pageViews).where(eq(t.pageViews.tenantId, tenantId)).returning(one)).length;
  counts[getTableName(t.sessions)] = (await db.delete(t.sessions).where(eq(t.sessions.tenantId, tenantId)).returning(one)).length;
  counts[getTableName(t.crawlerHits)] = (await db.delete(t.crawlerHits).where(eq(t.crawlerHits.tenantId, tenantId)).returning(one)).length;
  counts[getTableName(t.rate)] = (await db.delete(t.rate).where(eq(t.rate.tenantId, tenantId)).returning(one)).length;
  counts[getTableName(t.annotations)] = (await db.delete(t.annotations).where(eq(t.annotations.tenantId, tenantId)).returning(one)).length;
  counts[getTableName(t.websites)] = (await db.delete(t.websites).where(eq(t.websites.tenantId, tenantId)).returning(one)).length;
  counts[getTableName(t.sites)] = (await db.delete(t.sites).where(eq(t.sites.tenantId, tenantId)).returning(one)).length;
  return counts;
}
