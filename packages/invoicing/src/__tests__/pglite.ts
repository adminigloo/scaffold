import { PGlite } from "@electric-sql/pglite";
import { commsMessages, commsScheduled, commsTemplates } from "@adminigloo/comms/schema";
import { is, SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import type { InvoicingDb } from "../index.js";
import { invoiceItems, invoicePayments, invoices } from "../schema.js";

/**
 * A REAL Postgres for the handler, company and email suites (Tenancy 2a):
 * PGlite is Postgres compiled to WASM, in-process, so `pnpm test` runs the
 * actual SQL (row locks, the partial unique indexes, the tenant filters) with
 * nothing configured. COPIED from @adminigloo/scheduling (src/__tests__/
 * pglite.ts); the 0.2 suites keep their fake (fake-db.ts).
 *
 * The DDL is GENERATED from the drizzle tables, so the test database cannot
 * drift from `./schema`. With `comms: true` the @adminigloo/comms tables (a
 * devDependency, built to dist) are created too, for the invoice email.
 */

const TABLES: PgTable[] = [invoices, invoiceItems, invoicePayments];
const COMMS_TABLES: PgTable[] = [commsTemplates, commsMessages, commsScheduled];

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
  db: InvoicingDb;
  client: PGlite;
  /** Every statement sent through `db`, in order. */
  queries: LoggedQuery[];
  close: () => Promise<void>;
}

export async function createTestDb(options: { comms?: boolean } = {}): Promise<TestDb> {
  const client = new PGlite();
  for (const statement of schemaDdl(options.comms ? [...TABLES, ...COMMS_TABLES] : TABLES)) await client.exec(statement);
  const queries: LoggedQuery[] = [];
  const db = drizzle(client, {
    logger: { logQuery: (query, params) => queries.push({ sql: query, params }) },
  }) as unknown as InvoicingDb;
  return { db, client, queries, close: () => client.close() };
}

let counter = 0;
/** A fresh tenant per test: isolation by the same scoping the package promises. */
export function tenant(prefix = "t"): string {
  counter += 1;
  return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}
