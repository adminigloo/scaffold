import type { AudienceReason, MarkSource, SubjectKind } from "./labels.js";
import type {
  AudienceMark,
  AudienceRule,
  AudienceRun,
  NewAudienceMark,
  NewAudienceRun,
  RowsSource,
} from "./types.js";

/**
 * Everything `createAudience` needs from a database, and nothing that names
 * one. The package ships a Drizzle Postgres implementation
 * (`createDrizzleAudienceStore`); a MySQL app (Road Rally) implements this
 * interface over its own driver — the SQL builders in `./core` (`countRowsParts`,
 * `breakdownParts`, rendered with `renderSql(…, { placeholder: "?" })`) do the
 * two queries that touch the app's own rows.
 *
 * Contract, for any implementation:
 *   - Every method is scoped by `tenantId`. Nothing reads across tenants.
 *   - Nothing is ever hard-deleted. A rule is disabled; a mark is cleared.
 *   - `insertMarks` is idempotent: at most ONE active (uncleared) mark per
 *     (tenant, subject kind, subject id, rule id — or the reason, when there is
 *     no rule). A duplicate is silently skipped, and only real inserts count.
 *     MySQL has no partial unique index: use a generated column, e.g.
 *     `active_key VARCHAR(…) AS (IF(cleared_at IS NULL, CONCAT_WS('|',
 *     tenant_id, subject_kind, subject_id, COALESCE(rule_id, reason)), NULL))`
 *     with a UNIQUE index on it (NULLs never collide), and INSERT IGNORE.
 *   - `insertMarks` never creates an ACTIVE mark that names a DISABLED rule,
 *     atomically with `disableRule`. Every server instance caches rules for up
 *     to a minute, so one that has not yet seen a removal keeps classifying
 *     with the removed rule; without this check its marks would outlive the
 *     rule and exclude people for good. Postgres: `INSERT … SELECT … WHERE
 *     rule_id IS NULL OR EXISTS (SELECT 1 FROM rules WHERE id = rule_id AND
 *     disabled_at IS NULL FOR SHARE)`. MySQL: the same `INSERT … SELECT …
 *     WHERE EXISTS`, which in InnoDB already takes shared locks on the rule
 *     rows it reads.
 *   - `insertRule` refuses a second ACTIVE rule with the same (tenant, kind,
 *     value) — a unique index — and surfaces it as an `AudienceError`
 *     ("duplicate_rule") or the driver's own unique-violation error (Postgres
 *     23505, MySQL ER_DUP_ENTRY), which `createAudience` maps.
 *   - No IP address is ever passed to a store, so a store can never keep one.
 */
export interface AudienceStore {
  /** The marks table's name, as the counted-SQL fragments must spell it. */
  readonly marksTable?: string;

  listRules(tenantId: string, options?: { includeDisabled?: boolean }): Promise<AudienceRule[]>;
  getRule(tenantId: string, id: string): Promise<AudienceRule | null>;
  insertRule(rule: NewAudienceRuleRow): Promise<AudienceRule>;
  /** Sets disabled_at; returns false when the rule was missing or already disabled. */
  disableRule(tenantId: string, id: string, at: Date, by: string | null): Promise<boolean>;

  /**
   * Returns how many marks were actually inserted. Duplicates of an active
   * mark are skipped, and so is a mark whose rule is disabled (see above).
   */
  insertMarks(marks: readonly NewAudienceMark[]): Promise<number>;
  /** Sets cleared_at on the ACTIVE marks that match; returns what was cleared. */
  clearMarks(tenantId: string, where: ClearMarksWhere, at: Date, by: string | null): Promise<ClearedMark[]>;
  listMarks(tenantId: string, where: ListMarksWhere): Promise<AudienceMark[]>;

  /** Insert or refresh last_seen. A link holds a visitor id and a user KEY (an HMAC), never a user id. */
  upsertLink(tenantId: string, visitorId: string, userKey: string, at: Date): Promise<void>;
  visitorsForUserKeys(tenantId: string, userKeys: readonly string[]): Promise<Array<{ userKey: string; visitorId: string }>>;

  insertRun(run: NewAudienceRun): Promise<AudienceRun>;
  listRuns(tenantId: string, options?: { limit?: number; ruleId?: string }): Promise<AudienceRun[]>;

  /**
   * Over the APP's rows (its sessions table): row count, distinct visitors and
   * time range — in a window, optionally only some visitors, optionally only
   * rows that count. Optional: without it, preview and apply report subjects
   * but no session numbers.
   */
  countRows?(tenantId: string, query: RowCountQuery): Promise<RowCount>;
  /** Excluded rows in a window, grouped by each row's best reason. */
  breakdownRows?(tenantId: string, query: RowWindowQuery): Promise<Array<{ reason: AudienceReason; count: number }>>;
}

export interface NewAudienceRuleRow {
  tenantId: string;
  kind: AudienceRule["kind"];
  value: string;
  reasonLabel: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: Date;
  appliesFrom: Date | null;
}

export type ClearMarksWhere =
  | { ruleId: string }
  | {
      subjectKind: SubjectKind;
      subjectId: string;
      /** Only marks from these sources. Omitted: any source. */
      sources?: readonly MarkSource[];
      reason?: AudienceReason;
      ruleIdIsNull?: boolean;
    };

export interface ClearedMark {
  subjectKind: SubjectKind;
  subjectId: string;
  reason: AudienceReason;
  ruleId: string | null;
}

export interface ListMarksWhere {
  subjectKind?: SubjectKind;
  subjectIds?: readonly string[];
  ruleId?: string;
  reason?: AudienceReason;
  /** Only marks no rule owns (made at intake by a default or the code rule, by hand, or by a backfill). */
  ruleIdIsNull?: boolean;
  /** true: uncleared only (the default); false: cleared only; null: both. */
  active?: boolean | null;
  limit?: number;
}

export interface RowWindowQuery {
  rows: RowsSource;
  from?: Date | null;
  to?: Date | null;
}

export interface RowCountQuery extends RowWindowQuery {
  /** Only these visitors (batched by the store). Null/undefined: all. */
  visitorIds?: readonly string[] | null;
  /** Only rows no active mark excludes (honouring each mark's appliesFrom). */
  countedOnly: boolean;
}

export interface RowCount {
  rows: number;
  visitors: number;
  earliest: Date | null;
  latest: Date | null;
}
