import { PGlite } from "@electric-sql/pglite";
import { is, SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import type { AudienceDb } from "../drizzle-store.js";
import { defineAudienceTables, type AudienceTables } from "../schema.js";

/**
 * A REAL Postgres for the store and instance tests — PGlite is Postgres
 * compiled to WASM, in-process, so `pnpm test` exercises the actual SQL (the
 * partial unique index behind idempotency, ON CONFLICT, the NOT EXISTS
 * anti-join, the breakdown's scalar subquery) on a laptop with nothing set up.
 *
 * The DDL is GENERATED from the Drizzle tables, including the partial and
 * expression indexes, so the test database cannot drift from `./schema`.
 * What PGlite cannot prove: concurrency (one connection). Idempotency under
 * a race rests on the unique index, which this DOES create and exercise.
 */

const dialect = new PgDialect();

function render(value: SQL): string {
  const query = dialect.sqlToQuery(value);
  if (query.params.length) throw new Error(`DDL expression has parameters: ${query.sql}`);
  return query.sql;
}

function literal(value: unknown): string {
  if (is(value, SQL)) return render(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  throw new Error(`no literal for default ${String(value)}`);
}

export function tableDdl(tables: readonly PgTable[]): string[] {
  const statements: string[] = [];
  for (const table of tables) {
    const config = getTableConfig(table);
    const lines = config.columns.map((column) => {
      let line = `"${column.name}" ${column.getSQLType()}`;
      if (column.primary) line += " PRIMARY KEY";
      else if (column.notNull) line += " NOT NULL";
      if (column.default !== undefined) line += ` DEFAULT ${literal(column.default)}`;
      return line;
    });
    for (const pk of config.primaryKeys) {
      lines.push(`CONSTRAINT "${pk.getName()}" PRIMARY KEY (${pk.columns.map((c) => `"${c.name}"`).join(", ")})`);
    }
    for (const fk of config.foreignKeys) {
      const ref = fk.reference();
      lines.push(
        `CONSTRAINT "${fk.getName()}" FOREIGN KEY (${ref.columns.map((c) => `"${c.name}"`).join(", ")}) REFERENCES "${getTableConfig(ref.foreignTable).name}" (${ref.foreignColumns.map((c) => `"${c.name}"`).join(", ")})`,
      );
    }
    statements.push(`CREATE TABLE "${config.name}" (\n  ${lines.join(",\n  ")}\n)`);
    for (const index of config.indexes) {
      const columns = index.config.columns
        .map((column) => (is(column, SQL) ? `(${render(column)})` : `"${(column as { name: string }).name}"`))
        .join(", ");
      const where = index.config.where ? ` WHERE ${render(index.config.where)}` : "";
      statements.push(`CREATE ${index.config.unique ? "UNIQUE " : ""}INDEX "${index.config.name}" ON "${config.name}" (${columns})${where}`);
    }
  }
  return statements;
}

export function audienceDdl(tables: AudienceTables): string[] {
  return tableDdl([tables.rules, tables.marks, tables.links, tables.runs]);
}

/** The app's own sessions table, the way Riddler Go keeps it (text ids, a visitor cookie, a start time). */
export const APP_DDL = [
  `CREATE TABLE app_sessions (id text PRIMARY KEY, visitor_id text NOT NULL, created_at timestamptz NOT NULL)`,
  `CREATE TABLE app_orgs (id text PRIMARY KEY, name text NOT NULL)`,
];

export interface TestDb {
  db: AudienceDb;
  client: PGlite;
  tables: AudienceTables;
  close: () => Promise<void>;
}

export async function createTestDb(prefix?: string): Promise<TestDb> {
  const client = new PGlite();
  const tables = defineAudienceTables(prefix === undefined ? {} : { prefix });
  for (const statement of [...audienceDdl(tables), ...APP_DDL]) await client.exec(statement);
  const db = drizzle(client) as unknown as AudienceDb;
  return { db, client, tables, close: () => client.close() };
}

let counter = 0;
/** A fresh tenant per test: isolation by the same scoping the package promises. */
export function tenant(prefix = "t"): string {
  counter += 1;
  return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}
