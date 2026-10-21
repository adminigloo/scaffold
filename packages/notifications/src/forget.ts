import { eq, getTableName, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { notificationTables, type NotificationTables } from "./schema.js";

/**
 * FORGET ONE COMPANY (create-app's "delete a company"): every alert the
 * company's people got, each person's alert choices and who each kind of
 * alert goes to — each statement filtered by the company's id. Run it on the
 * deletion's transaction. `tables`: the set the project defined
 * (`defineNotificationTables`), default the package's own names.
 *
 * Returns how many rows went from each table. Refuses an empty id and the
 * site's own ("*").
 */
export async function forgetTenant(
  db: PgDatabase<any, any, any>,
  tenantId: string,
  options: { readonly tables?: NotificationTables } = {},
): Promise<Readonly<Record<string, number>>> {
  if (typeof tenantId !== "string" || tenantId.trim() === "" || tenantId === "*") {
    throw new Error("forgetTenant needs one company's id; the site's own rows (\"*\") are never forgotten.");
  }
  const { alerts, choices, routing } = options.tables ?? notificationTables;
  const one = { one: sql<number>`1` };
  const counts: Record<string, number> = {};
  counts[getTableName(alerts)] = (await db.delete(alerts).where(eq(alerts.tenantId, tenantId)).returning(one)).length;
  counts[getTableName(choices)] = (await db.delete(choices).where(eq(choices.tenantId, tenantId)).returning(one)).length;
  counts[getTableName(routing)] = (await db.delete(routing).where(eq(routing.tenantId, tenantId)).returning(one)).length;
  return counts;
}
