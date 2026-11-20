import { and, count, desc, eq, gte, isNull } from "drizzle-orm";
import { auditLog, errorLog } from "@adminigloo/observability/schema";
import { ago, daySeries, plural, type Glance } from "../glance.js";
import { BY_FIRST_COLUMN, dayOf } from "../glance-sql.js";
import type { DashboardDb } from "../handlers.js";

/**
 * Glances over @adminigloo/observability: the error log and the audit log.
 * Both are the site owner's own records across every business, as their
 * pages are; the permission that opens those pages gates these cards.
 */

export interface ObservabilityGlanceInput {
  readonly db: DashboardDb;
  readonly now: Date;
  /** Days on the chart and in "this week" counts are cut in this zone. Default UTC. */
  readonly timeZone?: string;
  /** The full page. */
  readonly href?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SPARK_DAYS = 14;

/** Errors: what's unresolved, what's new, and the ones seen most recently. */
export async function errorsGlance(input: ObservabilityGlanceInput): Promise<Glance> {
  const { db, now } = input;
  const href = input.href ?? "/admin/errors";
  const timeZone = input.timeZone ?? "UTC";
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const sparkFrom = new Date(now.getTime() - SPARK_DAYS * DAY_MS);

  const [unresolved, seenToday, newToday, recent, perDay] = await Promise.all([
    db.select({ n: count() }).from(errorLog).where(isNull(errorLog.resolvedAt)),
    db
      .select({ n: count() })
      .from(errorLog)
      .where(and(isNull(errorLog.resolvedAt), gte(errorLog.lastSeenAt, dayAgo))),
    db.select({ n: count() }).from(errorLog).where(gte(errorLog.firstSeenAt, dayAgo)),
    db
      .select({
        message: errorLog.message,
        source: errorLog.source,
        occurrences: errorLog.occurrences,
        lastSeenAt: errorLog.lastSeenAt,
      })
      .from(errorLog)
      .where(isNull(errorLog.resolvedAt))
      .orderBy(desc(errorLog.lastSeenAt))
      .limit(5),
    db
      .select({ day: dayOf(errorLog.firstSeenAt, timeZone), n: count() })
      .from(errorLog)
      .where(gte(errorLog.firstSeenAt, sparkFrom))
      .groupBy(BY_FIRST_COLUMN),
  ]);

  const open = unresolved[0]?.n ?? 0;
  const live = seenToday[0]?.n ?? 0;
  const fresh = newToday[0]?.n ?? 0;

  return {
    status:
      open === 0
        ? { text: "No unresolved errors.", tone: "good" }
        : live > 0
          ? { text: `${plural(open, "error")} unresolved; ${plural(live, "was", "were")} seen in the last day.`, tone: "bad" }
          : { text: `${plural(open, "error")} unresolved, none seen in the last day.`, tone: "warn" },
    attention: open,
    tiles: [
      { label: "Unresolved", value: open, href, tone: open > 0 ? "bad" : "good" },
      { label: "Seen today", value: live, href, tone: live > 0 ? "bad" : undefined, hint: "Unresolved, in the last 24 h" },
      { label: "New today", value: fresh, href, hint: "First seen in the last 24 h" },
    ],
    spark: { label: "New errors by day", points: daySeries(perDay, SPARK_DAYS, now, timeZone) },
    list: {
      title: "Most recent",
      empty: "Nothing to triage.",
      rows: recent.map((row) => ({
        title: row.message,
        meta: `${row.occurrences > 1 ? `×${row.occurrences.toLocaleString("en-US")} · ` : ""}${ago(row.lastSeenAt, now)}`,
        badge: row.source ?? undefined,
        tone: row.lastSeenAt.getTime() >= dayAgo.getTime() ? "bad" : "neutral",
        href,
      })),
    },
    link: { href, label: "Open errors" },
  };
}

/** "staff.role_granted" → "Staff role granted". */
function readable(action: string): string {
  const words = action.replace(/[._:-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The audit log: how much happened, and any access to sensitive records. */
export async function auditGlance(input: ObservabilityGlanceInput): Promise<Glance> {
  const { db, now } = input;
  const href = input.href ?? "/admin/audit";
  const timeZone = input.timeZone ?? "UTC";
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
  const sparkFrom = new Date(now.getTime() - SPARK_DAYS * DAY_MS);

  const [today, sensitive, latest, perDay] = await Promise.all([
    db.select({ n: count() }).from(auditLog).where(gte(auditLog.createdAt, dayAgo)),
    db
      .select({ n: count() })
      .from(auditLog)
      .where(and(eq(auditLog.isSensitive, true), gte(auditLog.createdAt, weekAgo))),
    db
      .select({ action: auditLog.action, isSensitive: auditLog.isSensitive, createdAt: auditLog.createdAt })
      .from(auditLog)
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(5),
    db
      .select({ day: dayOf(auditLog.createdAt, timeZone), n: count() })
      .from(auditLog)
      .where(gte(auditLog.createdAt, sparkFrom))
      .groupBy(BY_FIRST_COLUMN),
  ]);

  const actions = today[0]?.n ?? 0;
  const touchy = sensitive[0]?.n ?? 0;
  const sensitiveHref = `${href}?sensitive=1`;

  return {
    status:
      touchy > 0
        ? { text: `${plural(touchy, "sensitive record")} opened this week. Worth a look.`, tone: "warn" }
        : { text: `${plural(actions, "action")} recorded in the last day.`, tone: "neutral" },
    tiles: [
      { label: "Last 24 h", value: actions, href },
      { label: "Sensitive, 7 days", value: touchy, href: sensitiveHref, tone: touchy > 0 ? "warn" : undefined },
    ],
    spark: { label: "Actions by day", points: daySeries(perDay, SPARK_DAYS, now, timeZone) },
    list: {
      title: "Latest",
      empty: "Nothing recorded yet.",
      rows: latest.map((row) => ({
        title: readable(row.action),
        meta: ago(row.createdAt, now),
        badge: row.isSensitive ? "Sensitive" : undefined,
        tone: row.isSensitive ? "warn" : undefined,
        href: row.isSensitive ? sensitiveHref : href,
      })),
    },
    link: { href, label: "Open the audit log" },
  };
}
