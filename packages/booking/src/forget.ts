import { eq, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { bookingAvailability, bookingBlackouts, bookingBookings, bookingEvents, bookingExceptions, bookingHosts, bookingTypes } from "./schema.js";

/**
 * FORGET ONE COMPANY (create-app's "delete a company"): its calls and their history,
 * the people who take them, their hours and time off, its holidays and call
 * types.
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
  counts["booking_events"] = (await db.delete(bookingEvents).where(eq(bookingEvents.tenantId, tenantId)).returning(one)).length;
  counts["booking_bookings"] = (await db.delete(bookingBookings).where(eq(bookingBookings.tenantId, tenantId)).returning(one)).length;
  counts["booking_availability"] = (await db.delete(bookingAvailability).where(eq(bookingAvailability.tenantId, tenantId)).returning(one)).length;
  counts["booking_exceptions"] = (await db.delete(bookingExceptions).where(eq(bookingExceptions.tenantId, tenantId)).returning(one)).length;
  counts["booking_blackouts"] = (await db.delete(bookingBlackouts).where(eq(bookingBlackouts.tenantId, tenantId)).returning(one)).length;
  counts["booking_types"] = (await db.delete(bookingTypes).where(eq(bookingTypes.tenantId, tenantId)).returning(one)).length;
  counts["booking_hosts"] = (await db.delete(bookingHosts).where(eq(bookingHosts.tenantId, tenantId)).returning(one)).length;
  return counts;
}
