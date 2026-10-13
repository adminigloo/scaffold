/**
 * A real Postgres (PGlite) for this package's suites, with the DDL generated
 * from the Drizzle tables so the test database can't drift from ./schema.
 *
 * A COPY of @adminigloo/testing/pglite's `schemaDdl` (which is the promotion of
 * analytics' helper, plus enums and unique constraints). Copied, not imported:
 * @adminigloo/testing depends on this package, so importing it here would be a
 * cycle. Keep the two in step.
 *
 * Not a suite: vitest only collects *.test.ts.
 */
import { PGlite } from "@electric-sql/pglite";
import { is, SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, isPgEnum, PgDialect, PgTable, type PgEnum } from "drizzle-orm/pg-core";

export class PgliteDdlError extends Error {
  readonly name = "PgliteDdlError";
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


export interface TestDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  client: PGlite;
  queries: { sql: string; params: unknown[] }[];
  close: () => Promise<void>;
}

/** A fresh PGlite holding every table and enum in `schema`, with a query log. */
export async function createTestDb(schema: Readonly<Record<string, unknown>>): Promise<TestDb> {
  const client = new PGlite();
  for (const statement of schemaDdl(schema)) await client.exec(statement);
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle({
    client,
    schema: schema as Record<string, unknown>,
    logger: { logQuery: (sql: string, params: unknown[]) => void queries.push({ sql, params: [...params] }) },
  });
  return { db, client, queries, close: () => client.close() };
}
