import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { SubjectKind } from "./core/labels.js";
import {
  countedSubjectParts,
  countedVisitorParts,
  type ColumnInput,
  type CountedOptions,
  type CountedVisitorOptions,
  type SqlPart,
} from "./core/sql.js";

/**
 * The SQL-text builders, as Drizzle `sql` objects: what a Drizzle app drops
 * into its own raw queries. Riddler Go's `inWindow()` becomes
 *
 *   sql`s.created_at >= ${w.from} AND s.created_at < ${w.to}
 *       AND ${audience.countedVisitorSql("s.visitor_id", { time: "s.created_at", session: "s.id", includeInternal })}`
 *
 * A column may be an identifier string QUALIFIED with the app's own alias
 * (`s.visitor_id` — a bare name inside the anti-join can resolve to the marks
 * table) or any Drizzle column / SQL. A Drizzle column renders
 * table-qualified, so use it only where the query does not alias that table.
 */

export type DrizzleColumnInput = string | SQLWrapper;

export function toDrizzleSql(parts: readonly SqlPart[]): SQL {
  const chunks = parts.map((part) => {
    if (part.kind === "text") return sql.raw(part.text);
    if (part.kind === "param") return sql`${part.value}`;
    return sql`${part.chunk as SQLWrapper}`;
  });
  return sql.join(chunks, sql.raw(""));
}

function columnOf(input: DrizzleColumnInput): ColumnInput {
  return typeof input === "string" ? input : { chunk: input };
}

export interface DrizzleCountedOptions extends Omit<CountedOptions, "time" | "session"> {
  time?: DrizzleColumnInput | null;
  session?: DrizzleColumnInput | null;
}

/** The visitor fragment's options: `time` and `session` must be named (or null on purpose). */
export interface DrizzleCountedVisitorOptions extends DrizzleCountedOptions {
  time: DrizzleColumnInput | null;
  session: DrizzleColumnInput | null;
}

function adapt(options: DrizzleCountedOptions): CountedOptions {
  const { time, session, ...rest } = options;
  return {
    ...rest,
    ...(time !== undefined ? { time: time === null ? null : columnOf(time) } : {}),
    ...(session !== undefined ? { session: session === null ? null : columnOf(session) } : {}),
  };
}

/**
 * True for rows that COUNT: no uncleared visitor or session mark.
 * `includeInternal` → always true. `time` and `session` are required (see
 * `CountedVisitorOptions`): leaving either out silently miscounts.
 */
export function countedVisitorSql(visitorColumn: DrizzleColumnInput, options: DrizzleCountedVisitorOptions): SQL {
  return toDrizzleSql(countedVisitorParts(columnOf(visitorColumn), adapt(options) as CountedVisitorOptions));
}

/** The same for an org / event / order / user / session id column. */
export function countedSubjectSql(kind: SubjectKind, subjectColumn: DrizzleColumnInput, options: DrizzleCountedOptions): SQL {
  return toDrizzleSql(countedSubjectParts(kind, columnOf(subjectColumn), adapt(options)));
}
