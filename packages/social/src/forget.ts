import { eq, getTableName, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { socialTables, type SocialTables } from "./schema.js";

/**
 * FORGET ONE COMPANY (create-app's "delete a company"): every post drafted,
 * approved, posted or skipped for it — one statement, filtered by the
 * company's id. Run it on the deletion's transaction. `tables`: the set the
 * project defined (`defineSocialTables`), default `social_posts`.
 *
 * Returns how many rows went from each table. Refuses an empty id and the
 * site's own ("*"): those are never one company's.
 */
export async function forgetTenant(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: PgDatabase<any, any, any>,
  tenantId: string,
  options: { readonly tables?: SocialTables } = {},
): Promise<Readonly<Record<string, number>>> {
  if (typeof tenantId !== "string" || tenantId.trim() === "" || tenantId === "*") {
    throw new Error("forgetTenant needs one company's id; the site's own rows (\"*\") are never forgotten.");
  }
  const t = options.tables ?? socialTables;
  const one = { one: sql<number>`1` };
  return {
    [getTableName(t.posts)]: (await db.delete(t.posts).where(eq(t.posts.tenantId, tenantId)).returning(one)).length,
  };
}
