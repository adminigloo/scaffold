import { and, asc, count, desc, eq, exists, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { columnFlags, isUniqueViolation, noNul, NUL_MESSAGE, recordEventsQuietly, sameName, type EventDraft } from "./board-shared.js";
import { isTenantId, type FeedbackDb } from "./core.js";
import {
  canMoveEpic,
  EMPTY_PROGRESS,
  EPIC_COLOR_NAMES,
  EPIC_STATUS_LABELS,
  epicBucketOf,
  epicProgressFromCounts,
  landingColumnOf,
  takesTickets,
  type EpicBucket,
  type EpicColor,
  type EpicProgress,
  type EpicStatus,
} from "./epic-core.js";
import { feedbackEpics, feedbackTickets } from "./schema.js";

/**
 * Epics' server half (0.12.0): a company's bigger pieces of work, each with
 * the tickets that belong to it. Included in @adminigloo/feedback, on the
 * board's own permissions (feedback.view to look, feedback.manage to change).
 *
 * EVERY FUNCTION TAKES THE COMPANY and only ever reads or writes that
 * company's rows, the same rule as board-data.ts: another company's epic, or
 * ticket, asked for by id is "not found" — never a different answer.
 *
 * Ask Lou's epic system, with its known bugs designed out (see
 * docs/feedback-complete-board/epics-create-columns.md):
 *
 *   - progress is by the columns' flags, one rule (epic-core.ts);
 *   - an epic is never blocked from being deleted: its tickets stay on the
 *     board, archived ones included, and leave the epic, each with a line on
 *     its trail (Ask Lou refused an epic holding only archived tickets, which
 *     nobody could see to remove);
 *   - tickets are only ever ADDED to an epic still being worked on; a
 *     membership change both adds and removes, says how many came from
 *     another epic, and refuses the whole change if any ticket isn't this
 *     company's;
 *   - "open → in progress" happens by itself the moment one of its tickets
 *     leaves the column new tickets land in — whatever that column is called
 *     (Ask Lou compared against "open" and "submitted") — and nothing ever
 *     completes an epic by itself;
 *   - no owner is only ever chosen, never what a "Me" default quietly saves.
 */

export class EpicChangeError extends Error {
  readonly name = "EpicChangeError";
  /** 400: fix the form; 409: the epic's own state is in the way (finished, a name in use). */
  constructor(
    message: string,
    readonly status: 400 | 409 = 400,
  ) {
    super(message);
  }
}

/** The most tickets one membership change takes. */
export const MAX_EPIC_TICKETS_PER_CALL = 200;
/** The most tickets an epic's page lists (its progress always counts them all). */
export const EPIC_TICKET_LIMIT = 500;
/** The most epics a company's board carries for its badges, filter and pickers. */
export const BOARD_EPIC_LIMIT = 500;

export interface EpicRow {
  id: string;
  name: string;
  description: string | null;
  status: EpicStatus;
  ownerId: string | null;
  ownerName: string | null;
  /** "YYYY-MM-DD", or null. */
  targetDate: string | null;
  color: EpicColor;
  completedAt: Date | null;
  archivedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EpicSummary extends EpicRow {
  progress: EpicProgress;
}

/** One of an epic's tickets, as its page lists them, with the bucket its progress counts it in. */
export interface EpicTicket {
  id: string;
  ticketNumber: string;
  title: string;
  status: string;
  /** The column's name ("In progress"); the key itself when no column has it. */
  statusLabel: string;
  priority: string;
  assignee: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  bucket: EpicBucket;
}

export interface EpicDetail extends EpicSummary {
  tickets: EpicTicket[];
  /** More tickets than EPIC_TICKET_LIMIT: the progress counts them all, the list shows the newest. */
  truncated: boolean;
}

/** What the board carries about each epic: the card's badge, the Epic filter, the pickers. */
export interface BoardEpic {
  id: string;
  name: string;
  color: EpicColor;
  status: EpicStatus;
}

/** Who leads an epic: one of the company's people (the handler looks the id up). */
export interface EpicOwner {
  readonly id: string;
  readonly name: string;
}

export interface EpicActor {
  readonly id: string | null;
  readonly name: string;
}

const EPIC_COLUMNS = {
  id: feedbackEpics.id,
  name: feedbackEpics.name,
  description: feedbackEpics.description,
  status: feedbackEpics.status,
  ownerId: feedbackEpics.ownerId,
  ownerName: feedbackEpics.ownerName,
  targetDate: feedbackEpics.targetDate,
  color: feedbackEpics.color,
  completedAt: feedbackEpics.completedAt,
  archivedAt: feedbackEpics.archivedAt,
  createdBy: feedbackEpics.createdBy,
  createdAt: feedbackEpics.createdAt,
  updatedAt: feedbackEpics.updatedAt,
} as const;

// ---------------------------------------------------------------------------
// The forms
// ---------------------------------------------------------------------------

const FIRST_YEAR = 2000;
const LAST_YEAR = 2999;

/** A day ("2026-11-30") that is a real date, or null for no date. */
const targetDateField = z
  .string()
  .trim()
  .refine((value) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const date = new Date(Date.UTC(y, m - 1, d));
    return y >= FIRST_YEAR && y <= LAST_YEAR && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  }, `Pick a date between ${FIRST_YEAR} and ${LAST_YEAR}.`)
  .nullable();

const nameField = z
  .string()
  .trim()
  .min(1, "Give the epic a name.")
  .max(120, "Keep the name under 120 characters.")
  .refine(noNul, NUL_MESSAGE);
const descriptionField = z
  .string()
  .trim()
  .max(2000, "Keep the description under 2000 characters.")
  .refine(noNul, NUL_MESSAGE)
  .nullable();
const colorField = z.enum(EPIC_COLOR_NAMES as [EpicColor, ...EpicColor[]], { message: "Pick one of the colours." });

/** A new epic. Only the name is needed; no owner unless one is chosen. */
export const createEpicSchema = z.object({
  name: nameField,
  description: descriptionField.optional(),
  targetDate: targetDateField.optional(),
  color: colorField.default("blue"),
});

/** An epic's edit. Absent = unchanged; null clears the description or the date. */
export const epicPatchSchema = z.object({
  name: nameField.optional(),
  description: descriptionField.optional(),
  targetDate: targetDateField.optional(),
  color: colorField.optional(),
});

const NAME_TAKEN = "There's already an epic with that name. Pick another, or open that one.";

async function nameTaken(db: FeedbackDb, tenantId: string, name: string, exceptId: string | null): Promise<boolean> {
  const rows = (await db
    .select({ id: feedbackEpics.id, name: feedbackEpics.name })
    .from(feedbackEpics)
    .where(eq(feedbackEpics.tenantId, tenantId))) as Array<{ id: string; name: string }>;
  return rows.some((row) => row.id !== exceptId && sameName(row.name, name));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** One of this company's epics; null for any other id. */
export async function findEpic(db: FeedbackDb, tenantId: string, epicId: string): Promise<EpicRow | null> {
  if (!isTenantId(tenantId) || typeof epicId !== "string" || epicId.length === 0 || epicId.length > 200) return null;
  const rows = (await db
    .select(EPIC_COLUMNS)
    .from(feedbackEpics)
    .where(and(eq(feedbackEpics.tenantId, tenantId), eq(feedbackEpics.id, epicId)))
    .limit(1)) as EpicRow[];
  return rows[0] ?? null;
}

/**
 * Each epic's tickets, inside the company: the un-archived ones counted per
 * column, and how many are archived (which progress counts as done).
 */
async function countsByEpic(
  db: FeedbackDb,
  tenantId: string,
  epicIds: readonly string[],
): Promise<Map<string, { counts: Record<string, number>; archived: number }>> {
  const out = new Map<string, { counts: Record<string, number>; archived: number }>();
  if (epicIds.length === 0) return out;
  const isArchived = sql<boolean>`(${feedbackTickets.archivedAt} is not null)`;
  const rows = (await db
    .select({ epicId: feedbackTickets.epicId, status: feedbackTickets.status, archived: isArchived, n: count() })
    .from(feedbackTickets)
    .where(and(eq(feedbackTickets.tenantId, tenantId), inArray(feedbackTickets.epicId, [...epicIds])))
    .groupBy(feedbackTickets.epicId, feedbackTickets.status, isArchived)) as Array<{ epicId: string; status: string; archived: boolean; n: number }>;
  for (const row of rows) {
    const entry = out.get(row.epicId) ?? { counts: {}, archived: 0 };
    if (row.archived === true || (row.archived as unknown) === "t") entry.archived += Number(row.n);
    else entry.counts[row.status] = (entry.counts[row.status] ?? 0) + Number(row.n);
    out.set(row.epicId, entry);
  }
  return out;
}

function progressOf(entry: { counts: Record<string, number>; archived: number } | undefined, columns: Parameters<typeof epicProgressFromCounts>[1]): EpicProgress {
  return epicProgressFromCounts(entry?.counts ?? {}, columns, entry?.archived ?? 0);
}

/** Still being worked on first, then finished, then archived; soonest date, then name, inside each. */
const STATUS_ORDER: Readonly<Record<EpicStatus, number>> = { in_progress: 0, open: 1, completed: 2, archived: 3 };

function byListOrder(a: EpicRow, b: EpicRow): number {
  const status = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
  if (status !== 0) return status;
  if (a.targetDate !== b.targetDate) {
    if (a.targetDate === null) return 1;
    if (b.targetDate === null) return -1;
    return a.targetDate < b.targetDate ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

/**
 * This company's epics, each with its progress — the epics list. Every
 * status, archived included (the list's own filter hides those by default),
 * so a restore is always one click away.
 */
export async function listEpics(db: FeedbackDb, tenantId: string): Promise<EpicSummary[]> {
  if (!isTenantId(tenantId)) return [];
  const epics = (await db
    .select(EPIC_COLUMNS)
    .from(feedbackEpics)
    .where(eq(feedbackEpics.tenantId, tenantId))
    .orderBy(desc(feedbackEpics.createdAt), desc(feedbackEpics.id))
    .limit(BOARD_EPIC_LIMIT)) as EpicRow[];
  if (epics.length === 0) return [];
  const columns = await columnFlags(db, tenantId);
  const counts = await countsByEpic(
    db,
    tenantId,
    epics.map((epic) => epic.id),
  );
  return epics
    .sort(byListOrder)
    .map((epic) => ({ ...epic, progress: progressOf(counts.get(epic.id), columns) }));
}

/** One epic with its progress and its tickets (newest first, archived ones included); null for any other id. */
export async function getEpic(db: FeedbackDb, tenantId: string, epicId: string): Promise<EpicDetail | null> {
  const epic = await findEpic(db, tenantId, epicId);
  if (!epic) return null;
  const columns = await columnFlags(db, tenantId);
  const landing = landingColumnOf(columns);
  const labels = new Map(columns.map((column) => [column.key, column.label]));
  const progress = progressOf((await countsByEpic(db, tenantId, [epic.id])).get(epic.id), columns);
  const rows = (await db
    .select({
      id: feedbackTickets.id,
      ticketNumber: feedbackTickets.ticketNumber,
      title: feedbackTickets.title,
      status: feedbackTickets.status,
      priority: feedbackTickets.priority,
      assignee: feedbackTickets.assignee,
      archivedAt: feedbackTickets.archivedAt,
      createdAt: feedbackTickets.createdAt,
    })
    .from(feedbackTickets)
    .where(and(eq(feedbackTickets.tenantId, tenantId), eq(feedbackTickets.epicId, epic.id)))
    .orderBy(desc(feedbackTickets.createdAt), desc(feedbackTickets.id))
    .limit(EPIC_TICKET_LIMIT)) as Array<Omit<EpicTicket, "statusLabel" | "bucket">>;
  const tickets = rows.map((row) => ({
    ...row,
    statusLabel: labels.get(row.status) ?? row.status,
    // The SAME rule the counts used, so a ticket is listed in the group it's
    // counted in (an archived one under Done).
    bucket: epicBucketOf(row.status, columns, landing, row.archivedAt !== null),
  }));
  return { ...epic, progress, tickets, truncated: progress.total > tickets.length };
}

/** This company's epics as the board carries them: each one's name, colour and status. */
export async function listBoardEpics(db: FeedbackDb, tenantId: string): Promise<BoardEpic[]> {
  if (!isTenantId(tenantId)) return [];
  const rows = (await db
    .select({ id: feedbackEpics.id, name: feedbackEpics.name, color: feedbackEpics.color, status: feedbackEpics.status })
    .from(feedbackEpics)
    .where(eq(feedbackEpics.tenantId, tenantId))
    .orderBy(asc(feedbackEpics.name), asc(feedbackEpics.id))
    .limit(BOARD_EPIC_LIMIT)) as BoardEpic[];
  return rows.sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Make an epic. `owner` arrives already looked up (one of the company's people), or null for nobody. */
export async function createEpic(
  db: FeedbackDb,
  tenantId: string,
  input: z.input<typeof createEpicSchema> & { readonly owner?: EpicOwner | null },
  actor: EpicActor,
  now: Date = new Date(),
): Promise<EpicSummary> {
  if (!isTenantId(tenantId)) throw new Error("createEpic: pass the company");
  const parsed = createEpicSchema.parse(input);
  if (await nameTaken(db, tenantId, parsed.name, null)) throw new EpicChangeError(NAME_TAKEN, 409);
  const owner = input.owner ?? null;
  try {
    const [row] = (await db
      .insert(feedbackEpics)
      .values({
        tenantId,
        name: parsed.name,
        description: parsed.description || null,
        targetDate: parsed.targetDate ?? null,
        color: parsed.color,
        ownerId: owner ? owner.id : null,
        ownerName: owner ? owner.name.slice(0, 120) : null,
        createdBy: actor.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning(EPIC_COLUMNS)) as EpicRow[];
    if (!row) throw new Error("epic insert returned no row");
    return { ...row, progress: EMPTY_PROGRESS };
  } catch (error) {
    if (isUniqueViolation(error)) throw new EpicChangeError(NAME_TAKEN, 409);
    throw error;
  }
}

/**
 * Edit one of this company's epics: its name, description, date, colour and
 * owner (`owner: null` clears it; absent leaves it). Null: not this company's.
 */
export async function updateEpic(
  db: FeedbackDb,
  tenantId: string,
  epicId: string,
  input: z.input<typeof epicPatchSchema> & { readonly owner?: EpicOwner | null },
  now: Date = new Date(),
): Promise<EpicRow | null> {
  const epic = await findEpic(db, tenantId, epicId);
  if (!epic) return null;
  const { owner, ...fields } = input;
  const patch = epicPatchSchema.parse(fields);
  if (patch.name !== undefined && !sameName(patch.name, epic.name) && (await nameTaken(db, tenantId, patch.name, epic.id))) {
    throw new EpicChangeError(NAME_TAKEN, 409);
  }
  const set: Partial<typeof feedbackEpics.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description || null;
  if (patch.targetDate !== undefined) set.targetDate = patch.targetDate;
  if (patch.color !== undefined) set.color = patch.color;
  if (owner !== undefined) {
    set.ownerId = owner ? owner.id : null;
    set.ownerName = owner ? owner.name.slice(0, 120) : null;
  }
  if (Object.keys(set).length === 0) return epic;
  set.updatedAt = now;
  try {
    const [row] = (await db
      .update(feedbackEpics)
      .set(set)
      .where(and(eq(feedbackEpics.tenantId, tenantId), eq(feedbackEpics.id, epic.id)))
      .returning(EPIC_COLUMNS)) as EpicRow[];
    return row ?? null;
  } catch (error) {
    // Two renames to one name at once: the unique index decides (review L1).
    if (isUniqueViolation(error)) throw new EpicChangeError(NAME_TAKEN, 409);
    throw error;
  }
}

const statusField = z.enum(["open", "in_progress", "completed", "archived"], { message: "That isn't a status an epic can have." });

/** The sentence for a move the table doesn't allow. */
function refusedMove(from: EpicStatus, to: EpicStatus): string {
  if (from === "archived") return `An archived epic can only be restored (to ${EPIC_STATUS_LABELS.open}) first.`;
  return `An epic can't go from ${EPIC_STATUS_LABELS[from]} to ${EPIC_STATUS_LABELS[to]}.`;
}

/**
 * Move an epic along its life, by EPIC_TRANSITIONS — anything else is refused
 * with a sentence. The stamps follow (Ask Lou's): completed sets
 * `completedAt`; archived sets `archivedAt`; back to work clears both.
 * Null: not this company's epic.
 */
export async function setEpicStatus(
  db: FeedbackDb,
  tenantId: string,
  epicId: string,
  status: string,
  now: Date = new Date(),
): Promise<{ readonly changed: boolean; readonly epic: EpicRow } | null> {
  const to = statusField.parse(status);
  const epic = await findEpic(db, tenantId, epicId);
  if (!epic) return null;
  if (epic.status === to) return { changed: false, epic };
  if (!canMoveEpic(epic.status, to)) throw new EpicChangeError(refusedMove(epic.status, to), 409);
  const set: Partial<typeof feedbackEpics.$inferInsert> = { status: to, updatedAt: now };
  if (to === "completed") {
    set.completedAt = now;
    set.archivedAt = null;
  } else if (to === "archived") {
    set.archivedAt = now;
  } else {
    set.completedAt = null;
    set.archivedAt = null;
  }
  const [row] = (await db
    .update(feedbackEpics)
    .set(set)
    .where(and(eq(feedbackEpics.tenantId, tenantId), eq(feedbackEpics.id, epic.id), eq(feedbackEpics.status, epic.status)))
    .returning(EPIC_COLUMNS)) as EpicRow[];
  // Someone else moved it between the read and the write: say so rather than overwrite.
  if (!row) throw new EpicChangeError("Someone else just changed this epic. Refresh to see it as it is.", 409);
  // Back to "not started" with tickets already under way (a restore, a
  // reopen): the automatic start runs, so it says what is true (review L5).
  if (to === "open" && (await autoStartEpics(db, tenantId, [row.id], now)).length > 0) {
    return { changed: true, epic: (await findEpic(db, tenantId, row.id)) ?? row };
  }
  return { changed: true, epic: row };
}

/** The sentence for adding tickets to an epic that isn't being worked on. */
export function closedEpicMessage(status: EpicStatus): string {
  return status === "archived"
    ? "This epic is archived. Restore it before adding tickets."
    : "This epic is completed. Reopen it before adding tickets.";
}

const NOT_ON_BOARD = "Some of those tickets aren't on this board any more. Refresh and try again.";
/** The epic was deleted (or finished) while the change was on its way. */
const GONE_EPIC = "This epic was just deleted or finished by someone else. Refresh to see it as it is.";

/** A foreign key refused the write: the row it points at is gone (Postgres 23503). */
export function isForeignKeyViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code ?? (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return code === "23503";
}

const ticketIdsField = z
  .array(z.string().min(1).max(200))
  .max(MAX_EPIC_TICKETS_PER_CALL, `Change up to ${MAX_EPIC_TICKETS_PER_CALL} tickets at a time.`);

export const epicTicketsSchema = z.object({
  add: ticketIdsField.default([]),
  remove: ticketIdsField.default([]),
});

export interface EpicTicketsResult {
  /** Tickets put into this epic (including ones moved from another). */
  readonly added: number;
  /** Of those, how many were in another epic before. */
  readonly movedFromOther: number;
  /** Tickets taken out of this epic. */
  readonly removed: number;
}

/** The names of this company's epics, by id — the trail's words. */
async function epicNames(db: FeedbackDb, tenantId: string, ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = (await db
    .select({ id: feedbackEpics.id, name: feedbackEpics.name })
    .from(feedbackEpics)
    .where(and(eq(feedbackEpics.tenantId, tenantId), inArray(feedbackEpics.id, unique)))) as Array<{ id: string; name: string }>;
  return new Map(rows.map((row) => [row.id, row.name]));
}

/**
 * Put tickets into an epic and take others out, in one change (Ask Lou's only
 * added). EVERYTHING IS CHECKED BEFORE ANYTHING IS WRITTEN: every id must be
 * one of THIS company's tickets (one that isn't refuses the whole change, so
 * nothing of another company is ever touched, and nothing half-happens), and
 * adding needs an epic still being worked on. A ticket already in another
 * epic moves here — `movedFromOther` says how many, and the screen asked
 * first. Each ticket that changed gets a line on its trail; the epic starts
 * by itself if one of its tickets already has. Null: not this company's epic.
 */
export async function setEpicTickets(
  db: FeedbackDb,
  tenantId: string,
  epicId: string,
  input: z.input<typeof epicTicketsSchema>,
  actor: EpicActor,
  now: Date = new Date(),
): Promise<EpicTicketsResult | null> {
  const parsed = epicTicketsSchema.parse(input);
  const add = [...new Set(parsed.add)];
  const remove = [...new Set(parsed.remove)];
  if (add.some((id) => remove.includes(id))) throw new EpicChangeError("A ticket can't be added and taken out in the same change.");
  if (add.length + remove.length > MAX_EPIC_TICKETS_PER_CALL) {
    throw new EpicChangeError(`Change up to ${MAX_EPIC_TICKETS_PER_CALL} tickets at a time.`);
  }
  const epic = await findEpic(db, tenantId, epicId);
  if (!epic) return null;
  if (add.length > 0 && !takesTickets(epic.status)) throw new EpicChangeError(closedEpicMessage(epic.status), 409);
  const ids = [...add, ...remove];
  if (ids.length === 0) return { added: 0, movedFromOther: 0, removed: 0 };
  const rows = (await db
    .select({ id: feedbackTickets.id, epicId: feedbackTickets.epicId })
    .from(feedbackTickets)
    .where(and(eq(feedbackTickets.tenantId, tenantId), inArray(feedbackTickets.id, ids)))) as Array<{ id: string; epicId: string | null }>;
  if (rows.length !== ids.length) throw new EpicChangeError(NOT_ON_BOARD);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const adding = add.map((id) => byId.get(id)!).filter((row) => row.epicId !== epic.id);
  const removing = remove.map((id) => byId.get(id)!).filter((row) => row.epicId === epic.id);
  const others = await epicNames(
    db,
    tenantId,
    adding.flatMap((row) => (row.epicId ? [row.epicId] : [])),
  );

  if (adding.length > 0) {
    // In ONE statement, and only while the epic is still there and still
    // taking tickets (review L2): an epic deleted, finished or archived since
    // it was read above adds nothing. The foreign key on epic_id backs it up —
    // a ticket can never point at an epic that doesn't exist — on every
    // driver, transactions or not.
    let added: Array<{ id: string }>;
    try {
      added = (await db
        .update(feedbackTickets)
        .set({ epicId: epic.id })
        .where(
          and(
            eq(feedbackTickets.tenantId, tenantId),
            inArray(feedbackTickets.id, adding.map((row) => row.id)),
            exists(
              db
                .select({ one: sql`1` })
                .from(feedbackEpics)
                .where(
                  and(
                    eq(feedbackEpics.tenantId, tenantId),
                    eq(feedbackEpics.id, epic.id),
                    inArray(feedbackEpics.status, ["open", "in_progress"]),
                  ),
                ),
            ),
          ),
        )
        .returning({ id: feedbackTickets.id })) as Array<{ id: string }>;
    } catch (error) {
      if (isForeignKeyViolation(error)) throw new EpicChangeError(GONE_EPIC);
      throw error;
    }
    if (added.length === 0) throw new EpicChangeError(GONE_EPIC);
  }
  if (removing.length > 0) {
    await db
      .update(feedbackTickets)
      .set({ epicId: null })
      .where(
        and(
          eq(feedbackTickets.tenantId, tenantId),
          eq(feedbackTickets.epicId, epic.id),
          inArray(feedbackTickets.id, removing.map((row) => row.id)),
        ),
      );
  }
  const by = { actorId: actor.id, actorName: actor.name };
  const drafts: EventDraft[] = [
    ...adding.map((row) => ({
      ...by,
      ticketId: row.id,
      kind: "epic" as const,
      fromValue: row.epicId ? (others.get(row.epicId) ?? null) : null,
      toValue: epic.name,
    })),
    ...removing.map((row) => ({ ...by, ticketId: row.id, kind: "epic" as const, fromValue: epic.name, toValue: null })),
  ];
  await recordEventsQuietly(db, tenantId, drafts, now);
  await db
    .update(feedbackEpics)
    .set({ updatedAt: now })
    .where(and(eq(feedbackEpics.tenantId, tenantId), eq(feedbackEpics.id, epic.id)));
  await autoStartEpics(db, tenantId, [epic.id], now);
  return { added: adding.length, movedFromOther: adding.filter((row) => row.epicId !== null).length, removed: removing.length };
}

/**
 * Delete one of this company's epics. NEVER REFUSED for holding tickets: they
 * stay on the board — archived ones too — and simply leave the epic, each
 * with a line on its trail. Null: not this company's epic.
 *
 * A ticket added while this runs (review L2) can't be left pointing at the
 * deleted epic: the foreign key on epic_id clears it as the epic row goes
 * (ON DELETE SET NULL), and an add that comes after finds no epic to add to.
 */
export async function deleteEpic(
  db: FeedbackDb,
  tenantId: string,
  epicId: string,
  actor: EpicActor,
  now: Date = new Date(),
): Promise<{ readonly deleted: true; readonly detached: number } | null> {
  const epic = await findEpic(db, tenantId, epicId);
  if (!epic) return null;
  const detached = (await db
    .update(feedbackTickets)
    .set({ epicId: null })
    .where(and(eq(feedbackTickets.tenantId, tenantId), eq(feedbackTickets.epicId, epic.id)))
    .returning({ id: feedbackTickets.id })) as Array<{ id: string }>;
  await recordEventsQuietly(
    db,
    tenantId,
    detached.map((row) => ({
      ticketId: row.id,
      kind: "epic" as const,
      fromValue: epic.name,
      toValue: null,
      actorId: actor.id,
      actorName: actor.name,
    })),
    now,
  );
  await db.delete(feedbackEpics).where(and(eq(feedbackEpics.tenantId, tenantId), eq(feedbackEpics.id, epic.id)));
  return { deleted: true, detached: detached.length };
}

// ---------------------------------------------------------------------------
// A ticket's own epic (the panel's picker, New ticket) and the starts
// ---------------------------------------------------------------------------

const STALE_EPIC = "That epic isn't on this board any more. Refresh to see the board's epics.";

/** The refusal for a ticket write whose epic was deleted on the way (the foreign key said so). */
export function staleEpicError(): EpicChangeError {
  return new EpicChangeError(STALE_EPIC);
}

/**
 * The epic a ticket is being put in, checked: one of THIS company's (else a
 * sentence, never a write), and still taking tickets — unless it is the
 * ticket's current epic, which it may stay in whatever its status.
 */
export async function epicForTicket(
  db: FeedbackDb,
  tenantId: string,
  epicId: string,
  currentEpicId: string | null = null,
): Promise<EpicRow> {
  const epic = await findEpic(db, tenantId, epicId);
  if (!epic) throw new EpicChangeError(STALE_EPIC);
  if (epic.id !== currentEpicId && !takesTickets(epic.status)) throw new EpicChangeError(closedEpicMessage(epic.status), 409);
  return epic;
}

/** An epic's name for the trail, inside the company (null when it has none by that id). */
export async function epicNameOf(db: FeedbackDb, tenantId: string, epicId: string | null): Promise<string | null> {
  if (!epicId) return null;
  return (await epicNames(db, tenantId, [epicId])).get(epicId) ?? null;
}

/**
 * The automatic start (Ask Lou's auto-bump, without its hardcoded names): an
 * epic still "not started" becomes "in progress" the moment any of its
 * un-archived tickets is anywhere but the column new tickets land in. Never
 * the other way, and never to completed. Returns the epics it started.
 */
export async function autoStartEpics(db: FeedbackDb, tenantId: string, epicIds: readonly string[], now: Date = new Date()): Promise<string[]> {
  const ids = [...new Set(epicIds.filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (!isTenantId(tenantId) || ids.length === 0) return [];
  const waiting = (await db
    .select({ id: feedbackEpics.id })
    .from(feedbackEpics)
    .where(and(eq(feedbackEpics.tenantId, tenantId), inArray(feedbackEpics.id, ids), eq(feedbackEpics.status, "open")))) as Array<{
    id: string;
  }>;
  if (waiting.length === 0) return [];
  const columns = await columnFlags(db, tenantId);
  const landing = landingColumnOf(columns);
  const rows = (await db
    .select({ epicId: feedbackTickets.epicId, status: feedbackTickets.status })
    .from(feedbackTickets)
    .where(
      and(
        eq(feedbackTickets.tenantId, tenantId),
        inArray(
          feedbackTickets.epicId,
          waiting.map((row) => row.id),
        ),
        isNull(feedbackTickets.archivedAt),
      ),
    )
    .groupBy(feedbackTickets.epicId, feedbackTickets.status)) as Array<{ epicId: string; status: string }>;
  const started = [...new Set(rows.filter((row) => epicBucketOf(row.status, columns, landing) !== "open").map((row) => row.epicId))];
  if (started.length === 0) return [];
  await db
    .update(feedbackEpics)
    .set({ status: "in_progress", updatedAt: now })
    .where(and(eq(feedbackEpics.tenantId, tenantId), inArray(feedbackEpics.id, started), eq(feedbackEpics.status, "open")));
  return started;
}

/**
 * The start, for tickets that just moved (a drag, a bulk move, a column's
 * tickets moved before it's deleted): the epics they're in. Best-effort, like
 * the trail — a move never fails because its epic couldn't start.
 */
export async function autoStartEpicsOfTickets(
  db: FeedbackDb,
  tenantId: string,
  ticketIds: readonly string[],
  now: Date = new Date(),
): Promise<void> {
  if (!isTenantId(tenantId) || ticketIds.length === 0) return;
  try {
    const rows = (await db
      .selectDistinct({ epicId: feedbackTickets.epicId })
      .from(feedbackTickets)
      .where(and(eq(feedbackTickets.tenantId, tenantId), inArray(feedbackTickets.id, [...ticketIds]), isNotNull(feedbackTickets.epicId)))) as Array<{
      epicId: string;
    }>;
    await autoStartEpics(
      db,
      tenantId,
      rows.map((row) => row.epicId),
      now,
    );
  } catch {
    /* the move stands */
  }
}
