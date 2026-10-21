import { sql } from "drizzle-orm";
import { check, integer, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { companyRowCounts, forgetReport, plantCompanyRows } from "../forget.js";
import { createPgliteDb, type PgliteTestDb } from "../pglite.js";

/**
 * The forget proof's own proof: on a small schema shaped like the packages'
 * (a companies table, company tables with required columns, a unique key, a
 * check, an enum, a child with no tenant_id, a grandchild, a table that
 * points at a person), a correct forget leaves nothing of A's and all of
 * B's — and the two mistakes it exists to catch are caught by name: a delete
 * with its company filter removed, and a table the forget never touched.
 */
const kind = pgEnum("forget_kind", ["one", "two"]);
const tenants = pgTable("tenants", { id: text("id").primaryKey(), name: text("name").notNull() });
const people = pgTable("people", { id: text("id").primaryKey(), email: text("email").notNull() });
const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "restrict" }),
    number: integer("number").notNull(),
    kind: kind("kind").notNull(),
    when: timestamp("when", { withTimezone: true }).notNull(),
    personId: text("person_id").notNull().references(() => people.id),
  },
  (t) => [uniqueIndex("jobs_number_idx").on(t.tenantId, t.number), check("jobs_number_positive", sql`${t.number} > 0`)],
);
const jobLines = pgTable("job_lines", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => jobs.id),
  quantity: integer("quantity").notNull(),
});
const lineNotes = pgTable("line_notes", {
  id: text("id").primaryKey(),
  lineId: text("line_id").notNull().references(() => jobLines.id),
  body: text("body").notNull(),
});
const settings = pgTable(
  "settings",
  { tenantId: text("tenant_id").notNull(), key: text("key").notNull(), value: text("value") },
  (t) => [primaryKey({ columns: [t.tenantId, t.key] })],
);
const audit = pgTable("audit", { id: text("id").primaryKey(), tenantId: text("tenant_id"), what: text("what").notNull() });
/** One row per company, made when the company was (its settings). */
const prefs = pgTable("prefs", { id: text("id").primaryKey(), tenantId: text("tenant_id").notNull(), theme: text("theme").notNull() }, (t) => [
  uniqueIndex("prefs_tenant_idx").on(t.tenantId),
]);
const schema = { kind, tenants, people, jobs, jobLines, lineNotes, settings, audit, prefs };

let t: PgliteTestDb<typeof schema>;
beforeEach(async () => {
  t = await createPgliteDb({ schema, logQueries: false });
  await t.db.insert(tenants).values([
    { id: "co_a", name: "A" },
    { id: "co_b", name: "B" },
  ]);
});
afterEach(async () => {
  await t.close();
});

/** A correct forget: children first, every table, only A's. */
async function forgetRight(tenantId: string, opts: { skip?: string; unfiltered?: string } = {}) {
  const where = (table: string) => (opts.unfiltered === table ? sql`true` : sql`tenant_id = ${tenantId}`);
  const jobsOf = sql`select id from jobs where ${where("jobs")}`;
  if (opts.skip !== "line_notes") {
    await t.db.execute(sql`delete from line_notes where line_id in (select id from job_lines where job_id in (${jobsOf}))`);
  }
  if (opts.skip !== "job_lines") await t.db.execute(sql`delete from job_lines where job_id in (${jobsOf})`);
  if (opts.skip !== "jobs") await t.db.execute(sql`delete from jobs where ${where("jobs")}`);
  if (opts.skip !== "settings") await t.db.execute(sql`delete from settings where ${where("settings")}`);
  await t.db.execute(sql`delete from prefs where tenant_id = ${tenantId}`);
}

describe("plantCompanyRows", () => {
  it("plants one row per company in every company table and every table hanging off one, parents first", async () => {
    const planted = await plantCompanyRows(t.db, ["co_a", "co_b"]);
    expect(planted.companyTables).toEqual(["audit", "jobs", "prefs", "settings"]);
    expect(planted.childTables).toEqual(["job_lines", "line_notes"]);
    expect(planted.rows.filter((r) => r.tenantId === "co_a").map((r) => r.table).sort()).toEqual(
      ["audit", "job_lines", "jobs", "line_notes", "prefs", "settings"],
    );
    // The child points at ITS company's parent.
    for (const row of planted.rows.filter((r) => r.table === "job_lines")) {
      const found = (await t.db.execute(sql`select j.tenant_id from job_lines l join jobs j on j.id = l.job_id where l.id = ${String(row.match["id"])}`)) as unknown as {
        rows: Record<string, unknown>[];
      };
      expect(found.rows[0]?.["tenant_id"]).toBe(row.tenantId);
    }
  });
});

describe("plantCompanyRows with a company's one-row table already filled", () => {
  it("plants the company's existing row instead of failing on its unique key", async () => {
    await t.db.insert(prefs).values({ id: "p-a", tenantId: "co_a", theme: "dark" });
    const planted = await plantCompanyRows(t.db, ["co_a", "co_b"]);
    const prefRows = planted.rows.filter((r) => r.table === "prefs");
    expect(prefRows.map((r) => [r.tenantId, r.match["id"] === "p-a"])).toEqual([
      ["co_a", true],
      ["co_b", false],
    ]);
  });
});

describe("forgetReport", () => {
  it("is clean for a forget that takes all of A's and none of B's (the kept table named)", async () => {
    const planted = await plantCompanyRows(t.db, ["co_a", "co_b"]);
    const before = await companyRowCounts(t.db, ["co_a", "co_b"]);
    await forgetRight("co_a");
    const report = await forgetReport(t.db, planted, { forgotten: "co_a", kept: { audit: "the record of the deletion" }, before });
    expect(report).toEqual({ left: [], lost: [], kept: ["audit"], unknownKept: [] });
  });

  it("NEGATIVE CONTROL: a delete with its company filter removed is caught — B's rows went too", async () => {
    const planted = await plantCompanyRows(t.db, ["co_a", "co_b"]);
    const before = await companyRowCounts(t.db, ["co_a", "co_b"]);
    await forgetRight("co_a", { unfiltered: "settings" });
    const report = await forgetReport(t.db, planted, { forgotten: "co_a", kept: { audit: "x" }, before });
    expect(report.lost).toEqual(["settings"]);
  });

  it("NEGATIVE CONTROL: a table the forget never touched is caught — A's rows are left, child tables too", async () => {
    const planted = await plantCompanyRows(t.db, ["co_a", "co_b"]);
    await forgetRight("co_a", { skip: "settings" });
    expect((await forgetReport(t.db, planted, { forgotten: "co_a", kept: { audit: "x" } })).left).toEqual(["settings"]);
    await t.db.execute(sql`delete from settings where tenant_id = 'co_a'`);
    // A grandchild left behind is caught too (its parent row is gone, its own row isn't).
    const again = await plantCompanyRows(t.db, ["co_a", "co_b"]);
    await t.db.execute(sql`alter table line_notes drop constraint if exists line_notes_line_id_job_lines_id_fk`);
    await forgetRight("co_a", { skip: "line_notes" });
    expect((await forgetReport(t.db, again, { forgotten: "co_a", kept: { audit: "x" } })).left).toEqual(["line_notes"]);
  });

  it("names a kept table that doesn't exist", async () => {
    const planted = await plantCompanyRows(t.db, ["co_a", "co_b"]);
    await forgetRight("co_a");
    const report = await forgetReport(t.db, planted, { forgotten: "co_a", kept: { audit: "x", old_table: "gone" } });
    expect(report.unknownKept).toEqual(["old_table"]);
  });
});
