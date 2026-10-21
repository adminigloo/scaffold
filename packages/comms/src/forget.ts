import { eq, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { commsMessages, commsScheduled, commsTemplates } from "./schema.js";

/**
 * FORGET ONE COMPANY (create-app's "delete a company"): every row comms keeps
 * for `tenantId` — the messages it sent, the ones waiting to go and its
 * message templates — each statement filtered by the company's id. Run it on
 * the deletion's transaction; a message waiting to go never goes.
 *
 * Returns how many rows went from each table. Refuses an empty id and the
 * site's own ("*").
 */
export async function forgetTenant(db: PgDatabase<any, any, any>, tenantId: string): Promise<Readonly<Record<string, number>>> {
  if (typeof tenantId !== "string" || tenantId.trim() === "" || tenantId === "*") {
    throw new Error("forgetTenant needs one company's id; the site's own rows (\"*\") are never forgotten.");
  }
  const one = { one: sql<number>`1` };
  const counts: Record<string, number> = {};
  counts["comms_messages"] = (await db.delete(commsMessages).where(eq(commsMessages.tenantId, tenantId)).returning(one)).length;
  counts["comms_scheduled"] = (await db.delete(commsScheduled).where(eq(commsScheduled.tenantId, tenantId)).returning(one)).length;
  counts["comms_templates"] = (await db.delete(commsTemplates).where(eq(commsTemplates.tenantId, tenantId)).returning(one)).length;
  return counts;
}
