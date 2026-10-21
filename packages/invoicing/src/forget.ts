import { eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { invoiceCardAlerts, invoiceCheckouts, invoiceItems, invoicePayments, invoices } from "./schema.js";

/**
 * FORGET ONE COMPANY (create-app's "delete a company"): every row invoicing
 * keeps for `tenantId` — its invoices, their lines and payments, card
 * checkouts and the card alerts — children first, each statement filtered by
 * the company's id. Run it on the deletion's transaction.
 *
 * Returns how many rows went from each table. Refuses an empty id and the
 * site's own ("*").
 */
export async function forgetTenant(db: PgDatabase<any, any, any>, tenantId: string): Promise<Readonly<Record<string, number>>> {
  if (typeof tenantId !== "string" || tenantId.trim() === "" || tenantId === "*") {
    throw new Error("forgetTenant needs one company's id; the site's own rows (\"*\") are never forgotten.");
  }
  const one = { one: sql<number>`1` };
  const mine = db.select({ id: invoices.id }).from(invoices).where(eq(invoices.tenantId, tenantId));
  const counts: Record<string, number> = {};
  counts["invoice_payments"] = (await db.delete(invoicePayments).where(inArray(invoicePayments.invoiceId, mine)).returning(one)).length;
  counts["invoice_items"] = (await db.delete(invoiceItems).where(inArray(invoiceItems.invoiceId, mine)).returning(one)).length;
  counts["invoice_checkouts"] = (await db.delete(invoiceCheckouts).where(eq(invoiceCheckouts.tenantId, tenantId)).returning(one)).length;
  counts["invoice_card_alerts"] = (await db.delete(invoiceCardAlerts).where(eq(invoiceCardAlerts.tenantId, tenantId)).returning(one)).length;
  counts["invoices"] = (await db.delete(invoices).where(eq(invoices.tenantId, tenantId)).returning(one)).length;
  return counts;
}
