import { and, count, desc, eq, gte, isNull, notInArray, sql } from "drizzle-orm";
import { feedbackMessages, feedbackTickets } from "@adminigloo/feedback/schema";
import { listStatuses } from "@adminigloo/feedback";
import { ago, daySeries, GLANCE_LIMITS, plural, type Glance, type GlanceRow, type GlanceTile } from "../glance.js";
import { BY_FIRST_COLUMN, dayOf } from "../glance-sql.js";
import type { DashboardDb } from "../handlers.js";

/**
 * The glance over @adminigloo/feedback: this site's own feedback board, one
 * company's. Every query is scoped to `tenantId` — a company sees only its
 * own tickets, the same rule every function in board-data.ts enforces.
 */
export interface FeedbackGlanceInput {
  readonly db: DashboardDb;
  readonly tenantId: string;
  readonly now: Date;
  /** The spark and "new this week" are cut in this zone. Default UTC. */
  readonly timeZone?: string;
  /** The board. */
  readonly href?: string;
  /** Who is looking, so "Assigned to you" can be their own count. */
  readonly userId?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SPARK_DAYS = 14;
const WEEK_DAYS = 7;

interface TicketRow {
  id: string;
  ticketNumber: string;
  title: string;
  createdAt: Date;
}

const ROW_COLUMNS = {
  id: feedbackTickets.id,
  ticketNumber: feedbackTickets.ticketNumber,
  title: feedbackTickets.title,
  createdAt: feedbackTickets.createdAt,
} as const;

/**
 * True for a ticket a reporter has replied to since the team last opened it
 * (board-data.ts's own `hasUnreadReporterReply` rule): the latest reporter
 * message, correlated to this ticket, is newer than `lastStaffReadAt` — or
 * there is no read mark at all. A ticket with no reporter message never
 * matches (`max(...)` is null, and `null > anything` is null).
 */
function waitingOnTeamSql(db: DashboardDb) {
  const latestReporterReply = db
    .select({ latest: sql<string | null>`max(${feedbackMessages.createdAt})` })
    .from(feedbackMessages)
    .where(and(eq(feedbackMessages.ticketId, feedbackTickets.id), eq(feedbackMessages.senderType, "reporter")));
  return sql<boolean>`(${latestReporterReply}) > coalesce(${feedbackTickets.lastStaffReadAt}, '-infinity'::timestamptz)`;
}

function rowOf(ticket: TicketRow, now: Date, waiting: boolean, href: string): GlanceRow {
  return {
    title: `${ticket.ticketNumber}: ${ticket.title}`,
    meta: ago(ticket.createdAt, now),
    badge: waiting ? "Waiting" : undefined,
    tone: waiting ? "warn" : undefined,
    href: `${href}?ticket=${encodeURIComponent(ticket.id)}`,
  };
}

export async function feedbackGlance(input: FeedbackGlanceInput): Promise<Glance> {
  const { db, tenantId, now } = input;
  const href = input.href ?? "/admin/feedback";
  const timeZone = input.timeZone ?? "UTC";
  const weekAgo = new Date(now.getTime() - WEEK_DAYS * DAY_MS);
  const sparkFrom = new Date(now.getTime() - SPARK_DAYS * DAY_MS);

  // The board's finished columns ("resolved", "closed" by default, but a
  // company's own): a handful of rows, cheap, and already exported — the
  // same read listBoardData uses to split open from finished. A board nobody
  // has opened yet has no rows here, but by the time a ticket exists
  // createTicket has already seeded the defaults, so terminalKeys is only
  // ever empty on a company with zero tickets anyway.
  const statuses = await listStatuses(db, tenantId);
  const terminalKeys = statuses.filter((s) => s.isTerminal).map((s) => s.key);

  const forTenant = eq(feedbackTickets.tenantId, tenantId);
  const notArchived = isNull(feedbackTickets.archivedAt);
  const openCondition = and(forTenant, notArchived, terminalKeys.length > 0 ? notInArray(feedbackTickets.status, terminalKeys) : undefined);

  const [openRows, waitingRows, newRows, perDay, waitingList, openList, assignedRows] = await Promise.all([
    db.select({ n: count() }).from(feedbackTickets).where(openCondition),
    db
      .select({ n: count() })
      .from(feedbackTickets)
      .where(and(forTenant, notArchived, waitingOnTeamSql(db))),
    db
      .select({ n: count() })
      .from(feedbackTickets)
      .where(and(forTenant, gte(feedbackTickets.createdAt, weekAgo))),
    db
      .select({ day: dayOf(feedbackTickets.createdAt, timeZone), n: count() })
      .from(feedbackTickets)
      .where(and(forTenant, gte(feedbackTickets.createdAt, sparkFrom)))
      .groupBy(BY_FIRST_COLUMN),
    db
      .select(ROW_COLUMNS)
      .from(feedbackTickets)
      .where(and(forTenant, notArchived, waitingOnTeamSql(db)))
      .orderBy(desc(feedbackTickets.createdAt), desc(feedbackTickets.id))
      .limit(GLANCE_LIMITS.rows),
    db.select(ROW_COLUMNS).from(feedbackTickets).where(openCondition).orderBy(desc(feedbackTickets.createdAt), desc(feedbackTickets.id)).limit(GLANCE_LIMITS.rows),
    input.userId
      ? db
          .select({ n: count() })
          .from(feedbackTickets)
          .where(and(openCondition, eq(feedbackTickets.assigneeId, input.userId)))
      : Promise.resolve([{ n: 0 }]),
  ]);

  const open = openRows[0]?.n ?? 0;
  const waiting = waitingRows[0]?.n ?? 0;
  const fresh = newRows[0]?.n ?? 0;
  const assigned = assignedRows[0]?.n ?? 0;

  const seen = new Set<string>();
  const rows: GlanceRow[] = [];
  for (const ticket of waitingList) {
    if (rows.length >= GLANCE_LIMITS.rows) break;
    seen.add(ticket.id);
    rows.push(rowOf(ticket, now, true, href));
  }
  for (const ticket of openList) {
    if (rows.length >= GLANCE_LIMITS.rows) break;
    if (seen.has(ticket.id)) continue;
    rows.push(rowOf(ticket, now, false, href));
  }

  const tiles: GlanceTile[] = [
    { label: "Open", value: open, href, tone: open === 0 ? "good" : undefined },
    { label: "Waiting on team", value: waiting, href, tone: waiting > 0 ? "warn" : "good", hint: "A customer replied and nobody on the team has read it" },
    { label: "New this week", value: fresh, href, hint: "Opened in the last 7 days" },
  ];
  if (input.userId) tiles.push({ label: "Assigned to you", value: assigned, href });

  return {
    status:
      open === 0
        ? { text: "No open tickets.", tone: "good" }
        : waiting > 0
          ? { text: `${plural(waiting, "ticket")} waiting on a reply from the team.`, tone: "warn" }
          : { text: `${plural(open, "ticket")} open, none waiting on a reply.`, tone: "neutral" },
    attention: waiting,
    tiles,
    spark: { label: "Tickets by day", points: daySeries(perDay, SPARK_DAYS, now, timeZone) },
    list: { title: "Tickets", empty: "No tickets yet.", rows },
    link: { href, label: "Open the feedback board" },
  };
}
