import { Column, getTableColumns, is, Param, SQL, StringChunk, type Table } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import type { InvoicingDb } from "../index.js";

/**
 * An in-memory stand-in for the drizzle chains invoicing runs — richer than the
 * route-by-shape fakes elsewhere, because the bugs here live in the WHERE
 * clauses (a missing tenant filter IS the IDOR) and in the unique indexes (a
 * missing index IS the double conversion). So:
 *
 *   - WHERE conditions are evaluated, not ignored: drizzle's SQL chunks are
 *     flattened and parsed (and/or/not, = <> < <= > >=, is [not] null,
 *     in (...), like, ~, now()). A tenant filter the code forgot means another
 *     tenant's row matches here too.
 *   - Unique indexes are read from the real schema (getTableConfig), partial
 *     `where` included, and enforced on insert/update with a 23505 wrapped the
 *     way drizzle ≥0.44 wraps driver errors (DrizzleQueryError → cause). Drop
 *     an index from schema.ts and the test that relies on it goes red.
 *   - transaction() snapshots and restores state on throw, nesting included.
 *
 * Aggregate selects (sql`count(*)`, sql`max(...)`) are answered by field name
 * from `aggregates` — the one place this routes by shape.
 */

type Row = Record<string, unknown>;
type Tok =
  | { k: "op"; v: string }
  | { k: "word"; v: string }
  | { k: "lp" }
  | { k: "rp" }
  | { k: "comma" }
  | { k: "col"; name: string }
  | { k: "val"; v: unknown }
  | { k: "list"; v: unknown[] };

function isColumnLike(chunk: unknown): chunk is { name: string } {
  return (
    is(chunk, Column) ||
    (typeof chunk === "object" &&
      chunk !== null &&
      typeof (chunk as { name?: unknown }).name === "string" &&
      typeof (chunk as { columnType?: unknown }).columnType === "string")
  );
}

function flatten(chunk: unknown, out: Tok[]): void {
  if (chunk === undefined) return;
  if (is(chunk, SQL)) {
    for (const c of chunk.queryChunks) flatten(c, out);
    return;
  }
  if (is(chunk, StringChunk)) {
    const text = chunk.value.join("");
    const re = /\s*(<>|<=|>=|!=|=|<|>|~|\(|\)|,|[A-Za-z_][A-Za-z0-9_]*\(\)|[A-Za-z_][A-Za-z0-9_]*|::[a-z]+|\S)\s*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const t = m[1]!;
      if (t.startsWith("::")) continue; // casts don't change a comparison here
      if (t === "(") out.push({ k: "lp" });
      else if (t === ")") out.push({ k: "rp" });
      else if (t === ",") out.push({ k: "comma" });
      else if (/^[A-Za-z_]/.test(t)) out.push({ k: "word", v: t.toLowerCase() });
      else out.push({ k: "op", v: t });
    }
    return;
  }
  if (is(chunk, Param)) {
    out.push({ k: "val", v: chunk.value });
    return;
  }
  if (isColumnLike(chunk)) {
    out.push({ k: "col", name: chunk.name });
    return;
  }
  if (Array.isArray(chunk)) {
    out.push({ k: "list", v: chunk.map((c) => (is(c, Param) ? c.value : c)) });
    return;
  }
  out.push({ k: "val", v: chunk });
}

type Pred = (row: Row) => unknown;

function comparable(v: unknown): unknown {
  return v instanceof Date ? v.getTime() : v;
}

/** Compile a drizzle condition to a row predicate over property-keyed rows. */
function compile(condition: unknown, keyOf: (dbName: string) => string): Pred {
  const toks: Tok[] = [];
  flatten(condition, toks);
  let i = 0;
  const peek = () => toks[i];
  const word = (w: string) => {
    const t = toks[i];
    if (t && t.k === "word" && t.v === w) {
      i++;
      return true;
    }
    return false;
  };

  const operand = (): Pred => {
    const t = toks[i++];
    if (!t) throw new Error("fake-db: condition ended early");
    if (t.k === "col") {
      const key = keyOf(t.name);
      return (row) => row[key];
    }
    if (t.k === "val") return () => t.v;
    if (t.k === "word" && t.v === "now()") return () => new Date();
    if (t.k === "word" && (t.v === "true" || t.v === "false")) return () => t.v === "true";
    if (t.k === "word" && t.v === "null") return () => null;
    throw new Error(`fake-db: unsupported operand ${JSON.stringify(t)}`);
  };

  const atom = (): Pred => {
    const t = peek();
    if (t && t.k === "lp") {
      i++;
      const inner = orExpr();
      if (peek()?.k !== "rp") throw new Error("fake-db: missing )");
      i++;
      return inner;
    }
    const left = operand();
    const next = peek();
    if (!next || next.k === "rp" || (next.k === "word" && (next.v === "and" || next.v === "or"))) {
      return left;
    }
    if (word("is")) {
      const negate = word("not");
      if (!word("null")) throw new Error("fake-db: expected null");
      return (row) => {
        const v = left(row);
        const isNull = v === null || v === undefined;
        return negate ? !isNull : isNull;
      };
    }
    const negateIn = word("not");
    if (word("in")) {
      const list = toks[i++];
      if (!list || list.k !== "list") throw new Error("fake-db: expected list");
      return (row) => {
        const v = left(row);
        if (v === null || v === undefined) return false;
        const hit = list.v.some((x) => comparable(x) === comparable(v));
        return negateIn ? !hit : hit;
      };
    }
    if (word("like")) {
      const right = operand();
      return (row) => {
        const v = left(row);
        const p = right(row);
        if (typeof v !== "string" || typeof p !== "string") return false;
        const re = new RegExp(
          "^" +
            p
              .split("")
              .map((c) => (c === "%" ? ".*" : c === "_" ? "." : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
              .join("") +
            "$",
        );
        return re.test(v);
      };
    }
    const op = toks[i++];
    if (!op || op.k !== "op") throw new Error(`fake-db: unsupported condition near ${JSON.stringify(op)}`);
    const right = operand();
    return (row) => {
      const a = left(row);
      const b = right(row);
      if (a === null || a === undefined || b === null || b === undefined) return false;
      if (op.v === "~") return new RegExp(String(b)).test(String(a));
      const x = comparable(a) as number | string;
      const y = comparable(b) as number | string;
      switch (op.v) {
        case "=":
          return x === y;
        case "<>":
        case "!=":
          return x !== y;
        case "<":
          return x < y;
        case "<=":
          return x <= y;
        case ">":
          return x > y;
        case ">=":
          return x >= y;
        default:
          throw new Error(`fake-db: unsupported operator ${op.v}`);
      }
    };
  };

  const notExpr = (): Pred => {
    if (word("not")) {
      const inner = notExpr();
      return (row) => !inner(row);
    }
    return atom();
  };
  const andExpr = (): Pred => {
    const parts = [notExpr()];
    while (word("and")) parts.push(notExpr());
    return (row) => parts.every((p) => Boolean(p(row)));
  };
  const orExpr = (): Pred => {
    const parts = [andExpr()];
    while (word("or")) parts.push(andExpr());
    return (row) => parts.some((p) => Boolean(p(row)));
  };

  if (toks.length === 0) return () => true;
  const pred = orExpr();
  if (i !== toks.length) throw new Error(`fake-db: trailing tokens in condition: ${JSON.stringify(toks.slice(i))}`);
  return pred;
}

function uniqueViolation(constraint: string): Error {
  const cause = Object.assign(
    new Error(`duplicate key value violates unique constraint "${constraint}"`),
    { code: "23505", constraint },
  );
  return Object.assign(new Error("Failed query: (fake)"), { cause });
}

export type Aggregates = Record<string, (rows: Row[]) => unknown>;

const DEFAULT_AGGREGATES: Aggregates = {
  n: (rows) => rows.length,
  top: (rows) =>
    rows.reduce<number>((max, r) => {
      const m = /-(\d+)$/.exec(String(r.invoiceNumber ?? ""));
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0),
};

export interface FakeDb {
  db: InvoicingDb;
  rows: (table: Table) => Row[];
  seed: (table: Table, rows: Row[]) => void;
  /** Runs before each insert is applied; throw to simulate a failure, or seed a racer. */
  beforeInsert: ((table: Table, row: Row) => void) | null;
  /** Every executed statement, for asserting what ran (e.g. the lock). */
  log: Array<{ op: "select" | "insert" | "update"; table: string; forUpdate?: boolean }>;
}

export function createFakeDb(aggregates: Aggregates = DEFAULT_AGGREGATES): FakeDb {
  let state = new Map<Table, Row[]>();
  /** Open transactions' snapshots, outermost first. */
  const snapshots: Array<Map<Table, Row[]>> = [];
  const rowsIn = (map: Map<Table, Row[]>, table: Table): Row[] => {
    let rows = map.get(table);
    if (!rows) {
      rows = [];
      map.set(table, rows);
    }
    return rows;
  };
  const tableRows = (table: Table): Row[] => rowsIn(state, table);
  const columnsOf = (table: Table) => getTableColumns(table) as Record<string, Column>;
  const keyResolver = (table: Table) => {
    const byName = new Map<string, string>();
    for (const [key, col] of Object.entries(columnsOf(table))) byName.set(col.name, key);
    return (dbName: string) => {
      const key = byName.get(dbName);
      if (!key) throw new Error(`fake-db: no column ${dbName}`);
      return key;
    };
  };
  const tableName = (table: Table) => getTableConfig(table as PgTable).name;

  const project = (table: Table, row: Row, fields?: Record<string, unknown>): Row => {
    if (!fields) return { ...row };
    const keyOf = keyResolver(table);
    const out: Row = {};
    for (const [alias, field] of Object.entries(fields)) {
      if (!isColumnLike(field)) throw new Error(`fake-db: non-column field ${alias} outside an aggregate`);
      out[alias] = row[keyOf(field.name)];
    }
    return out;
  };

  const assertUnique = (table: Table, candidate: Row, others: Row[]) => {
    const keyOf = keyResolver(table);
    for (const idx of getTableConfig(table as PgTable).indexes) {
      if (!idx.config.unique) continue;
      const where = idx.config.where ? compile(idx.config.where, keyOf) : () => true;
      if (!where(candidate)) continue;
      const keys = idx.config.columns.map((c) => keyOf((c as { name: string }).name));
      // SQL: a NULL in any key column never collides.
      if (keys.some((k) => candidate[k] === null || candidate[k] === undefined)) continue;
      const clash = others.some(
        (o) =>
          where(o) && keys.every((k) => comparable(o[k]) === comparable(candidate[k])),
      );
      if (clash) throw uniqueViolation(idx.config.name ?? "unnamed_unique");
    }
  };

  const withDefaults = (table: Table, values: Row): Row => {
    const row: Row = {};
    for (const [key, col] of Object.entries(columnsOf(table))) {
      if (values[key] !== undefined) {
        row[key] = values[key];
        continue;
      }
      const c = col as unknown as { defaultFn?: () => unknown; default?: unknown };
      if (c.defaultFn) row[key] = c.defaultFn();
      else if (is(c.default, SQL)) row[key] = new Date();
      else row[key] = c.default ?? null;
    }
    return row;
  };

  const fake: FakeDb = {
    db: undefined as unknown as InvoicingDb,
    rows: (table) => tableRows(table),
    // A seeded row is another connection's COMMITTED write: it survives a
    // rollback of whatever transaction is open when it lands (the racer case).
    seed: (table, rows) => {
      for (const r of rows) {
        const row = withDefaults(table, r);
        tableRows(table).push(row);
        for (const snap of snapshots) rowsIn(snap, table).push(structuredClone(row));
      }
    },
    beforeInsert: null,
    log: [],
  };

  const thenable = <T>(run: () => T) => ({
    then<R1 = T, R2 = never>(
      resolve?: ((v: T) => R1 | PromiseLike<R1>) | null,
      reject?: ((e: unknown) => R2 | PromiseLike<R2>) | null,
    ): Promise<R1 | R2> {
      return Promise.resolve()
        .then(run)
        .then(resolve, reject);
    },
  });

  const db = {
    select: (fields?: Record<string, unknown>) => ({
      from: (table: Table) => {
        const q: { where?: unknown; order: unknown[]; limit?: number; forUpdate: boolean } = {
          order: [],
          forUpdate: false,
        };
        const run = (): Row[] => {
          fake.log.push({ op: "select", table: tableName(table), forUpdate: q.forUpdate });
          const keyOf = keyResolver(table);
          const pred = compile(q.where, keyOf);
          let rows = tableRows(table).filter((r) => Boolean(pred(r)));
          const aggregate = fields && Object.values(fields).some((f) => is(f, SQL));
          if (aggregate) {
            const out: Row = {};
            for (const alias of Object.keys(fields!)) {
              const fn = aggregates[alias];
              if (!fn) throw new Error(`fake-db: no aggregate for field "${alias}"`);
              out[alias] = fn(rows);
            }
            return [out];
          }
          for (const o of [...q.order].reverse()) {
            const toks: Tok[] = [];
            flatten(o, toks);
            const col = toks.find((t): t is { k: "col"; name: string } => t.k === "col");
            if (!col) throw new Error("fake-db: orderBy without a column");
            const key = keyOf(col.name);
            const desc = toks.some((t) => t.k === "word" && t.v === "desc");
            rows = [...rows].sort((a, b) => {
              const x = comparable(a[key]) as number | string;
              const y = comparable(b[key]) as number | string;
              const c = x < y ? -1 : x > y ? 1 : 0;
              return desc ? -c : c;
            });
          }
          if (q.limit !== undefined) rows = rows.slice(0, q.limit);
          return rows.map((r) => project(table, r, fields));
        };
        const chain = {
          where: (c: unknown) => ((q.where = c), chain),
          orderBy: (...o: unknown[]) => ((q.order = o), chain),
          limit: (n: number) => ((q.limit = n), chain),
          for: () => ((q.forUpdate = true), chain),
          ...thenable(run),
        };
        return chain;
      },
    }),

    insert: (table: Table) => ({
      values: (v: Row | Row[]) => {
        let returning: Record<string, unknown> | undefined | null = null;
        let done: Row[] | null = null;
        const run = (): Row[] => {
          if (done) return done;
          fake.log.push({ op: "insert", table: tableName(table) });
          const list = Array.isArray(v) ? v : [v];
          const written: Row[] = [];
          for (const values of list) {
            const row = withDefaults(table, values);
            fake.beforeInsert?.(table, row);
            assertUnique(table, row, tableRows(table));
            tableRows(table).push(row);
            written.push(row);
          }
          done = written;
          return returning === null ? [] : written.map((r) => project(table, r, returning ?? undefined));
        };
        return {
          returning: (fields?: Record<string, unknown>) => {
            returning = fields;
            return thenable(run);
          },
          ...thenable(run),
        };
      },
    }),

    update: (table: Table) => ({
      set: (values: Row) => {
        let where: unknown;
        let returning: Record<string, unknown> | undefined | null = null;
        const run = (): Row[] => {
          fake.log.push({ op: "update", table: tableName(table) });
          const pred = compile(where, keyResolver(table));
          const all = tableRows(table);
          const hits = all.filter((r) => Boolean(pred(r)));
          for (const row of hits) {
            const next = { ...row };
            for (const [k, val] of Object.entries(values)) if (val !== undefined) next[k] = val;
            assertUnique(table, next, all.filter((o) => o !== row));
            Object.assign(row, next);
          }
          return returning === null ? [] : hits.map((r) => project(table, r, returning ?? undefined));
        };
        const chain = {
          where: (c: unknown) => {
            where = c;
            return {
              returning: (fields?: Record<string, unknown>) => {
                returning = fields;
                return thenable(run);
              },
              ...thenable(run),
            };
          },
        };
        return chain;
      },
    }),

    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const snapshot = new Map([...state].map(([t, rows]) => [t, structuredClone(rows)]));
      snapshots.push(snapshot);
      try {
        return await fn(db);
      } catch (error) {
        state = snapshot;
        throw error;
      } finally {
        snapshots.splice(snapshots.indexOf(snapshot), 1);
      }
    },
  };

  fake.db = db as unknown as InvoicingDb;
  return fake;
}
