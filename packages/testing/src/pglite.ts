/**
 * @adminigloo/testing/pglite — a real Postgres (PGlite, in-process WASM) built
 * from a project's own Drizzle schema object.
 *
 * WHY THIS EXISTS (decision D20 in the Tenancy 1 contract). A generated
 * project's two-company isolation test must run on every `pnpm test` with
 * nothing configured. A test that only runs with `DATABASE_URL` reports
 * "skipped", and a skipped isolation test is how a cross-company leak ships:
 * skips are free and nobody reads them. PGlite is real Postgres compiled to
 * WASM, in process, so the test runs the actual SQL — row locks, `ON CONFLICT`
 * on partial indexes, cascades, advisory locks — with no server.
 *
 * THE DDL IS GENERATED FROM THE SCHEMA OBJECT, the same object drizzle-kit
 * generates the project's migrations from, so the test database cannot drift
 * from the real one. Pass the project's whole `schema` export: values that are
 * neither a table nor an enum (relations, helper constants) are skipped.
 *
 * A promotion of packages/analytics/src/__tests__/pglite.ts, plus enums,
 * unique constraints, checks and literal (jsonb included) defaults. Analytics
 * keeps its own copy, deliberately untouched.
 *
 * WHAT IT CANNOT PROVE: concurrency. PGlite is one connection, so two
 * transactions never truly overlap; races are tested as sequential
 * interleavings at the lock boundary (see the tenancy package's tests), and
 * the query log proves the lock statement is taken first.
 *
 * `@electric-sql/pglite` is an OPTIONAL peer, imported lazily inside
 * `createPgliteDb`: importing this module without it installed fails only when
 * you call it, with a message naming the package to install.
 */
import { is, SQL } from "drizzle-orm";
import {
  getTableConfig,
  isPgEnum,
  PgDialect,
  PgTable,
  type PgEnum,
} from "drizzle-orm/pg-core";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";

/** A schema value this builder could not turn into DDL. Names the column or expression. */
export class PgliteDdlError extends Error {
  readonly name = "PgliteDdlError";
}

/** `@electric-sql/pglite` (or drizzle's pglite driver) is not installed in this project. */
export class PgliteMissingError extends Error {
  readonly name = "PgliteMissingError";
  constructor(cause: unknown) {
    super(
      "createPgliteDb needs @electric-sql/pglite. Install it as a devDependency " +
        '(`pnpm add -D @electric-sql/pglite@^0.5.8`); create-app adds it for you.',
      { cause },
    );
  }
}

export interface PgliteDbOptions {
  readonly schema: Readonly<Record<string, unknown>>;
  /** Record every statement sent through `db` into `queries` (default true). */
  readonly logQueries?: boolean;
}

export interface PgliteTestDb<TSchema extends Record<string, unknown>> {
  /** drizzle(client, { schema }), so `db.query.<table>` works too. */
  readonly db: PgliteDatabase<TSchema>;
  readonly client: PGlite;
  /** Every statement sent through `db`, in order (when logQueries). Clear with `queries.length = 0`. */
  readonly queries: { sql: string; params: unknown[] }[];
  close(): Promise<void>;
}

const dialect = new PgDialect();

function render(value: SQL, where: string): string {
  const query = dialect.sqlToQuery(value);
  if (query.params.length > 0) {
    // A parameter cannot be bound into DDL; Postgres would reject "$1" in a
    // default or an index predicate with a message that names neither.
    throw new PgliteDdlError(`${where} has a parameterised expression, which DDL cannot carry: ${query.sql}`);
  }
  return query.sql;
}

function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function stringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function literal(value: unknown, where: string): string {
  if (is(value, SQL)) return render(value, where);
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return stringLiteral(value);
  if (value instanceof Date) return stringLiteral(value.toISOString());
  if (value !== null && typeof value === "object") return stringLiteral(JSON.stringify(value));
  throw new PgliteDdlError(`${where} has a default (${String(value)}) that can't be written as a SQL literal.`);
}

function collect(schema: Readonly<Record<string, unknown>>): { tables: PgTable[]; enums: PgEnum<[string, ...string[]]>[] } {
  const tables = new Map<string, PgTable>();
  const enums = new Map<string, PgEnum<[string, ...string[]]>>();
  for (const value of Object.values(schema)) {
    if (isPgEnum(value)) {
      if (!enums.has(value.enumName)) enums.set(value.enumName, value);
      continue;
    }
    if (is(value, PgTable)) {
      const name = getTableConfig(value).name;
      if (!tables.has(name)) tables.set(name, value);
    }
    // Anything else (relations, constants, functions) is not DDL: skipped.
  }
  return { tables: [...tables.values()], enums: [...enums.values()] };
}

/**
 * The DDL alone, in executable order: enums, tables (with primary keys,
 * NOT NULL, defaults, unique constraints and checks), then foreign keys, then
 * indexes (partial and expression ones included). For a caller managing its
 * own PGlite.
 */
export function schemaDdl(schema: Readonly<Record<string, unknown>>): string[] {
  const { tables, enums } = collect(schema);
  const statements: string[] = [];
  const later: string[] = [];

  for (const e of enums) {
    statements.push(`CREATE TYPE ${quote(e.enumName)} AS ENUM (${e.enumValues.map(stringLiteral).join(", ")})`);
  }

  for (const table of tables) {
    const config = getTableConfig(table);
    const lines = config.columns.map((column) => {
      const where = `${config.name}.${column.name}`;
      let line = `${quote(column.name)} ${column.getSQLType()}`;
      if (column.primary) line += " PRIMARY KEY";
      else if (column.notNull) line += " NOT NULL";
      if (column.default !== undefined) line += ` DEFAULT ${literal(column.default, where)}`;
      if (column.isUnique) {
        line += column.uniqueName ? ` CONSTRAINT ${quote(column.uniqueName)} UNIQUE` : " UNIQUE";
      }
      return line;
    });
    for (const pk of config.primaryKeys) {
      lines.push(`CONSTRAINT ${quote(pk.getName())} PRIMARY KEY (${pk.columns.map((c) => quote(c.name)).join(", ")})`);
    }
    for (const unique of config.uniqueConstraints) {
      const name = unique.getName();
      const columns = unique.columns.map((c) => quote(c.name)).join(", ");
      lines.push(
        `${name ? `CONSTRAINT ${quote(name)} ` : ""}UNIQUE${unique.nullsNotDistinct ? " NULLS NOT DISTINCT" : ""} (${columns})`,
      );
    }
    for (const check of config.checks) {
      lines.push(`CONSTRAINT ${quote(check.name)} CHECK (${render(check.value, `${config.name} check ${check.name}`)})`);
    }
    statements.push(`CREATE TABLE ${quote(config.name)} (\n  ${lines.join(",\n  ")}\n)`);

    for (const fk of config.foreignKeys) {
      const ref = fk.reference();
      later.push(
        `ALTER TABLE ${quote(config.name)} ADD CONSTRAINT ${quote(fk.getName())} FOREIGN KEY (${ref.columns
          .map((c) => quote(c.name))
          .join(", ")}) REFERENCES ${quote(getTableConfig(ref.foreignTable).name)} (${ref.foreignColumns
          .map((c) => quote(c.name))
          .join(", ")}) ON DELETE ${fk.onDelete ?? "no action"} ON UPDATE ${fk.onUpdate ?? "no action"}`,
      );
    }
    for (const index of config.indexes) {
      const where = `${config.name} index ${index.config.name ?? "(unnamed)"}`;
      const columns = index.config.columns
        .map((column) => (is(column, SQL) ? `(${render(column, where)})` : quote((column as { name: string }).name)))
        .join(", ");
      const method = index.config.method && index.config.method !== "btree" ? ` USING ${index.config.method}` : "";
      const predicate = index.config.where ? ` WHERE ${render(index.config.where, where)}` : "";
      later.push(
        `CREATE ${index.config.unique ? "UNIQUE " : ""}INDEX ${quote(index.config.name ?? `${config.name}_idx_${later.length}`)} ON ${quote(config.name)}${method} (${columns})${predicate}`,
      );
    }
  }

  return [...statements, ...later];
}

/**
 * A fresh in-memory Postgres holding every table and enum in `schema`, and a
 * drizzle handle on it (with the schema registered, so `db.query.*` works).
 *
 *   const { db, queries, close } = await createPgliteDb({ schema });
 */
export async function createPgliteDb<TSchema extends Record<string, unknown>>(
  options: PgliteDbOptions & { readonly schema: TSchema },
): Promise<PgliteTestDb<TSchema>> {
  let PGliteCtor: typeof import("@electric-sql/pglite").PGlite;
  let drizzleFn: typeof import("drizzle-orm/pglite").drizzle;
  try {
    ({ PGlite: PGliteCtor } = await import("@electric-sql/pglite"));
    ({ drizzle: drizzleFn } = await import("drizzle-orm/pglite"));
  } catch (cause) {
    throw new PgliteMissingError(cause);
  }

  const client = new PGliteCtor();
  for (const statement of schemaDdl(options.schema)) await client.exec(statement);

  const queries: { sql: string; params: unknown[] }[] = [];
  const logQueries = options.logQueries ?? true;
  const db = drizzleFn({
    client,
    schema: options.schema,
    ...(logQueries
      ? { logger: { logQuery: (sql: string, params: unknown[]) => void queries.push({ sql, params: [...params] }) } }
      : {}),
  }) as unknown as PgliteDatabase<TSchema>;

  return { db, client, queries, close: () => client.close() };
}
