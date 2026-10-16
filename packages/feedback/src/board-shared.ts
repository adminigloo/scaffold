import { asc, eq } from "drizzle-orm";
import { isTenantId, type FeedbackDb } from "./core.js";
import { feedbackStatuses, feedbackTicketEvents, type FeedbackTicketEventKind } from "./schema.js";

/**
 * The small pieces board-data.ts and epics-data.ts both need (0.12.0), in a
 * module of their own so neither imports the other's code at load time.
 * Internal: nothing here is re-exported from the package's entry except
 * NUL_MESSAGE (through board-data.ts, as in 0.11).
 */

/**
 * A NUL character can't be stored or searched in Postgres text (0.11.0: it
 * was a 500). Refused at the boundary with a sentence instead.
 */
export const NUL_MESSAGE = "That has a character in it that can't be saved. Type it again without it.";
export const noNul = (value: string) => !value.includes("\u0000");

export function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code ?? (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return code === "23505";
}

/** Two names a person would call the same: case and spacing don't count. */
export function sameName(a: string, b: string): boolean {
  return a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();
}

// ---------------------------------------------------------------------------
// The activity trail's writes (0.11.0; moved here in 0.12.0)
// ---------------------------------------------------------------------------

export interface EventDraft {
  ticketId: string;
  kind: FeedbackTicketEventKind;
  fromValue: string | null;
  toValue: string | null;
  actorId: string | null;
  actorName: string;
}

/** Callers have already found every ticket INSIDE `tenantId`; the rows carry it too. */
export async function recordEvents(db: FeedbackDb, tenantId: string, drafts: readonly EventDraft[], now?: Date): Promise<void> {
  if (drafts.length === 0) return;
  await db.insert(feedbackTicketEvents).values(
    drafts.map((draft) => ({
      tenantId,
      ticketId: draft.ticketId,
      kind: draft.kind,
      fromValue: draft.fromValue?.slice(0, 200) ?? null,
      toValue: draft.toValue?.slice(0, 200) ?? null,
      actorId: draft.actorId,
      actorName: draft.actorName.trim().slice(0, 120) || "The team",
      ...(now ? { createdAt: now } : {}),
    })),
  );
}

/** The trail is a record of a change, never the change itself: a failed write never undoes one. */
export async function recordEventsQuietly(db: FeedbackDb, tenantId: string, drafts: readonly EventDraft[], now?: Date): Promise<void> {
  try {
    await recordEvents(db, tenantId, drafts, now);
  } catch {
    /* the change stands */
  }
}

// ---------------------------------------------------------------------------
// The columns, as an epic's progress reads them (0.12.0)
// ---------------------------------------------------------------------------

/** What progress needs to know about a column: is it finished, is it waiting. */
export interface ColumnFlags {
  readonly key: string;
  readonly label: string;
  readonly isTerminal: boolean;
  readonly isWaiting: boolean;
}

/** A company's columns in board order, with the flags progress reads. */
export async function columnFlags(db: FeedbackDb, tenantId: string): Promise<ColumnFlags[]> {
  if (!isTenantId(tenantId)) return [];
  return db
    .select({
      key: feedbackStatuses.key,
      label: feedbackStatuses.label,
      isTerminal: feedbackStatuses.isTerminal,
      isWaiting: feedbackStatuses.isWaiting,
    })
    .from(feedbackStatuses)
    .where(eq(feedbackStatuses.tenantId, tenantId))
    .orderBy(asc(feedbackStatuses.sortOrder), asc(feedbackStatuses.key));
}

/**
 * The column a new ticket lands in: the first unfinished one by order, else
 * the first, else "open" — the same rule the intake uses (board-data.ts's
 * `initialStatus`), so "not started yet" means the same thing everywhere.
 */
export function landingKey(columns: readonly ColumnFlags[]): string {
  return columns.find((column) => !column.isTerminal)?.key ?? columns[0]?.key ?? "open";
}
