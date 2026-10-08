import { REASON_ORDER, SUBJECT_KINDS, type SubjectKind } from "./labels.js";
import type { RowsSource } from "./types.js";

/**
 * The read side, as SQL TEXT: the anti-join every counting query adds, and
 * the two queries the store runs over the app's own rows (counts and the
 * per-reason breakdown). Built as parts — text, bound values, and opaque
 * chunks — so one builder serves a raw-SQL caller (`?` or `$n` placeholders,
 * Postgres or MySQL) and the Drizzle `sql` adapter in the package root alike.
 *
 * Excluding NEVER rewrites an app row. A row is left out because a mark
 * exists for its visitor (or its session) and is not cleared — so adding a
 * rule cleans history at once and removing it restores history exactly.
 */

export type SqlPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "param"; readonly value: unknown }
  | { readonly kind: "chunk"; readonly chunk: unknown };

/** A column reference: an identifier ("s.visitor_id", "\"s\".\"visitorId\"") or an opaque chunk from an adapter. */
export type ColumnInput = string | { readonly chunk: unknown };

export type SqlDialect = "postgres" | "mysql";

export const DEFAULT_MARKS_TABLE = "aig_audience_marks";

const BARE_PART = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const DOUBLE_QUOTED_PART = /^"[^"\u0000]+"$/;
const BACKTICK_PART = /^`[^`\u0000\\]+`$/;

/**
 * One part of an identifier, in the dialect's OWN quoting only. In MySQL's
 * default mode `"x"` is a string literal, so a fragment comparing a mark to it
 * would silently match nothing; in Postgres a backtick is not a quote at all.
 */
function identPartOk(part: string, dialect: SqlDialect): boolean {
  if (BARE_PART.test(part)) return true;
  if (dialect === "mysql") return BACKTICK_PART.test(part);
  return DOUBLE_QUOTED_PART.test(part);
}

/** An identifier, optionally dotted (alias.column, schema.table), each part bare or quoted the dialect's way. */
export function assertIdentifier(value: string, what: string, dialect: SqlDialect = "postgres"): string {
  const parts = typeof value === "string" ? splitIdentifier(value) : [];
  if (parts.length === 0 || parts.length > 3 || !parts.every((part) => identPartOk(part, dialect))) {
    throw new Error(
      `@adminigloo/audience: ${what} must be a plain SQL identifier${dialect === "mysql" ? " (quote with backticks in MySQL)" : ""} (got ${JSON.stringify(value)}).`,
    );
  }
  return value;
}

/** One identifier, no dots — a bare column name. */
export function assertColumnName(value: string, what: string, dialect: SqlDialect = "postgres"): string {
  if (typeof value !== "string" || !identPartOk(value, dialect)) {
    throw new Error(`@adminigloo/audience: ${what} must be a single column name (got ${JSON.stringify(value)}).`);
  }
  return value;
}

const unquote = (part: string) => (/^["`].*["`]$/.test(part) ? part.slice(1, -1) : part).toLowerCase();

/**
 * A column of the APP's row, as the anti-join compares it. It must be
 * qualified with the app's alias (`s.visitor_id`, `o.id`): inside
 * `EXISTS (SELECT 1 FROM marks aig_m WHERE … = <col>)` a bare `id` resolves to
 * the MARKS row's own id, so the mark is compared with itself, never matches,
 * and exclusion silently turns off.
 */
function assertOuterColumn(value: string, what: string, dialect: SqlDialect, alias: string): string {
  assertIdentifier(value, what, dialect);
  const parts = splitIdentifier(value);
  if (parts.length < 2) {
    throw new Error(
      `@adminigloo/audience: qualify ${what} with your table's alias (e.g. "s.${parts[0] ?? "visitor_id"}"), got ${JSON.stringify(value)}. A bare name inside the anti-join can resolve to the marks table's own column and turn exclusion off.`,
    );
  }
  if (unquote(parts[0]!) === unquote(alias)) {
    throw new Error(`@adminigloo/audience: ${what} ${JSON.stringify(value)} names the marks alias "${alias}"; use your own table's alias.`);
  }
  return value;
}

function splitIdentifier(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of value) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "`") {
      current += ch;
      quote = ch;
    } else if (ch === ".") {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (quote) return [];
  parts.push(current);
  return parts;
}

const text = (value: string): SqlPart => ({ kind: "text", text: value });
const param = (value: unknown): SqlPart => ({ kind: "param", value });

function column(input: ColumnInput, what: string, cast: string | null, options: CountedOptions): SqlPart[] {
  const inner: SqlPart =
    typeof input === "string"
      ? text(assertOuterColumn(input, what, options.dialect ?? "postgres", options.alias ?? "aig_m"))
      : { kind: "chunk", chunk: input.chunk };
  return cast ? [text("CAST("), inner, text(` AS ${cast})`)] : [inner];
}

function castType(dialect: SqlDialect): string {
  return dialect === "mysql" ? "CHAR" : "TEXT";
}

export interface CountedOptions {
  tenantId: string;
  /** The marks table (default `aig_audience_marks`). */
  marksTable?: string;
  /** The per-request "include internal" view: the fragment becomes always-true. */
  includeInternal?: boolean;
  /**
   * The row's time column (`"s.created_at"`). With it, a rule's "only from"
   * date is honoured: rows before it stay counted. REQUIRED for the visitor
   * fragment (pass `null` to opt out knowingly), because without it a rule
   * with a start date excludes all of history while `excludedBreakdown`
   * honours the date, and "Excluded: N" stops matching the report.
   */
  time?: ColumnInput | null;
  /**
   * The row's session id column (`"s.id"`), so visit-only reasons (automation,
   * a network, a non-production host) marked on one session leave that
   * session out. REQUIRED for the visitor fragment (`null` when the read has
   * no session id — then session marks are ignored).
   */
  session?: ColumnInput | null;
  /** Wrap the app's column in CAST(… AS TEXT) — for a uuid or integer id column. */
  castToText?: boolean;
  dialect?: SqlDialect;
  /** The marks alias inside the subquery (default `aig_m`); change it only on a clash. */
  alias?: string;
}

/** The visitor fragment's options: `time` and `session` must be named (or set to null on purpose). */
export interface CountedVisitorOptions extends CountedOptions {
  time: ColumnInput | null;
  session: ColumnInput | null;
}

function marksExists(
  subjectKind: SubjectKind,
  subjectColumn: ColumnInput,
  options: CountedOptions,
  what: string,
): SqlPart[] {
  const dialect = options.dialect ?? "postgres";
  const table = assertIdentifier(options.marksTable ?? DEFAULT_MARKS_TABLE, "marksTable", dialect);
  const m = assertColumnName(options.alias ?? "aig_m", "alias", dialect);
  const cast = options.castToText ? castType(dialect) : null;
  const parts: SqlPart[] = [
    text(`EXISTS (SELECT 1 FROM ${table} ${m} WHERE ${m}.tenant_id = `),
    param(options.tenantId),
    text(` AND ${m}.subject_kind = '${subjectKind}' AND ${m}.subject_id = `),
    ...column(subjectColumn, what, cast, options),
    text(` AND ${m}.cleared_at IS NULL`),
  ];
  if (options.time !== undefined && options.time !== null) {
    parts.push(text(` AND (${m}.applies_from IS NULL OR ${m}.applies_from <= `), ...column(options.time, "time", null, options), text(")"));
  }
  parts.push(text(")"));
  return parts;
}

/**
 * `(NOT EXISTS (… marks m WHERE m.subject_kind = 'visitor' AND m.subject_id = <col> AND m.cleared_at IS NULL …))`
 * — true for a row that COUNTS. Drop it into a WHERE with the app's own
 * alias: `WHERE s.created_at >= $1 AND <this>`.
 */
export function countedVisitorParts(visitorColumn: ColumnInput, options: CountedVisitorOptions): SqlPart[] {
  if ((options as CountedOptions).time === undefined) {
    throw new Error(
      '@adminigloo/audience: countedVisitor needs `time` — the row\'s time column, e.g. { time: "s.created_at" } — so a rule\'s "only from" date is honoured the way excludedBreakdown honours it. Pass time: null only if this read has no time column.',
    );
  }
  if ((options as CountedOptions).session === undefined) {
    throw new Error(
      '@adminigloo/audience: countedVisitor needs `session` — the row\'s session id column, e.g. { session: "s.id" } — so a visit marked on its own (automation, a network rule, a non-production host) is left out. Pass session: null only if this read has no session id.',
    );
  }
  if (options.includeInternal) return [text("(1 = 1)")];
  const parts: SqlPart[] = [text("(NOT "), ...marksExists("visitor", visitorColumn, options, "visitor column")];
  if (options.session !== null) {
    parts.push(text(" AND NOT "), ...marksExists("session", options.session, options, "session column"));
  }
  parts.push(text(")"));
  return parts;
}

/** The same anti-join for any other subject: `countedSubjectParts("org", "o.id", …)`. */
export function countedSubjectParts(kind: SubjectKind, subjectColumn: ColumnInput, options: CountedOptions): SqlPart[] {
  if (!SUBJECT_KINDS.includes(kind)) throw new Error(`@adminigloo/audience: unknown subject kind ${JSON.stringify(kind)}.`);
  if (options.includeInternal) return [text("(1 = 1)")];
  return [text("(NOT "), ...marksExists(kind, subjectColumn, options, `${kind} column`), text(")")];
}

export interface RawSql {
  sql: string;
  params: unknown[];
}

export interface RenderOptions {
  /** "?" (MySQL, SQLite) or "$" (Postgres, numbered). Default "?". */
  placeholder?: "?" | "$";
  /** First number for "$" placeholders, to splice into a query that already has some. Default 1. */
  startAt?: number;
}

/** Parts → text + params. Opaque chunks are an adapter's business and are refused here. */
export function renderSql(parts: readonly SqlPart[], options: RenderOptions = {}): RawSql {
  const placeholder = options.placeholder ?? "?";
  let next = options.startAt ?? 1;
  let sql = "";
  const params: unknown[] = [];
  for (const part of parts) {
    if (part.kind === "text") sql += part.text;
    else if (part.kind === "param") {
      params.push(part.value);
      sql += placeholder === "$" ? `$${next++}` : "?";
    } else {
      throw new Error("@adminigloo/audience: a column chunk can only be rendered by the Drizzle helpers; pass the column as an identifier string.");
    }
  }
  return { sql, params };
}

/** `countedVisitorParts` rendered to text — for a caller without Drizzle. */
export function countedVisitorClause(
  visitorColumn: string,
  options: CountedVisitorOptions & RenderOptions,
): RawSql {
  return renderSql(countedVisitorParts(visitorColumn, options), options);
}

/** `countedSubjectParts` rendered to text — for a caller without Drizzle. */
export function countedSubjectClause(
  kind: SubjectKind,
  subjectColumn: string,
  options: CountedOptions & RenderOptions,
): RawSql {
  return renderSql(countedSubjectParts(kind, subjectColumn, options), options);
}

// ---------------------------------------------------------------------------
// The store's two queries over the app's rows
// ---------------------------------------------------------------------------

export interface RowQueryBase {
  tenantId: string;
  marksTable?: string;
  rows: RowsSource;
  from?: Date | null;
  to?: Date | null;
  castToText?: boolean;
  dialect?: SqlDialect;
}

function rowRefs(rows: RowsSource, dialect: SqlDialect = "postgres") {
  const table = assertIdentifier(rows.table, "rows.table", dialect);
  const visitor = `aig_s.${assertColumnName(rows.visitor, "rows.visitor", dialect)}`;
  const time = `aig_s.${assertColumnName(rows.time, "rows.time", dialect)}`;
  const id = rows.id === undefined ? undefined : `aig_s.${assertColumnName(rows.id, "rows.id", dialect)}`;
  return { table, visitor, time, id };
}

function filterParts(rows: RowsSource, dialect: SqlDialect = "postgres"): SqlPart[] {
  const parts: SqlPart[] = [];
  for (const [column, value] of Object.entries(rows.where ?? {})) {
    parts.push(text(` AND aig_s.${assertColumnName(column, "rows.where column", dialect)} = `), param(value));
  }
  return parts;
}

function windowParts(time: string, from: Date | null | undefined, to: Date | null | undefined): SqlPart[] {
  const parts: SqlPart[] = [];
  if (from) parts.push(text(` AND ${time} >= `), param(from));
  if (to) parts.push(text(` AND ${time} < `), param(to));
  return parts;
}

/**
 * Rows, distinct visitors and the earliest/latest row time — over a window,
 * optionally only these visitors, optionally only rows that COUNT.
 */
export function countRowsParts(
  query: RowQueryBase & { visitorIds?: readonly string[] | null; countedOnly: boolean },
): SqlPart[] {
  const r = rowRefs(query.rows, query.dialect);
  const parts: SqlPart[] = [
    text(
      `SELECT count(*) AS n, count(DISTINCT ${r.visitor}) AS v, min(${r.time}) AS earliest, max(${r.time}) AS latest FROM ${r.table} aig_s WHERE 1 = 1`,
    ),
    ...filterParts(query.rows, query.dialect),
    ...windowParts(r.time, query.from, query.to),
  ];
  if (query.visitorIds) {
    if (query.visitorIds.length === 0) parts.push(text(" AND 1 = 0"));
    else {
      const cast = query.castToText ? castType(query.dialect ?? "postgres") : null;
      parts.push(text(" AND "), ...(cast ? [text(`CAST(${r.visitor} AS ${cast})`)] : [text(r.visitor)]), text(" IN ("));
      query.visitorIds.forEach((id, i) => {
        if (i > 0) parts.push(text(", "));
        parts.push(param(id));
      });
      parts.push(text(")"));
    }
  }
  if (query.countedOnly) {
    parts.push(
      text(" AND "),
      ...countedVisitorParts(r.visitor, {
        tenantId: query.tenantId,
        ...(query.marksTable !== undefined ? { marksTable: query.marksTable } : {}),
        time: r.time,
        session: r.id ?? null,
        ...(query.castToText !== undefined ? { castToText: query.castToText } : {}),
        ...(query.dialect !== undefined ? { dialect: query.dialect } : {}),
      }),
    );
  }
  return parts;
}

/**
 * Excluded rows in a window, grouped by each row's BEST reason — the lowest
 * precedence rank among its visitor's (and session's) active marks. One
 * reason per row, so the groups add up to the total excluded exactly.
 * Returns rows of { best: rank, n }.
 */
export function breakdownParts(query: RowQueryBase): SqlPart[] {
  const r = rowRefs(query.rows, query.dialect);
  const table = assertIdentifier(query.marksTable ?? DEFAULT_MARKS_TABLE, "marksTable", query.dialect);
  const cast = query.castToText ? castType(query.dialect ?? "postgres") : null;
  const wrap = (ref: string) => (cast ? `CAST(${ref} AS ${cast})` : ref);
  const cases = REASON_ORDER.map((reason, i) => `WHEN '${reason}' THEN ${i}`).join(" ");
  const subject =
    r.id !== undefined
      ? `((aig_m.subject_kind = 'visitor' AND aig_m.subject_id = ${wrap(r.visitor)}) OR (aig_m.subject_kind = 'session' AND aig_m.subject_id = ${wrap(r.id)}))`
      : `aig_m.subject_kind = 'visitor' AND aig_m.subject_id = ${wrap(r.visitor)}`;
  return [
    text(
      `SELECT aig_x.best AS best, count(*) AS n FROM (SELECT (SELECT min(CASE aig_m.reason ${cases} ELSE ${REASON_ORDER.length} END) FROM ${table} aig_m WHERE aig_m.tenant_id = `,
    ),
    param(query.tenantId),
    text(
      ` AND aig_m.cleared_at IS NULL AND ${subject} AND (aig_m.applies_from IS NULL OR aig_m.applies_from <= ${r.time})) AS best FROM ${r.table} aig_s WHERE 1 = 1`,
    ),
    ...filterParts(query.rows, query.dialect),
    ...windowParts(r.time, query.from, query.to),
    text(") aig_x WHERE aig_x.best IS NOT NULL GROUP BY aig_x.best"),
  ];
}
