import { PGlite } from "@electric-sql/pglite";
import { is, SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { defineAudienceTables, type AudienceTables } from "@adminigloo/audience/schema";
import type { AnalyticsDb } from "../context.js";
import { defineAnalyticsTables, type AnalyticsTables } from "../schema.js";

/**
 * A REAL Postgres for the instance tests — PGlite is Postgres compiled to
 * WASM, in-process, so `pnpm test` runs the actual SQL (the advisory lock and
 * transaction in the ingest, ON CONFLICT upserts, the audience's NOT EXISTS
 * anti-join inside every report, percentile_cont, time-zone grouping) with
 * nothing set up.
 *
 * The DDL is GENERATED from the Drizzle tables — names, defaults, primary
 * and foreign keys with their ON DELETE, partial and expression indexes — so
 * the test database cannot drift from `./schema`. What PGlite cannot prove:
 * concurrency (one connection).
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

export function analyticsDdl(tables: AnalyticsTables): string[] {
  return tableDdl([tables.sessions, tables.pageViews, tables.events, tables.crawlerHits, tables.salts, tables.rate, tables.sites, tables.annotations]);
}

export function audienceDdl(tables: AudienceTables): string[] {
  return tableDdl([tables.rules, tables.marks, tables.links, tables.runs]);
}

export interface TestDb {
  db: AnalyticsDb;
  client: PGlite;
  close: () => Promise<void>;
}

/** One PGlite with an analytics table set per prefix given, plus the default audience tables. */
export async function createTestDb(prefixes: readonly string[] = ["analytics_"]): Promise<TestDb & { tables: AnalyticsTables[]; audienceTables: AudienceTables }> {
  const client = new PGlite();
  const tables = prefixes.map((prefix) => defineAnalyticsTables({ prefix }));
  const audienceTables = defineAudienceTables();
  for (const set of tables) for (const statement of analyticsDdl(set)) await client.exec(statement);
  for (const statement of audienceDdl(audienceTables)) await client.exec(statement);
  const db = drizzle(client) as unknown as AnalyticsDb;
  return { db, client, tables, audienceTables, close: () => client.close() };
}

let counter = 0;
/** A fresh tenant per test: isolation by the same scoping the package promises. */
export function tenant(prefix = "t"): string {
  counter += 1;
  return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}
