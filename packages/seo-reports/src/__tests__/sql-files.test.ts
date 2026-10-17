import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { seoReportsDdl } from "./pglite.js";

/**
 * THE SHIPPED SQL (0.2.0): sql/seo-reports-0.2.0.sql builds exactly the table
 * the code queries, and sql/upgrade-0.1-to-0.2.sql turns a 0.1 database into
 * 0.2's — every 0.1 report kept, as the site's own ('*') — safely twice.
 */

const SQL_DIR = join(__dirname, "..", "..", "sql");
const read = (name: string) => readFileSync(join(SQL_DIR, name), "utf8");

/** 0.1's table, exactly as 0.1.0 shipped it. */
const V01 = `create table "seo_reports" (
  "id" text primary key,
  "base_url" text not null,
  "started_at" timestamptz not null,
  "finished_at" timestamptz not null,
  "score" integer not null,
  "seo_score" integer not null,
  "aeo_score" integer not null,
  "page_count" integer not null,
  "site_checks" jsonb not null,
  "pages" jsonb not null,
  "created_at" timestamptz not null default now()
);`;

async function shapeOf(db: PGlite): Promise<string[]> {
  const columns = await db.query<{ c: string; ty: string; n: string; d: string | null }>(
    `select column_name as c, data_type as ty, is_nullable as n, column_default as d
       from information_schema.columns where table_name = 'seo_reports' order by column_name`,
  );
  const indexes = await db.query<{ def: string }>(`select indexdef as def from pg_indexes where tablename = 'seo_reports' order by indexname`);
  return [...columns.rows.map((r) => `${r.c} ${r.ty} ${r.n} ${r.d ?? ""}`), ...indexes.rows.map((r) => r.def)];
}

describe("sql/seo-reports-0.2.0.sql", () => {
  it("builds the same table as the schema, and runs twice", async () => {
    const fromFile = new PGlite();
    await fromFile.exec(read("seo-reports-0.2.0.sql"));
    await fromFile.exec(read("seo-reports-0.2.0.sql"));
    const fromSchema = new PGlite();
    for (const statement of seoReportsDdl()) await fromSchema.exec(statement);
    expect(await shapeOf(fromFile)).toEqual(await shapeOf(fromSchema));
    await fromFile.close();
    await fromSchema.close();
  });
});

describe("sql/upgrade-0.1-to-0.2.sql", () => {
  it("gives every 0.1 report to the site's own checks, keeps it, matches 0.2, and runs twice", async () => {
    const db = new PGlite();
    await db.exec(V01);
    await db.exec(
      `insert into seo_reports (id, base_url, started_at, finished_at, score, seo_score, aeo_score, page_count, site_checks, pages)
       values ('r1', 'https://example.com', now(), now(), 80, 70, 90, 3,
         '[{"id":"site.robots","status":"pass"},{"id":"site.llms-txt","status":"fail"}]',
         '[{"path":"/","checks":[{"id":"page.title","status":"pass"},{"id":"page.og","status":"warn"},{"id":"page.h1","status":"pass"}]}]')`,
    );
    await db.exec(read("upgrade-0.1-to-0.2.sql"));
    await db.exec(read("upgrade-0.1-to-0.2.sql"));
    const fresh = new PGlite();
    await fresh.exec(read("seo-reports-0.2.0.sql"));
    expect(await shapeOf(db)).toEqual(await shapeOf(fresh));
    const rows = await db.query<{ id: string; tenant_id: string; status: string; score: number; pass_count: number; warn_count: number; fail_count: number }>(
      `select id, tenant_id, status, score, pass_count, warn_count, fail_count from seo_reports`,
    );
    // The counts are worked out from 0.1's stored verdicts (review L8).
    expect(rows.rows).toEqual([{ id: "r1", tenant_id: "*", status: "done", score: 80, pass_count: 3, warn_count: 1, fail_count: 1 }]);
    // A new row must name its company: no default is left behind.
    await expect(
      db.exec(`insert into seo_reports (id, base_url, started_at, finished_at, score, seo_score, aeo_score, page_count, site_checks, pages) values ('r2', 'x', now(), now(), 0, 0, 0, 0, '[]', '[]')`),
    ).rejects.toThrow();
    await db.close();
    await fresh.close();
  });
});
