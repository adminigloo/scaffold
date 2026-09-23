import { Column, getTableColumns, getTableName, is, SQL, Table } from "drizzle-orm";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import type { EstimatorDb } from "../index.js";

/**
 * An in-memory Postgres small enough to reason about, for the query-builder
 * statements this package sends.
 *
 * WHY NOT A MOCK OF THE CALLS: the defects worth testing here ARE the WHERE
 * clauses — a read that forgot the tenant, a status update with no guard on the
 * current status. A fake that returns canned rows per table proves only that
 * the code asked for a table. This one compiles each condition through
 * Drizzle's own PgDialect (so it sees exactly the SQL the driver would) and
 * evaluates it against the rows, so a missing `tenant_id = $n` really does
 * return another tenant's row.
 *
 * IT IS NOT A DATABASE. It evaluates the subset the package emits — and/or/not,
 * = <> < > <= >=, in, like, is [not] null, and two aggregates (count(*) and
 * max(substring(col from 're'))) — enforces the unique indexes declared in the
 * schema, applies column defaults, and rolls a transaction back through an undo
 * log. Anything else throws, loudly, rather than answering wrong.
 */

type Row = Record<string, unknown>;
type Joined = Map<string, Row>;

interface TableMeta {
  readonly name: string;
  readonly table: PgTable;
  /** property key → column */
  readonly columns: Record<string, Column>;
  /** db column name → property key */
  readonly keyOf: Map<string, string>;
  readonly uniques: Array<{ name: string; keys: string[] }>;
}

const dialect = new PgDialect();
const metas = new Map<PgTable, TableMeta>();

function metaOf(table: PgTable): TableMeta {
  const cached = metas.get(table);
  if (cached) return cached;
  const columns = getTableColumns(table) as Record<string, Column>;
  const keyOf = new Map<string, string>();
  for (const [key, col] of Object.entries(columns)) keyOf.set(col.name, key);
  const uniques = getTableConfig(table)
    .indexes.filter((idx) => idx.config.unique)
    .map((idx) => ({
      name: idx.config.name ?? "unique",
      keys: idx.config.columns.map((c) => keyOf.get((c as Column).name) as string),
    }));
  const meta: TableMeta = { name: getTableName(table), table, columns, keyOf, uniques };
  metas.set(table, meta);
  return meta;
}

// --- Condition compiler ------------------------------------------------------

type Tok =
  | { k: "col"; table: string | null; col: string }
  | { k: "param"; i: number }
  | { k: "lit"; v: unknown }
  | { k: "word"; v: string }
  | { k: "op"; v: string }
  | { k: "("}
  | { k: ")" }
  | { k: "," };

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"') {
      const m = /^"([^"]+)"(?:\."([^"]+)")?/.exec(text.slice(i));
      if (!m) throw new Error(`fake-db: bad identifier at ${text.slice(i)}`);
      out.push(m[2] ? { k: "col", table: m[1]!, col: m[2] } : { k: "col", table: null, col: m[1]! });
      i += m[0].length;
      continue;
    }
    if (ch === "$") {
      const m = /^\$(\d+)/.exec(text.slice(i))!;
      out.push({ k: "param", i: Number(m[1]) - 1 });
      i += m[0].length;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      let v = "";
      while (j < text.length) {
        if (text[j] === "'" && text[j + 1] === "'") {
          v += "'";
          j += 2;
        } else if (text[j] === "'") break;
        else v += text[j++];
      }
      out.push({ k: "lit", v });
      i = j + 1;
      continue;
    }
    if (ch === ":" && text[i + 1] === ":") {
      // A cast (::int) — the value is already the right JS type.
      const m = /^::\w+/.exec(text.slice(i))!;
      i += m[0].length;
      continue;
    }
    const op = /^(<>|!=|<=|>=|=|<|>)/.exec(text.slice(i));
    if (op) {
      out.push({ k: "op", v: op[1]! === "!=" ? "<>" : op[1]! });
      i += op[1]!.length;
      continue;
    }
    if (ch === "(" || ch === ")" || ch === ",") {
      out.push({ k: ch } as Tok);
      i++;
      continue;
    }
    const num = /^-?\d+(\.\d+)?/.exec(text.slice(i));
    if (num) {
      out.push({ k: "lit", v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const word = /^[A-Za-z_]\w*/.exec(text.slice(i));
    if (word) {
      out.push({ k: "word", v: word[0].toLowerCase() });
      i += word[0].length;
      continue;
    }
    throw new Error(`fake-db: cannot tokenize ${text.slice(i)}`);
  }
  return out;
}

type Getter = (j: Joined) => unknown;
type Pred = (j: Joined) => boolean;

function norm(v: unknown): unknown {
  return v instanceof Date ? v.getTime() : v;
}

function compare(op: string, a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  const x = norm(a) as number | string | boolean;
  const y = norm(b) as number | string | boolean;
  switch (op) {
    case "=":
      return x === y;
    case "<>":
      return x !== y;
    case "<":
      return x < y;
    case ">":
      return x > y;
    case "<=":
      return x <= y;
    case ">=":
      return x >= y;
  }
  throw new Error(`fake-db: operator ${op}`);
}

function likeToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/%/g, ".*").replace(/_/g, ".")}$`, "s");
}

function readColumn(j: Joined, table: string | null, col: string): unknown {
  const candidates = table ? [table] : [...j.keys()];
  for (const name of candidates) {
    const row = j.get(name);
    if (!row) continue;
    const meta = [...metas.values()].find((m) => m.name === name);
    const key = meta?.keyOf.get(col);
    if (key !== undefined) return row[key];
  }
  throw new Error(`fake-db: unknown column ${table ?? "?"}.${col}`);
}

function compileCondition(condition: SQL | undefined): Pred {
  if (!condition) return () => true;
  const { sql: text, params } = dialect.sqlToQuery(condition);
  const toks = tokenize(text);
  let p = 0;
  const peek = () => toks[p];
  const isWord = (w: string) => {
    const t = toks[p];
    return t?.k === "word" && t.v === w;
  };
  const expect = (k: Tok["k"]) => {
    if (toks[p]?.k !== k) throw new Error(`fake-db: expected ${k} in ${text}`);
    p++;
  };

  function operand(): Getter {
    const t = toks[p++];
    if (!t) throw new Error(`fake-db: unexpected end of ${text}`);
    if (t.k === "col") return (j) => readColumn(j, t.table, t.col);
    if (t.k === "param") {
      const v = params[t.i];
      return () => v;
    }
    if (t.k === "lit") return () => t.v;
    if (t.k === "word" && (t.v === "true" || t.v === "false")) {
      const v = t.v === "true";
      return () => v;
    }
    if (t.k === "word" && t.v === "null") return () => null;
    if (t.k === "word" && t.v === "extract") {
      // extract(year from "t"."c") — the pre-0.2 numbering read; kept so the
      // fake can run old statements when checking a regression against them.
      expect("(");
      if (!isWord("year")) throw new Error(`fake-db: only extract(year …) in ${text}`);
      p++;
      if (!isWord("from")) throw new Error(`fake-db: expected from in ${text}`);
      p++;
      const inner = operand();
      expect(")");
      return (j) => {
        const v = inner(j);
        return v instanceof Date ? v.getUTCFullYear() : null;
      };
    }
    throw new Error(`fake-db: unsupported operand ${JSON.stringify(t)} in ${text}`);
  }

  function predicate(): Pred {
    const lhs = operand();
    const t = peek();
    if (t?.k === "op") {
      p++;
      const rhs = operand();
      return (j) => compare(t.v, lhs(j), rhs(j));
    }
    if (isWord("is")) {
      p++;
      const negate = isWord("not");
      if (negate) p++;
      if (!isWord("null")) throw new Error(`fake-db: expected null in ${text}`);
      p++;
      return (j) => {
        const v = lhs(j);
        const isNullish = v === null || v === undefined;
        return negate ? !isNullish : isNullish;
      };
    }
    let negate = false;
    if (isWord("not")) {
      negate = true;
      p++;
    }
    if (isWord("in")) {
      p++;
      expect("(");
      const list: Getter[] = [operand()];
      while (peek()?.k === ",") {
        p++;
        list.push(operand());
      }
      expect(")");
      return (j) => {
        const v = lhs(j);
        const hit = list.some((g) => compare("=", v, g(j)));
        return negate ? !hit : hit;
      };
    }
    if (isWord("like")) {
      p++;
      const rhs = operand();
      return (j) => {
        const v = lhs(j);
        const hit = typeof v === "string" && likeToRegExp(String(rhs(j))).test(v);
        return negate ? !hit : hit;
      };
    }
    // A bare boolean (drizzle renders `inArray(col, [])` as `false`).
    return (j) => Boolean(lhs(j));
  }

  function primary(): Pred {
    if (peek()?.k === "(") {
      p++;
      const inner = or();
      expect(")");
      return inner;
    }
    return predicate();
  }

  function not(): Pred {
    if (isWord("not")) {
      p++;
      const inner = not();
      return (j) => !inner(j);
    }
    return primary();
  }

  function and(): Pred {
    let left = not();
    while (isWord("and")) {
      p++;
      const l = left;
      const r = not();
      left = (j) => l(j) && r(j);
    }
    return left;
  }

  function or(): Pred {
    let left = and();
    while (isWord("or")) {
      p++;
      const l = left;
      const r = and();
      left = (j) => l(j) || r(j);
    }
    return left;
  }

  const pred = or();
  if (p !== toks.length) throw new Error(`fake-db: trailing tokens in ${text}`);
  return pred;
}

// --- The database ------------------------------------------------------------

export interface FakeDbOptions {
  /** Runs before each insert's unique check — the hook a race test plants a competitor with. */
  beforeInsert?: (table: string, row: Row, fake: FakeDb) => void;
}

export interface FakeDb {
  readonly db: EstimatorDb;
  /** Rows by table name; mutate directly to seed or to simulate another writer. */
  readonly tables: Record<string, Row[]>;
  /** Every statement, in order: "select:estimator_products", "tx:begin", … */
  readonly log: string[];
  seed(table: PgTable, rows: Row[]): Row[];
  rows(table: PgTable): Row[];
}

let idCounter = 0;

export function createFakeDb(options: FakeDbOptions = {}): FakeDb {
  const tables: Record<string, Row[]> = {};
  const log: string[] = [];
  /** Undo entries of the open transactions, innermost last. */
  const undoStack: Array<Array<() => void>> = [];

  const rowsOf = (table: PgTable): Row[] => {
    const meta = metaOf(table);
    return (tables[meta.name] ??= []);
  };
  const recordUndo = (undo: () => void) => undoStack.at(-1)?.push(undo);

  function withDefaults(meta: TableMeta, values: Row): Row {
    const row: Row = {};
    for (const [key, col] of Object.entries(meta.columns)) {
      const given = values[key];
      if (given !== undefined) {
        row[key] = given;
        continue;
      }
      const c = col as Column & { defaultFn?: () => unknown; default?: unknown };
      if (typeof c.defaultFn === "function") row[key] = c.defaultFn();
      else if (c.default !== undefined) row[key] = is(c.default, SQL) ? new Date() : c.default;
      else row[key] = null;
    }
    if (row.id === null || row.id === undefined) row.id = `id-${++idCounter}`;
    return row;
  }

  function project(fields: Record<string, unknown> | undefined, j: Joined, base: string): Row {
    if (!fields) return { ...j.get(base)! };
    const out: Row = {};
    for (const [key, field] of Object.entries(fields)) {
      if (is(field, Column)) {
        const col = field as Column;
        out[key] = readColumn(j, getTableName(col.table), col.name);
      } else if (is(field, Table)) {
        out[key] = { ...j.get(getTableName(field as PgTable))! };
      } else {
        throw new Error(`fake-db: unsupported non-aggregate field ${key}`);
      }
    }
    return out;
  }

  function aggregate(fields: Record<string, unknown>, rows: Joined[]): Row {
    const out: Row = {};
    for (const [key, field] of Object.entries(fields)) {
      const { sql: text } = dialect.sqlToQuery(field as SQL);
      if (/^count\(\*\)/.test(text)) {
        out[key] = rows.length;
        continue;
      }
      const max = /max\(substring\("([^"]+)"\."([^"]+)" from '([^']+)'\)/.exec(text);
      if (max) {
        const re = new RegExp(max[3]!);
        let best: number | null = null;
        for (const j of rows) {
          const v = readColumn(j, max[1]!, max[2]!);
          const m = typeof v === "string" ? re.exec(v) : null;
          if (!m) continue;
          const n = Number(m[1] ?? m[0]);
          if (best === null || n > best) best = n;
        }
        out[key] = /^coalesce\(/.test(text) ? (best ?? 0) : best;
        continue;
      }
      throw new Error(`fake-db: unsupported aggregate ${text}`);
    }
    return out;
  }

  function orderKey(term: unknown): { get: (j: Joined) => unknown; desc: boolean } {
    if (is(term, Column)) {
      const col = term as Column;
      return { get: (j) => readColumn(j, getTableName(col.table), col.name), desc: false };
    }
    const { sql: text } = dialect.sqlToQuery(term as SQL);
    const m = /^"([^"]+)"\."([^"]+)"\s+(asc|desc)$/.exec(text.trim());
    if (!m) throw new Error(`fake-db: unsupported order by ${text}`);
    return { get: (j) => readColumn(j, m[1]!, m[2]!), desc: m[3] === "desc" };
  }

  function select(fields?: Record<string, unknown>) {
    let base: PgTable | null = null;
    const joins: Array<{ table: PgTable; on: SQL }> = [];
    let where: SQL | undefined;
    let orders: unknown[] = [];
    let limit: number | null = null;

    const run = (): Row[] => {
      if (!base) throw new Error("fake-db: select without from");
      const baseMeta = metaOf(base);
      log.push(`select:${baseMeta.name}`);
      let joined: Joined[] = rowsOf(base).map((r) => new Map([[baseMeta.name, r]]));
      for (const join of joins) {
        const jm = metaOf(join.table);
        const on = compileCondition(join.on);
        const next: Joined[] = [];
        for (const left of joined) {
          for (const r of rowsOf(join.table)) {
            const candidate = new Map(left);
            candidate.set(jm.name, r);
            if (on(candidate)) next.push(candidate);
          }
        }
        joined = next;
      }
      const pred = compileCondition(where);
      joined = joined.filter(pred);

      if (fields && Object.values(fields).some((f) => is(f, SQL))) {
        return [aggregate(fields, joined)];
      }
      if (orders.length > 0) {
        const keys = orders.map(orderKey);
        joined = [...joined].sort((a, b) => {
          for (const k of keys) {
            const x = norm(k.get(a)) as number | string;
            const y = norm(k.get(b)) as number | string;
            if (x === y) continue;
            const cmp = x < y ? -1 : 1;
            return k.desc ? -cmp : cmp;
          }
          return 0;
        });
      }
      if (limit !== null) joined = joined.slice(0, limit);
      return joined.map((j) => project(fields, j, baseMeta.name));
    };

    const builder = {
      from(table: PgTable) {
        base = table;
        metaOf(table);
        return builder;
      },
      innerJoin(table: PgTable, on: SQL) {
        metaOf(table);
        joins.push({ table, on });
        return builder;
      },
      where(condition: SQL | undefined) {
        where = condition;
        return builder;
      },
      orderBy(...terms: unknown[]) {
        orders = terms;
        return builder;
      },
      limit(n: number) {
        limit = n;
        return builder;
      },
      for(_strength: string) {
        log.push("lock");
        return builder;
      },
      then<T>(resolve: (rows: Row[]) => T, reject?: (e: unknown) => T) {
        return Promise.resolve().then(run).then(resolve, reject);
      },
    };
    return builder;
  }

  function insert(table: PgTable) {
    const meta = metaOf(table);
    let pending: Row[] = [];
    let fields: Record<string, unknown> | undefined;
    let wantRows = false;

    const run = (): Row[] => {
      log.push(`insert:${meta.name}`);
      const rows = rowsOf(table);
      const inserted: Row[] = [];
      for (const values of pending) {
        const row = withDefaults(meta, values);
        options.beforeInsert?.(meta.name, row, fake);
        for (const u of meta.uniques) {
          const clash = rows.some((existing) =>
            u.keys.every((k) => compare("=", existing[k], row[k])),
          );
          if (clash) {
            // Shaped like the real thing: Drizzle wraps the driver's error, and
            // the Postgres code rides on `cause`.
            const pgError = Object.assign(
              new Error(`duplicate key value violates unique constraint "${u.name}"`),
              { code: "23505", constraint: u.name },
            );
            throw Object.assign(new Error(`Failed query: insert into "${meta.name}"`), {
              cause: pgError,
            });
          }
        }
        rows.push(row);
        recordUndo(() => {
          const at = rows.indexOf(row);
          if (at >= 0) rows.splice(at, 1);
        });
        inserted.push(row);
      }
      if (!wantRows) return [];
      return inserted.map((r) => project(fields, new Map([[meta.name, r]]), meta.name));
    };

    const builder = {
      values(v: Row | Row[]) {
        pending = Array.isArray(v) ? v : [v];
        return builder;
      },
      returning(f?: Record<string, unknown>) {
        wantRows = true;
        fields = f;
        return builder;
      },
      then<T>(resolve: (rows: Row[]) => T, reject?: (e: unknown) => T) {
        return Promise.resolve().then(run).then(resolve, reject);
      },
    };
    return builder;
  }

  function update(table: PgTable) {
    const meta = metaOf(table);
    let patch: Row = {};
    let where: SQL | undefined;
    let fields: Record<string, unknown> | undefined;
    let wantRows = false;

    const run = (): Row[] => {
      log.push(`update:${meta.name}`);
      const pred = compileCondition(where);
      const changed: Row[] = [];
      for (const row of rowsOf(table)) {
        if (!pred(new Map([[meta.name, row]]))) continue;
        const before = { ...row };
        for (const [k, v] of Object.entries(patch)) if (v !== undefined) row[k] = v;
        recordUndo(() => {
          for (const k of Object.keys(row)) delete row[k];
          Object.assign(row, before);
        });
        changed.push(row);
      }
      if (!wantRows) return [];
      return changed.map((r) => project(fields, new Map([[meta.name, r]]), meta.name));
    };

    const builder = {
      set(p: Row) {
        patch = p;
        return builder;
      },
      where(condition: SQL | undefined) {
        where = condition;
        return builder;
      },
      returning(f?: Record<string, unknown>) {
        wantRows = true;
        fields = f;
        return builder;
      },
      then<T>(resolve: (rows: Row[]) => T, reject?: (e: unknown) => T) {
        return Promise.resolve().then(run).then(resolve, reject);
      },
    };
    return builder;
  }

  const handle = {
    select,
    insert,
    update,
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      log.push("tx:begin");
      undoStack.push([]);
      try {
        const result = await fn(handle);
        const done = undoStack.pop()!;
        // A nested transaction's work belongs to its parent until that commits.
        undoStack.at(-1)?.push(...done);
        log.push("tx:commit");
        return result;
      } catch (error) {
        const undo = undoStack.pop()!;
        for (const step of undo.reverse()) step();
        log.push("tx:rollback");
        throw error;
      }
    },
  };

  const fake: FakeDb = {
    db: handle as unknown as EstimatorDb,
    tables,
    log,
    seed(table, rows) {
      const meta = metaOf(table);
      const target = rowsOf(table);
      const full = rows.map((r) => withDefaults(meta, r));
      target.push(...full);
      return full;
    },
    rows(table) {
      return rowsOf(table);
    },
  };
  return fake;
}
