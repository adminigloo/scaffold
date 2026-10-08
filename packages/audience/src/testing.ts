import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

/**
 * @adminigloo/audience/testing — the guard that keeps "internal never counts"
 * true as an app grows.
 *
 * An exclusion is only as good as the read that forgets it. Riddler Go's
 * Play Along rule (`lib/__tests__/host-play-exclusion.test.ts`) learned this:
 * a fixed list of files cannot catch the read the NEXT feature adds, so the
 * test scans the source for every file that reads the counted tables and
 * requires each one to either use the predicate or carry a written reason in
 * an exemption list. This is that test, generalised:
 *
 *   import { assertCountedReads } from "@adminigloo/audience/testing";
 *
 *   it("every analytics read leaves internal traffic out", () => {
 *     assertCountedReads({
 *       roots: ["app", "lib"],
 *       tables: ["analytics_sessions", "page_views", "session_events"],
 *       predicates: ["countedVisitorSql", "countedSubjectSql"],
 *       exempt: { "lib/analytics/ingest.ts": "the writer itself; it reads its own session to bucket a visit" },
 *       expectReaders: ["lib/analytics/queries.ts"],
 *     });
 *   });
 *
 * Name only the package's own functions as predicates, never the app's
 * helper (`inWindow(`): the helper's definition contains its own name, so the
 * file that defines it would pass even after the helper stopped calling the
 * package. The check is PER FILE: one use of the predicate passes the whole
 * file, so a second query in it that forgets the predicate is not caught.
 *
 * Framework-free: it throws an Error listing every problem, which fails
 * vitest, jest and node:test alike. `findCountedReadProblems` returns the same
 * findings without throwing.
 */

export interface CountedTable {
  /** The SQL name, matched in raw SQL (`FROM analytics_sessions`). */
  sql?: string;
  /** JS identifiers the table is imported as (`analyticsSessions`), matched in builder reads. */
  js?: readonly string[];
}

export interface AssertCountedReadsOptions {
  /** Directories to scan, relative to `cwd` (or absolute). */
  roots: readonly string[];
  /**
   * The counted tables. A string is a SQL name AND its camelCase identifier
   * ("analytics_sessions" also matches `analyticsSessions`).
   */
  tables: ReadonlyArray<string | CountedTable>;
  /** Evidence a file applies the exclusion: substrings or regular expressions. Any one is enough. */
  predicates: ReadonlyArray<string | RegExp>;
  /** path (relative to cwd, forward slashes) → why this file may read the tables without the predicate. */
  exempt?: Readonly<Record<string, string>>;
  /** Files that MUST be found as readers — proof the detector is not matching nothing. */
  expectReaders?: readonly string[];
  /** Fail when fewer readers than this are found. */
  minReaders?: number;
  /** Default process.cwd(). */
  cwd?: string;
  /** Default [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]. */
  extensions?: readonly string[];
  /** Directory names never entered. Default node_modules, .next, dist, build, coverage, .git, __tests__. */
  skipDirs?: readonly string[];
  /** Include test files (*.test.*, *.spec.*). Default false. */
  includeTests?: boolean;
  /** Shortest acceptable exemption reason. Default 10 characters. */
  minReasonLength?: number;
}

export interface CountedReadProblems {
  /** Every file found reading a counted table. */
  readers: string[];
  /** Readers with no predicate and no exemption. */
  offenders: string[];
  /** Exemptions naming a file that is missing or no longer reads the tables. */
  stale: string[];
  /** Exemptions whose reason is too short to mean anything. */
  weakReasons: string[];
  /** `expectReaders` the scan did not find. */
  missingReaders: string[];
  /** Set when fewer readers were found than `minReaders`. */
  tooFewReaders: { found: number; required: number } | null;
}

const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
const DEFAULT_SKIP = ["node_modules", ".next", "dist", "build", "coverage", ".git", "__tests__"];

function camel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface NormalizedTable {
  sql: string | null;
  js: string[];
}

function normalizeTables(tables: AssertCountedReadsOptions["tables"]): NormalizedTable[] {
  return tables.map((table) => {
    if (typeof table === "string") {
      const js = new Set([camel(table)]);
      if (/^[A-Za-z_$][\w$]*$/.test(table)) js.add(table);
      return { sql: table, js: [...js] };
    }
    return { sql: table.sql ?? null, js: [...(table.js ?? [])] };
  });
}

/**
 * Does this source read any of the tables?
 *
 * Query-builder reads (`.from(analyticsSessions)`, `.innerJoin(pageViews, …)`,
 * including an import alias such as `analyticsSessions as s`) and raw SQL
 * (`from ${analyticsSessions}`, `FROM analytics_sessions`, `JOIN "page_views"`).
 * Raw SQL keywords are matched in CAPITALS or as a template interpolation,
 * so prose in a comment ("counts sessions from …") does not trip it — the
 * same trade Riddler Go's guard makes.
 */
export function readsCountedTables(source: string, tables: AssertCountedReadsOptions["tables"]): boolean {
  const normalized = normalizeTables(tables);
  const names = new Set<string>();
  for (const table of normalized) for (const js of table.js) names.add(js);
  for (const name of [...names]) {
    for (const match of source.matchAll(new RegExp(`\\b${escapeRe(name)}\\s+as\\s+([A-Za-z_$][\\w$]*)`, "g"))) {
      if (match[1]) names.add(match[1]);
    }
  }
  if (names.size) {
    const alt = [...names].map(escapeRe).join("|");
    const builder = new RegExp(`\\.(?:from|innerJoin|leftJoin|rightJoin|fullJoin|crossJoin)\\(\\s*(?:${alt})\\s*[,)]`);
    const interpolated = new RegExp(`\\b(?:from|join)\\s+\\$\\{\\s*(?:${alt})\\s*\\}`, "i");
    if (builder.test(source) || interpolated.test(source)) return true;
  }
  const sqlNames = normalized.map((table) => table.sql).filter((name): name is string => !!name);
  if (sqlNames.length) {
    const raw = new RegExp(`\\b(?:FROM|JOIN)\\s+[\`"]?(?:${sqlNames.map(escapeRe).join("|")})[\`"]?(?![\\w$])`);
    if (raw.test(source)) return true;
  }
  return false;
}

function usesPredicate(source: string, predicates: AssertCountedReadsOptions["predicates"]): boolean {
  return predicates.some((predicate) => (typeof predicate === "string" ? source.includes(predicate) : predicate.test(source)));
}

function* walk(dir: string, extensions: readonly string[], skip: ReadonlySet<string>, includeTests: boolean): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (skip.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full, extensions, skip, includeTests);
    else if (extensions.some((ext) => entry.endsWith(ext)) && !entry.endsWith(".d.ts")) {
      if (!includeTests && /\.(test|spec)\.[cm]?[jt]sx?$/.test(entry)) continue;
      yield full;
    }
  }
}

export function findCountedReadProblems(options: AssertCountedReadsOptions): CountedReadProblems {
  if (!options.roots.length) throw new Error("assertCountedReads: give at least one root to scan.");
  if (!options.tables.length) throw new Error("assertCountedReads: name at least one table.");
  if (!options.predicates.length) throw new Error("assertCountedReads: name at least one predicate.");
  const cwd = options.cwd ?? process.cwd();
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
  const skip = new Set(options.skipDirs ?? DEFAULT_SKIP);
  const exempt = options.exempt ?? {};
  const minReason = options.minReasonLength ?? 10;

  const files: Array<{ rel: string; source: string }> = [];
  for (const root of options.roots) {
    const dir = isAbsolute(root) ? root : join(cwd, root);
    if (!existsSync(dir)) throw new Error(`assertCountedReads: root "${root}" does not exist under ${cwd}.`);
    for (const file of walk(dir, extensions, skip, options.includeTests ?? false)) {
      files.push({ rel: relative(cwd, file).replace(/\\/g, "/"), source: readFileSync(file, "utf8") });
    }
  }
  const readers = files.filter((file) => readsCountedTables(file.source, options.tables));
  const readerSet = new Set(readers.map((reader) => reader.rel));
  const offenders = readers
    .filter((reader) => !usesPredicate(reader.source, options.predicates) && !(reader.rel in exempt))
    .map((reader) => reader.rel);
  const stale = Object.keys(exempt).filter((rel) => {
    if (readerSet.has(rel)) return false;
    const full = join(cwd, rel);
    if (!existsSync(full)) return true;
    return !readsCountedTables(readFileSync(full, "utf8"), options.tables);
  });
  const weakReasons = Object.entries(exempt)
    .filter(([, reason]) => typeof reason !== "string" || reason.trim().length < minReason)
    .map(([rel]) => rel);
  const missingReaders = (options.expectReaders ?? []).filter((rel) => !readerSet.has(rel));
  const tooFewReaders =
    options.minReaders !== undefined && readers.length < options.minReaders
      ? { found: readers.length, required: options.minReaders }
      : null;
  return { readers: [...readerSet].sort(), offenders, stale, weakReasons, missingReaders, tooFewReaders };
}

/** Throws (failing the test) when any read of the counted tables skips the predicate without a reason. */
export function assertCountedReads(options: AssertCountedReadsOptions): CountedReadProblems {
  const found = findCountedReadProblems(options);
  const lines: string[] = [];
  if (found.offenders.length) {
    lines.push(
      `These files read ${describe(options.tables)} without the counted predicate (${options.predicates
        .map(String)
        .join(", ")}). Use it, or add the file to \`exempt\` with the reason internal rows cannot skew it:`,
      ...found.offenders.map((rel) => `  - ${rel}`),
    );
  }
  if (found.stale.length) {
    lines.push("These exemptions name a file that is gone or no longer reads the tables (a stale entry exempts whatever lands there next):", ...found.stale.map((rel) => `  - ${rel}`));
  }
  if (found.weakReasons.length) {
    lines.push("These exemptions need a real reason:", ...found.weakReasons.map((rel) => `  - ${rel}`));
  }
  if (found.missingReaders.length) {
    lines.push("The scan did not find these expected readers — the detector may be matching nothing:", ...found.missingReaders.map((rel) => `  - ${rel}`));
  }
  if (found.tooFewReaders) {
    lines.push(`Only ${found.tooFewReaders.found} readers found; expected at least ${found.tooFewReaders.required}.`);
  }
  if (lines.length) throw new Error(`assertCountedReads failed:\n${lines.join("\n")}`);
  return found;
}

function describe(tables: AssertCountedReadsOptions["tables"]): string {
  return tables.map((table) => (typeof table === "string" ? table : (table.sql ?? table.js?.[0] ?? "?"))).join(", ");
}
