import { PGlite } from "@electric-sql/pglite";
import { is, SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { seoReports } from "../schema.js";
import type { SeoDb } from "../store.js";

/**
 * A REAL Postgres for the store and handler tests (PGlite: Postgres in WASM,
 * in-process) — the advisory lock, the transaction and the jsonb columns run
 * as they will in production. The DDL is generated from the Drizzle table
 * (the analytics package's helper, copied), so the test database can't drift
 * from ./schema.
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
  if (Array.isArray(value) || (value !== null && typeof value === "object")) return `'${JSON.stringify(value)}'::jsonb`;
  throw new Error(`no literal for default ${String(value)}`);
}

export function tableDdl(tables: readonly PgTable[]): string[] {
  const statements: string[] = [];
  const later: string[] = [];
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
    statements.push(`CREATE TABLE "${config.name}" (\n  ${lines.join(",\n  ")}\n)`);
    for (const fk of config.foreignKeys) {
      const ref = fk.reference();
      later.push(
        `ALTER TABLE "${config.name}" ADD CONSTRAINT "${fk.getName()}" FOREIGN KEY (${ref.columns.map((c) => `"${c.name}"`).join(", ")}) REFERENCES "${getTableConfig(ref.foreignTable).name}" (${ref.foreignColumns.map((c) => `"${c.name}"`).join(", ")}) ON DELETE ${fk.onDelete ?? "no action"} ON UPDATE ${fk.onUpdate ?? "no action"}`,
      );
    }
    for (const index of config.indexes) {
      const columns = index.config.columns
        .map((column) => (is(column, SQL) ? `(${render(column)})` : `"${(column as { name: string }).name}"`))
        .join(", ");
      const where = index.config.where ? ` WHERE ${render(index.config.where)}` : "";
      later.push(`CREATE ${index.config.unique ? "UNIQUE " : ""}INDEX "${index.config.name}" ON "${config.name}" (${columns})${where}`);
    }
  }
  return [...statements, ...later];
}

export function seoReportsDdl(): string[] {
  return tableDdl([seoReports]);
}

export async function createTestDb(): Promise<{ db: SeoDb; client: PGlite; close: () => Promise<void> }> {
  const client = new PGlite();
  for (const statement of seoReportsDdl()) await client.exec(statement);
  const db = drizzle(client) as unknown as SeoDb;
  return { db, client, close: () => client.close() };
}
