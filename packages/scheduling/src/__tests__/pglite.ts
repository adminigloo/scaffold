import { PGlite } from "@electric-sql/pglite";
import { is, SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import type { SchedulingDb } from "../index.js";
import {
  schedulingAvailability,
  schedulingBookings,
  schedulingDriveCache,
  schedulingResources,
} from "../schema.js";

/**
 * A REAL Postgres for the service tests — PGlite is Postgres compiled to WASM,
 * in-process, so `pnpm test` exercises the actual SQL (advisory locks, jsonb,
 * transactions, tenant filters) on a laptop with nothing configured. The 0.2
 * suite ran on a hand-rolled fake that answered every query with the same rows
 * whatever the WHERE said — which is exactly why it could not see a missing
 * tenant filter.
 *
 * The DDL is GENERATED from the drizzle tables rather than hand-written (the
 * same helper as @adminigloo/booking's), so the test database cannot drift from
 * `./schema`: a new column is here the moment it is in the schema.
 *
 * What PGlite cannot prove: it is a single connection, so two transactions
 * never truly run at once. The concurrency tests prove the
 * re-check-under-lock LOGIC (the second claimant sees the first's row once it
 * gets its turn). That the lock is TAKEN — first, on the right key, on the
 * transaction — is proved from the query log below (`queries`), because no
 * race on one connection can fail without it.
 */

const TABLES: PgTable[] = [schedulingResources, schedulingAvailability, schedulingBookings, schedulingDriveCache];

const dialect = new PgDialect();

function literal(value: unknown): string {
  if (is(value, SQL)) return dialect.sqlToQuery(value).sql;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  if (Array.isArray(value) || (value && typeof value === "object")) {
    return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
  }
  throw new Error(`no literal for default ${String(value)}`);
}

export function schemaDdl(): string[] {
  const statements: string[] = [];
  for (const table of TABLES) {
    const config = getTableConfig(table);
    const lines = config.columns.map((column) => {
      let line = `"${column.name}" ${column.getSQLType()}`;
      if (column.primary) line += " PRIMARY KEY";
      else if (column.notNull) line += " NOT NULL";
      if (column.default !== undefined) line += ` DEFAULT ${literal(column.default)}`;
      return line;
    });
    statements.push(`CREATE TABLE "${config.name}" (\n  ${lines.join(",\n  ")}\n)`);
    for (const index of config.indexes) {
      const columns = index.config.columns.map((column) => `"${(column as { name: string }).name}"`).join(", ");
      statements.push(
        `CREATE ${index.config.unique ? "UNIQUE " : ""}INDEX "${index.config.name}" ON "${config.name}" (${columns})`,
      );
    }
  }
  return statements;
}

/** One statement the package sent, and whether a transaction callback was running when it did. */
export interface LoggedQuery {
  sql: string;
  params: unknown[];
  inTransaction: boolean;
}

export interface TestDb {
  db: SchedulingDb;
  client: PGlite;
  /**
   * Every statement sent through `db`, in order. Clear it (`length = 0`)
   * before the call under test. PGlite runs one transaction at a time, so
   * `inTransaction` is exact.
   */
  queries: LoggedQuery[];
  /** True while a `db.transaction` callback is running — for a spy that must not be called inside one. */
  inTransaction: () => boolean;
  close: () => Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
  for (const statement of schemaDdl()) await client.exec(statement);

  const queries: LoggedQuery[] = [];
  let depth = 0;
  const db = drizzle(client, {
    logger: { logQuery: (query, params) => queries.push({ sql: query, params, inTransaction: depth > 0 }) },
  }) as unknown as SchedulingDb;
  // Mark the span of every transaction callback. The callback's own queries go
  // through a session that shares the logger above, so they log as in-tx.
  const transaction = db.transaction.bind(db);
  db.transaction = ((run, config) =>
    transaction(async (tx) => {
      depth += 1;
      try {
        return await run(tx);
      } finally {
        depth -= 1;
      }
    }, config)) as typeof db.transaction;

  return { db, client, queries, inTransaction: () => depth > 0, close: () => client.close() };
}

let counter = 0;
/** A fresh tenant per test: isolation by the same scoping the package promises. */
export function tenant(prefix = "t"): string {
  counter += 1;
  return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}
