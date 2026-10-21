import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { defineAnalyticsTables } from "../schema.js";
import { analyticsDdl } from "./pglite.js";

/**
 * THE SHIPPED SQL (0.3.0): sql/analytics-0.3.0.sql builds exactly the tables
 * the code queries (the same columns, types, defaults and indexes the schema
 * generates), and sql/upgrade-0.2-to-0.3.sql turns a 0.2 database into 0.3's
 * without touching a row — safely twice.
 */

const SQL_DIR = join(__dirname, "..", "..", "sql");
const read = (name: string) => readFileSync(join(SQL_DIR, name), "utf8");

async function shapeOf(db: PGlite): Promise<string[]> {
  const columns = await db.query<{ t: string; c: string; ty: string; n: string; d: string | null }>(
    `select table_name as t, column_name as c, data_type as ty, is_nullable as n, column_default as d
       from information_schema.columns where table_name like 'analytics_%' order by table_name, column_name`,
  );
  const indexes = await db.query<{ i: string; def: string }>(`select indexname as i, indexdef as def from pg_indexes where tablename like 'analytics_%' order by indexname`);
  return [...columns.rows.map((r) => `${r.t}.${r.c} ${r.ty} ${r.n} ${r.d ?? ""}`), ...indexes.rows.map((r) => r.def)];
}

describe("sql/analytics-0.4.0.sql", () => {
  it("builds the same tables as the schema, and runs twice", async () => {
    const fromFile = new PGlite();
    await fromFile.exec(read("analytics-0.4.0.sql"));
    await fromFile.exec(read("analytics-0.4.0.sql"));
    const fromSchema = new PGlite();
    for (const statement of analyticsDdl(defineAnalyticsTables())) await fromSchema.exec(statement);
    expect(await shapeOf(fromFile)).toEqual(await shapeOf(fromSchema));
    await fromFile.close();
    await fromSchema.close();
  });
});

describe("sql/upgrade-0.3-to-0.4.sql", () => {
  it("adds import_key and its index to a 0.3 database, keeps every row, and runs twice", async () => {
    const db = new PGlite();
    await db.exec(read("analytics-0.3.0.sql"));
    await db.exec(`insert into analytics_sessions (id, tenant_id, visitor_key, landing_path, source_bucket) values ('s1', 'site', 'k1', '/', 'direct')`);
    await db.exec(read("upgrade-0.3-to-0.4.sql"));
    await db.exec(read("upgrade-0.3-to-0.4.sql"));
    const fresh = new PGlite();
    await fresh.exec(read("analytics-0.4.0.sql"));
    expect(await shapeOf(db)).toEqual(await shapeOf(fresh));
    const rows = await db.query<{ id: string; import_key: string | null }>(`select id, import_key from analytics_sessions`);
    expect(rows.rows).toEqual([{ id: "s1", import_key: null }]);
    await db.close();
    await fresh.close();
  });
});

describe("sql/upgrade-0.2-to-0.3.sql", () => {
  it("adds the site column and the register to a 0.2 database, keeps every row, and runs twice", async () => {
    const db = new PGlite();
    // 0.2's tables: today's file without the two 0.3 additions.
    const v03 = read("analytics-0.3.0.sql");
    const v02 = v03
      .replace(/,\n {2}"site_id" text\n/, "\n")
      .replace(/create index if not exists "analytics_sessions_tenant_site_idx"[^;]*;/, "")
      .replace(/create table if not exists "analytics_websites" \([^;]*\);/, "")
      .replace(/create (unique )?index if not exists "analytics_websites_[a-z_]+" on "analytics_websites"[^;]*;/g, "");
    expect(v02).not.toContain("site_id");
    expect(v02).not.toContain("analytics_websites");
    await db.exec(v02);
    await db.exec(`insert into analytics_sessions (id, tenant_id, visitor_key, landing_path, source_bucket) values ('s1', 'site', 'k1', '/', 'direct')`);
    await db.exec(read("upgrade-0.2-to-0.3.sql"));
    await db.exec(read("upgrade-0.2-to-0.3.sql"));
    const fresh = new PGlite();
    await fresh.exec(v03);
    expect(await shapeOf(db)).toEqual(await shapeOf(fresh));
    const rows = await db.query<{ id: string; site_id: string | null }>(`select id, site_id from analytics_sessions`);
    expect(rows.rows).toEqual([{ id: "s1", site_id: null }]);
    await db.close();
    await fresh.close();
  });
});
