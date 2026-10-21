import { eq, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { stripeConnectedAccounts, stripeEvents } from "./schema.js";

/**
 * FORGET ONE COMPANY (create-app's "delete a company"): its connected Stripe account's
 * record here (the account itself stays at Stripe, the business's own) and the
 * card events recorded for it.
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
  counts["stripe_events"] = (await db.delete(stripeEvents).where(eq(stripeEvents.tenantId, tenantId)).returning(one)).length;
  counts["stripe_connected_accounts"] = (await db.delete(stripeConnectedAccounts).where(eq(stripeConnectedAccounts.tenantId, tenantId)).returning(one)).length;
  return counts;
}
