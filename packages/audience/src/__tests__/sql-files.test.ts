import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { defineAudienceTables } from "../schema.js";
import { audienceDdl } from "./pglite.js";

/** THE SHIPPED SQL (0.2.0): sql/audience-0.2.0.sql builds exactly the schema's four tables, and runs twice. */

const read = (name: string) => readFileSync(join(__dirname, "..", "..", "sql", name), "utf8");

async function shapeOf(db: PGlite): Promise<string[]> {
  const columns = await db.query<{ t: string; c: string; ty: string; n: string; d: string | null }>(
    `select table_name as t, column_name as c, data_type as ty, is_nullable as n, column_default as d
       from information_schema.columns where table_name like 'aig_audience_%' order by table_name, column_name`,
  );
  const indexes = await db.query<{ def: string }>(`select indexdef as def from pg_indexes where tablename like 'aig_audience_%' order by indexname`);
  return [...columns.rows.map((r) => `${r.t}.${r.c} ${r.ty} ${r.n} ${r.d ?? ""}`), ...indexes.rows.map((r) => r.def)];
}

describe("sql/audience-0.2.0.sql", () => {
  it("builds the same tables as the schema, and runs twice", async () => {
    const fromFile = new PGlite();
    await fromFile.exec(read("audience-0.2.0.sql"));
    await fromFile.exec(read("audience-0.2.0.sql"));
    const fromSchema = new PGlite();
    for (const statement of audienceDdl(defineAudienceTables())) await fromSchema.exec(statement);
    expect(await shapeOf(fromFile)).toEqual(await shapeOf(fromSchema));
    await fromFile.close();
    await fromSchema.close();
  });
});
