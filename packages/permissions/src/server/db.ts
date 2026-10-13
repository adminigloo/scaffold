import type { PgDatabase } from "drizzle-orm/pg-core";

/**
 * Any Drizzle Postgres handle: a `db`, a transaction, a savepoint. Every
 * function in `./server` runs every statement through the handle it is
 * given, so passing a transaction gives the read-your-writes the tenancy
 * lifecycle functions rely on (decision D7).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PermissionsDb = PgDatabase<any, any, any>;

export type Row = Record<string, unknown>;

/**
 * Rows from a raw `execute`, whichever driver is underneath: node-postgres,
 * Neon's WebSocket client and PGlite resolve to `{ rows }`, an HTTP driver to
 * the array itself. Anything else throws, because "no rows" is a meaningful
 * answer here and must not be manufactured from a shape we failed to read.
 */
export function rowsOf(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  if (typeof result === "object" && result !== null) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Row[];
  }
  throw new Error(
    "The database driver returned a result with no readable rows. Expected an array " +
      "of rows or an object with a `rows` array (node-postgres, Neon and PGlite all produce one).",
  );
}

/**
 * Run `fn` inside a transaction on `db`. When `db` is already a transaction,
 * Drizzle opens a SAVEPOINT, so a caller's outer transaction (and its locks)
 * carries straight through.
 */
export function inTransaction<T>(db: PermissionsDb, fn: (tx: PermissionsDb) => Promise<T>): Promise<T> {
  return db.transaction((tx) => fn(tx as unknown as PermissionsDb));
}
