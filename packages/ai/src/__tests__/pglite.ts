import { PGlite } from "@electric-sql/pglite";
import { is, SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import type { AiDb } from "../server.js";
import { aiUsage } from "../schema.js";

/**
 * A REAL Postgres for the ledger suites: PGlite is Postgres compiled to WASM,
 * in process. The DDL is GENERATED from the drizzle table, so the test
 * database cannot drift from `./schema`. COPIED from @adminigloo/invoicing
 * (src/__tests__/pglite.ts).
 */

const dialect = new PgDialect();

function literal(value: unknown): string {
  if (is(value, SQL)) return dialect.sqlToQuery(value).sql;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  throw new Error(`no literal for default ${String(value)}`);
}

export function schemaDdl(tables: readonly PgTable[]): string[] {
  const statements: string[] = [];
  for (const table of tables) {
    const config = getTableConfig(table);
    const lines = config.columns.map((column) => {
      const type = column.getSQLType();
      let line = `"${column.name}" ${type}`;
      if (column.primary) line += " PRIMARY KEY";
      else if (column.notNull) line += " NOT NULL";
      if (column.default !== undefined) line += ` DEFAULT ${literal(column.default)}`;
      return line;
    });
    statements.push(`CREATE TABLE "${config.name}" (\n  ${lines.join(",\n  ")}\n)`);
    for (const index of config.indexes) {
      const columns = index.config.columns.map((column) => `"${(column as { name: string }).name}"`).join(", ");
      statements.push(`CREATE ${index.config.unique ? "UNIQUE " : ""}INDEX "${index.config.name}" ON "${config.name}" (${columns})`);
    }
  }
  return statements;
}

export interface TestDb {
  db: AiDb;
  client: PGlite;
  close: () => Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
  for (const statement of schemaDdl([aiUsage])) await client.exec(statement);
  const db = drizzle(client) as unknown as AiDb;
  return { db, client, close: () => client.close() };
}
