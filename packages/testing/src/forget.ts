/**
 * @adminigloo/testing/forget — prove that forgetting one company removes that
 * company's rows from EVERY table, and nobody else's.
 *
 * WHY GENERIC. A proof that lists the tables it plants is a proof that goes
 * quiet the day a package adds a table: the new table is never planted, so it
 * is never checked, and the company's rows in it outlive the deletion. This
 * reads the database itself (pg_catalog), so every table that has a
 * `tenant_id` column is planted and checked, today's and tomorrow's:
 *
 *   const planted = await plantCompanyRows(db, [aId, bId]);
 *   const before = await companyRowCounts(db, [aId, bId]);
 *   await forget(aId);
 *   const report = await forgetReport(db, planted, { forgotten: aId, kept, before });
 *   expect(report.left).toEqual([]);   // A's rows still in these tables
 *   expect(report.lost).toEqual([]);   // B's rows that went too
 *
 * Planting: one row per company in every table with `tenant_id`, and one in
 * every table that hangs off one of those by a foreign key (an estimate's
 * lines, an order's items), pointing at THAT company's row. Every column that
 * must be filled is filled with a stand-in of its type (text, numbers ≥ 1,
 * now, `{}`), each value unique, so unique indexes and the non-negative checks
 * hold. A column whose type it can't fill fails the plant naming the column.
 *
 * Throwaway databases only (PGlite in a test): it writes rows that mean
 * nothing.
 */
import { sql, type SQL } from "drizzle-orm";

/** Anything drizzle-shaped that runs a statement: a PGlite, Neon or node-postgres drizzle handle, or a transaction. */
export interface ForgetProofDb {
  execute(query: SQL): Promise<unknown>;
}

type Row = Record<string, unknown>;

async function rows(db: ForgetProofDb, query: SQL): Promise<Row[]> {
  const result = await db.execute(query);
  if (Array.isArray(result)) return result as Row[];
  const inner = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(inner) ? (inner as Row[]) : [];
}

function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

interface Column {
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly hasDefault: boolean;
  readonly skip: boolean;
  readonly enumLabels: readonly string[] | null;
}

interface ForeignKey {
  readonly name: string;
  readonly columns: readonly string[];
  readonly refTable: string;
  readonly refColumns: readonly string[];
}

interface Table {
  readonly key: string;
  readonly sqlName: string;
  readonly columns: readonly Column[];
  readonly primaryKey: readonly string[];
  readonly foreignKeys: readonly ForeignKey[];
  readonly hasTenant: boolean;
}

/** Every user table in the database, its columns, primary key and foreign keys. */
async function readTables(db: ForgetProofDb): Promise<Map<string, Table>> {
  const rel = await rows(
    db,
    sql`select c.oid::int as oid, n.nspname as schema, c.relname as name
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema')
          and n.nspname not like 'pg_toast%' and not c.relispartition`,
  );
  const cols = await rows(
    db,
    sql`select a.attrelid::int as oid, a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
               a.attnotnull as not_null, a.atthasdef as has_default, a.attidentity as identity, a.attgenerated as generated,
               t.typtype as typtype, a.atttypid::int as typid
        from pg_attribute a join pg_type t on t.oid = a.atttypid
        where a.attnum > 0 and not a.attisdropped
        order by a.attrelid, a.attnum`,
  );
  const labels = await rows(db, sql`select enumtypid::int as typid, enumlabel as label from pg_enum order by enumtypid, enumsortorder`);
  const cons = await rows(
    db,
    sql`select c.conname as name, c.contype as kind, c.conrelid::int as oid, c.confrelid::int as ref_oid, k.ord::int as ord,
               a.attname as col, af.attname as ref_col
        from pg_constraint c
        cross join lateral unnest(c.conkey, coalesce(c.confkey, c.conkey)) with ordinality as k(attnum, refnum, ord)
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
        left join pg_attribute af on af.attrelid = c.confrelid and af.attnum = k.refnum
        where c.contype in ('f', 'p')
        order by c.conname, k.ord`,
  );
  const enumOf = new Map<number, string[]>();
  for (const l of labels) {
    const list = enumOf.get(Number(l["typid"])) ?? [];
    list.push(String(l["label"]));
    enumOf.set(Number(l["typid"]), list);
  }
  const keyOf = new Map<number, { key: string; sqlName: string }>();
  for (const r of rel) {
    const schema = String(r["schema"]);
    const name = String(r["name"]);
    keyOf.set(Number(r["oid"]), {
      key: schema === "public" ? name : `${schema}.${name}`,
      sqlName: `${quote(schema)}.${quote(name)}`,
    });
  }
  const tables = new Map<string, Table>();
  for (const [oid, { key, sqlName }] of keyOf) {
    const columns: Column[] = cols
      .filter((c) => Number(c["oid"]) === oid)
      .map((c) => ({
        name: String(c["name"]),
        type: String(c["type"]),
        notNull: c["not_null"] === true,
        hasDefault: c["has_default"] === true,
        skip: String(c["identity"] ?? "") !== "" || String(c["generated"] ?? "") !== "",
        enumLabels: c["typtype"] === "e" ? (enumOf.get(Number(c["typid"])) ?? null) : null,
      }));
    const mine = cons.filter((c) => Number(c["oid"]) === oid);
    const primaryKey = mine.filter((c) => c["kind"] === "p").map((c) => String(c["col"]));
    const fkNames = [...new Set(mine.filter((c) => c["kind"] === "f").map((c) => String(c["name"])))];
    const foreignKeys: ForeignKey[] = fkNames.flatMap((name) => {
      const parts = mine.filter((c) => c["kind"] === "f" && c["name"] === name);
      const ref = keyOf.get(Number(parts[0]?.["ref_oid"]));
      return ref
        ? [{ name, columns: parts.map((p) => String(p["col"])), refTable: ref.key, refColumns: parts.map((p) => String(p["ref_col"])) }]
        : [];
    });
    tables.set(key, { key, sqlName, columns, primaryKey, foreignKeys, hasTenant: columns.some((c) => c.name === "tenant_id") });
  }
  return tables;
}

/** One planted row: its table, whose it is, and the values that find it again. */
export interface PlantedRow {
  readonly table: string;
  readonly tenantId: string;
  /** "company" (has tenant_id) or "child" (hangs off one by a foreign key). */
  readonly kind: "company" | "child";
  readonly match: Readonly<Record<string, unknown>>;
}

export interface PlantedCompanyRows {
  readonly tenantIds: readonly string[];
  /** Every table with a `tenant_id` column. */
  readonly companyTables: readonly string[];
  /** Every table without one that hangs off a company table by a foreign key. */
  readonly childTables: readonly string[];
  readonly rows: readonly PlantedRow[];
}

export interface PlantCompanyRowsOptions {
  /** Tables to leave unplanted (still checked). */
  readonly skip?: readonly string[];
  /** The companies table, whose `id` a `tenant_id` foreign key points at. Default "tenants". */
  readonly companiesTable?: string;
  /**
   * Links the database doesn't know about: a child column that points at a
   * parent with no foreign key, as `{ "estimate_items.estimate_id": "estimates.id" }`.
   * Planted and checked exactly like a foreign key.
   */
  readonly links?: Readonly<Record<string, string>>;
}

/** Unique across every plant in this process, so a second plant never repeats a value. */
let seq = 1;

export class ForgetProofError extends Error {
  readonly name = "ForgetProofError";
}

function splitColumn(ref: string): [string, string] {
  const at = ref.lastIndexOf(".");
  if (at <= 0) throw new ForgetProofError(`"${ref}" isn't table.column`);
  return [ref.slice(0, at), ref.slice(at + 1)];
}

/** A stand-in for a column of `type`, unique per call; null when it can't make one. */
function standIn(column: Column, seq: number): { value: unknown; cast: string } | null {
  const type = column.type;
  if (column.enumLabels && column.enumLabels.length > 0) return { value: column.enumLabels[0], cast: quote(type.replace(/^"|"$/g, "")) };
  if (type.endsWith("[]")) return { value: "{}", cast: type };
  if (/^(text|character varying|varchar|character|char|citext|name)/.test(type)) {
    const limit = /\((\d+)\)/.exec(type);
    const text = `f${seq}`;
    return { value: limit ? text.slice(0, Number(limit[1])) : text, cast: type };
  }
  if (/^(smallint|integer|bigint|numeric|real|double precision|decimal)/.test(type)) return { value: String(seq), cast: type };
  if (type === "boolean") return { value: "false", cast: "boolean" };
  if (/^timestamp|^date/.test(type)) return { value: new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString(), cast: type };
  if (/^time/.test(type)) return { value: "12:00:00", cast: type };
  if (type === "interval") return { value: "1 hour", cast: type };
  if (type === "jsonb" || type === "json") return { value: "{}", cast: type };
  if (type === "uuid") {
    const hex = seq.toString(16).padStart(12, "0");
    return { value: `00000000-0000-4000-8000-${hex}`, cast: "uuid" };
  }
  if (type === "bytea") return { value: "\\x00", cast: "bytea" };
  if (type === "inet" || type === "cidr") return { value: "127.0.0.1", cast: type };
  if (type === "tsvector") return { value: "", cast: "tsvector" };
  return null;
}

/**
 * One row per company in every table with `tenant_id`, and one in every
 * table hanging off those, for each of `tenantIds` (which must already exist
 * in the companies table when it has foreign keys pointing at it).
 */
export async function plantCompanyRows(
  db: ForgetProofDb,
  tenantIds: readonly string[],
  options: PlantCompanyRowsOptions = {},
): Promise<PlantedCompanyRows> {
  const tables = await readTables(db);
  for (const [from, to] of Object.entries(options.links ?? {})) {
    const [childTable, childColumn] = splitColumn(from);
    const [parentTable, parentColumn] = splitColumn(to);
    const child = tables.get(childTable);
    if (!child || !tables.has(parentTable)) throw new ForgetProofError(`link ${from} → ${to} names a table that doesn't exist`);
    if (!child.columns.some((c) => c.name === childColumn)) throw new ForgetProofError(`link ${from}: no column ${childColumn}`);
    tables.set(childTable, {
      ...child,
      foreignKeys: [...child.foreignKeys, { name: `link:${from}`, columns: [childColumn], refTable: parentTable, refColumns: [parentColumn] }],
    });
  }
  const companiesTable = options.companiesTable ?? "tenants";
  const skip = new Set(options.skip ?? []);
  const companyTables = [...tables.values()].filter((t) => t.hasTenant).map((t) => t.key);

  // The children: tables without tenant_id reaching a company table by foreign keys, however deep.
  const planted = new Set(companyTables);
  const children: string[] = [];
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of tables.values()) {
      if (planted.has(t.key) || t.key === companiesTable) continue;
      if (t.foreignKeys.some((fk) => planted.has(fk.refTable) && fk.refTable !== t.key)) {
        planted.add(t.key);
        children.push(t.key);
        grew = true;
      }
    }
  }

  // Parents before children (a cycle is broken at a nullable key, left empty).
  const order: string[] = [];
  const placed = new Set<string>();
  const placing = new Set<string>();
  const visit = (key: string) => {
    if (placed.has(key) || placing.has(key) || !planted.has(key)) return;
    placing.add(key);
    for (const fk of tables.get(key)!.foreignKeys) if (fk.refTable !== key) visit(fk.refTable);
    placing.delete(key);
    placed.add(key);
    order.push(key);
  };
  for (const key of [...planted].sort()) visit(key);


  const out: PlantedRow[] = [];
  /** A shared row in a table that isn't any company's (a person, say), for a required key pointing there. */
  const shared = new Map<string, Row>();

  async function insert(table: Table, values: Map<string, { value: unknown; cast: string }>): Promise<Row> {
    const names = [...values.keys()];
    const statement = names.length
      ? sql.join(
          [
            sql.raw(`insert into ${table.sqlName} (${names.map(quote).join(", ")}) values (`),
            sql.join(
              names.map((n) => {
                const v = values.get(n)!;
                return v.value === null ? sql.raw("null") : sql`${v.value}::${sql.raw(v.cast)}`;
              }),
              sql.raw(", "),
            ),
            // A company that already has its one row here (its settings, made when it was created) keeps it: that row is planted instead.
            sql.raw(`) on conflict do nothing returning *`),
          ],
          sql.raw(""),
        )
      : sql.raw(`insert into ${table.sqlName} default values returning *`);
    let row: Row | undefined;
    try {
      [row] = await rows(db, statement);
    } catch (error) {
      throw new ForgetProofError(`couldn't plant a row in ${table.key} (${names.join(", ")}): ${(error as Error).message}`);
    }
    if (row) return row;
    // Nothing written: a unique key this company already holds. Its existing row stands in.
    const tenant = values.get("tenant_id")?.value;
    if (table.hasTenant && typeof tenant === "string") {
      const [existing] = await rows(db, sql`select * from ${sql.raw(table.sqlName)} where tenant_id = ${tenant} limit 1`);
      if (existing) return existing;
    }
    throw new ForgetProofError(`couldn't plant a row in ${table.key} (${names.join(", ")}): a unique key refused it`);
  }

  async function sharedRow(key: string, depth: number): Promise<Row | null> {
    if (shared.has(key)) return shared.get(key)!;
    const table = tables.get(key);
    if (!table || depth > 4) return null;
    const values = new Map<string, { value: unknown; cast: string }>();
    for (const column of table.columns) {
      if (column.skip || !column.notNull || column.hasDefault) continue;
      const fk = table.foreignKeys.find((f) => f.columns.includes(column.name));
      if (fk && fk.refTable !== key) {
        const parent = await sharedRow(fk.refTable, depth + 1);
        const refCol = fk.refColumns[fk.columns.indexOf(column.name)]!;
        if (parent) values.set(column.name, { value: parent[refCol] ?? null, cast: column.type });
        continue;
      }
      const v = standIn(column, seq++);
      if (!v) throw new ForgetProofError(`can't make a stand-in for ${key}.${column.name} (${column.type})`);
      values.set(column.name, v);
    }
    const row = await insert(table, values);
    shared.set(key, row);
    return row;
  }

  for (const tenantId of tenantIds) {
    const mine = new Map<string, Row>();
    for (const key of order) {
      if (skip.has(key)) continue;
      const table = tables.get(key)!;
      const values = new Map<string, { value: unknown; cast: string }>();
      for (const column of table.columns) {
        if (column.skip) continue;
        if (column.name === "tenant_id") {
          values.set(column.name, { value: tenantId, cast: column.type });
          continue;
        }
        const fk = table.foreignKeys.find((f) => f.columns.includes(column.name));
        if (fk) {
          const refCol = fk.refColumns[fk.columns.indexOf(column.name)]!;
          if (fk.refTable === companiesTable) {
            values.set(column.name, { value: tenantId, cast: column.type });
            continue;
          }
          if (fk.refTable === key) {
            if (!column.notNull) continue;
          } else {
            const parent = mine.get(fk.refTable) ?? (planted.has(fk.refTable) ? null : await sharedRow(fk.refTable, 0));
            if (parent) {
              values.set(column.name, { value: parent[refCol] ?? null, cast: column.type });
              continue;
            }
            if (!column.notNull) continue;
          }
        }
        if (!column.notNull || column.hasDefault) continue;
        const v = standIn(column, seq++);
        if (!v) throw new ForgetProofError(`can't make a stand-in for ${key}.${column.name} (${column.type})`);
        values.set(column.name, v);
      }
      const row = await insert(table, values);
      mine.set(key, row);
      const matchColumns = table.primaryKey.length > 0 ? table.primaryKey : [...values.keys()];
      const match: Record<string, unknown> = {};
      for (const c of matchColumns) match[c] = row[c];
      out.push({ table: key, tenantId, kind: table.hasTenant ? "company" : "child", match });
    }
  }
  return { tenantIds: [...tenantIds], companyTables: companyTables.sort(), childTables: children.sort(), rows: out };
}

async function stillThere(db: ForgetProofDb, row: PlantedRow, table: Table): Promise<boolean> {
  const where = Object.entries(row.match).map(([column, value]) => {
    const type = table.columns.find((c) => c.name === column)?.type ?? "text";
    return value === null || value === undefined
      ? sql.raw(`${quote(column)} is null`)
      : sql`${sql.raw(quote(column))} = ${value instanceof Date ? value.toISOString() : typeof value === "object" ? JSON.stringify(value) : value}::${sql.raw(type)}`;
  });
  const found = await rows(db, sql`select 1 as found from ${sql.raw(table.sqlName)} where ${sql.join(where, sql.raw(" and "))} limit 1`);
  return found.length > 0;
}

/** How many rows each company has in every table with `tenant_id`: `{ table: { tenantId: n } }`. */
export async function companyRowCounts(db: ForgetProofDb, tenantIds: readonly string[]): Promise<Record<string, Record<string, number>>> {
  const tables = await readTables(db);
  const out: Record<string, Record<string, number>> = {};
  for (const table of [...tables.values()].filter((t) => t.hasTenant).sort((a, b) => a.key.localeCompare(b.key))) {
    const counts: Record<string, number> = {};
    for (const tenantId of tenantIds) {
      const [r] = await rows(db, sql`select count(*)::int as n from ${sql.raw(table.sqlName)} where tenant_id = ${tenantId}`);
      counts[tenantId] = Number(r?.["n"] ?? 0);
    }
    out[table.key] = counts;
  }
  return out;
}

export interface ForgetReport {
  /** Tables that still hold rows of the forgotten company (kept tables apart). */
  readonly left: readonly string[];
  /** Tables where another company's rows went too, or its planted row is gone. */
  readonly lost: readonly string[];
  /** The kept tables that do still hold the forgotten company's rows (expected). */
  readonly kept: readonly string[];
  /** Tables named as kept that don't exist (a stale reason). */
  readonly unknownKept: readonly string[];
}

/**
 * After forgetting `forgotten`: which tables still hold its rows, and which
 * lost another company's. `kept` names the tables allowed to keep the
 * forgotten company's rows, each with its reason (the deletion's own record,
 * say); `before` is `companyRowCounts` taken before the deletion, so a lost
 * row of another company is caught even if it wasn't planted.
 */
export async function forgetReport(
  db: ForgetProofDb,
  planted: PlantedCompanyRows,
  options: {
    readonly forgotten: string;
    readonly kept?: Readonly<Record<string, string>>;
    readonly before?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  },
): Promise<ForgetReport> {
  const kept = options.kept ?? {};
  const tables = await readTables(db);
  const left = new Set<string>();
  const lost = new Set<string>();
  const keptLeft = new Set<string>();
  const after = await companyRowCounts(db, planted.tenantIds);
  for (const [table, counts] of Object.entries(after)) {
    if ((counts[options.forgotten] ?? 0) > 0) (table in kept ? keptLeft : left).add(table);
    for (const other of planted.tenantIds) {
      if (other === options.forgotten) continue;
      const was = options.before?.[table]?.[other];
      if (was !== undefined && (counts[other] ?? 0) < was) lost.add(table);
    }
  }
  for (const row of planted.rows) {
    const table = tables.get(row.table);
    if (!table) continue;
    const there = await stillThere(db, row, table);
    if (row.tenantId === options.forgotten) {
      if (there) (row.table in kept ? keptLeft : left).add(row.table);
    } else if (!there) {
      lost.add(row.table);
    }
  }
  return {
    left: [...left].sort(),
    lost: [...lost].sort(),
    kept: [...keptLeft].sort(),
    unknownKept: Object.keys(kept).filter((k) => !tables.has(k)).sort(),
  };
}
