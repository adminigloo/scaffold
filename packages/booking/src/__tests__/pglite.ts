import { PGlite } from "@electric-sql/pglite";
import { is, SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import type { BookingDb } from "../services/context.js";
import {
  bookingAvailability,
  bookingBlackouts,
  bookingBookings,
  bookingEvents,
  bookingExceptions,
  bookingHosts,
  bookingTypes,
} from "../schema.js";

/**
 * A REAL Postgres for the service tests — PGlite is Postgres compiled to
 * WASM, in-process, so `pnpm test` exercises the actual SQL (advisory locks,
 * text[] columns, ON CONFLICT, transactions) on a laptop with nothing
 * configured, the scaffold's rule for packages.
 *
 * The DDL is GENERATED from the drizzle tables rather than hand-written, so
 * the test database cannot drift from `./schema` — a renamed column or a new
 * index shows up here the moment it is made.
 *
 * What PGlite cannot prove: it is a single connection, so two transactions
 * never truly run at once. Concurrency tests here prove the re-check-under-
 * lock LOGIC (the second claimant sees the first's row); the lock itself is
 * proven against a pooled Postgres in the testbed's integration run.
 */

const TABLES: PgTable[] = [
  bookingHosts,
  bookingAvailability,
  bookingExceptions,
  bookingBlackouts,
  bookingTypes,
  bookingBookings,
  bookingEvents,
];

const dialect = new PgDialect();

function literal(value: unknown): string {
  if (is(value, SQL)) return dialect.sqlToQuery(value).sql;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  if (Array.isArray(value)) return `ARRAY[${value.map(literal).join(", ")}]::text[]`;
  if (value && typeof value === "object") return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
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
    for (const fk of config.foreignKeys) {
      const ref = fk.reference();
      lines.push(
        `FOREIGN KEY (${ref.columns.map((c) => `"${c.name}"`).join(", ")}) REFERENCES "${getTableConfig(ref.foreignTable).name}" (${ref.foreignColumns.map((c) => `"${c.name}"`).join(", ")})${fk.onDelete ? ` ON DELETE ${fk.onDelete}` : ""}`,
      );
    }
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

export interface TestDb {
  db: BookingDb;
  client: PGlite;
  close: () => Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
  for (const statement of schemaDdl()) await client.exec(statement);
  const db = drizzle(client) as unknown as BookingDb;
  return { db, client, close: () => client.close() };
}

let counter = 0;
/** A fresh tenant per test: isolation by the same scoping the package promises. */
export function tenant(prefix = "t"): string {
  counter += 1;
  return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}
