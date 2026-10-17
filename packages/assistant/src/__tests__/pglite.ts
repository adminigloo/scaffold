import { PGlite } from "@electric-sql/pglite";
import { is, SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import type { AssistantDb } from "../brain.js";
import * as schema from "../schema.js";

/**
 * A REAL Postgres for the company suites (0.9.0): PGlite is Postgres compiled
 * to WASM, in process, so `pnpm test` runs the actual SQL — every company
 * filter, the full-text search, the one-row confirm — with nothing set up.
 * The DDL is GENERATED from the drizzle tables, so the test database cannot
 * drift from `./schema`. COPIED from @adminigloo/invoicing
 * (src/__tests__/pglite.ts).
 */

export const TABLES: PgTable[] = (Object.values(schema) as unknown[]).filter((value): value is PgTable => {
  if (typeof value !== "object" || value === null) return false;
  try {
    getTableConfig(value as PgTable);
    return true;
  } catch {
    return false;
  }
});

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

export function schemaDdl(tables: readonly PgTable[] = TABLES): string[] {
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
    statements.push(`CREATE TABLE "${config.name}" (\n  ${lines.join(",\n  ")}\n)`);
    for (const index of config.indexes) {
      const columns = index.config.columns.map((column) => `"${(column as { name: string }).name}"`).join(", ");
      const where = index.config.where ? ` WHERE ${dialect.sqlToQuery(index.config.where).sql}` : "";
      statements.push(
        `CREATE ${index.config.unique ? "UNIQUE " : ""}INDEX "${index.config.name}" ON "${config.name}" (${columns})${where}`,
      );
    }
  }
  return statements;
}

export interface LoggedQuery {
  sql: string;
  params: unknown[];
}

export interface TestDb {
  db: AssistantDb;
  client: PGlite;
  /** Every statement sent through `db`, in order. */
  queries: LoggedQuery[];
  close: () => Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
  for (const statement of schemaDdl()) await client.exec(statement);
  const queries: LoggedQuery[] = [];
  const db = drizzle(client, {
    logger: { logQuery: (query, params) => queries.push({ sql: query, params }) },
  }) as unknown as AssistantDb;
  return { db, client, queries, close: () => client.close() };
}

let counter = 0;
/** A fresh company per test: isolation by the same scoping the package promises. */
export function tenant(prefix = "co"): string {
  counter += 1;
  return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}
