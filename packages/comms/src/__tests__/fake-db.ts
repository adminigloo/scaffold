import { getTableColumns, getTableName, is, Name, Param, SQL, StringChunk, type Table } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import type { CommsDb } from "../index.js";

/**
 * An in-memory stand-in for the drizzle chains comms runs — richer than the
 * narrow per-test fakes elsewhere in the repo ON PURPOSE. The queue's
 * correctness lives in its WHERE clauses (claim only if still pending, reclaim
 * only stale claims, cancel only pending rows), and a fake that ignores the
 * condition would pass a query with the guard deleted. So this one EVALUATES
 * the condition drizzle built — `and`/`or`/`not`, comparisons, `is [not] null`,
 * `in (...)` — against stored rows, applies column defaults and NOT NULL, and
 * enforces the schema's real unique indexes (partial ones included) for
 * `onConflictDoNothing` / `onConflictDoUpdate`.
 *
 * Anything it does not understand throws, so a new query shape shows up as a
 * test failure rather than a silently-true filter.
 */

type Row = Record<string, unknown>;

type Token =
  | { t: "col"; key: string }
  | { t: "val"; v: unknown }
  | { t: "word"; w: string }
  | { t: "op"; o: string }
  | { t: "(" }
  | { t: ")" }
  | { t: "," };

interface ColumnLike {
  name: string;
}

function columnKeyByName(table: Table): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, column] of Object.entries(getTableColumns(table))) {
    map.set((column as unknown as ColumnLike).name, key);
  }
  return map;
}

function isColumnLike(value: unknown): value is ColumnLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof (value as ColumnLike).name === "string" &&
    ("columnType" in value || "table" in value)
  );
}

function tokenizeText(text: string, out: Token[]): void {
  const re = /\s*(<=|>=|<>|=|<|>|\(|\)|,|[A-Za-z_]+|'[^']*'|-?\d+(?:\.\d+)?)\s*/gy;
  let match: RegExpExecArray | null;
  let consumed = 0;
  while ((match = re.exec(text)) !== null) {
    consumed = re.lastIndex;
    const piece = match[1]!;
    if (piece === "(" || piece === ")" || piece === ",") out.push({ t: piece });
    else if (/^(<=|>=|<>|=|<|>)$/.test(piece)) out.push({ t: "op", o: piece });
    else if (piece.startsWith("'")) out.push({ t: "val", v: piece.slice(1, -1) });
    else if (/^-?\d/.test(piece)) out.push({ t: "val", v: Number(piece) });
    else out.push({ t: "word", w: piece.toLowerCase() });
  }
  if (text.slice(consumed).trim() !== "") {
    throw new Error(`fake-db: cannot tokenize SQL text ${JSON.stringify(text)}`);
  }
}

function flatten(chunk: unknown, names: Map<string, string>, out: Token[]): void {
  if (chunk === undefined) return;
  if (is(chunk, StringChunk)) {
    for (const text of chunk.value) tokenizeText(text, out);
    return;
  }
  if (is(chunk, SQL)) {
    for (const inner of chunk.queryChunks) flatten(inner, names, out);
    return;
  }
  if (is(chunk, Param)) {
    out.push({ t: "val", v: chunk.value });
    return;
  }
  if (is(chunk, Name)) {
    const key = names.get(chunk.value);
    if (!key) throw new Error(`fake-db: unknown identifier ${chunk.value}`);
    out.push({ t: "col", key });
    return;
  }
  if (Array.isArray(chunk)) {
    out.push({ t: "(" });
    chunk.forEach((item, i) => {
      if (i > 0) out.push({ t: "," });
      flatten(item, names, out);
    });
    out.push({ t: ")" });
    return;
  }
  if (isColumnLike(chunk)) {
    const key = names.get(chunk.name);
    if (!key) throw new Error(`fake-db: column ${chunk.name} is not on this table`);
    out.push({ t: "col", key });
    return;
  }
  if (chunk instanceof Date || ["string", "number", "boolean"].includes(typeof chunk) || chunk === null) {
    out.push({ t: "val", v: chunk });
    return;
  }
  throw new Error(`fake-db: unsupported SQL chunk ${String(chunk)}`);
}

type Predicate = (row: Row) => boolean;
type Operand = (row: Row) => unknown;

function comparable(value: unknown): unknown {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return Date.parse(value);
  return value;
}

function compare(op: string, left: unknown, right: unknown): boolean {
  if (left === null || left === undefined || right === null || right === undefined) return false;
  const a = comparable(left) as number | string;
  const b = comparable(right) as number | string;
  switch (op) {
    case "=":
      return a === b;
    case "<>":
      return a !== b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    default:
      throw new Error(`fake-db: unsupported operator ${op}`);
  }
}

/** Recursive descent over the flattened tokens: or > and > not > comparison. */
function parseCondition(tokens: Token[]): Predicate {
  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];
  const isWord = (w: string): boolean => {
    const tok = peek();
    return tok?.t === "word" && tok.w === w;
  };
  const expect = (t: Token["t"]): Token => {
    const tok = tokens[pos++];
    if (!tok || tok.t !== t) throw new Error(`fake-db: expected ${t} at token ${pos - 1}`);
    return tok;
  };

  function operand(): Operand {
    const tok = tokens[pos++];
    if (tok?.t === "col") return (row) => row[tok.key];
    if (tok?.t === "val") return () => tok.v;
    if (tok?.t === "word" && (tok.w === "true" || tok.w === "false")) {
      const v = tok.w === "true";
      return () => v;
    }
    throw new Error(`fake-db: expected an operand at token ${pos - 1}`);
  }

  function comparison(): Predicate {
    const left = operand();
    if (isWord("is")) {
      pos++;
      const negate = isWord("not");
      if (negate) pos++;
      if (!isWord("null")) throw new Error("fake-db: expected null after is");
      pos++;
      return (row) => {
        const v = left(row);
        const isNullish = v === null || v === undefined;
        return negate ? !isNullish : isNullish;
      };
    }
    const notIn = isWord("not");
    if (notIn) pos++;
    if (isWord("in")) {
      pos++;
      expect("(");
      const items: Operand[] = [operand()];
      while (peek()?.t === ",") {
        pos++;
        items.push(operand());
      }
      expect(")");
      return (row) => {
        const v = left(row);
        const hit = items.some((item) => compare("=", v, item(row)));
        return notIn ? !hit : hit;
      };
    }
    const op = peek();
    if (op?.t !== "op") {
      // A bare boolean operand: `where ${t.isSensitive}`.
      return (row) => left(row) === true;
    }
    pos++;
    const right = operand();
    return (row) => compare(op.o, left(row), right(row));
  }

  function primary(): Predicate {
    if (isWord("not")) {
      pos++;
      const inner = primary();
      return (row) => !inner(row);
    }
    if (peek()?.t === "(") {
      pos++;
      const inner = orExpr();
      expect(")");
      return inner;
    }
    return comparison();
  }

  function andExpr(): Predicate {
    const parts = [primary()];
    while (isWord("and")) {
      pos++;
      parts.push(primary());
    }
    return (row) => parts.every((p) => p(row));
  }

  function orExpr(): Predicate {
    const parts = [andExpr()];
    while (isWord("or")) {
      pos++;
      parts.push(andExpr());
    }
    return (row) => parts.some((p) => p(row));
  }

  const predicate = orExpr();
  if (pos !== tokens.length) throw new Error(`fake-db: trailing tokens in condition at ${pos}`);
  return predicate;
}

function toPredicate(condition: unknown, table: Table): Predicate {
  if (condition === undefined) return () => true;
  const tokens: Token[] = [];
  flatten(condition, columnKeyByName(table), tokens);
  return parseCondition(tokens);
}

function sortRows(rows: Row[], orderBy: unknown[], table: Table): Row[] {
  const names = columnKeyByName(table);
  const keys = orderBy.map((expr) => {
    const tokens: Token[] = [];
    flatten(expr, names, tokens);
    const col = tokens[0];
    if (col?.t !== "col") throw new Error("fake-db: orderBy must start with a column");
    const dir = tokens[1];
    return { key: col.key, desc: dir?.t === "word" && dir.w === "desc" };
  });
  return [...rows].sort((a, b) => {
    for (const { key, desc } of keys) {
      const x = comparable(a[key]) as number | string;
      const y = comparable(b[key]) as number | string;
      if (x === y) continue;
      const cmp = x < y ? -1 : 1;
      return desc ? -cmp : cmp;
    }
    return 0;
  });
}

function project(row: Row, fields: Record<string, unknown> | undefined, table: Table): Row {
  const copy = structuredClone(row);
  if (!fields) return copy;
  const names = columnKeyByName(table);
  const out: Row = {};
  for (const [alias, column] of Object.entries(fields)) {
    if (!isColumnLike(column)) throw new Error(`fake-db: unsupported selected field ${alias}`);
    const key = names.get(column.name);
    if (!key) throw new Error(`fake-db: ${column.name} is not on this table`);
    out[alias] = copy[key];
  }
  return out;
}

class UniqueViolation extends Error {
  constructor(
    readonly indexName: string,
    readonly existing: Row,
    readonly columns: string[],
  ) {
    super(`duplicate key value violates unique constraint "${indexName}"`);
  }
}

export interface FakeDbHooks {
  /** Called before each row is stored — throw to simulate a failed write. */
  onInsert?: (tableName: string, row: Row) => void;
  /** Called before an update is applied — throw to simulate a failed write. */
  onUpdate?: (tableName: string, patch: Row) => void;
}

export function createFakeDb(hooks: FakeDbHooks = {}) {
  const store = new Map<string, Row[]>();
  const rowsOf = (table: Table): Row[] => {
    const name = getTableName(table);
    let rows = store.get(name);
    if (!rows) {
      rows = [];
      store.set(name, rows);
    }
    return rows;
  };

  function withDefaults(table: Table, input: Row): Row {
    const row: Row = {};
    for (const [key, column] of Object.entries(getTableColumns(table))) {
      const col = column as unknown as {
        name: string;
        notNull: boolean;
        default?: unknown;
        defaultFn?: () => unknown;
      };
      let value = input[key];
      if (value === undefined) {
        if (col.defaultFn) value = col.defaultFn();
        else if (col.default !== undefined) {
          value = is(col.default, SQL) ? new Date() : structuredClone(col.default);
        } else value = null;
      }
      if (is(value, SQL)) throw new Error(`fake-db: SQL values are not supported (${key})`);
      if (col.notNull && (value === null || value === undefined)) {
        throw new Error(`null value in column "${col.name}" violates not-null constraint`);
      }
      row[key] = value instanceof Date ? new Date(value) : structuredClone(value);
    }
    return row;
  }

  function findViolation(table: Table, candidate: Row, ignore?: Row): UniqueViolation | null {
    const names = columnKeyByName(table);
    for (const index of getTableConfig(table as PgTable).indexes) {
      if (!index.config.unique) continue;
      const cols = index.config.columns.map((c) => {
        const key = names.get((c as unknown as ColumnLike).name);
        if (!key) throw new Error(`fake-db: index ${index.config.name} has an expression column`);
        return key;
      });
      const partial = index.config.where ? toPredicate(index.config.where, table) : () => true;
      if (!partial(candidate)) continue;
      if (cols.some((k) => candidate[k] === null || candidate[k] === undefined)) continue;
      for (const existing of rowsOf(table)) {
        if (existing === ignore || !partial(existing)) continue;
        if (cols.every((k) => comparable(existing[k]) === comparable(candidate[k]))) {
          return new UniqueViolation(index.config.name ?? "unique", existing, cols);
        }
      }
    }
    return null;
  }

  function targetKeys(table: Table, target: unknown): string[] | null {
    if (target === undefined) return null;
    const names = columnKeyByName(table);
    const list = Array.isArray(target) ? target : [target];
    return list.map((c) => names.get((c as ColumnLike).name) ?? "?").sort();
  }

  function applyPatch(table: Table, row: Row, patch: Row): void {
    const columns = getTableColumns(table);
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (!(key in columns)) throw new Error(`fake-db: ${key} is not a column`);
      if (is(value, SQL)) throw new Error(`fake-db: SQL values are not supported in set (${key})`);
      const col = columns[key] as unknown as { notNull: boolean; name: string };
      if (col.notNull && value === null) {
        throw new Error(`null value in column "${col.name}" violates not-null constraint`);
      }
      row[key] = value instanceof Date ? new Date(value) : structuredClone(value);
    }
  }

  const thenable = <T>(run: () => T) => ({
    then<R1 = T, R2 = never>(
      resolve?: ((value: T) => R1 | PromiseLike<R1>) | null,
      reject?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
    ): Promise<R1 | R2> {
      return Promise.resolve().then(run).then(resolve, reject);
    },
  });

  const db = {
    select(fields?: Record<string, unknown>) {
      return {
        from(table: Table) {
          let condition: unknown;
          let order: unknown[] = [];
          let max = Infinity;
          const run = () => {
            const predicate = toPredicate(condition, table);
            let rows = rowsOf(table).filter(predicate);
            if (order.length > 0) rows = sortRows(rows, order, table);
            return rows.slice(0, max).map((r) => project(r, fields, table));
          };
          const query = {
            where(c: unknown) {
              condition = c;
              return query;
            },
            orderBy(...exprs: unknown[]) {
              order = exprs;
              return query;
            },
            limit(n: number) {
              max = n;
              return query;
            },
            ...thenable(run),
          };
          return query;
        },
      };
    },

    insert(table: Table) {
      return {
        values(input: Row | Row[]) {
          const inputs = Array.isArray(input) ? input : [input];
          let conflict:
            | { kind: "nothing"; target: string[] | null }
            | { kind: "update"; target: string[] | null; set: Row }
            | null = null;
          const run = (fields?: Record<string, unknown>) => {
            const written: Row[] = [];
            for (const raw of inputs) {
              const row = withDefaults(table, raw);
              hooks.onInsert?.(getTableName(table), row);
              const violation = findViolation(table, row);
              if (violation) {
                const matches =
                  conflict &&
                  (conflict.target === null ||
                    conflict.target.join(",") === [...violation.columns].sort().join(","));
                if (!conflict || !matches) throw violation;
                if (conflict.kind === "nothing") continue;
                applyPatch(table, violation.existing, conflict.set);
                written.push(violation.existing);
                continue;
              }
              rowsOf(table).push(row);
              written.push(row);
            }
            return written.map((r) => project(r, fields, table));
          };
          const builder = {
            onConflictDoNothing(config: { target?: unknown } = {}) {
              conflict = { kind: "nothing", target: targetKeys(table, config.target) };
              return builder;
            },
            onConflictDoUpdate(config: { target: unknown; set: Row }) {
              conflict = { kind: "update", target: targetKeys(table, config.target), set: config.set };
              return builder;
            },
            returning(fields?: Record<string, unknown>) {
              return thenable(() => run(fields));
            },
            ...thenable(() => {
              run();
              return undefined;
            }),
          };
          return builder;
        },
      };
    },

    update(table: Table) {
      return {
        set(patch: Row) {
          return {
            where(condition: unknown) {
              const run = (fields?: Record<string, unknown>) => {
                hooks.onUpdate?.(getTableName(table), patch);
                const predicate = toPredicate(condition, table);
                const hit = rowsOf(table).filter(predicate);
                for (const row of hit) applyPatch(table, row, patch);
                return hit.map((r) => project(r, fields, table));
              };
              return {
                returning(fields?: Record<string, unknown>) {
                  return thenable(() => run(fields));
                },
                ...thenable(() => {
                  run();
                  return undefined;
                }),
              };
            },
          };
        },
      };
    },
  };

  return {
    db: db as unknown as CommsDb,
    /** The live rows of a table, by SQL name — mutate to set up odd states. */
    rows: (tableName: string): Row[] => store.get(tableName) ?? [],
    /** Insert fixtures directly, with defaults applied and hooks bypassed. */
    seed(table: Table, input: Row[]): Row[] {
      return input.map((raw) => {
        const row = withDefaults(table, raw);
        rowsOf(table).push(row);
        return row;
      });
    },
  };
}
