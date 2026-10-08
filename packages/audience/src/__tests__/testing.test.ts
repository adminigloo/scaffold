import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertCountedReads, findCountedReadProblems, readsCountedTables } from "../testing.js";

/**
 * The source guard, against a throwaway app tree shaped like Riddler Go's:
 * a reader that uses the predicate, one that forgets it, one exempt with a
 * reason, prose that must not trip it, and directories it must not enter.
 */

const TABLES = ["analytics_sessions", "page_views", "session_events"];
const PREDICATES = ["countedVisitorSql", /\binWindow\(/];

let root: string;
function write(rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "aig-audience-guard-"));
  write(
    "lib/analytics/queries.ts",
    "const k = sql`SELECT count(*) FROM analytics_sessions s WHERE ${inWindow(w)}`;\nconst v = sql`SELECT 1 FROM session_events e JOIN analytics_sessions s ON s.id = e.analytics_session_id`;",
  );
  write("lib/analytics/top-pages.ts", 'import { pageViews as pv } from "@/db/schema/analytics";\nexport const q = db.select().from(pv).where(countedVisitorSql("s.visitor_id"));');
  write("app/admin/page.tsx", "export default async function Page() { return db.select().from(analyticsSessions); }");
  write("lib/tracking/server-events.ts", "await dbc.insert(sessionEvents).values(x);\nconst [row] = await dbc.select().from(analyticsSessions).where(eq(analyticsSessions.visitorId, id));");
  write("lib/analytics/digest.ts", "// the digest counts analytics sessions from the last week\nexport const words = 'FROM the analytics_sessions_archive';");
  write("lib/analytics/__tests__/queries.test.ts", "db.select().from(analyticsSessions)");
  write("lib/analytics/raw.test.ts", "SELECT * FROM page_views");
  write("node_modules/pkg/index.ts", "db.select().from(analyticsSessions)");
  write("lib/types.d.ts", "declare const x: typeof analyticsSessions; // FROM analytics_sessions");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("readsCountedTables", () => {
  it("sees builder reads, aliases, interpolated and raw SQL — and ignores prose and lookalikes", () => {
    expect(readsCountedTables("db.select().from(analyticsSessions).where(x)", TABLES)).toBe(true);
    expect(readsCountedTables(".leftJoin(pageViews, eq(a, b))", TABLES)).toBe(true);
    expect(readsCountedTables('import { sessionEvents as se } from "@/db";\n db.select().from(se)', TABLES)).toBe(true);
    expect(readsCountedTables("sql`select count(*) from ${analyticsSessions} where x`", TABLES)).toBe(true);
    expect(readsCountedTables("sql`SELECT 1 FROM page_views WHERE x`", TABLES)).toBe(true);
    expect(readsCountedTables('sql`SELECT 1 FROM "session_events" e`', TABLES)).toBe(true);
    expect(readsCountedTables("// counts analytics sessions from the page views", TABLES)).toBe(false);
    expect(readsCountedTables("db.select().from(analyticsSessionsArchive)", TABLES)).toBe(false);
    expect(readsCountedTables("sql`SELECT 1 FROM page_views_daily`", TABLES)).toBe(false);
    expect(readsCountedTables("db.insert(analyticsSessions).values(x)", TABLES)).toBe(false);
  });

  it("takes explicit SQL and JS names", () => {
    expect(readsCountedTables("db.select().from(rgSessions)", [{ sql: "analytics_sessions", js: ["rgSessions"] }])).toBe(true);
    expect(readsCountedTables("SELECT 1 FROM analytics_sessions", [{ js: ["rgSessions"] }])).toBe(false);
  });
});

describe("assertCountedReads", () => {
  it("passes when every reader uses the predicate or is exempt with a reason", () => {
    const found = assertCountedReads({
      cwd: root,
      roots: ["app", "lib"],
      tables: TABLES,
      predicates: PREDICATES,
      exempt: {
        "app/admin/page.tsx": "the platform-health card counts raw ingest volume on purpose",
        "lib/tracking/server-events.ts": "the writer: reads the visitor's own session to bucket an event",
      },
      expectReaders: ["lib/analytics/queries.ts"],
      minReaders: 4,
    });
    expect(found.readers).toEqual([
      "app/admin/page.tsx",
      "lib/analytics/queries.ts",
      "lib/analytics/top-pages.ts",
      "lib/tracking/server-events.ts",
    ]);
  });

  it("fails naming the file that forgot the predicate", () => {
    expect(() =>
      assertCountedReads({
        cwd: root,
        roots: ["app", "lib"],
        tables: TABLES,
        predicates: PREDICATES,
        exempt: { "lib/tracking/server-events.ts": "the writer reads its own session" },
      }),
    ).toThrow(/app\/admin\/page\.tsx/);
  });

  it("flags stale exemptions, reasons too short to mean anything, and a detector that found nothing", () => {
    const problems = findCountedReadProblems({
      cwd: root,
      roots: ["app", "lib"],
      tables: TABLES,
      predicates: PREDICATES,
      exempt: {
        "app/admin/page.tsx": "ok",
        "lib/tracking/server-events.ts": "the writer reads its own session",
        "lib/gone.ts": "this file was deleted last sprint",
        "lib/analytics/digest.ts": "used to read sessions, no longer does",
      },
      expectReaders: ["lib/reports/event-summary.ts"],
      minReaders: 10,
    });
    expect(problems.offenders).toEqual([]);
    expect(problems.stale.sort()).toEqual(["lib/analytics/digest.ts", "lib/gone.ts"]);
    expect(problems.weakReasons).toEqual(["app/admin/page.tsx"]);
    expect(problems.missingReaders).toEqual(["lib/reports/event-summary.ts"]);
    expect(problems.tooFewReaders).toEqual({ found: 4, required: 10 });
  });

  it("can include test files when asked, and refuses an empty configuration", () => {
    const withTests = findCountedReadProblems({ cwd: root, roots: ["lib"], tables: TABLES, predicates: PREDICATES, includeTests: true, skipDirs: ["node_modules"] });
    expect(withTests.readers).toContain("lib/analytics/__tests__/queries.test.ts");
    expect(withTests.readers).toContain("lib/analytics/raw.test.ts");
    expect(() => findCountedReadProblems({ cwd: root, roots: [], tables: TABLES, predicates: PREDICATES })).toThrow(/root/);
    expect(() => findCountedReadProblems({ cwd: root, roots: ["lib"], tables: [], predicates: PREDICATES })).toThrow(/table/);
    expect(() => findCountedReadProblems({ cwd: root, roots: ["lib"], tables: TABLES, predicates: [] })).toThrow(/predicate/);
    expect(() => findCountedReadProblems({ cwd: root, roots: ["nope"], tables: TABLES, predicates: PREDICATES })).toThrow(/does not exist/);
  });
});
