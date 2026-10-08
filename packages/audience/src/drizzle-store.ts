import { and, desc, eq, getTableName, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { REASON_ORDER, type AudienceReason } from "./core/labels.js";
import { breakdownParts, countRowsParts } from "./core/sql.js";
import type {
  AudienceStore,
  ClearedMark,
  ClearMarksWhere,
  ListMarksWhere,
  NewAudienceRuleRow,
  RowCount,
  RowCountQuery,
  RowWindowQuery,
} from "./core/store.js";
import type { AudienceMark, AudienceRule, AudienceRun, NewAudienceMark, NewAudienceRun } from "./core/types.js";
import { toDrizzleSql } from "./drizzle-sql.js";
import { audienceTables, newAudienceId, type AudienceTables } from "./schema.js";

/**
 * The default store: Drizzle over Postgres (Neon in production, PGlite in the
 * tests). Every query names the tenant. Marks are inserted with
 * ON CONFLICT DO NOTHING against the partial unique index, which is what makes
 * every apply, observe and backfill idempotent under concurrency, not just in
 * one process — and only while their rule is still active, checked in the
 * same statement with the rule row share-locked, so a removal racing an
 * insert on another instance can never leave a mark behind.
 */

/** The loosest Drizzle handle that runs these queries — Neon, a transaction, PGlite. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AudienceDb = PgDatabase<any, any, any>;

const VISITOR_BATCH = 1000;

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  const date = new Date(String(value).replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function createDrizzleAudienceStore(options: { db: AudienceDb; tables?: AudienceTables }): AudienceStore {
  const db = options.db;
  const t = options.tables ?? audienceTables;

  const ruleOf = (row: typeof t.rules.$inferSelect): AudienceRule => ({
    id: row.id,
    tenantId: row.tenantId,
    kind: row.kind,
    value: row.value,
    reasonLabel: row.reasonLabel,
    note: row.note,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    disabledAt: row.disabledAt,
    disabledBy: row.disabledBy,
    appliesFrom: row.appliesFrom,
  });

  const markOf = (row: typeof t.marks.$inferSelect): AudienceMark => ({
    id: row.id,
    tenantId: row.tenantId,
    subjectKind: row.subjectKind,
    subjectId: row.subjectId,
    reason: row.reason,
    ruleId: row.ruleId,
    source: row.source,
    markedBy: row.markedBy,
    markedAt: row.markedAt,
    clearedAt: row.clearedAt,
    clearedBy: row.clearedBy,
    appliesFrom: row.appliesFrom,
  });

  const runOf = (row: typeof t.runs.$inferSelect): AudienceRun => ({
    id: row.id,
    tenantId: row.tenantId,
    ruleId: row.ruleId,
    action: row.action,
    subjectsChanged: row.subjectsChanged,
    sessionsAffected: row.sessionsAffected,
    rangeFrom: row.rangeFrom,
    rangeTo: row.rangeTo,
    runBy: row.runBy,
    runAt: row.runAt,
    summary: row.summary,
  });

  const marksTable = getTableName(t.marks);
  const rulesTable = getTableName(t.rules);

  async function countBatch(tenantId: string, query: RowCountQuery, visitorIds: readonly string[] | null): Promise<RowCount> {
    const parts = countRowsParts({
      tenantId,
      marksTable,
      rows: query.rows,
      from: query.from ?? null,
      to: query.to ?? null,
      visitorIds,
      countedOnly: query.countedOnly,
      ...((query.rows as { castToText?: boolean }).castToText ? { castToText: true } : {}),
    });
    const row = rowsOf<{ n: unknown; v: unknown; earliest: unknown; latest: unknown }>(await db.execute(toDrizzleSql(parts)))[0];
    return {
      rows: Number(row?.n ?? 0),
      visitors: Number(row?.v ?? 0),
      earliest: toDate(row?.earliest),
      latest: toDate(row?.latest),
    };
  }

  return {
    marksTable,

    async listRules(tenantId, opts = {}) {
      const rows = await db
        .select()
        .from(t.rules)
        .where(opts.includeDisabled ? eq(t.rules.tenantId, tenantId) : and(eq(t.rules.tenantId, tenantId), isNull(t.rules.disabledAt)))
        .orderBy(desc(t.rules.createdAt));
      return rows.map(ruleOf);
    },

    async getRule(tenantId, id) {
      const [row] = await db.select().from(t.rules).where(and(eq(t.rules.tenantId, tenantId), eq(t.rules.id, id))).limit(1);
      return row ? ruleOf(row) : null;
    },

    async insertRule(rule: NewAudienceRuleRow) {
      const [row] = await db
        .insert(t.rules)
        .values({
          tenantId: rule.tenantId,
          kind: rule.kind,
          value: rule.value,
          reasonLabel: rule.reasonLabel,
          note: rule.note,
          createdBy: rule.createdBy,
          createdAt: rule.createdAt,
          appliesFrom: rule.appliesFrom,
        })
        .returning();
      return ruleOf(row!);
    },

    async disableRule(tenantId, id, at, by) {
      const rows = await db
        .update(t.rules)
        .set({ disabledAt: at, disabledBy: by })
        .where(and(eq(t.rules.tenantId, tenantId), eq(t.rules.id, id), isNull(t.rules.disabledAt)))
        .returning({ id: t.rules.id });
      return rows.length > 0;
    },

    async insertMarks(marks: readonly NewAudienceMark[]) {
      if (!marks.length) return 0;
      // INSERT … SELECT FROM (VALUES …) so each row can be checked against
      // its rule in the same statement. `FOR SHARE` makes the check atomic
      // with `disableRule`: a concurrent removal waits for this insert to
      // commit (and then clears what it wrote), or this insert waits for the
      // removal and sees the rule disabled. ON CONFLICT DO NOTHING (no target)
      // covers the partial unique index, as before.
      const rows = marks.map(
        (mark) =>
          sql`(${newAudienceId()}::text, ${mark.tenantId}::text, ${mark.subjectKind}::text, ${mark.subjectId}::text, ${mark.reason}::text, ${mark.ruleId}::text, ${mark.source}::text, ${mark.markedBy}::text, ${mark.markedAt.toISOString()}::timestamptz, ${mark.appliesFrom ? mark.appliesFrom.toISOString() : null}::timestamptz)`,
      );
      const result = await db.execute(sql`
        INSERT INTO ${sql.identifier(marksTable)} ("id", "tenant_id", "subject_kind", "subject_id", "reason", "rule_id", "source", "marked_by", "marked_at", "applies_from")
        SELECT v.id, v.tenant_id, v.subject_kind, v.subject_id, v.reason, v.rule_id, v.source, v.marked_by, v.marked_at, v.applies_from
        FROM (VALUES ${sql.join(rows, sql`, `)}) AS v(id, tenant_id, subject_kind, subject_id, reason, rule_id, source, marked_by, marked_at, applies_from)
        WHERE v.rule_id IS NULL OR EXISTS (
          SELECT 1 FROM ${sql.identifier(rulesTable)} r
          WHERE r.id = v.rule_id AND r.tenant_id = v.tenant_id AND r.disabled_at IS NULL
          FOR SHARE
        )
        ON CONFLICT DO NOTHING
        RETURNING id`);
      return rowsOf<{ id: string }>(result).length;
    },

    async clearMarks(tenantId, where: ClearMarksWhere, at, by) {
      const conditions: SQL[] = [eq(t.marks.tenantId, tenantId), isNull(t.marks.clearedAt)];
      if ("ruleId" in where) conditions.push(eq(t.marks.ruleId, where.ruleId));
      else {
        conditions.push(eq(t.marks.subjectKind, where.subjectKind), eq(t.marks.subjectId, where.subjectId));
        if (where.sources) {
          if (!where.sources.length) return [];
          conditions.push(inArray(t.marks.source, [...where.sources]));
        }
        if (where.reason) conditions.push(eq(t.marks.reason, where.reason));
        if (where.ruleIdIsNull) conditions.push(isNull(t.marks.ruleId));
      }
      const rows = await db
        .update(t.marks)
        .set({ clearedAt: at, clearedBy: by })
        .where(and(...conditions))
        .returning({ subjectKind: t.marks.subjectKind, subjectId: t.marks.subjectId, reason: t.marks.reason, ruleId: t.marks.ruleId });
      return rows as ClearedMark[];
    },

    async listMarks(tenantId, where: ListMarksWhere) {
      const conditions: SQL[] = [eq(t.marks.tenantId, tenantId)];
      if (where.subjectKind) conditions.push(eq(t.marks.subjectKind, where.subjectKind));
      if (where.subjectIds) {
        if (where.subjectIds.length === 0) return [];
        conditions.push(inArray(t.marks.subjectId, [...where.subjectIds]));
      }
      if (where.ruleId) conditions.push(eq(t.marks.ruleId, where.ruleId));
      if (where.reason) conditions.push(eq(t.marks.reason, where.reason));
      if (where.ruleIdIsNull) conditions.push(isNull(t.marks.ruleId));
      const active = where.active === undefined ? true : where.active;
      if (active === true) conditions.push(isNull(t.marks.clearedAt));
      else if (active === false) conditions.push(isNotNull(t.marks.clearedAt));
      const query = db.select().from(t.marks).where(and(...conditions)).orderBy(t.marks.markedAt);
      const rows = where.limit ? await query.limit(where.limit) : await query;
      return rows.map(markOf);
    },

    async upsertLink(tenantId, visitorId, userKey, at) {
      await db
        .insert(t.links)
        .values({ tenantId, visitorId, userKey, firstSeen: at, lastSeen: at })
        .onConflictDoUpdate({
          target: [t.links.tenantId, t.links.visitorId, t.links.userKey],
          set: { lastSeen: sql`greatest(${t.links.lastSeen}, excluded.last_seen)` },
        });
    },

    async visitorsForUserKeys(tenantId, userKeys) {
      if (!userKeys.length) return [];
      return db
        .select({ userKey: t.links.userKey, visitorId: t.links.visitorId })
        .from(t.links)
        .where(and(eq(t.links.tenantId, tenantId), inArray(t.links.userKey, [...userKeys])));
    },

    async insertRun(run: NewAudienceRun) {
      const [row] = await db
        .insert(t.runs)
        .values({
          tenantId: run.tenantId,
          ruleId: run.ruleId,
          action: run.action,
          subjectsChanged: run.subjectsChanged,
          sessionsAffected: run.sessionsAffected,
          rangeFrom: run.rangeFrom,
          rangeTo: run.rangeTo,
          runBy: run.runBy,
          runAt: run.runAt,
          summary: run.summary,
        })
        .returning();
      return runOf(row!);
    },

    async listRuns(tenantId, opts = {}) {
      const rows = await db
        .select()
        .from(t.runs)
        .where(opts.ruleId ? and(eq(t.runs.tenantId, tenantId), eq(t.runs.ruleId, opts.ruleId)) : eq(t.runs.tenantId, tenantId))
        .orderBy(desc(t.runs.runAt), desc(t.runs.id))
        .limit(opts.limit ?? 50);
      return rows.map(runOf);
    },

    async countRows(tenantId, query: RowCountQuery): Promise<RowCount> {
      if (!query.visitorIds) return countBatch(tenantId, query, null);
      const ids = [...new Set(query.visitorIds)];
      if (!ids.length) return { rows: 0, visitors: 0, earliest: null, latest: null };
      // Each visitor lands in exactly one batch, so summing is exact.
      const total: RowCount = { rows: 0, visitors: 0, earliest: null, latest: null };
      for (let i = 0; i < ids.length; i += VISITOR_BATCH) {
        const part = await countBatch(tenantId, query, ids.slice(i, i + VISITOR_BATCH));
        total.rows += part.rows;
        total.visitors += part.visitors;
        if (part.earliest && (!total.earliest || part.earliest < total.earliest)) total.earliest = part.earliest;
        if (part.latest && (!total.latest || part.latest > total.latest)) total.latest = part.latest;
      }
      return total;
    },

    async breakdownRows(tenantId, query: RowWindowQuery) {
      const parts = breakdownParts({
        tenantId,
        marksTable,
        rows: query.rows,
        from: query.from ?? null,
        to: query.to ?? null,
        ...((query.rows as { castToText?: boolean }).castToText ? { castToText: true } : {}),
      });
      const rows = rowsOf<{ best: unknown; n: unknown }>(await db.execute(toDrizzleSql(parts)));
      return rows.map((row) => ({
        reason: (REASON_ORDER[Number(row.best)] ?? "manual") as AudienceReason,
        count: Number(row.n),
      }));
    },
  };
}
