import { and, asc, count, desc, eq, inArray, isNull, max, sql } from "drizzle-orm";
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
import { feedbackCategories, feedbackClientKeys, feedbackMessages, feedbackStatuses, feedbackTickets } from "./schema.js";

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
 * it's used — and only then: a company that already has any column (or any
 * category) gets nothing added, so a column the owner deleted never comes
 * back.
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
    key: statusKeySchema,
    label: z.string().trim().min(1).max(60),
    color: z.string().max(30).nullish(),
    sortOrder: z.number().int().min(0).max(100000).optional(),
    isTerminal: z.boolean().optional(),
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

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code ?? (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return code === "23505";
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
  try {
    const rows = await db
      .insert(feedbackStatuses)
      .values({
        tenantId,
        key: parsed.key,
        label: parsed.label,
        color: parsed.color ?? null,
        sortOrder,
        isTerminal: parsed.isTerminal ?? false,
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
    if (isUniqueViolation(error)) throw new DuplicateKeyError("column", parsed.key);
    throw error;
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
  const patch: Record<string, unknown> = {};
  if (parsed.label !== undefined) patch["label"] = parsed.label;
  if (parsed.color !== undefined) patch["color"] = parsed.color;
  if (parsed.sortOrder !== undefined) patch["sortOrder"] = parsed.sortOrder;
  if (parsed.isTerminal !== undefined) patch["isTerminal"] = parsed.isTerminal;
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
  | { deleted: true }
  | { deleted: false; reason: "unknown" | "occupied"; ticketCount?: number };

/**
 * Refuses to delete a column that holds tickets, and says how many — the
 * alternative is tickets whose status points at nothing, which vanish from
 * every column of the board while still existing in the queue. Move them
 * first; the refusal message is the instruction. "unknown" for a column that
 * isn't on this company's board.
 */
export async function deleteStatus(db: FeedbackDb, tenantId: string, statusId: string): Promise<DeleteStatusResult> {
  if (!isTenantId(tenantId)) return { deleted: false, reason: "unknown" };
  const rows = await db
    .select({ id: feedbackStatuses.id, key: feedbackStatuses.key })
    .from(feedbackStatuses)
    .where(and(eq(feedbackStatuses.tenantId, tenantId), eq(feedbackStatuses.id, statusId)))
    .limit(1);
  const status = rows[0];
  if (!status) return { deleted: false, reason: "unknown" };

  const [occupied] = (await db
    .select({ n: count() })
    .from(feedbackTickets)
    .where(and(eq(feedbackTickets.tenantId, tenantId), eq(feedbackTickets.status, status.key)))) as Array<{ n: number }>;
  const ticketCount = Number(occupied?.n ?? 0);
  if (ticketCount > 0) return { deleted: false, reason: "occupied", ticketCount };

  await db.delete(feedbackStatuses).where(and(eq(feedbackStatuses.tenantId, tenantId), eq(feedbackStatuses.id, statusId)));
  return { deleted: true };
}

/**
 * The full column order, as ids. Renumbers in tens so gaps stay available.
 * An id that isn't one of this company's columns is skipped by the WHERE.
 */
export async function reorderStatuses(db: FeedbackDb, tenantId: string, orderedIds: readonly string[]): Promise<void> {
  if (!isTenantId(tenantId)) return;
  for (const [index, id] of orderedIds.entries()) {
    await db
      .update(feedbackStatuses)
      .set({ sortOrder: (index + 1) * 10 })
      .where(and(eq(feedbackStatuses.tenantId, tenantId), eq(feedbackStatuses.id, id)));
  }
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

export interface BoardData {
  statuses: BoardStatus[];
  tickets: BoardTicket[];
  /**
   * How many un-archived tickets sit in finished columns right now — the
   * number on the "Archive done (N)" button, counted in the database rather
   * than from the capped page of tickets above.
   */
  archivableCount: number;
}

/** How many cards one board read returns at most, newest first. */
export const BOARD_TICKET_LIMIT = 300;

const TICKET_CARD_COLUMNS = {
  id: feedbackTickets.id,
  ticketNumber: feedbackTickets.ticketNumber,
  title: feedbackTickets.title,
  priority: feedbackTickets.priority,
  category: feedbackTickets.category,
  status: feedbackTickets.status,
  assignee: feedbackTickets.assignee,
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

/** A company's board: its columns (seeded the first time) and its newest tickets. */
export async function listBoardData(
  db: FeedbackDb,
  tenantId: string,
  options: { includeArchived?: boolean } = {},
): Promise<BoardData> {
  if (!isTenantId(tenantId)) return { statuses: [], tickets: [], archivableCount: 0 };
  await ensureFeedbackBoard(db, tenantId);
  const statuses = await listStatuses(db, tenantId);

  const rows = (await db
    .select(TICKET_CARD_COLUMNS)
    .from(feedbackTickets)
    .where(
      and(
        eq(feedbackTickets.tenantId, tenantId),
        // Archived tickets leave the board by default; the eye toggle brings
        // them back greyed rather than moving them anywhere.
        options.includeArchived ? undefined : isNull(feedbackTickets.archivedAt),
      ),
    )
    .orderBy(desc(feedbackTickets.createdAt), desc(feedbackTickets.id))
    .limit(BOARD_TICKET_LIMIT)) as Array<BoardTicket & { lastStaffReadAt: Date | null }>;

  const terminalKeys = statuses.filter((s) => s.isTerminal).map((s) => s.key);
  let archivableCount = 0;
  if (terminalKeys.length > 0) {
    const [archivable] = (await db
      .select({ n: count() })
      .from(feedbackTickets)
      .where(
        and(
          eq(feedbackTickets.tenantId, tenantId),
          inArray(feedbackTickets.status, terminalKeys),
          isNull(feedbackTickets.archivedAt),
        ),
      )) as Array<{ n: number }>;
    archivableCount = Number(archivable?.n ?? 0);
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

  return { statuses, tickets, archivableCount };
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

/** How many times a ticket number is retried when two submits race for it. */
const NUMBER_ATTEMPTS = 8;

/**
 * Put a report on a company's board: the ticket (numbered in that company),
 * the reporter's follow-up token, and the reporter's own words as the first
 * message of the conversation.
 *
 * RACE-SAFE NUMBERING without a lock (so it works on every driver, neon-http
 * included): the unique index on (company, number) is the arbiter, and a
 * submit that loses the race takes the next number, up to eight times.
 */
export async function createTicket(
  db: FeedbackDb,
  input: { readonly tenantId: string; readonly payload: SubmitPayload },
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

  for (let attempt = 0; ; attempt++) {
    const ticketNumber = await nextTicketNumber(db, tenantId);
    let id: string | undefined;
    try {
      const [inserted] = (await db
        .insert(feedbackTickets)
        .values({
          tenantId,
          ticketNumber,
          title,
          description: payload.description,
          priority: payload.priority,
          category: payload.category ?? null,
          status,
          screenshotUrl: payload.screenshotUrl ?? null,
          annotatedScreenshotUrl: payload.annotatedScreenshotUrl ?? null,
          reporterName: payload.reporter?.name?.trim() || null,
          reporterEmail: payload.reporter?.email?.trim() || null,
          reporterTokenHash,
          pagePathname: payload.clientMetadata.pathname,
          clientMetadata: payload.clientMetadata,
          recentErrors: payload.recentErrors ?? [],
        })
        .returning({ id: feedbackTickets.id })) as Array<{ id: string }>;
      id = inserted?.id;
    } catch (error) {
      if (isUniqueViolation(error) && attempt < NUMBER_ATTEMPTS - 1) continue;
      throw error;
    }
    if (!id) throw new Error("ticket insert returned no row");
    // The reporter's own words as the first message, so "My reports → thread"
    // shows their submission rather than an empty conversation. Best-effort:
    // a ticket that was created must not fail because its first message didn't.
    try {
      await insertMessage(db, {
        ticketId: id,
        senderType: "reporter",
        senderName: payload.reporter?.name?.trim() || payload.reporter?.email?.trim() || "Reporter",
        body: payload.description,
      });
    } catch {
      /* the ticket stands */
    }
    return { id, ticketNumber, ticketToken, title, status };
  }
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

/**
 * The one board mutation. An unknown column key is refused instead of written
 * — a drop target that doesn't exist is a stale client, and a silently
 * invented status would vanish from every column. Moving a ticket to the
 * column it's already in changes nothing (and resets no aging clock).
 */
export async function moveTicket(
  db: FeedbackDb,
  tenantId: string,
  input: { ticketId: string; statusKey: string },
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
  input: { ticketIds: readonly string[]; statusKey: string },
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
  input: { ticketId: string; archivedBy: string },
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
  return rows.length > 0;
}

/** False: not this company's ticket. */
export async function unarchiveTicket(db: FeedbackDb, tenantId: string, ticketId: string): Promise<boolean> {
  if (!isTenantId(tenantId)) return false;
  const rows = (await db
    .update(feedbackTickets)
    .set({ archivedAt: null, archivedBy: null })
    .where(and(eq(feedbackTickets.tenantId, tenantId), eq(feedbackTickets.id, ticketId)))
    .returning({ id: feedbackTickets.id })) as Array<{ id: string }>;
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
  input: { archivedBy: string },
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
  key: statusKeySchema,
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
  try {
    const rows = await db
      .insert(feedbackCategories)
      .values({
        tenantId,
        key: parsed.key,
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
    if (isUniqueViolation(error)) throw new DuplicateKeyError("category", parsed.key);
    throw error;
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
  for (const [index, id] of orderedIds.entries()) {
    await db
      .update(feedbackCategories)
      .set({ sortOrder: (index + 1) * 10 })
      .where(and(eq(feedbackCategories.tenantId, tenantId), eq(feedbackCategories.id, id)));
  }
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
  input: { ticketId: string; assignee: string | null; actorName: string },
): Promise<boolean> {
  if (!isTenantId(tenantId)) return false;
  const assignee = input.assignee?.trim() ? input.assignee.trim().slice(0, 120) : null;
  const rows = (await db
    .update(feedbackTickets)
    .set({ assignee })
    .where(and(eq(feedbackTickets.tenantId, tenantId), eq(feedbackTickets.id, input.ticketId)))
    .returning({ id: feedbackTickets.id })) as Array<{ id: string }>;
  if (rows.length === 0) return false;
  await insertMessage(db, {
    ticketId: input.ticketId,
    senderType: "system",
    senderName: input.actorName.trim().slice(0, 120) || "The team",
    body: assignee ? `Assigned to ${assignee}` : "Unassigned",
  });
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
