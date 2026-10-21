import { eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import {
  feedbackBoards,
  feedbackCategories,
  feedbackClientKeys,
  feedbackEpics,
  feedbackMessages,
  feedbackStatuses,
  feedbackTicketEvents,
  feedbackTickets,
  feedbackUploads,
} from "./schema.js";

/**
 * FORGET ONE COMPANY (create-app's "delete a company"): every row of a
 * company's feedback board — tickets, their messages and history, uploads'
 * records, epics, columns, categories, website keys and the board itself —
 * children first, each statement filtered by the company's id. Run it on the
 * deletion's transaction. The site's own board ("*") is never one company's.
 *
 * Returns how many rows went from each table.
 */
export async function forgetTenant(db: PgDatabase<any, any, any>, tenantId: string): Promise<Readonly<Record<string, number>>> {
  if (typeof tenantId !== "string" || tenantId.trim() === "" || tenantId === "*") {
    throw new Error("forgetTenant needs one company's id; the site's own rows (\"*\") are never forgotten.");
  }
  const one = { one: sql<number>`1` };
  const tickets = db.select({ id: feedbackTickets.id }).from(feedbackTickets).where(eq(feedbackTickets.tenantId, tenantId));
  const counts: Record<string, number> = {};
  counts["feedback_messages"] = (await db.delete(feedbackMessages).where(inArray(feedbackMessages.ticketId, tickets)).returning(one)).length;
  counts["feedback_ticket_events"] = (await db.delete(feedbackTicketEvents).where(eq(feedbackTicketEvents.tenantId, tenantId)).returning(one)).length;
  counts["feedback_uploads"] = (await db.delete(feedbackUploads).where(eq(feedbackUploads.tenantId, tenantId)).returning(one)).length;
  counts["feedback_tickets"] = (await db.delete(feedbackTickets).where(eq(feedbackTickets.tenantId, tenantId)).returning(one)).length;
  counts["feedback_epics"] = (await db.delete(feedbackEpics).where(eq(feedbackEpics.tenantId, tenantId)).returning(one)).length;
  counts["feedback_statuses"] = (await db.delete(feedbackStatuses).where(eq(feedbackStatuses.tenantId, tenantId)).returning(one)).length;
  counts["feedback_categories"] = (await db.delete(feedbackCategories).where(eq(feedbackCategories.tenantId, tenantId)).returning(one)).length;
  counts["feedback_client_keys"] = (await db.delete(feedbackClientKeys).where(eq(feedbackClientKeys.tenantId, tenantId)).returning(one)).length;
  counts["feedback_boards"] = (await db.delete(feedbackBoards).where(eq(feedbackBoards.tenantId, tenantId)).returning(one)).length;
  return counts;
}
