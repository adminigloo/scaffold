import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, max, notInArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  CLIENT_KEY_PREFIX,
  DEFAULT_CATEGORIES,
  generateClientKey,
  generateReporterToken,
  hashClientKey,
  hashReporterToken,
  isTenantId,
  type FeedbackCategoryOption,
  type FeedbackDb,
  type SubmitPayload,
} from "./core.js";
import {
  EMPTY_FILTERS,
  FILTER_ME,
  FILTER_NAMED_PREFIX,
  FILTER_NONE,
  FILTER_PRIORITIES,
  namedAssignee,
  FILTER_SOURCES,
  MAX_FILTER_VALUES,
  MAX_SEARCH_LENGTH,
  PRIORITY_LABELS,
  type BoardFilters,
} from "./board-filters.js";
import {
  feedbackBoards,
  feedbackCategories,
  feedbackClientKeys,
  feedbackMessages,
  feedbackStatuses,
  feedbackTicketEvents,
  feedbackTickets,
  type FeedbackTicketEventKind,
  type FeedbackTicketSource,
} from "./schema.js";
import { isUniqueViolation, noNul, NUL_MESSAGE, recordEventsQuietly, sameName, type EventDraft } from "./board-shared.js";
import {
  autoStartEpics,
  autoStartEpicsOfTickets,
  epicForTicket,
  epicNameOf,
  isForeignKeyViolation,
  listBoardEpics,
  staleEpicError,
  type BoardEpic,
} from "./epics-data.js";

/**
 * The board's server half: every read and write a company's staff screens
 * (and the intake) make.
 *
 * EVERY FUNCTION TAKES THE COMPANY (`tenantId`) AND ONLY EVER READS OR WRITES
 * THAT COMPANY'S ROWS (0.10.0). A ticket, column, category or website key of
 * another company, asked for by id, is simply not there: the function answers
 * the same "not found" it gives for an id that never existed, so a caller can't
 * tell the two apart. The company is in the WHERE of every statement — never a
 * filter applied afterwards — and a message is reached through its ticket's
 * company (feedback_messages has no company column of its own).
 *
 * 0.9's functions took no company and acted on the whole install. Their
 * signatures changed on purpose: a call that compiles against 0.9 and silently
 * reads every company's board is the one outcome worse than a type error.
 */

// ---------------------------------------------------------------------------
// The board's first-time setup
// ---------------------------------------------------------------------------

/**
 * A company's columns before it has changed anything. Resolved and Closed are
 * finished columns: they are what "Archive done" sweeps, and a reporter can't
 * reply on a ticket sitting in one.
 */
export const DEFAULT_BOARD_STATUSES = [
  { key: "open", label: "Open", color: "#1f6fff", sortOrder: 10 },
  { key: "in_progress", label: "In progress", color: "#ff8a00", sortOrder: 20 },
  { key: "resolved", label: "Resolved", color: "#12b23b", sortOrder: 30, isTerminal: true },
  { key: "closed", label: "Closed", color: "#6b7280", sortOrder: 40, isTerminal: true },
] as const;

/**
 * Give a company's board its default columns and categories, the first time
 * it's used — and only then. 0.11.0: "the first time" is remembered
 * (feedback_boards), so a company that deletes every category, or every
 * column it can, never gets the defaults back; 0.10 re-seeded any list that
 * was empty.
 *
 * IDEMPOTENT AND RACE-SAFE. Two first requests at once both see "no rows" and
 * both insert; the unique index on (company, key) and ON CONFLICT DO NOTHING
 * make the second a no-op, so the board never gets two "Open" columns.
 *
 * Returns how many rows it added (0 every time after the first).
 */
export async function ensureFeedbackBoard(
  db: FeedbackDb,
  tenantId: string,
): Promise<{ readonly statuses: number; readonly categories: number }> {
  if (!isTenantId(tenantId)) return { statuses: 0, categories: 0 };
  const [setUp] = await db.select({ tenantId: feedbackBoards.tenantId }).from(feedbackBoards).where(eq(feedbackBoards.tenantId, tenantId)).limit(1);
  if (setUp) return { statuses: 0, categories: 0 };
  let statuses = 0;
  let categories = 0;
  const [statusCount] = (await db
    .select({ n: count() })
    .from(feedbackStatuses)
    .where(eq(feedbackStatuses.tenantId, tenantId))) as Array<{ n: number }>;
  if (Number(statusCount?.n ?? 0) === 0) {
    const added = (await db
      .insert(feedbackStatuses)
      .values(DEFAULT_BOARD_STATUSES.map((status) => ({ ...status, tenantId })))
      .onConflictDoNothing({ target: [feedbackStatuses.tenantId, feedbackStatuses.key] })
      .returning({ id: feedbackStatuses.id })) as Array<{ id: string }>;
    statuses = added.length;
  }
  const [categoryCount] = (await db
    .select({ n: count() })
    .from(feedbackCategories)
    .where(eq(feedbackCategories.tenantId, tenantId))) as Array<{ n: number }>;
  if (Number(categoryCount?.n ?? 0) === 0) {
    const added = (await db
      .insert(feedbackCategories)
      .values(
        DEFAULT_CATEGORIES.map((category, index) => ({
          tenantId,
          key: category.key,
          label: category.label,
          description: category.description ?? null,
          sortOrder: (index + 1) * 10,
        })),
      )
      .onConflictDoNothing({ target: [feedbackCategories.tenantId, feedbackCategories.key] })
      .returning({ id: feedbackCategories.id })) as Array<{ id: string }>;
    categories = added.length;
  }
  // Written AFTER the defaults, so a request that sees the mark sees a board
  // with its columns; two first requests at once both seed (harmlessly, the
  // unique indexes decide) and both mark (ON CONFLICT).
  await db.insert(feedbackBoards).values({ tenantId }).onConflictDoNothing({ target: feedbackBoards.tenantId });
  return { statuses, categories };
}

// ---------------------------------------------------------------------------
// Columns (statuses)
// ---------------------------------------------------------------------------

export interface BoardStatus {
  id: string;
  key: string;
  label: string;
  color: string | null;
  sortOrder: number;
  isTerminal: boolean;
  /** Work here waits on someone else (0.12.0): an epic's progress counts it as "waiting". */
  isWaiting: boolean;
  wipLimit: number | null;
  agingWarnHours: number | null;
  agingStaleHours: number | null;
  allowAiTransition: boolean;
}

const BOARD_STATUS_COLUMNS = {
  id: feedbackStatuses.id,
  key: feedbackStatuses.key,
  label: feedbackStatuses.label,
  color: feedbackStatuses.color,
  sortOrder: feedbackStatuses.sortOrder,
  isTerminal: feedbackStatuses.isTerminal,
  isWaiting: feedbackStatuses.isWaiting,
  wipLimit: feedbackStatuses.wipLimit,
  agingWarnHours: feedbackStatuses.agingWarnHours,
  agingStaleHours: feedbackStatuses.agingStaleHours,
  allowAiTransition: feedbackStatuses.allowAiTransition,
} as const;

/** A company's columns, in board order. */
export async function listStatuses(db: FeedbackDb, tenantId: string): Promise<BoardStatus[]> {
  if (!isTenantId(tenantId)) return [];
  return db
    .select(BOARD_STATUS_COLUMNS)
    .from(feedbackStatuses)
    .where(eq(feedbackStatuses.tenantId, tenantId))
    .orderBy(asc(feedbackStatuses.sortOrder), asc(feedbackStatuses.key));
}

/** A column with how many tickets sit in it (archived ones included): the settings screen's list. */
export interface ColumnWithCount extends BoardStatus {
  ticketCount: number;
}

export async function listColumnsWithCounts(db: FeedbackDb, tenantId: string): Promise<ColumnWithCount[]> {
  if (!isTenantId(tenantId)) return [];
  await ensureFeedbackBoard(db, tenantId);
  const statuses = await listStatuses(db, tenantId);
  const counts = (await db
    .select({ status: feedbackTickets.status, n: count() })
    .from(feedbackTickets)
    .where(eq(feedbackTickets.tenantId, tenantId))
    .groupBy(feedbackTickets.status)) as Array<{ status: string; n: number }>;
  const byStatus = new Map(counts.map((row) => [row.status, Number(row.n)]));
  return statuses.map((status) => ({ ...status, ticketCount: byStatus.get(status.key) ?? 0 }));
}

/** Stable machine names only: the ticket rows reference these as plain text. */
export const statusKeySchema = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[a-z][a-z0-9_]*$/, "Use lowercase letters, digits and underscores, starting with a letter.");

/**
 * Warn must come before stale when both are set — an amber that fires after
 * the red is a config that looks fine and behaves backwards, refused here
 * once for every surface that edits a column.
 */
function agingOrdered(input: {
  agingWarnHours?: number | null | undefined;
  agingStaleHours?: number | null | undefined;
}): boolean {
  if (input.agingWarnHours == null || input.agingStaleHours == null) return true;
  return input.agingWarnHours < input.agingStaleHours;
}

const AGING_MESSAGE = "The warning has to come before the overdue mark: make its hours smaller.";

export const createStatusSchema = z
  .object({
    /** A suggestion (0.11.0): made from the name when absent, and given a number when taken. */
    key: statusKeySchema.optional(),
    label: z.string().trim().min(1).max(60),
    color: z.string().max(30).nullish(),
    sortOrder: z.number().int().min(0).max(100000).optional(),
    isTerminal: z.boolean().optional(),
    isWaiting: z.boolean().optional(),
    wipLimit: z.number().int().min(1).max(9999).nullish(),
    agingWarnHours: z.number().int().min(1).max(8760).nullish(),
    agingStaleHours: z.number().int().min(1).max(8760).nullish(),
    allowAiTransition: z.boolean().optional(),
  })
  .refine(agingOrdered, { message: AGING_MESSAGE, path: ["agingWarnHours"] });

/**
 * KEY IS NOT UPDATABLE, and that is the design rather than an omission:
 * tickets reference a status by its key as plain text, so renaming a key
 * would strand every ticket in a column that no longer exists. The label is
 * what people see and it changes freely; the key is an identifier.
 */
export const updateStatusSchema = z
  .object({
    id: z.string().min(1).max(200),
    label: z.string().trim().min(1).max(60).optional(),
    color: z.string().max(30).nullish(),
    sortOrder: z.number().int().min(0).max(100000).optional(),
    isTerminal: z.boolean().optional(),
    isWaiting: z.boolean().optional(),
    wipLimit: z.number().int().min(1).max(9999).nullish(),
    agingWarnHours: z.number().int().min(1).max(8760).nullish(),
    agingStaleHours: z.number().int().min(1).max(8760).nullish(),
    allowAiTransition: z.boolean().optional(),
  })
  .refine(agingOrdered, { message: AGING_MESSAGE, path: ["agingWarnHours"] });

/** A column key this company already has (the unique index said so). */
export class DuplicateKeyError extends Error {
  readonly name = "DuplicateKeyError";
  constructor(readonly what: "column" | "category", readonly key: string) {
    // Plain words: the person typed a NAME (the short name is made from it),
    // so the sentence is about the name, never "key".
    super(what === "column" ? "This board already has a column with that name." : "There's already a category with that name.");
  }
}

/** A name as the short name tickets point at: "Waiting on customer" → "waiting_on_customer". */
export function keyFromLabel(label: string): string {
  const base = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50);
  if (!base) return "column";
  return /^[a-z]/.test(base) ? base : `c_${base}`.slice(0, 50);
}


/**
 * The short name to store (0.11.0): the suggestion if it's free, else the
 * suggestion with the next free number ("open_2"). Short names are never
 * shown and never change, so a column once called "Open" and renamed still
 * holds "open" — 0.10 then refused a new column named "Open" with "already
 * has a column with that name", which was untrue. Only the NAME people see
 * has to be unique.
 */
function freeKey(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base.slice(0, 50 - String(n).length - 1)}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}


export async function createStatus(
  db: FeedbackDb,
  tenantId: string,
  input: z.input<typeof createStatusSchema>,
): Promise<BoardStatus> {
  if (!isTenantId(tenantId)) throw new Error("createStatus: pass the company");
  const parsed = createStatusSchema.parse(input);
  // A company's very first column write still gets the default columns first,
  // so "add a column" never leaves the board with ONLY that one.
  await ensureFeedbackBoard(db, tenantId);
  const sortOrder =
    parsed.sortOrder ??
    // Default to the end of the board: the person adding a column almost
    // always means "after the ones I have", and 10-spacing leaves room to
    // reorder without renumbering everything.
    (await db
      .select({ sortOrder: feedbackStatuses.sortOrder })
      .from(feedbackStatuses)
      .where(eq(feedbackStatuses.tenantId, tenantId))
      .orderBy(desc(feedbackStatuses.sortOrder))
      .limit(1)
      .then((rows: Array<{ sortOrder: number }>) => (rows[0]?.sortOrder ?? 0) + 10));
  const base = parsed.key ?? keyFromLabel(parsed.label);
  for (let attempt = 0; ; attempt += 1) {
    const existing = (await db
      .select({ key: feedbackStatuses.key, label: feedbackStatuses.label })
      .from(feedbackStatuses)
      .where(eq(feedbackStatuses.tenantId, tenantId))) as Array<{ key: string; label: string }>;
    if (existing.some((row) => sameName(row.label, parsed.label))) throw new DuplicateKeyError("column", base);
    const key = freeKey(base, new Set(existing.map((row) => row.key)));
    try {
      const rows = await db
        .insert(feedbackStatuses)
        .values({
          tenantId,
          key,
          label: parsed.label,
          color: parsed.color ?? null,
          sortOrder,
          isTerminal: parsed.isTerminal ?? false,
          isWaiting: parsed.isWaiting ?? false,
          wipLimit: parsed.wipLimit ?? null,
          agingWarnHours: parsed.agingWarnHours ?? null,
          agingStaleHours: parsed.agingStaleHours ?? null,
          allowAiTransition: parsed.allowAiTransition ?? false,
        })
        .returning(BOARD_STATUS_COLUMNS);
      const row = rows[0];
      if (!row) throw new Error("status insert returned no row");
      return row;
    } catch (error) {
      // Another add took that short name between the read and the insert: try the next.
      if (isUniqueViolation(error) && attempt < 5) continue;
      if (isUniqueViolation(error)) throw new DuplicateKeyError("column", base);
      throw error;
    }
  }
}

/** False: no such column on this company's board. */
export async function updateStatus(
  db: FeedbackDb,
  tenantId: string,
  input: z.input<typeof updateStatusSchema>,
): Promise<boolean> {
  if (!isTenantId(tenantId)) return false;
  const parsed = updateStatusSchema.parse(input);
  if (parsed.label !== undefined) {
    const others = (await db
      .select({ id: feedbackStatuses.id, label: feedbackStatuses.label })
      .from(feedbackStatuses)
      .where(eq(feedbackStatuses.tenantId, tenantId))) as Array<{ id: string; label: string }>;
    if (others.some((row) => row.id !== parsed.id && sameName(row.label, parsed.label!))) throw new DuplicateKeyError("column", parsed.id);
  }
  const patch: Record<string, unknown> = {};
  if (parsed.label !== undefined) patch["label"] = parsed.label;
  if (parsed.color !== undefined) patch["color"] = parsed.color;
  if (parsed.sortOrder !== undefined) patch["sortOrder"] = parsed.sortOrder;
  if (parsed.isTerminal !== undefined) patch["isTerminal"] = parsed.isTerminal;
  if (parsed.isWaiting !== undefined) patch["isWaiting"] = parsed.isWaiting;
  if (parsed.wipLimit !== undefined) patch["wipLimit"] = parsed.wipLimit;
  if (parsed.agingWarnHours !== undefined) patch["agingWarnHours"] = parsed.agingWarnHours;
  if (parsed.agingStaleHours !== undefined) patch["agingStaleHours"] = parsed.agingStaleHours;
  if (parsed.allowAiTransition !== undefined) patch["allowAiTransition"] = parsed.allowAiTransition;
  const where = and(eq(feedbackStatuses.tenantId, tenantId), eq(feedbackStatuses.id, parsed.id));
  if (Object.keys(patch).length === 0) {
    const found = await db.select({ id: feedbackStatuses.id }).from(feedbackStatuses).where(where).limit(1);
    return found.length > 0;
  }
  const rows = (await db.update(feedbackStatuses).set(patch).where(where).returning({ id: feedbackStatuses.id })) as Array<{
    id: string;
  }>;
  return rows.length > 0;
}

export type DeleteStatusResult =
  | {
      deleted: true;
      moved?: number;
      /** The column the tickets went to, and each moved ticket with where it was (0.11.0: for `ticket.moved`). */
      to?: BoardStatus;
      tickets?: ReadonlyArray<{ id: string; from: string }>;
    }
  | { deleted: false; reason: "unknown" | "occupied" | "unknown-target" | "last"; ticketCount?: number };

/**
 * Delete a column. One that holds tickets is refused, saying how many — the
 * alternative is tickets whose status points at nothing — UNLESS `moveTo`
 * names another of this company's columns (0.11.0): its tickets are moved
 * there first (each a line on its trail, by `actor`), then the column goes.
 * The editor asks where; the sentence for a refusal is the instruction.
 *
 * "last" for the board's only column (0.11.0): a board needs one, for new
 * tickets to land in — and since defaults come only once, a board left with
 * none would stay that way.
 *
 * "unknown" for a column that isn't on this company's board; "unknown-target"
 * for a `moveTo` that isn't (or is the column itself). `moveTo` is checked
 * even when the column is empty, so a stale editor can't delete on the
 * strength of a target that no longer exists.
 */
export async function deleteStatus(
  db: FeedbackDb,
  tenantId: string,
  statusId: string,
  options: { moveTo?: string | null; actor?: TicketActor; now?: Date } = {},
): Promise<DeleteStatusResult> {
  if (!isTenantId(tenantId)) return { deleted: false, reason: "unknown" };
  const rows = await db
    .select({ id: feedbackStatuses.id, key: feedbackStatuses.key, label: feedbackStatuses.label })
    .from(feedbackStatuses)
    .where(and(eq(feedbackStatuses.tenantId, tenantId), eq(feedbackStatuses.id, statusId)))
    .limit(1);
  const status = rows[0];
  if (!status) return { deleted: false, reason: "unknown" };
  const [columns] = (await db
    .select({ n: count() })
    .from(feedbackStatuses)
    .where(eq(feedbackStatuses.tenantId, tenantId))) as Array<{ n: number }>;
  if (Number(columns?.n ?? 0) <= 1) return { deleted: false, reason: "last" };
  const target = options.moveTo ? await findStatus(db, tenantId, options.moveTo) : null;
  if (options.moveTo && (!target || target.key === status.key)) return { deleted: false, reason: "unknown-target" };

  const occupants = (await db
    .select({ id: feedbackTickets.id })
    .from(feedbackTickets)
    .where(and(eq(feedbackTickets.tenantId, tenantId), eq(feedbackTickets.status, status.key)))) as Array<{ id: string }>;
  if (occupants.length > 0 && !target) return { deleted: false, reason: "occupied", ticketCount: occupants.length };

  let moved = 0;
  let movedTickets: Array<{ id: string; from: string }> = [];
  if (target && occupants.length > 0) {
    const now = options.now ?? new Date();
    const updated = (await db
      .update(feedbackTickets)
      .set({ status: target.key, statusChangedAt: now })
      .where(and(eq(feedbackTickets.tenantId, tenantId), eq(feedbackTickets.status, status.key)))
      .returning({ id: feedbackTickets.id })) as Array<{ id: string }>;
    moved = updated.length;
    movedTickets = updated.map((row) => ({ id: row.id, from: status.key }));
    const actor = options.actor ?? { id: null, name: "The team" };
    await recordEventsQuietly(
      db,
      tenantId,
      updated.map((row) => ({
        ticketId: row.id,
        kind: "status" as const,
        fromValue: status.label,
        toValue: target.label,
        actorId: actor.id,
        actorName: actor.name,
      })),
      now,
    );
  }
  await db.delete(feedbackStatuses).where(and(eq(feedbackStatuses.tenantId, tenantId), eq(feedbackStatuses.id, statusId)));
  // Tickets that moved may start their epics (0.12.0) — judged on the board as
  // it is now, without the deleted column.
  await autoStartEpicsOfTickets(
    db,
    tenantId,
    movedTickets.map((ticket) => ticket.id),
    options.now ?? new Date(),
  );
  return target ? { deleted: true, moved, to: target, tickets: movedTickets } : { deleted: true };
}

/**
 * Renumber rows in tens, in the order given, in ONE statement (0.11.0 —
 * 0.10 ran one update per row, so a refresh between two of them saw a half-
 * reordered board). Ids that aren't this company's are skipped by the WHERE.
 */
async function reorderRows(
  db: FeedbackDb,
  table: typeof feedbackStatuses | typeof feedbackCategories,
  tenantId: string,
  orderedIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(orderedIds)];
  if (ids.length === 0) return;
  const cases = sql.join(
    ids.map((id, index) => sql`when ${id} then ${(index + 1) * 10}`),
    sql` `,
  );
  await db
    .update(table)
    .set({ sortOrder: sql`(case ${table.id} ${cases} end)::integer` })
    .where(and(eq(table.tenantId, tenantId), inArray(table.id, ids)));
}

/** The full column order, as ids. Renumbers in tens so gaps stay available. */
export async function reorderStatuses(db: FeedbackDb, tenantId: string, orderedIds: readonly string[]): Promise<void> {
  if (!isTenantId(tenantId)) return;
  await reorderRows(db, feedbackStatuses, tenantId, orderedIds);
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

/** What a ticket card carries (the board payload). */
export interface BoardTicket {
  id: string;
  ticketNumber: string;
  title: string;
  priority: string;
  category: string | null;
  status: string;
  assignee: string | null;
  /** The host's user id of the assignee, when they were picked from the company's people (0.11.0). */
  assigneeId: string | null;
  /** "widget" | "page" | "staff" (0.11.0). */
  source: FeedbackTicketSource;
  /** Is the reporter emailed about it (0.11.0; false for a team ticket filed without "tell them"). */
  notifyReporter: boolean;
  /** The epic it's part of (0.12.0): one of this company's, named in `BoardData.epics`. */
  epicId: string | null;
  reporterName: string | null;
  reporterEmail: string | null;
  pagePathname: string | null;
  screenshotUrl: string | null;
  annotatedScreenshotUrl: string | null;
  createdAt: Date;
  /** When the ticket last changed column; null means never moved (age from createdAt). */
  statusChangedAt: Date | null;
  archivedAt: Date | null;
  archivedBy: string | null;
  /** A reporter message the team has not opened the ticket since (0.5.0). */
  hasUnreadReporterReply: boolean;
}

/**
 * How many tickets carry each value of a field, with every OTHER filter
 * applied (0.11.0) — "how many would I get if I ticked this", which is the
 * number a person choosing a filter wants. (Ask Lou's counts ignored the
 * filters, so they were board-wide totals that never matched what ticking
 * gave.) `FILTER_NONE` counts the empty value: unassigned, no category.
 */
export interface BoardFacets {
  status: Record<string, number>;
  priority: Record<string, number>;
  category: Record<string, number>;
  assignee: Record<string, number>;
  /** Per epic id, and `FILTER_NONE` for tickets in no epic (0.12.0). */
  epic: Record<string, number>;
  source: Record<string, number>;
}

export interface BoardData {
  statuses: BoardStatus[];
  tickets: BoardTicket[];
  /**
   * This company's epics (0.12.0), every status: what a card's badge names,
   * what the Epic filter and the pickers offer. A ticket's `epicId` is always
   * one of these.
   */
  epics: BoardEpic[];
  /**
   * How many un-archived tickets sit in finished columns right now — the
   * number on the "Archive done (N)" button, counted in the database rather
   * than from the capped page of tickets above.
   */
  archivableCount: number;
  /** Every ticket on the board (archived ones too when they're asked for): the "of Y" (0.11.0). */
  totalCount: number;
  /** How many match the filters, counted in the database: the "X" — more than `tickets.length` when truncated. */
  matchCount: number;
  /** Some matching tickets aren't in `tickets` (past the caps): the board says so instead of hiding them. */
  truncated: boolean;
  facets: BoardFacets;
}

/** How many unfinished cards one board read returns at most, newest first. */
export const BOARD_TICKET_LIMIT = 300;
/**
 * How many cards of FINISHED columns one read returns at most (0.11.0). Read
 * separately, so a busy Done column never pushes open work off the board —
 * 0.10 took the newest 300 of everything, and a month of closed tickets did
 * exactly that.
 */
export const BOARD_FINISHED_LIMIT = 100;

const TICKET_CARD_COLUMNS = {
  id: feedbackTickets.id,
  ticketNumber: feedbackTickets.ticketNumber,
  title: feedbackTickets.title,
  priority: feedbackTickets.priority,
  category: feedbackTickets.category,
  status: feedbackTickets.status,
  assignee: feedbackTickets.assignee,
  assigneeId: feedbackTickets.assigneeId,
  source: feedbackTickets.source,
  notifyReporter: feedbackTickets.notifyReporter,
  epicId: feedbackTickets.epicId,
  reporterName: feedbackTickets.reporterName,
  reporterEmail: feedbackTickets.reporterEmail,
  pagePathname: feedbackTickets.pagePathname,
  screenshotUrl: feedbackTickets.screenshotUrl,
  annotatedScreenshotUrl: feedbackTickets.annotatedScreenshotUrl,
  createdAt: feedbackTickets.createdAt,
  statusChangedAt: feedbackTickets.statusChangedAt,
  archivedAt: feedbackTickets.archivedAt,
  archivedBy: feedbackTickets.archivedBy,
  lastStaffReadAt: feedbackTickets.lastStaffReadAt,
} as const;

// ---------------------------------------------------------------------------
// Filters and search (0.11.0)
// ---------------------------------------------------------------------------

export { NUL_MESSAGE };

const filterValues = z
  .array(z.string().trim().min(1).max(200).refine(noNul, NUL_MESSAGE))
  .max(MAX_FILTER_VALUES, `Pick up to ${MAX_FILTER_VALUES} at a time.`);
/** The years a date filter may name: wider than any board, narrower than what the database can hold. */
const FIRST_YEAR = 1970;
const LAST_YEAR = 2999;
const filterMoment = z
  .string()
  .max(40)
  .refine((value) => !Number.isNaN(new Date(value).getTime()), "That date couldn't be read.")
  .refine((value) => {
    const year = new Date(value).getUTCFullYear();
    return year >= FIRST_YEAR && year <= LAST_YEAR;
  }, `Pick a date between ${FIRST_YEAR} and ${LAST_YEAR}.`)
  .nullable();

/**
 * The board's filters at the boundary: what `filtersFromSearchParams` reads
 * from a query string, checked again (a caller may build the object itself).
 * Priorities and sources are the known words; everything else is a value the
 * WHERE compares against this company's rows only, so an unknown one simply
 * matches nothing.
 */
export const boardFilterSchema = z.object({
  q: z.string().trim().max(MAX_SEARCH_LENGTH, `Keep a search under ${MAX_SEARCH_LENGTH} characters.`).refine(noNul, NUL_MESSAGE).default(""),
  status: filterValues.default([]),
  priority: z.array(z.enum(FILTER_PRIORITIES)).max(FILTER_PRIORITIES.length).default([]),
  category: filterValues.default([]),
  assignee: filterValues.default([]),
  epic: filterValues.default([]),
  source: z.array(z.enum(FILTER_SOURCES)).max(FILTER_SOURCES.length).default([]),
  from: filterMoment.default(null),
  to: filterMoment.default(null),
  archived: z.boolean().default(false),
});

/**
 * A search's text as a LIKE pattern that means exactly what was typed: `%`,
 * `_` and `\` are escaped, so "100%" finds "100%" and "a_b" doesn't match
 * "axb" (Ask Lou passed them through as wildcards).
 */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** "12", "#12", "fb12", "FB-00012" → "FB-00012": a number typed any way finds its ticket. */
function ticketNumberOf(text: string): string | null {
  const match = /^#?\s*(?:fb\s*-?\s*)?0*(\d{1,9})$/i.exec(text.trim());
  if (!match) return null;
  return `FB-${match[1]!.padStart(5, "0")}`;
}

type FilterPart = "status" | "priority" | "category" | "assignee" | "epic" | "source" | "q" | "dates";

/**
 * The filters as WHERE conditions, one per field, so a facet can leave its own
 * field out. NEVER includes the company: every statement starts from
 * `ticketWhere(tenantId, …)`, which puts the company first, so no combination
 * of filters can be run without it.
 */
function filterConditions(filters: BoardFilters, viewerId: string | null): Partial<Record<FilterPart, SQL>> {
  const parts: Partial<Record<FilterPart, SQL>> = {};
  if (filters.status.length > 0) parts.status = inArray(feedbackTickets.status, filters.status);
  if (filters.priority.length > 0) parts.priority = inArray(feedbackTickets.priority, filters.priority as never[]);
  if (filters.category.length > 0) {
    const keys = filters.category.filter((value) => value !== FILTER_NONE);
    parts.category =
      or(
        keys.length > 0 ? inArray(feedbackTickets.category, keys) : undefined,
        filters.category.includes(FILTER_NONE) ? isNull(feedbackTickets.category) : undefined,
      ) ?? sql`false`;
  }
  if (filters.assignee.length > 0) {
    // "Mine" is whoever is asking — resolved here, never taken from the
    // browser as an id, so a shared "mine" link means the viewer's own.
    const named = filters.assignee.filter((value) => value.startsWith(FILTER_NAMED_PREFIX)).map((value) => value.slice(FILTER_NAMED_PREFIX.length));
    const ids = filters.assignee
      .filter((value) => value !== FILTER_NONE && !value.startsWith(FILTER_NAMED_PREFIX))
      .flatMap((value) => (value === FILTER_ME ? (viewerId ? [viewerId] : []) : [value]));
    const none = filters.assignee.includes(FILTER_NONE);
    // THE SAME RULE as assigneeKeyOf below, which the counts use: a person
    // (by id), a typed name nobody is linked to, or nobody at all.
    parts.assignee =
      or(
        ids.length > 0 ? inArray(feedbackTickets.assigneeId, ids) : undefined,
        named.length > 0 ? and(isNull(feedbackTickets.assigneeId), inArray(feedbackTickets.assignee, named)) : undefined,
        none ? and(isNull(feedbackTickets.assigneeId), isNull(feedbackTickets.assignee)) : undefined,
      ) ?? sql`false`;
  }
  if (filters.epic.length > 0) {
    // An epic id is compared against THIS company's tickets only (the WHERE
    // starts with the company), so another company's epic id matches nothing.
    const ids = filters.epic.filter((value) => value !== FILTER_NONE);
    parts.epic =
      or(
        ids.length > 0 ? inArray(feedbackTickets.epicId, ids) : undefined,
        filters.epic.includes(FILTER_NONE) ? isNull(feedbackTickets.epicId) : undefined,
      ) ?? sql`false`;
  }
  if (filters.source.length > 0) parts.source = inArray(feedbackTickets.source, filters.source as FeedbackTicketSource[]);
  const q = filters.q.trim();
  if (q) {
    const pattern = likePattern(q);
    const number = ticketNumberOf(q);
    parts.q = or(
      sql`${feedbackTickets.ticketNumber} ilike ${pattern} escape '\\'`,
      sql`${feedbackTickets.title} ilike ${pattern} escape '\\'`,
      sql`${feedbackTickets.description} ilike ${pattern} escape '\\'`,
      sql`${feedbackTickets.reporterName} ilike ${pattern} escape '\\'`,
      sql`${feedbackTickets.reporterEmail} ilike ${pattern} escape '\\'`,
      number ? eq(feedbackTickets.ticketNumber, number) : undefined,
    )!;
  }
  const from = filters.from ? new Date(filters.from) : null;
  // A bare day for `to` means "to the end of that day" (UTC); a moment is
  // exclusive — the board's toolbar sends the start of the viewer's next day.
  const to = filters.to
    ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(filters.to) ? new Date(filters.to).getTime() + 86_400_000 : filters.to)
    : null;
  const dates = and(
    from && !Number.isNaN(from.getTime()) ? gte(feedbackTickets.createdAt, from) : undefined,
    to && !Number.isNaN(to.getTime()) ? lt(feedbackTickets.createdAt, to) : undefined,
  );
  if (dates) parts.dates = dates;
  return parts;
}

/** THE COMPANY FIRST, then the archive scope, then whichever filters apply. */
function ticketWhere(tenantId: string, includeArchived: boolean, ...conditions: Array<SQL | undefined>): SQL {
  return and(
    eq(feedbackTickets.tenantId, tenantId),
    includeArchived ? undefined : isNull(feedbackTickets.archivedAt),
    ...conditions,
  )!;
}

async function countWhere(db: FeedbackDb, where: SQL): Promise<number> {
  const [row] = (await db.select({ n: count() }).from(feedbackTickets).where(where)) as Array<{ n: number }>;
  return Number(row?.n ?? 0);
}

const FACET_COLUMNS = {
  status: feedbackTickets.status,
  priority: feedbackTickets.priority,
  category: feedbackTickets.category,
  epic: feedbackTickets.epicId,
  source: feedbackTickets.source,
} as const;

/**
 * Which "Assigned to" choice a ticket counts under: its person's id, its
 * typed name (`__name:…`, not linked to anyone), or `__none` — exactly the
 * rule the filter matches by, so a count is always what ticking gives.
 */
function assigneeKeyOf(assigneeId: string | null, assignee: string | null): string {
  if (assigneeId !== null) return assigneeId;
  if (assignee !== null) return namedAssignee(assignee);
  return FILTER_NONE;
}

/**
 * A company's board: its columns (seeded the first time) and the tickets that
 * match `filters` — unfinished ones newest first up to BOARD_TICKET_LIMIT,
 * finished ones up to BOARD_FINISHED_LIMIT — with the counts the toolbar
 * shows ("Showing X of Y", per-option counts).
 *
 * Filtering happens HERE, in the database, never on the page: a capped read
 * filtered in the browser can't find ticket 301 (Riddler Go's list bug, and
 * the reason Ask Lou moved its filters server-side). `viewerId` is who is
 * asking, for "Mine".
 */
export async function listBoardData(
  db: FeedbackDb,
  tenantId: string,
  options: {
    includeArchived?: boolean;
    filters?: Partial<BoardFilters> | null;
    viewerId?: string | null;
  } = {},
): Promise<BoardData> {
  const emptyFacets: BoardFacets = { status: {}, priority: {}, category: {}, assignee: {}, epic: {}, source: {} };
  if (!isTenantId(tenantId)) {
    return { statuses: [], tickets: [], epics: [], archivableCount: 0, totalCount: 0, matchCount: 0, truncated: false, facets: emptyFacets };
  }
  const filters: BoardFilters = boardFilterSchema.parse({ ...EMPTY_FILTERS, ...(options.filters ?? {}) });
  const includeArchived = options.includeArchived === true || filters.archived;
  const viewerId = options.viewerId ?? null;
  await ensureFeedbackBoard(db, tenantId);
  const statuses = await listStatuses(db, tenantId);
  const terminalKeys = statuses.filter((s) => s.isTerminal).map((s) => s.key);

  const parts = filterConditions(filters, viewerId);
  const conditions = Object.values(parts);
  const matching = ticketWhere(tenantId, includeArchived, ...conditions);

  // Two reads, so finished work never crowds out open work (BOARD_FINISHED_LIMIT).
  const open = (await db
    .select(TICKET_CARD_COLUMNS)
    .from(feedbackTickets)
    .where(and(matching, terminalKeys.length > 0 ? notInArray(feedbackTickets.status, terminalKeys) : undefined))
    .orderBy(desc(feedbackTickets.createdAt), desc(feedbackTickets.id))
    .limit(BOARD_TICKET_LIMIT)) as Array<BoardTicket & { lastStaffReadAt: Date | null }>;
  const finished = (
    terminalKeys.length === 0
      ? []
      : await db
          .select(TICKET_CARD_COLUMNS)
          .from(feedbackTickets)
          .where(and(matching, inArray(feedbackTickets.status, terminalKeys)))
          .orderBy(desc(feedbackTickets.createdAt), desc(feedbackTickets.id))
          .limit(BOARD_FINISHED_LIMIT)
  ) as Array<BoardTicket & { lastStaffReadAt: Date | null }>;
  const rows = [...open, ...finished];

  const totalCount = await countWhere(db, ticketWhere(tenantId, includeArchived));
  const matchCount = conditions.length === 0 ? totalCount : await countWhere(db, matching);
  const archivableCount =
    terminalKeys.length === 0 ? 0 : await countWhere(db, ticketWhere(tenantId, false, inArray(feedbackTickets.status, terminalKeys)));

  // Per-option counts: each field counted with every OTHER field's filter on.
  const facets: BoardFacets = { status: {}, priority: {}, category: {}, assignee: {}, epic: {}, source: {} };
  for (const field of Object.keys(FACET_COLUMNS) as Array<keyof typeof FACET_COLUMNS>) {
    const others = (Object.entries(parts) as Array<[FilterPart, SQL]>)
      .filter(([part]) => part !== field)
      .map(([, condition]) => condition);
    const column = FACET_COLUMNS[field];
    const grouped = (await db
      .select({ value: column, n: count() })
      .from(feedbackTickets)
      .where(ticketWhere(tenantId, includeArchived, ...others))
      .groupBy(column)) as Array<{ value: string | null; n: number }>;
    for (const row of grouped) facets[field][row.value ?? FILTER_NONE] = Number(row.n);
  }
  {
    const others = (Object.entries(parts) as Array<[FilterPart, SQL]>)
      .filter(([part]) => part !== "assignee")
      .map(([, condition]) => condition);
    const grouped = (await db
      .select({ id: feedbackTickets.assigneeId, name: feedbackTickets.assignee, n: count() })
      .from(feedbackTickets)
      .where(ticketWhere(tenantId, includeArchived, ...others))
      .groupBy(feedbackTickets.assigneeId, feedbackTickets.assignee)) as Array<{ id: string | null; name: string | null; n: number }>;
    for (const row of grouped) {
      const key = assigneeKeyOf(row.id, row.name);
      facets.assignee[key] = (facets.assignee[key] ?? 0) + Number(row.n);
    }
  }

  // One grouped query for the whole board, not one per ticket: the latest
  // reporter message per ticket of THIS company (joined to the ticket, which
  // carries the company), compared against when the team last opened it.
  const ids = rows.map((row) => row.id);
  const latestReplies: Array<{ ticketId: string; latest: Date | string | null }> =
    ids.length === 0
      ? []
      : await db
          .select({ ticketId: feedbackMessages.ticketId, latest: max(feedbackMessages.createdAt) })
          .from(feedbackMessages)
          .innerJoin(feedbackTickets, eq(feedbackTickets.id, feedbackMessages.ticketId))
          .where(
            and(
              eq(feedbackTickets.tenantId, tenantId),
              eq(feedbackMessages.senderType, "reporter"),
              inArray(feedbackMessages.ticketId, ids),
            ),
          )
          .groupBy(feedbackMessages.ticketId);
  const latestReplyByTicket = new Map(
    latestReplies.map((row) => [row.ticketId, row.latest === null ? null : new Date(row.latest)]),
  );

  const tickets = rows.map(({ lastStaffReadAt, ...ticket }) => {
    const latest = latestReplyByTicket.get(ticket.id) ?? null;
    const readAt = lastStaffReadAt === null ? null : new Date(lastStaffReadAt);
    return {
      ...ticket,
      // The ticket's first message is the reporter's own submission; it is
      // "unread" until the team opens the ticket, which is what a new card is.
      hasUnreadReporterReply: latest !== null && (readAt === null || latest > readAt),
    };
  });

  const epics = await listBoardEpics(db, tenantId);
  return { statuses, tickets, epics, archivableCount, totalCount, matchCount, truncated: matchCount > tickets.length, facets };
}

/** The heavy half of a ticket, for the panel: the report, its captured context and errors. */
export interface TicketDetail extends BoardTicket {
  description: string;
  clientMetadata: unknown;
  recentErrors: unknown;
}

/** One of this company's tickets, in full; null for any other id. */
export async function getTicket(db: FeedbackDb, tenantId: string, ticketId: string): Promise<TicketDetail | null> {
  if (!isTenantId(tenantId) || typeof ticketId !== "string" || ticketId.length === 0) return null;
  const rows = (await db
    .select({
      ...TICKET_CARD_COLUMNS,
      description: feedbackTickets.description,
      clientMetadata: feedbackTickets.clientMetadata,
      recentErrors: feedbackTickets.recentErrors,
    })
    .from(feedbackTickets)
    .where(and(eq(feedbackTickets.tenantId, tenantId), eq(feedbackTickets.id, ticketId)))
    .limit(1)) as Array<TicketDetail & { lastStaffReadAt: Date | null }>;
  const row = rows[0];
  if (!row) return null;
  const { lastStaffReadAt, ...ticket } = row;
  const latest = await db
    .select({ latest: max(feedbackMessages.createdAt) })
    .from(feedbackMessages)
    .where(and(eq(feedbackMessages.ticketId, ticket.id), eq(feedbackMessages.senderType, "reporter")));
  const at = (latest[0] as { latest: Date | string | null } | undefined)?.latest ?? null;
  const latestDate = at === null ? null : new Date(at);
  return {
    ...ticket,
    hasUnreadReporterReply: latestDate !== null && (lastStaffReadAt === null || latestDate > new Date(lastStaffReadAt)),
  };
}

/**
 * The next ticket number IN THIS COMPANY: one past its highest. Ordered by
 * length first, then text, so FB-100000 counts after FB-99999 (0.9 compared
 * the text alone, and would have reused FB-100000 for ever).
 */
async function nextTicketNumber(db: FeedbackDb, tenantId: string): Promise<string> {
  const rows = (await db
    .select({ ticketNumber: feedbackTickets.ticketNumber })
    .from(feedbackTickets)
    .where(eq(feedbackTickets.tenantId, tenantId))
    .orderBy(desc(sql`length(${feedbackTickets.ticketNumber})`), desc(feedbackTickets.ticketNumber))
    .limit(1)) as Array<{ ticketNumber: string }>;
  const last = rows[0]?.ticketNumber;
  const parsed = last ? Number.parseInt(last.slice(3), 10) : 0;
  const n = (Number.isFinite(parsed) ? parsed : 0) + 1;
  return `FB-${String(n).padStart(5, "0")}`;
}

/**
 * The column a new ticket lands in: the company's first unfinished column by
 * order — the leftmost real column — falling back to its first column, then to
 * "open". Never a hardcoded key a company may have renamed out from under it.
 */
async function initialStatus(db: FeedbackDb, tenantId: string): Promise<string> {
  const rows = await listStatuses(db, tenantId);
  return rows.find((r) => !r.isTerminal)?.key ?? rows[0]?.key ?? "open";
}

export interface CreatedTicket {
  id: string;
  ticketNumber: string;
  /** The reporter's follow-up capability. Exists only here; the row keeps its hash. */
  ticketToken: string;
  title: string;
  status: string;
}

/**
 * How many times a ticket number is retried when submits race for it. Each
 * round of a race has exactly one winner, so N tickets filed at the same
 * moment need N rounds: 0.10's 8 lost the ninth of a burst (a team filing
 * while a busy widget reports). 25 covers a burst bigger than any board sees.
 */
const NUMBER_ATTEMPTS = 25;

type TicketInsert = typeof feedbackTickets.$inferInsert;

/**
 * Insert a ticket under the company's next number. RACE-SAFE WITHOUT A LOCK
 * (so it works on every driver, neon-http included): the unique index on
 * (company, number) is the arbiter, and an insert that loses the race takes
 * the next number, up to NUMBER_ATTEMPTS times. The intake and staff "New ticket" share
 * it, so a reporter and a teammate filing at the same moment never collide.
 */
async function insertNumbered(
  db: FeedbackDb,
  tenantId: string,
  values: Omit<TicketInsert, "tenantId" | "ticketNumber">,
): Promise<{ id: string; ticketNumber: string }> {
  for (let attempt = 0; ; attempt++) {
    const ticketNumber = await nextTicketNumber(db, tenantId);
    try {
      const [inserted] = (await db
        .insert(feedbackTickets)
        .values({ ...values, tenantId, ticketNumber })
        .returning({ id: feedbackTickets.id })) as Array<{ id: string }>;
      if (!inserted) throw new Error("ticket insert returned no row");
      return { id: inserted.id, ticketNumber };
    } catch (error) {
      if (isUniqueViolation(error) && attempt < NUMBER_ATTEMPTS - 1) continue;
      throw error;
    }
  }
}

/**
 * Put a report on a company's board: the ticket (numbered in that company),
 * the reporter's follow-up token, and the reporter's own words as the first
 * message of the conversation. `source` (0.11.0) is how it arrived: the
 * feedback button on a website key ("widget", the default) or the company's
 * own feedback page ("page").
 */
export async function createTicket(
  db: FeedbackDb,
  input: { readonly tenantId: string; readonly payload: SubmitPayload; readonly source?: "widget" | "page" },
): Promise<CreatedTicket> {
  const { tenantId, payload } = input;
  if (!isTenantId(tenantId)) throw new Error("createTicket: pass the company");
  await ensureFeedbackBoard(db, tenantId);
  const title = (payload.description.split("\n", 1)[0] ?? "").slice(0, 100);
  // The follow-up capability, minted with the ticket. The plaintext goes out
  // in the answer and nowhere else; the row keeps only the hash.
  const ticketToken = generateReporterToken();
  const reporterTokenHash = await hashReporterToken(ticketToken);
  const status = await initialStatus(db, tenantId);
  const reporterName = payload.reporter?.name?.trim() || null;
  const reporterEmail = payload.reporter?.email?.trim() || null;

  const { id, ticketNumber } = await insertNumbered(db, tenantId, {
    title,
    description: payload.description,
    priority: payload.priority,
    category: payload.category ?? null,
    status,
    source: input.source ?? "widget",
    screenshotUrl: payload.screenshotUrl ?? null,
    annotatedScreenshotUrl: payload.annotatedScreenshotUrl ?? null,
    reporterName,
    reporterEmail,
    reporterTokenHash,
    pagePathname: payload.clientMetadata.pathname,
    clientMetadata: payload.clientMetadata,
    recentErrors: payload.recentErrors ?? [],
  });
  // The reporter's own words as the first message, so "My reports → thread"
  // shows their submission rather than an empty conversation; and the first
  // line of the activity trail. Best-effort: a ticket that was created must
  // not fail because either didn't.
  try {
    await insertMessage(db, {
      ticketId: id,
      senderType: "reporter",
      senderName: reporterName || reporterEmail || "Reporter",
      body: payload.description,
    });
  } catch {
    /* the ticket stands */
  }
  await recordEventsQuietly(db, tenantId, [
    { ticketId: id, kind: "created", fromValue: null, toValue: null, actorId: null, actorName: reporterName || "A customer" },
  ]);
  return { id, ticketNumber, ticketToken, title, status };
}

// ---------------------------------------------------------------------------
// The activity trail (0.11.0)
// ---------------------------------------------------------------------------

/** Who made a change: the host's user id (or null) and the name the trail shows. */
export interface TicketActor {
  readonly id: string | null;
  readonly name: string;
}

export interface TicketEvent {
  id: string;
  ticketId: string;
  kind: FeedbackTicketEventKind;
  fromValue: string | null;
  toValue: string | null;
  actorId: string | null;
  actorName: string;
  createdAt: Date;
}


const EVENT_COLUMNS = {
  id: feedbackTicketEvents.id,
  ticketId: feedbackTicketEvents.ticketId,
  kind: feedbackTicketEvents.kind,
  fromValue: feedbackTicketEvents.fromValue,
  toValue: feedbackTicketEvents.toValue,
  actorId: feedbackTicketEvents.actorId,
  actorName: feedbackTicketEvents.actorName,
  createdAt: feedbackTicketEvents.createdAt,
} as const;


/** One of this company's tickets' trail, oldest first ([] for any other ticket). */
export async function listTicketEvents(db: FeedbackDb, tenantId: string, ticketId: string): Promise<TicketEvent[]> {
  if (!isTenantId(tenantId) || typeof ticketId !== "string" || ticketId.length === 0) return [];
  return db
    .select(EVENT_COLUMNS)
    .from(feedbackTicketEvents)
    .where(and(eq(feedbackTicketEvents.tenantId, tenantId), eq(feedbackTicketEvents.ticketId, ticketId)))
    .orderBy(asc(feedbackTicketEvents.createdAt), asc(feedbackTicketEvents.id));
}

// ---------------------------------------------------------------------------
// Staff tickets and editing (0.11.0)
// ---------------------------------------------------------------------------

/** A ticket change refused for a reason a person can fix: the sentence is shown as it is. */
export class TicketChangeError extends Error {
  readonly name = "TicketChangeError";
}

/** A person to assign: the host's own user id, and the name the card shows. */
export interface TicketAssignee {
  readonly id: string;
  readonly name: string;
}

const priorityEnum = z.enum(FILTER_PRIORITIES);

/**
 * A ticket the team files from the board. Only the title is required; the
 * column defaults to the board's first unfinished one, exactly where the
 * intake puts a report. The assignee arrives already looked up (the handler
 * checks it is one of the company's people).
 */
/** Checked the way the reporter emails check it, so an address that's stored is one that can be written to. */
const EMAIL_SHAPE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

export const staffTicketSchema = z.object({
  title: z.string().trim().min(1, "Give the ticket a title.").max(200, "Keep the title under 200 characters.").refine(noNul, NUL_MESSAGE),
  description: z.string().trim().max(5000, "Keep the description under 5000 characters.").refine(noNul, NUL_MESSAGE).optional(),
  priority: priorityEnum.default("medium"),
  category: z.string().trim().min(1).max(50).nullish(),
  status: z.string().trim().min(1).max(50).optional(),
  reporterName: z.string().trim().max(120).refine(noNul, NUL_MESSAGE).nullish(),
  reporterEmail: z
    .string()
    .trim()
    .max(255)
    .refine((value) => value === "" || EMAIL_SHAPE.test(value), "That email address doesn't look right. Check it, or leave it empty.")
    .nullish(),
  /**
   * Email the customer when the team replies or moves it (0.11.0). Off
   * unless asked: the customer never used the feedback form.
   */
  tellReporter: z.boolean().optional(),
  /**
   * The epic it's part of (0.12.0): one of THIS company's, still being worked
   * on. Another company's id is refused with a sentence, never written.
   */
  epicId: z.string().trim().min(1).max(200).nullish(),
});

export interface CreatedStaffTicket {
  id: string;
  ticketNumber: string;
  title: string;
  status: string;
}

const UNKNOWN_CATEGORY = "That category isn't on this board. Refresh to see the board's categories.";
const UNKNOWN_COLUMN = "That column isn't on this board any more. Refresh to see the board as it is.";

/** A category key of THIS company's (or of the built-in list, when it has none); its label for the trail. */
async function categoryLabel(db: FeedbackDb, tenantId: string, key: string): Promise<string | null> {
  const rows = await listCategories(db, tenantId);
  if (rows.length === 0) return DEFAULT_CATEGORIES.find((category) => category.key === key)?.label ?? null;
  return rows.find((row) => row.key === key)?.label ?? null;
}

/**
 * File a ticket from the board (0.11.0): numbered in the company like a
 * report, marked `source: "staff"` and `createdBy`, with the trail's first
 * line. A column or category that isn't THIS company's is refused with a
 * sentence (TicketChangeError) — never written, never "found" on another
 * company's board.
 */
export async function createStaffTicket(
  db: FeedbackDb,
  tenantId: string,
  input: z.input<typeof staffTicketSchema> & { readonly assignee?: TicketAssignee | null },
  actor: TicketActor,
): Promise<CreatedStaffTicket> {
  if (!isTenantId(tenantId)) throw new Error("createStaffTicket: pass the company");
  const parsed = staffTicketSchema.parse(input);
  await ensureFeedbackBoard(db, tenantId);
  let status: string;
  if (parsed.status) {
    const column = await findStatus(db, tenantId, parsed.status);
    if (!column) throw new TicketChangeError(UNKNOWN_COLUMN);
    status = column.key;
  } else {
    status = await initialStatus(db, tenantId);
  }
  const category = parsed.category ?? null;
  if (category !== null && (await categoryLabel(db, tenantId, category)) === null) throw new TicketChangeError(UNKNOWN_CATEGORY);
  const assignee = input.assignee ?? null;
  // Checked before anything is written, like the column and the category.
  const epic = parsed.epicId ? await epicForTicket(db, tenantId, parsed.epicId) : null;

  const { id, ticketNumber } = await insertNumbered(db, tenantId, {
    title: parsed.title,
    description: parsed.description ?? "",
    priority: parsed.priority,
    category,
    status,
    source: "staff",
    createdBy: actor.id,
    assignee: assignee ? assignee.name.slice(0, 120) : null,
    assigneeId: assignee ? assignee.id : null,
    reporterName: parsed.reporterName || null,
    reporterEmail: parsed.reporterEmail || null,
    notifyReporter: parsed.tellReporter === true && Boolean(parsed.reporterEmail),
    epicId: epic ? epic.id : null,
  }).catch((error: unknown) => {
    // The epic was deleted between the check above and this insert (review L2).
    if (isForeignKeyViolation(error)) throw staleEpicError();
    throw error;
  });
  await recordEventsQuietly(db, tenantId, [
    { ticketId: id, kind: "created", fromValue: null, toValue: null, actorId: actor.id, actorName: actor.name },
    ...(epic ? [{ ticketId: id, kind: "epic" as const, fromValue: null, toValue: epic.name, actorId: actor.id, actorName: actor.name }] : []),
  ]);
  // Filed straight into a later column, it starts its epic.
  if (epic) await autoStartEpics(db, tenantId, [epic.id]).catch(() => undefined);
  return { id, ticketNumber, title: parsed.title, status };
}

/** What a ticket's editor may change (0.11.0). Absent = unchanged; `category: null` clears it. */
export const ticketPatchSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, "Give the ticket a title.")
      .max(200, "Keep the title under 200 characters.")
      .refine(noNul, NUL_MESSAGE)
      .optional(),
    priority: priorityEnum.optional(),
    category: z.string().trim().min(1).max(50).nullable().optional(),
    /** The epic it's part of (0.12.0); null takes it out of its epic. */
    epicId: z.string().trim().min(1).max(200).nullable().optional(),
  });

export type UpdateTicketResult = { readonly updated: true; readonly changed: readonly FeedbackTicketEventKind[] } | null;

/**
 * Edit one of this company's tickets: its title, priority, category and
 * assignee (`assignee: null` unassigns; absent leaves it). Every field that
 * actually changed becomes a line of the trail, by `actor`. Everything is
 * checked BEFORE anything is written, so a refused category never leaves half
 * an edit behind. Null: not this company's ticket.
 */
export async function updateTicket(
  db: FeedbackDb,
  tenantId: string,
  input: z.input<typeof ticketPatchSchema> & { readonly ticketId: string; readonly assignee?: TicketAssignee | null },
  actor: TicketActor,
  now: Date = new Date(),
): Promise<UpdateTicketResult> {
  if (!isTenantId(tenantId)) return null;
  const { ticketId, assignee, ...fields } = input;
  const patch = ticketPatchSchema.parse(fields);
  const [ticket] = (await db
    .select({
      id: feedbackTickets.id,
      title: feedbackTickets.title,
      priority: feedbackTickets.priority,
      category: feedbackTickets.category,
      assignee: feedbackTickets.assignee,
      assigneeId: feedbackTickets.assigneeId,
      epicId: feedbackTickets.epicId,
    })
    .from(feedbackTickets)
    .where(and(eq(feedbackTickets.tenantId, tenantId), eq(feedbackTickets.id, ticketId)))
    .limit(1)) as Array<{
    id: string;
    title: string;
    priority: string;
    category: string | null;
    assignee: string | null;
    assigneeId: string | null;
    epicId: string | null;
  }>;
  if (!ticket) return null;

  const set: Partial<TicketInsert> = {};
  const drafts: EventDraft[] = [];
  const by = { actorId: actor.id, actorName: actor.name, ticketId: ticket.id };
  if (patch.title !== undefined && patch.title !== ticket.title) {
    set.title = patch.title;
    drafts.push({ ...by, kind: "title", fromValue: ticket.title, toValue: patch.title });
  }
  if (patch.priority !== undefined && patch.priority !== ticket.priority) {
    set.priority = patch.priority;
    const label = (value: string) => PRIORITY_LABELS[value as keyof typeof PRIORITY_LABELS] ?? value;
    drafts.push({ ...by, kind: "priority", fromValue: label(ticket.priority), toValue: label(patch.priority) });
  }
  if (patch.category !== undefined && patch.category !== ticket.category) {
    const to = patch.category === null ? null : await categoryLabel(db, tenantId, patch.category);
    if (patch.category !== null && to === null) throw new TicketChangeError(UNKNOWN_CATEGORY);
    const from = ticket.category === null ? null : ((await categoryLabel(db, tenantId, ticket.category)) ?? ticket.category);
    set.category = patch.category;
    drafts.push({ ...by, kind: "category", fromValue: from, toValue: to });
  }
  if (assignee !== undefined) {
    const nextId = assignee?.id ?? null;
    const nextName = assignee ? assignee.name.slice(0, 120) : null;
    if (nextId !== ticket.assigneeId || nextName !== ticket.assignee) {
      set.assigneeId = nextId;
      set.assignee = nextName;
      if (nextName !== ticket.assignee) drafts.push({ ...by, kind: "assignee", fromValue: ticket.assignee, toValue: nextName });
    }
  }
  let startEpic: string | null = null;
  if (patch.epicId !== undefined && patch.epicId !== ticket.epicId) {
    // One of THIS company's epics, still taking tickets — checked before
    // anything is written, so a refused epic leaves no half an edit.
    const next = patch.epicId === null ? null : await epicForTicket(db, tenantId, patch.epicId, ticket.epicId);
    set.epicId = next ? next.id : null;
    drafts.push({ ...by, kind: "epic", fromValue: await epicNameOf(db, tenantId, ticket.epicId), toValue: next ? next.name : null });
    startEpic = next ? next.id : null;
  }
  if (Object.keys(set).length === 0) return { updated: true, changed: [] };
  try {
    await db
      .update(feedbackTickets)
      .set(set)
      .where(and(eq(feedbackTickets.tenantId, tenantId), eq(feedbackTickets.id, ticket.id)));
  } catch (error) {
    // The epic was deleted between the check and the write (review L2).
    if (isForeignKeyViolation(error)) throw staleEpicError();
    throw error;
  }
  await recordEventsQuietly(db, tenantId, drafts, now);
  // A ticket already under way, put into an epic, starts it.
  if (startEpic) await autoStartEpics(db, tenantId, [startEpic], now).catch(() => undefined);
  return { updated: true, changed: drafts.map((draft) => draft.kind) };
}

/**
 * The ticket a reporter's {number, token} pair names, INSIDE one company.
 * ONE ANSWER FOR EVERY FAILURE (null) — unknown number, another company's
 * ticket, a ticket with no token, a wrong token — because distinct answers
 * would let anyone enumerate which numbers exist.
 */
export async function findReporterTicket(
  db: FeedbackDb,
  tenantId: string,
  input: { readonly ticketNumber: string; readonly ticketToken: string },
): Promise<{
  id: string;
  ticketNumber: string;
  title: string;
  status: string;
  reporterName: string | null;
  reporterEmail: string | null;
  createdAt: Date;
} | null> {
  if (!isTenantId(tenantId)) return null;
  const rows = await db
    .select({
      id: feedbackTickets.id,
      ticketNumber: feedbackTickets.ticketNumber,
      title: feedbackTickets.title,
      status: feedbackTickets.status,
      reporterName: feedbackTickets.reporterName,
      reporterEmail: feedbackTickets.reporterEmail,
      reporterTokenHash: feedbackTickets.reporterTokenHash,
      createdAt: feedbackTickets.createdAt,
    })
    .from(feedbackTickets)
    .where(and(eq(feedbackTickets.tenantId, tenantId), eq(feedbackTickets.ticketNumber, input.ticketNumber)))
    .limit(1);
  const ticket = rows[0];
  if (!ticket || !ticket.reporterTokenHash) return null;
  if ((await hashReporterToken(input.ticketToken)) !== ticket.reporterTokenHash) return null;
  const { reporterTokenHash: _hash, ...rest } = ticket;
  return rest;
}

/** One of this company's columns by key; null when it has none by that key. */
export async function findStatus(db: FeedbackDb, tenantId: string, key: string): Promise<BoardStatus | null> {
  if (!isTenantId(tenantId)) return null;
  const rows = await db
    .select(BOARD_STATUS_COLUMNS)
    .from(feedbackStatuses)
    .where(and(eq(feedbackStatuses.tenantId, tenantId), eq(feedbackStatuses.key, key)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Stamp the ticket as seen by the team. Called when the panel opens; what it
 * clears is the unread mark `listBoardData` computes. False: not this
 * company's ticket.
 */
export async function markTicketRead(
  db: FeedbackDb,
  tenantId: string,
  ticketId: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (!isTenantId(tenantId)) return false;
  const rows = (await db
    .update(feedbackTickets)
    .set({ lastStaffReadAt: now })
    .where(and(eq(feedbackTickets.tenantId, tenantId), eq(feedbackTickets.id, ticketId)))
    .returning({ id: feedbackTickets.id })) as Array<{ id: string }>;
  return rows.length > 0;
}

export type MoveTicketResult =
  | { readonly moved: true; readonly from: string; readonly to: BoardStatus }
  | { readonly moved: false; readonly reason: "not-found" | "unknown-status" | "unchanged" };

/** A column key's label on this company's board, for the trail; the key itself when no column has it. */
async function columnLabels(db: FeedbackDb, tenantId: string): Promise<(key: string) => string> {
  const byKey = new Map((await listStatuses(db, tenantId)).map((status) => [status.key, status.label]));
  return (key) => byKey.get(key) ?? key;
}

/**
 * The one board mutation. An unknown column key is refused instead of written
 * — a drop target that doesn't exist is a stale client, and a silently
 * invented status would vanish from every column. Moving a ticket to the
 * column it's already in changes nothing (and resets no aging clock).
 * `actor` (0.11.0) puts the move on the ticket's trail.
 */
export async function moveTicket(
  db: FeedbackDb,
  tenantId: string,
  input: { ticketId: string; statusKey: string; actor?: TicketActor },
  now: Date = new Date(),
): Promise<MoveTicketResult> {
  if (!isTenantId(tenantId)) return { moved: false, reason: "not-found" };
  const [ticket] = await db
    .select({ id: feedbackTickets.id, status: feedbackTickets.status })
    .from(feedbackTickets)
    .where(and(eq(feedbackTickets.tenantId, tenantId), eq(feedbackTickets.id, input.ticketId)))
    .limit(1);
  if (!ticket) return { moved: false, reason: "not-found" };
  const status = await findStatus(db, tenantId, input.statusKey);
  if (!status) return { moved: false, reason: "unknown-status" };
  if (ticket.status === status.key) return { moved: false, reason: "unchanged" };
  await db
    .update(feedbackTickets)
    // The aging clock: every card ages from the moment it entered its
    // column, so a fresh move resets the dot rather than inheriting it.
    .set({ status: status.key, statusChangedAt: now })
    .where(and(eq(feedbackTickets.tenantId, tenantId), eq(feedbackTickets.id, ticket.id)));
  const actor = input.actor ?? { id: null, name: "The team" };
  const label = await columnLabels(db, tenantId);
  await recordEventsQuietly(
    db,
    tenantId,
    [{ ticketId: ticket.id, kind: "status", fromValue: label(ticket.status), toValue: status.label, actorId: actor.id, actorName: actor.name }],
    now,
  );
  // A ticket that starts moving starts its epic (0.12.0).
  await autoStartEpicsOfTickets(db, tenantId, [ticket.id], now);
  return { moved: true, from: ticket.status, to: status };
}

/** The most a single bulk move takes. */
export const MAX_BULK_MOVE = 200;

/**
 * The same move, for a selection (0.7.0). One statement, not a loop of
 * `moveTicket`s: thirty tickets moving is one board event, and thirty
 * separate updates is thirty chances for a refresh to catch it half-done.
 * Ids that aren't this company's tickets are skipped by the WHERE; `moved`
 * lists what changed (with where each came from).
 */
export async function moveTickets(
  db: FeedbackDb,
  tenantId: string,
  input: { ticketIds: readonly string[]; statusKey: string; actor?: TicketActor },
  now: Date = new Date(),
): Promise<
  | {
      readonly moved: number;
      readonly to: BoardStatus;
      /** The tickets that changed column, with the column each came from. */
      readonly tickets: ReadonlyArray<{ id: string; from: string }>;
      /** Every asked-for id that IS one of this company's tickets (moved, or already there). */
      readonly found: readonly string[];
    }
  | { readonly moved: 0; readonly reason: "unknown-status" }
> {
  if (input.ticketIds.length > MAX_BULK_MOVE) throw new Error(`moveTickets caps at ${MAX_BULK_MOVE} ids per call`);
  const status = isTenantId(tenantId) ? await findStatus(db, tenantId, input.statusKey) : null;
  if (!status) return { moved: 0, reason: "unknown-status" };
  if (input.ticketIds.length === 0) return { moved: 0, to: status, tickets: [], found: [] };
  const before = (await db
    .select({ id: feedbackTickets.id, status: feedbackTickets.status })
    .from(feedbackTickets)
    .where(and(eq(feedbackTickets.tenantId, tenantId), inArray(feedbackTickets.id, [...input.ticketIds])))) as Array<{
    id: string;
    status: string;
  }>;
  const moving = before.filter((row) => row.status !== status.key);
  const found = before.map((row) => row.id);
  if (moving.length === 0) return { moved: 0, to: status, tickets: [], found };
  await db
    .update(feedbackTickets)
    .set({ status: status.key, statusChangedAt: now })
    .where(and(eq(feedbackTickets.tenantId, tenantId), inArray(feedbackTickets.id, moving.map((row) => row.id))));
  const actor = input.actor ?? { id: null, name: "The team" };
  const label = await columnLabels(db, tenantId);
  await recordEventsQuietly(
    db,
    tenantId,
    moving.map((row) => ({
      ticketId: row.id,
      kind: "status" as const,
      fromValue: label(row.status),
      toValue: status.label,
      actorId: actor.id,
      actorName: actor.name,
    })),
    now,
  );
  await autoStartEpicsOfTickets(
    db,
    tenantId,
    moving.map((row) => row.id),
    now,
  );
  return { moved: moving.length, to: status, tickets: moving.map((row) => ({ id: row.id, from: row.status })), found };
}

// ---------------------------------------------------------------------------
// Archive (0.7.0) — the Done column stays readable in month three.
// ---------------------------------------------------------------------------

/**
 * Soft, reversible, and scoped in the WHERE: archiving an already-archived
 * ticket changes nothing, so a double-click cannot overwrite who archived it
 * first. False: not this company's ticket, or already archived.
 */
export async function archiveTicket(
  db: FeedbackDb,
  tenantId: string,
  input: { ticketId: string; archivedBy: string; actorId?: string | null },
  now: Date = new Date(),
): Promise<boolean> {
  if (!isTenantId(tenantId)) return false;
  const rows = (await db
    .update(feedbackTickets)
    .set({ archivedAt: now, archivedBy: input.archivedBy })
    .where(
      and(eq(feedbackTickets.tenantId, tenantId), eq(feedbackTickets.id, input.ticketId), isNull(feedbackTickets.archivedAt)),
    )
    .returning({ id: feedbackTickets.id })) as Array<{ id: string }>;
  await recordEventsQuietly(
    db,
    tenantId,
    rows.map((row) => ({ ticketId: row.id, kind: "archived" as const, fromValue: null, toValue: null, actorId: input.actorId ?? null, actorName: input.archivedBy })),
    now,
  );
  return rows.length > 0;
}

/** False: not this company's ticket. */
export async function unarchiveTicket(
  db: FeedbackDb,
  tenantId: string,
  ticketId: string,
  actor?: TicketActor,
  now: Date = new Date(),
): Promise<boolean> {
  if (!isTenantId(tenantId)) return false;
  const [before] = (await db
    .select({ archivedAt: feedbackTickets.archivedAt })
    .from(feedbackTickets)
    .where(and(eq(feedbackTickets.tenantId, tenantId), eq(feedbackTickets.id, ticketId)))
    .limit(1)) as Array<{ archivedAt: Date | null }>;
  if (!before) return false;
  const rows = (await db
    .update(feedbackTickets)
    .set({ archivedAt: null, archivedBy: null })
    .where(and(eq(feedbackTickets.tenantId, tenantId), eq(feedbackTickets.id, ticketId)))
    .returning({ id: feedbackTickets.id })) as Array<{ id: string }>;
  if (before.archivedAt !== null) {
    const by = actor ?? { id: null, name: "The team" };
    await recordEventsQuietly(
      db,
      tenantId,
      rows.map((row) => ({ ticketId: row.id, kind: "unarchived" as const, fromValue: null, toValue: null, actorId: by.id, actorName: by.name })),
      now,
    );
  }
  return rows.length > 0;
}

/**
 * "Archive done (N)": every un-archived ticket sitting in one of this
 * company's finished columns, in one statement. Finished is the flag on the
 * column, not a name — a company that renamed "closed" to "shipped" gets the
 * same sweep.
 */
export async function archiveTerminalTickets(
  db: FeedbackDb,
  tenantId: string,
  input: { archivedBy: string; actorId?: string | null },
  now: Date = new Date(),
): Promise<{ archived: number }> {
  if (!isTenantId(tenantId)) return { archived: 0 };
  const terminal = (await db
    .select({ key: feedbackStatuses.key })
    .from(feedbackStatuses)
    .where(and(eq(feedbackStatuses.tenantId, tenantId), eq(feedbackStatuses.isTerminal, true)))) as Array<{ key: string }>;
  if (terminal.length === 0) return { archived: 0 };
  const rows = (await db
    .update(feedbackTickets)
    .set({ archivedAt: now, archivedBy: input.archivedBy })
    .where(
      and(
        eq(feedbackTickets.tenantId, tenantId),
        inArray(
          feedbackTickets.status,
          terminal.map((row) => row.key),
        ),
        isNull(feedbackTickets.archivedAt),
      ),
    )
    .returning({ id: feedbackTickets.id })) as Array<{ id: string }>;
  await recordEventsQuietly(
    db,
    tenantId,
    rows.map((row) => ({ ticketId: row.id, kind: "archived" as const, fromValue: null, toValue: null, actorId: input.actorId ?? null, actorName: input.archivedBy })),
    now,
  );
  return { archived: rows.length };
}

// ---------------------------------------------------------------------------
// Categories (0.7.0) — the widget's dropdown, as rows
// ---------------------------------------------------------------------------

export interface CategoryRow {
  id: string;
  key: string;
  label: string;
  description: string | null;
  sortOrder: number;
  showToCustomer: boolean;
}

const CATEGORY_COLUMNS = {
  id: feedbackCategories.id,
  key: feedbackCategories.key,
  label: feedbackCategories.label,
  description: feedbackCategories.description,
  sortOrder: feedbackCategories.sortOrder,
  showToCustomer: feedbackCategories.showToCustomer,
} as const;

/** Every category of this company, customer-visible or not — the editor's read. */
export async function listCategories(db: FeedbackDb, tenantId: string): Promise<CategoryRow[]> {
  if (!isTenantId(tenantId)) return [];
  return db
    .select(CATEGORY_COLUMNS)
    .from(feedbackCategories)
    .where(eq(feedbackCategories.tenantId, tenantId))
    .orderBy(asc(feedbackCategories.sortOrder), asc(feedbackCategories.key));
}

/**
 * What this company's widget dropdown offers, in option shape. Empty when the
 * company has no rows — the intake falls back to the built-in list then, so
 * the dropdown is never empty.
 */
export async function customerCategoryOptions(db: FeedbackDb, tenantId: string): Promise<FeedbackCategoryOption[]> {
  if (!isTenantId(tenantId)) return [];
  const rows = await db
    .select(CATEGORY_COLUMNS)
    .from(feedbackCategories)
    .where(and(eq(feedbackCategories.tenantId, tenantId), eq(feedbackCategories.showToCustomer, true)))
    .orderBy(asc(feedbackCategories.sortOrder), asc(feedbackCategories.key));
  return rows.map((row) => ({
    key: row.key,
    label: row.label,
    ...(row.description === null ? {} : { description: row.description }),
  }));
}

export const createCategorySchema = z.object({
  /** A suggestion (0.11.0): made from the name when absent, and given a number when taken. */
  key: statusKeySchema.optional(),
  label: z.string().trim().min(1).max(60),
  description: z.string().max(200).nullish(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
  showToCustomer: z.boolean().optional(),
});

/** Key immutable, same rationale as updateStatusSchema. */
export const updateCategorySchema = z.object({
  id: z.string().min(1).max(200),
  label: z.string().trim().min(1).max(60).optional(),
  description: z.string().max(200).nullish(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
  showToCustomer: z.boolean().optional(),
});

export async function createCategory(
  db: FeedbackDb,
  tenantId: string,
  input: z.input<typeof createCategorySchema>,
): Promise<CategoryRow> {
  if (!isTenantId(tenantId)) throw new Error("createCategory: pass the company");
  const parsed = createCategorySchema.parse(input);
  await ensureFeedbackBoard(db, tenantId);
  const sortOrder =
    parsed.sortOrder ??
    (await db
      .select({ sortOrder: feedbackCategories.sortOrder })
      .from(feedbackCategories)
      .where(eq(feedbackCategories.tenantId, tenantId))
      .orderBy(desc(feedbackCategories.sortOrder))
      .limit(1)
      .then((rows: Array<{ sortOrder: number }>) => (rows[0]?.sortOrder ?? 0) + 10));
  const base = parsed.key ?? keyFromLabel(parsed.label);
  for (let attempt = 0; ; attempt += 1) {
    const existing = (await db
      .select({ key: feedbackCategories.key, label: feedbackCategories.label })
      .from(feedbackCategories)
      .where(eq(feedbackCategories.tenantId, tenantId))) as Array<{ key: string; label: string }>;
    if (existing.some((row) => sameName(row.label, parsed.label))) throw new DuplicateKeyError("category", base);
    const key = freeKey(base, new Set(existing.map((row) => row.key)));
    try {
      const rows = await db
        .insert(feedbackCategories)
        .values({
          tenantId,
          key,
          label: parsed.label,
          description: parsed.description ?? null,
          sortOrder,
          showToCustomer: parsed.showToCustomer ?? true,
        })
        .returning(CATEGORY_COLUMNS);
      const row = rows[0];
      if (!row) throw new Error("category insert returned no row");
      return row;
    } catch (error) {
      if (isUniqueViolation(error) && attempt < 5) continue;
      if (isUniqueViolation(error)) throw new DuplicateKeyError("category", base);
      throw error;
    }
  }
}

/** False: no such category in this company. */
export async function updateCategory(
  db: FeedbackDb,
  tenantId: string,
  input: z.input<typeof updateCategorySchema>,
): Promise<boolean> {
  if (!isTenantId(tenantId)) return false;
  const parsed = updateCategorySchema.parse(input);
  if (parsed.label !== undefined) {
    const others = (await db
      .select({ id: feedbackCategories.id, label: feedbackCategories.label })
      .from(feedbackCategories)
      .where(eq(feedbackCategories.tenantId, tenantId))) as Array<{ id: string; label: string }>;
    if (others.some((row) => row.id !== parsed.id && sameName(row.label, parsed.label!))) throw new DuplicateKeyError("category", parsed.id);
  }
  const patch: Record<string, unknown> = {};
  if (parsed.label !== undefined) patch["label"] = parsed.label;
  if (parsed.description !== undefined) patch["description"] = parsed.description;
  if (parsed.sortOrder !== undefined) patch["sortOrder"] = parsed.sortOrder;
  if (parsed.showToCustomer !== undefined) patch["showToCustomer"] = parsed.showToCustomer;
  const where = and(eq(feedbackCategories.tenantId, tenantId), eq(feedbackCategories.id, parsed.id));
  if (Object.keys(patch).length === 0) {
    const found = await db.select({ id: feedbackCategories.id }).from(feedbackCategories).where(where).limit(1);
    return found.length > 0;
  }
  const rows = (await db.update(feedbackCategories).set(patch).where(where).returning({ id: feedbackCategories.id })) as Array<{
    id: string;
  }>;
  return rows.length > 0;
}

export type DeleteCategoryResult =
  | { deleted: true }
  | { deleted: false; reason: "unknown" | "occupied"; ticketCount?: number };

/**
 * Refused while tickets carry the key — a deleted category would leave them
 * labelled with a word no editor can explain. Hide it from the widget with
 * showToCustomer instead; delete when its history is gone.
 */
export async function deleteCategory(db: FeedbackDb, tenantId: string, categoryId: string): Promise<DeleteCategoryResult> {
  if (!isTenantId(tenantId)) return { deleted: false, reason: "unknown" };
  const rows = await db
    .select({ id: feedbackCategories.id, key: feedbackCategories.key })
    .from(feedbackCategories)
    .where(and(eq(feedbackCategories.tenantId, tenantId), eq(feedbackCategories.id, categoryId)))
    .limit(1);
  const category = rows[0];
  if (!category) return { deleted: false, reason: "unknown" };

  const [occupied] = (await db
    .select({ n: count() })
    .from(feedbackTickets)
    .where(and(eq(feedbackTickets.tenantId, tenantId), eq(feedbackTickets.category, category.key)))) as Array<{ n: number }>;
  const ticketCount = Number(occupied?.n ?? 0);
  if (ticketCount > 0) return { deleted: false, reason: "occupied", ticketCount };

  await db
    .delete(feedbackCategories)
    .where(and(eq(feedbackCategories.tenantId, tenantId), eq(feedbackCategories.id, categoryId)));
  return { deleted: true };
}

/** The full option order, as ids. Ids that aren't this company's are skipped. */
export async function reorderCategories(db: FeedbackDb, tenantId: string, orderedIds: readonly string[]): Promise<void> {
  if (!isTenantId(tenantId)) return;
  await reorderRows(db, feedbackCategories, tenantId, orderedIds);
}

// ---------------------------------------------------------------------------
// The conversation (0.3.0) and assignment
// ---------------------------------------------------------------------------

export interface TicketMessage {
  id: string;
  ticketId: string;
  senderType: "staff" | "reporter" | "system";
  senderName: string;
  body: string;
  createdAt: Date;
}

const MESSAGE_COLUMNS = {
  id: feedbackMessages.id,
  ticketId: feedbackMessages.ticketId,
  senderType: feedbackMessages.senderType,
  senderName: feedbackMessages.senderName,
  body: feedbackMessages.body,
  createdAt: feedbackMessages.createdAt,
} as const;

/** The conversation on one of this company's tickets, oldest first ([] for any other ticket). */
export async function listTicketMessages(db: FeedbackDb, tenantId: string, ticketId: string): Promise<TicketMessage[]> {
  if (!isTenantId(tenantId)) return [];
  return db
    .select(MESSAGE_COLUMNS)
    .from(feedbackMessages)
    .innerJoin(feedbackTickets, eq(feedbackTickets.id, feedbackMessages.ticketId))
    .where(and(eq(feedbackTickets.tenantId, tenantId), eq(feedbackMessages.ticketId, ticketId)))
    .orderBy(asc(feedbackMessages.createdAt), asc(feedbackMessages.id));
}

export const addMessageSchema = z.object({
  ticketId: z.string().min(1).max(200),
  senderType: z.enum(["staff", "reporter", "system"]),
  senderName: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(5000),
});

/** The insert itself, for callers that already looked the ticket up inside its company. */
async function insertMessage(db: FeedbackDb, input: z.infer<typeof addMessageSchema>): Promise<TicketMessage> {
  const rows = await db.insert(feedbackMessages).values(input).returning(MESSAGE_COLUMNS);
  const row = rows[0];
  if (!row) throw new Error("message insert returned no row");
  return row as TicketMessage;
}

/** A message on one of this company's tickets; null when the ticket isn't this company's. */
export async function addTicketMessage(
  db: FeedbackDb,
  tenantId: string,
  input: z.input<typeof addMessageSchema>,
): Promise<TicketMessage | null> {
  if (!isTenantId(tenantId)) return null;
  const parsed = addMessageSchema.parse(input);
  const [ticket] = await db
    .select({ id: feedbackTickets.id })
    .from(feedbackTickets)
    .where(and(eq(feedbackTickets.tenantId, tenantId), eq(feedbackTickets.id, parsed.ticketId)))
    .limit(1);
  if (!ticket) return null;
  return insertMessage(db, parsed);
}

/**
 * Null assignee unassigns. A "system" message records the handoff in the
 * conversation itself, so the thread reads as the ticket's history without
 * joining an audit table (the reporter never sees system messages). False:
 * not this company's ticket.
 */
export async function assignTicket(
  db: FeedbackDb,
  tenantId: string,
  input: { ticketId: string; assignee: string | null; actorName: string; actorId?: string | null },
): Promise<boolean> {
  if (!isTenantId(tenantId)) return false;
  const assignee = input.assignee?.trim() ? input.assignee.trim().slice(0, 120) : null;
  const [before] = (await db
    .select({ assignee: feedbackTickets.assignee })
    .from(feedbackTickets)
    .where(and(eq(feedbackTickets.tenantId, tenantId), eq(feedbackTickets.id, input.ticketId)))
    .limit(1)) as Array<{ assignee: string | null }>;
  if (!before) return false;
  const rows = (await db
    .update(feedbackTickets)
    // A typed name is not one of the company's people: the id goes (0.11.0),
    // so the "Assigned to" filter never matches a person by a stale id.
    .set({ assignee, assigneeId: null })
    .where(and(eq(feedbackTickets.tenantId, tenantId), eq(feedbackTickets.id, input.ticketId)))
    .returning({ id: feedbackTickets.id })) as Array<{ id: string }>;
  if (rows.length === 0) return false;
  const actorName = input.actorName.trim().slice(0, 120) || "The team";
  await insertMessage(db, {
    ticketId: input.ticketId,
    senderType: "system",
    senderName: actorName,
    body: assignee ? `Assigned to ${assignee}` : "Unassigned",
  });
  if (before.assignee !== assignee) {
    await recordEventsQuietly(db, tenantId, [
      { ticketId: input.ticketId, kind: "assignee", fromValue: before.assignee, toValue: assignee, actorId: input.actorId ?? null, actorName },
    ]);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Website keys — issue, list, revoke, per company
// ---------------------------------------------------------------------------

export interface IssuedClientKey {
  id: string;
  tenantId: string;
  label: string;
  /** The one and only time the plaintext is available. */
  key: string;
}

export async function issueClientKey(
  db: FeedbackDb,
  input: { tenantId: string; label: string },
): Promise<IssuedClientKey> {
  if (!isTenantId(input.tenantId)) throw new Error("issueClientKey: pass the company");
  const key = generateClientKey();
  const keyHash = await hashClientKey(key);
  const label = input.label.trim().slice(0, 80) || "Website";
  const rows = await db
    .insert(feedbackClientKeys)
    .values({ tenantId: input.tenantId, label, keyHash })
    .returning({ id: feedbackClientKeys.id });
  const row = rows[0];
  if (!row) throw new Error("key insert returned no row");
  return { id: row.id, tenantId: input.tenantId, label, key };
}

/** A website key as it is listed: never the key itself (only its hash is kept). */
export interface ClientKeyRow {
  id: string;
  label: string;
  createdAt: Date;
  revokedAt: Date | null;
}

/** This company's website keys, newest first, revoked ones included (they explain a refused widget). */
export async function listClientKeys(db: FeedbackDb, tenantId: string): Promise<ClientKeyRow[]> {
  if (!isTenantId(tenantId)) return [];
  return db
    .select({
      id: feedbackClientKeys.id,
      label: feedbackClientKeys.label,
      createdAt: feedbackClientKeys.createdAt,
      revokedAt: feedbackClientKeys.revokedAt,
    })
    .from(feedbackClientKeys)
    .where(eq(feedbackClientKeys.tenantId, tenantId))
    .orderBy(desc(feedbackClientKeys.createdAt), desc(feedbackClientKeys.id));
}

/**
 * Switch one of this company's website keys off. A revoked key stays listed
 * (it explains a widget that stopped working) and is never switched back on.
 * False: not this company's key.
 */
export async function revokeClientKey(
  db: FeedbackDb,
  tenantId: string,
  keyId: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (!isTenantId(tenantId)) return false;
  const [row] = await db
    .select({ id: feedbackClientKeys.id, revokedAt: feedbackClientKeys.revokedAt })
    .from(feedbackClientKeys)
    .where(and(eq(feedbackClientKeys.tenantId, tenantId), eq(feedbackClientKeys.id, keyId)))
    .limit(1);
  if (!row) return false;
  if (row.revokedAt === null) {
    await db
      .update(feedbackClientKeys)
      .set({ revokedAt: now })
      .where(and(eq(feedbackClientKeys.tenantId, tenantId), eq(feedbackClientKeys.id, keyId), isNull(feedbackClientKeys.revokedAt)));
  }
  return true;
}

export interface VerifiedClientKey {
  keyId: string;
  tenantId: string;
}

/** null means "refuse", never "guess a company". */
export async function verifyClientKey(db: FeedbackDb, key: string): Promise<VerifiedClientKey | null> {
  if (!key.startsWith(CLIENT_KEY_PREFIX) || key.length > 200) return null;
  const keyHash = await hashClientKey(key);
  const rows = await db
    .select({ id: feedbackClientKeys.id, tenantId: feedbackClientKeys.tenantId })
    .from(feedbackClientKeys)
    .where(and(eq(feedbackClientKeys.keyHash, keyHash), isNull(feedbackClientKeys.revokedAt)))
    .limit(1);
  const row = rows[0];
  return row ? { keyId: row.id, tenantId: row.tenantId } : null;
}

// ---------------------------------------------------------------------------
// Assignees typed by name before 0.11.0
// ---------------------------------------------------------------------------

/**
 * Link the assignees 0.10 stored as typed names to the company's people
 * (0.11.0): every ticket of THIS company whose assignee is a name, with no
 * person behind it, gets the person whose name matches — when exactly one of
 * `people` has that name (case and spacing aside). A name that matches nobody,
 * or two people, is left as it is: it stays its own "Assigned to" choice
 * ("<name> (not linked)") until someone picks a person.
 *
 * The staff handlers run this once per company per process when they have a
 * `listPeople`; a host can run it itself after the 0.10 → 0.11 upgrade.
 * Returns how many tickets it linked.
 */
export async function linkTypedAssignees(
  db: FeedbackDb,
  tenantId: string,
  people: ReadonlyArray<{ readonly id: string; readonly name: string }>,
): Promise<{ linked: number }> {
  if (!isTenantId(tenantId) || people.length === 0) return { linked: 0 };
  const typed = (await db
    .selectDistinct({ name: feedbackTickets.assignee })
    .from(feedbackTickets)
    .where(and(eq(feedbackTickets.tenantId, tenantId), isNull(feedbackTickets.assigneeId), isNotNull(feedbackTickets.assignee)))) as Array<{
    name: string;
  }>;
  let linked = 0;
  for (const { name } of typed) {
    const matches = people.filter((person) => sameName(person.name, name));
    if (matches.length !== 1) continue;
    const person = matches[0]!;
    const rows = (await db
      .update(feedbackTickets)
      .set({ assigneeId: person.id, assignee: person.name.slice(0, 120) })
      .where(and(eq(feedbackTickets.tenantId, tenantId), isNull(feedbackTickets.assigneeId), eq(feedbackTickets.assignee, name)))
      .returning({ id: feedbackTickets.id })) as Array<{ id: string }>;
    linked += rows.length;
  }
  return { linked };
}
