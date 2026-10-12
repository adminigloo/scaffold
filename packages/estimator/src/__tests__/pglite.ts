import { PGlite } from "@electric-sql/pglite";
import { is, SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { commsMessages, commsScheduled, commsTemplates } from "@adminigloo/comms/schema";
import type { EstimatorDb } from "../types.js";
import {
  estimatorClientKeys,
  estimatorComponents,
  estimatorEstimateItems,
  estimatorEstimates,
  estimatorOptionValues,
  estimatorOptions,
  estimatorPhotos,
  estimatorProductComponents,
  estimatorProducts,
  estimatorQuoteTokens,
  estimatorSettings,
  estimatorTakeoffs,
} from "../schema.js";

/**
 * COPIED FROM @adminigloo/scheduling's src/__tests__/pglite.ts; change both or
 * neither (the table lists are each package's own).
 *
 * A REAL Postgres for the 0.3 suites — PGlite is Postgres compiled to WASM,
 * in-process, so `pnpm test` exercises the actual SQL (advisory locks, jsonb,
 * `FOR UPDATE SKIP LOCKED`, `ON CONFLICT`, tenant filters) on a laptop with
 * nothing configured. The 0.2 suites keep their in-memory fake (fake-db.ts).
 *
 * The DDL is GENERATED from the drizzle tables rather than hand-written, so
 * the test database cannot drift from `./schema`: a new column is here the
 * moment it is in the schema.
 *
 * What PGlite cannot prove: it is a single connection, so two transactions
 * never truly run at once. That a lock is TAKEN — first, on the right key, in
 * the transaction — is proved from the query log below (`queries`).
 */

export const TABLES: PgTable[] = [
  estimatorSettings,
  estimatorProducts,
  estimatorComponents,
  estimatorProductComponents,
  estimatorOptions,
  estimatorOptionValues,
  estimatorEstimates,
  estimatorEstimateItems,
  estimatorClientKeys,
  estimatorQuoteTokens,
  estimatorPhotos,
  estimatorTakeoffs,
];

/** @adminigloo/comms's tables (a devDependency, built to dist), for the suites that run the real comms listener. */
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
      // A PARTIAL index keeps its predicate (comms' dedupe key is unique only
      // where it is set): without it `ON CONFLICT … WHERE` couldn't find it.
      const where = index.config.where ? ` WHERE ${dialect.sqlToQuery(index.config.where).sql}` : "";
      statements.push(
        `CREATE ${index.config.unique ? "UNIQUE " : ""}INDEX "${index.config.name}" ON "${config.name}" (${columns})${where}`,
      );
    }
  }
  return statements;
}

/** One statement the package sent, and whether a transaction callback was running when it did. */
export interface LoggedQuery {
  sql: string;
  params: unknown[];
  inTransaction: boolean;
}

export interface TestDb {
  db: EstimatorDb;
  client: PGlite;
  /** Every statement sent through `db`, in order. Clear it (`length = 0`) before the call under test. */
  queries: LoggedQuery[];
  inTransaction: () => boolean;
  close: () => Promise<void>;
}

export interface CreateTestDbOptions {
  /** Also create @adminigloo/comms's tables (templates, delivery log, queue). */
  comms?: boolean;
}

export async function createTestDb(options: CreateTestDbOptions = {}): Promise<TestDb> {
  const client = new PGlite();
  const tables = options.comms ? [...TABLES, ...COMMS_TABLES] : TABLES;
  for (const statement of schemaDdl(tables)) await client.exec(statement);

  const queries: LoggedQuery[] = [];
  let depth = 0;
  const db = drizzle(client, {
    logger: { logQuery: (query, params) => queries.push({ sql: query, params, inTransaction: depth > 0 }) },
  }) as unknown as EstimatorDb;
  // Mark the span of every transaction callback. The callback's own queries go
  // through a session that shares the logger above, so they log as in-tx.
  const transaction = db.transaction.bind(db);
  db.transaction = ((run, config) =>
    transaction(async (tx) => {
      depth += 1;
      try {
        return await run(tx);
      } finally {
        depth -= 1;
      }
    }, config)) as typeof db.transaction;

  return { db, client, queries, inTransaction: () => depth > 0, close: () => client.close() };
}

let counter = 0;
/** A fresh tenant per test: isolation by the same scoping the package promises. */
export function tenant(prefix = "t"): string {
  counter += 1;
  return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}
