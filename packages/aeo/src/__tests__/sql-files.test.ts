import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { aeoDdl } from "./pglite.js";

/**
 * THE SHIPPED SQL (0.2.0): sql/aeo-0.2.0.sql builds exactly the tables the
 * code queries; sql/upgrade-0.1-to-0.2.sql turns a 0.1 database into 0.2's —
 * each company's profile taken from its newest question, every row kept —
 * safely twice.
 */

const SQL_DIR = join(__dirname, "..", "..", "sql");
const read = (name: string) => readFileSync(join(SQL_DIR, name), "utf8");

/** 0.1's tables, exactly as 0.1.1 shipped them. */
const V01 = `create table "aeo_queries" (
  "id" text primary key, "tenant_id" text not null, "query" text not null, "brand" text not null, "domain" text,
  "aliases" jsonb not null default '[]'::jsonb, "is_active" boolean not null default true, "created_at" timestamptz not null default now()
);
create index "aeo_queries_tenant_idx" on "aeo_queries" ("tenant_id", "is_active");
create table "aeo_checks" (
  "id" text primary key, "tenant_id" text not null, "query_id" text not null, "engine" text not null, "cited" boolean not null,
  "matched_on" text, "answer_snippet" text, "checked_at" timestamptz not null default now(), "created_at" timestamptz not null default now()
);
create index "aeo_checks_query_idx" on "aeo_checks" ("query_id", "checked_at");`;

async function shapeOf(db: PGlite): Promise<string[]> {
  const columns = await db.query<{ t: string; c: string; ty: string; n: string; d: string | null }>(
    `select table_name as t, column_name as c, data_type as ty, is_nullable as n, column_default as d
       from information_schema.columns where table_name like 'aeo_%' order by table_name, column_name`,
  );
  const indexes = await db.query<{ def: string }>(`select indexdef as def from pg_indexes where tablename like 'aeo_%' order by indexname`);
  return [...columns.rows.map((r) => `${r.t}.${r.c} ${r.ty} ${r.n} ${r.d ?? ""}`), ...indexes.rows.map((r) => r.def)];
}

describe("sql/aeo-0.2.0.sql", () => {
  it("builds the same tables as the schema, and runs twice", async () => {
    const fromFile = new PGlite();
    await fromFile.exec(read("aeo-0.2.0.sql"));
    await fromFile.exec(read("aeo-0.2.0.sql"));
    const fromSchema = new PGlite();
    for (const statement of aeoDdl()) await fromSchema.exec(statement);
    expect(await shapeOf(fromFile)).toEqual(await shapeOf(fromSchema));
    await fromFile.close();
    await fromSchema.close();
  });
});

describe("sql/upgrade-0.1-to-0.2.sql", () => {
  it("makes each company's profile from its newest question, keeps every row, matches 0.2, and runs twice", async () => {
    const db = new PGlite();
    await db.exec(V01);
    await db.exec(`insert into aeo_queries (id, tenant_id, query, brand, domain, created_at) values
      ('q1', 'acme', 'old question', 'Acme Old', null, now() - interval '2 days'),
      ('q2', 'acme', 'new question', 'Acme Ramps', 'acmeramps.com', now()),
      ('q3', 'zen', 'zen question', 'Zen Glass', null, now())`);
    await db.exec(`insert into aeo_checks (id, tenant_id, query_id, engine, cited, matched_on) values ('c1', 'acme', 'q2', 'claude', true, 'brand')`);
    await db.exec(read("upgrade-0.1-to-0.2.sql"));
    await db.exec(read("upgrade-0.1-to-0.2.sql"));
    const fresh = new PGlite();
    await fresh.exec(read("aeo-0.2.0.sql"));
    expect(await shapeOf(db)).toEqual(await shapeOf(fresh));
    const profiles = await db.query<{ tenant_id: string; brand: string; domain: string | null }>(`select tenant_id, brand, domain from aeo_profiles order by tenant_id`);
    expect(profiles.rows).toEqual([
      { tenant_id: "acme", brand: "Acme Ramps", domain: "acmeramps.com" },
      { tenant_id: "zen", brand: "Zen Glass", domain: null },
    ]);
    const checks = await db.query<{ id: string; cited: boolean; mentioned: boolean; status: string }>(`select id, cited, mentioned, status from aeo_checks`);
    expect(checks.rows).toEqual([{ id: "c1", cited: true, mentioned: true, status: "done" }]);
    expect((await db.query(`select id from aeo_queries`)).rows).toHaveLength(3);
    await db.close();
    await fresh.close();
  });
});
