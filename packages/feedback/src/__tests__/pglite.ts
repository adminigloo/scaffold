import { PGlite } from "@electric-sql/pglite";
import { is, SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import type { FeedbackDb } from "../index.js";
import {
  feedbackBoards,
  feedbackCategories,
  feedbackClientKeys,
  feedbackEpics,
  feedbackMessages,
  feedbackStatuses,
  feedbackTicketEvents,
  feedbackTickets,
  feedbackUploads,
} from "../schema.js";

/**
 * A REAL Postgres for the tests — PGlite is Postgres compiled to WASM,
 * in-process, so `pnpm test` exercises the actual SQL (the company in every
 * WHERE, the unique indexes, ON CONFLICT) with nothing configured. 0.9's suite
 * ran on a hand-rolled fake that answered every query with the same rows
 * whatever the WHERE said — which is exactly why it could not see a missing
 * company filter.
 *
 * The DDL is GENERATED from the drizzle tables (scheduling's helper, copied),
 * so the test database cannot drift from `./schema`. The shipped SQL is
 * checked against the same tables in upgrade.test.ts.
 */

export const TABLES: PgTable[] = [
  feedbackClientKeys,
  feedbackStatuses,
  feedbackCategories,
  feedbackTickets,
  feedbackMessages,
  feedbackUploads,
  feedbackTicketEvents,
  feedbackBoards,
  feedbackEpics,
];

const dialect = new PgDialect();

function literal(value: unknown): string {
  if (is(value, SQL)) return dialect.sqlToQuery(value).sql;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  throw new Error(`no literal for default ${String(value)}`);
}

export function schemaDdl(tables: readonly PgTable[] = TABLES): string[] {
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
    statements.push(`CREATE TABLE "${config.name}" (\n  ${lines.join(",\n  ")}\n)`);
    for (const index of config.indexes) {
      const columns = index.config.columns
        .map((column) => (is(column, SQL) ? dialect.sqlToQuery(column).sql : `"${(column as { name: string }).name}"`))
        .join(", ");
      later.push(`CREATE ${index.config.unique ? "UNIQUE " : ""}INDEX "${index.config.name}" ON "${config.name}" (${columns})`);
    }
    // Foreign keys after every table exists (0.12.0: a ticket's epic, its
    // trail and messages), so a cascade or SET NULL is what the tests see.
    for (const fk of config.foreignKeys) {
      const ref = fk.reference();
      later.push(
        `ALTER TABLE "${config.name}" ADD CONSTRAINT "${fk.getName()}" FOREIGN KEY (${ref.columns.map((c) => `"${c.name}"`).join(", ")}) ` +
          `REFERENCES "${getTableConfig(ref.foreignTable).name}" (${ref.foreignColumns.map((c) => `"${c.name}"`).join(", ")}) ON DELETE ${fk.onDelete ?? "no action"}`,
      );
    }
  }
  return [...statements, ...later];
}

export interface TestDb {
  db: FeedbackDb;
  client: PGlite;
  close: () => Promise<void>;
}

/** A fresh database; `sql` (statements) builds the tables instead of the schema. */
export async function createTestDb(options: { sql?: readonly string[] } = {}): Promise<TestDb> {
  const client = new PGlite();
  for (const statement of options.sql ?? schemaDdl()) await client.exec(statement);
  const db = drizzle(client) as unknown as FeedbackDb;
  return { db, client, close: () => client.close() };
}

let counter = 0;
/** A fresh company id per test. */
export function tenant(prefix = "co"): string {
  counter += 1;
  return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A minimal valid report. */
export function report(description = "The export button does nothing when the table is empty.", extra: Record<string, unknown> = {}) {
  return {
    description,
    priority: "medium" as const,
    clientMetadata: {
      browser: "Chrome",
      os: "macOS",
      viewport: { width: 1280, height: 800 },
      url: "https://example.test/reports",
      pathname: "/reports",
      clickTrail: [],
      sessionId: "s-1",
      capturedAt: 1,
    },
    ...extra,
  };
}
