import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertCountedReads } from "@adminigloo/audience/testing";

/**
 * The guard that keeps "internal never counts" true as reports are added.
 *
 * 1. @adminigloo/audience's own `assertCountedReads`, over this package's
 *    src: every FILE that reads the sessions, page-views or events table
 *    either applies the audience's predicate (`countedVisitorSql`) or is
 *    exempt with a written reason.
 * 2. Because that check is per file — one use passes the whole file — a
 *    second, finer check over every non-exempt source file: every FUNCTION
 *    that reads those tables (through `ctx.t`, a 0.1 named export or a
 *    destructuring) goes through one of the three helpers that apply the
 *    predicate. A new report that forgets fails here, by name.
 * 3. A function that calls a helper once passes (2) even if a SECOND query
 *    in it forgets. sql-guard.integration.test.ts closes that: it checks every
 *    statement every report really sends.
 */

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("every read of visitor rows applies the counted predicate", () => {
  it("per file (the audience package's guard)", () => {
    const found = assertCountedReads({
      cwd: PACKAGE_ROOT,
      roots: ["src"],
      tables: [
        // The SQL name, the 0.1 export, the instance's table, and the local alias each file uses for it.
        { sql: "analytics_sessions", js: ["analyticsSessions", "t.sessions", "ctx.t.sessions", "s"] },
        { sql: "analytics_page_views", js: ["analyticsPageViews", "t.pageViews", "ctx.t.pageViews", "p"] },
        { sql: "analytics_events", js: ["analyticsEvents", "t.events", "ctx.t.events", "e"] },
      ],
      predicates: ["countedVisitorSql"],
      exempt: {
        "src/ingest.ts": "the writer: it reads a visit only to append to it (live session, conversion) and to purge by age",
        "src/health.ts": "liveness: 'is anything arriving?' — a staff page view proves the pipeline as well as anyone's",
        "src/reclassify.ts": "rewrites every session's source bucket; it counts nobody, so who is internal is irrelevant",
      },
      expectReaders: ["src/reports.ts", "src/ingest.ts", "src/health.ts", "src/reclassify.ts"],
    });
    expect(found.readers).toEqual(["src/health.ts", "src/ingest.ts", "src/reclassify.ts", "src/reports.ts"]);
  });

  it("per function, in every source file that is not exempt", () => {
    const files = readdirSync(`${PACKAGE_ROOT}/src`).filter((file) => /\.tsx?$/.test(file) && !EXEMPT_FILES.has(file));
    expect(files).toContain("reports.ts");
    const offenders = files.flatMap((file) => uncountedReaders(readFileSync(`${PACKAGE_ROOT}/src/${file}`, "utf8")).offenders.map((name) => `${file}: ${name}`));
    expect(offenders).toEqual([]);
    // Proof the splitter and the detector see the reports at all.
    const problems = uncountedReaders(readFileSync(`${PACKAGE_ROOT}/src/reports.ts`, "utf8"));
    for (const name of ["totals", "getDailyTrend", "getTopPages", "getTopClicks", "getEventVisits", "getWebVitals", "getAiAssistantTraffic", "getSources"]) {
      expect(problems.readers).toContain(name);
    }
  });

  it("the per-function check catches a report that forgets (negative control)", () => {
    const forgetful = [
      "export async function getGood(ctx, q) {",
      "  const s = ctx.t.sessions;",
      "  return ctx.db.select().from(s).where(sessionWindow(ctx, q, q));",
      "}",
      "",
      "export async function getForgetful(ctx, q) {",
      "  const p = ctx.t.pageViews;",
      "  return ctx.db.select().from(p).where(eq(p.tenantId, q.tenantId));",
      "}",
      "",
      "export function unrelated() {",
      "  return 1;",
      "}",
    ].join("\n");
    expect(uncountedReaders(forgetful)).toEqual({ readers: ["getGood", "getForgetful"], offenders: ["getForgetful"] });
  });

  it("sees a report that reads a table without going through ctx.t (negative control)", () => {
    const sneaky = [
      'import { analyticsSessions } from "./schema.js";',
      "export async function getImported(ctx, q) {",
      "  return ctx.db.select().from(analyticsSessions).where(eq(analyticsSessions.tenantId, q.tenantId));",
      "}",
      "",
      "export async function getDestructured(ctx, q) {",
      "  const { events: e } = ctx.t;",
      "  return ctx.db.select().from(e);",
      "}",
      "",
      "export async function getFromTables(ctx, q) {",
      "  const tables = ctx.t;",
      "  return ctx.db.select().from(tables.pageViews);",
      "}",
    ].join("\n");
    expect(uncountedReaders(sneaky)).toEqual({
      readers: ["getImported", "getDestructured", "getFromTables"],
      offenders: ["getImported", "getDestructured", "getFromTables"],
    });
  });
});

/** Files whose reads are exempt in the per-file guard above (same reasons). */
const EXEMPT_FILES = new Set(["ingest.ts", "health.ts", "reclassify.ts"]);

/** The helpers that apply the audience's predicate — and are the predicate, so they are not themselves checked. */
const PREDICATE_HELPERS = ["countedSessions", "countedThroughSession", "sessionWindow"];
/**
 * Any way source can name a visitor table: the instance's (`t.sessions`,
 * `ctx.t.events`, `tables.pageViews`), the 0.1 named exports
 * (`analyticsSessions`…), or a destructuring of `ctx.t`. A per-function check
 * only — the per-STATEMENT check, which no way of writing the source can
 * dodge, is sql-guard.integration.test.ts.
 */
const TOUCHES_VISITOR_TABLES =
  /\b(?:t|tables)\.(?:sessions|pageViews|events)\b|\banalytics(?:Sessions|PageViews|Events)\b|\{[^}]*\b(?:sessions|pageViews|events)\b[^}]*\}\s*=\s*(?:ctx\.)?t\b/;
/** …and runs a query: a builder `.from(` or a raw `from ${table}` / `join ${table}`. (Defining a table or naming it is not a read.) */
const RUNS_A_QUERY = /\.from\(|\.innerJoin\(|\.leftJoin\(|\b(?:from|join) \$\{/i;

/** Top-level functions (by name) that read the visitor tables, and those of them that never call a predicate helper. */
function uncountedReaders(source: string): { readers: string[]; offenders: string[] } {
  const starts = [...source.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)];
  const readers: string[] = [];
  const offenders: string[] = [];
  starts.forEach((match, i) => {
    const name = match[1]!;
    const body = source.slice(match.index, starts[i + 1]?.index ?? source.length);
    if (PREDICATE_HELPERS.includes(name) || !TOUCHES_VISITOR_TABLES.test(body) || !RUNS_A_QUERY.test(body)) return;
    readers.push(name);
    if (!PREDICATE_HELPERS.some((helper) => body.includes(`${helper}(`))) offenders.push(name);
  });
  return { readers, offenders };
}
