import { PGlite } from "@electric-sql/pglite";
import { products, productVariants } from "@adminigloo/catalog/schema";
import { is, SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import type { StoreDb } from "../store.js";
import { orderItems, orders, storeAlerts, storeCheckouts, storeSettings } from "../schema.js";

/**
 * A REAL Postgres for the store suites: PGlite, in-process. COPIED from
 * @adminigloo/invoicing (src/__tests__/pglite.ts), plus CHECK constraints —
 * the catalog's "stock never below zero" is one of the things under test.
 * The DDL is generated from the drizzle tables, so it can't drift from them.
 */
export const STORE_TABLES: PgTable[] = [products, productVariants, orders, orderItems, storeCheckouts, storeAlerts, storeSettings];

const dialect = new PgDialect();

function literal(value: unknown): string {
  if (is(value, SQL)) return dialect.sqlToQuery(value).sql;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  if (Array.isArray(value) || (value && typeof value === "object")) return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
  throw new Error(`no literal for default ${String(value)}`);
}

export function schemaDdl(tables: readonly PgTable[] = STORE_TABLES): string[] {
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
      statements.push(`CREATE ${index.config.unique ? "UNIQUE " : ""}INDEX "${index.config.name}" ON "${config.name}" (${columns})${where}`);
    }
    for (const check of config.checks) {
      statements.push(`ALTER TABLE "${config.name}" ADD CONSTRAINT "${check.name}" CHECK (${dialect.sqlToQuery(check.value).sql})`);
    }
  }
  return statements;
}

export interface TestDb {
  db: StoreDb;
  client: PGlite;
  close: () => Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
  for (const statement of schemaDdl()) await client.exec(statement);
  const db = drizzle(client) as unknown as StoreDb;
  return { db, client, close: () => client.close() };
}

let counter = 0;
/** A fresh company per test. */
export function tenant(prefix = "co"): string {
  counter += 1;
  return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}
