import { sql, type SQL } from "drizzle-orm";

/**
 * SQL the glances share. The database does the counting and the day-cutting;
 * these only spell it the same way everywhere.
 */

/** A timestamp's calendar day in a time zone, as "2026-11-19". */
export function dayOf(column: unknown, timeZone: string): SQL<string> {
  return sql<string>`to_char(${column} at time zone ${timeZone}, 'YYYY-MM-DD')`;
}

/**
 * GROUP BY the first selected column. Spelt by position because the time
 * zone is a bound parameter: written out twice it becomes $1 and $3, and
 * Postgres won't accept two differently numbered expressions as the same one.
 */
export const BY_FIRST_COLUMN: SQL = sql`1`;
