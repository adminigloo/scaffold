import { PGlite } from "@electric-sql/pglite";
import { is, SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import type { DigestDb } from "../instance.js";
import { defineDigestTables, type DigestTables } from "../schema.js";

/**
 * A REAL Postgres for the digest suites: PGlite, in-process (the customers
 * package's helper, plus composite primary keys). The DDL is generated from
 * the drizzle tables, so it can't drift from them.
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
      let line = `"${column.name}" ${column.getSQLType()}`;
      if (column.primary) line += " PRIMARY KEY";
      else if (column.notNull) line += " NOT NULL";
      if (column.default !== undefined) line += ` DEFAULT ${literal(column.default)}`;
      return line;
    });
    for (const key of config.primaryKeys) {
      lines.push(`CONSTRAINT "${key.getName()}" PRIMARY KEY (${key.columns.map((column) => `"${column.name}"`).join(", ")})`);
    }
    statements.push(`CREATE TABLE "${config.name}" (\n  ${lines.join(",\n  ")}\n)`);
    for (const index of config.indexes) {
      const columns = index.config.columns.map((column) => `"${(column as { name: string }).name}"`).join(", ");
      const where = index.config.where ? ` WHERE ${dialect.sqlToQuery(index.config.where).sql}` : "";
      statements.push(`CREATE ${index.config.unique ? "UNIQUE " : ""}INDEX "${index.config.name}" ON "${config.name}" (${columns})${where}`);
    }
  }
  return statements;
}

export interface TestDb {
  readonly db: DigestDb;
  readonly client: PGlite;
  readonly tables: DigestTables;
  close(): Promise<void>;
}

export async function createTestDb(prefix = ""): Promise<TestDb> {
  const tables = defineDigestTables({ prefix });
  const client = new PGlite();
  for (const statement of schemaDdl([tables.preferences, tables.subscriptions, tables.sends])) await client.exec(statement);
  const db = drizzle(client) as unknown as DigestDb;
  return { db, client, tables, close: () => client.close() };
}
