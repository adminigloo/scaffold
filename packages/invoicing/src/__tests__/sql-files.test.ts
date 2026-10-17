import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { schemaDdl } from "./pglite.js";

/**
 * sql/upgrade-0.4-to-0.5.sql turns a 0.4 database into 0.5's — the same
 * columns, defaults and indexes the schema builds — without touching a row,
 * and runs twice.
 */
async function shapeOf(db: PGlite): Promise<string[]> {
  const columns = await db.query<{ t: string; c: string; ty: string; n: string; d: string | null }>(
    `select table_name as t, column_name as c, data_type as ty, is_nullable as n, column_default as d
       from information_schema.columns where table_name like 'invoice%' order by table_name, column_name`,
  );
  const indexes = await db.query<{ def: string }>(`select indexdef as def from pg_indexes where tablename like 'invoice%' order by indexname`);
  return [...columns.rows.map((r) => `${r.t}.${r.c} ${r.ty} ${r.n} ${r.d ?? ""}`), ...indexes.rows.map((r) => r.def)];
}

describe("sql/upgrade-0.4-to-0.5.sql", () => {
  it("adds the deposit, the payment flag and the checkouts to a 0.4 database, keeps its rows, and runs twice", async () => {
    const v05 = schemaDdl();
    const v04 = v05
      .filter((s) => !s.includes("invoice_checkouts") && !s.includes("invoice_card_alerts"))
      .map((s) => s.replace('CREATE INDEX "invoice_payments_reverses_idx"', 'CREATE UNIQUE INDEX "invoice_payments_reverses_uidx"'))
      .map((s) => s.replace(/,\n {2}"deposit_bp" integer/, "").replace(/,\n {2}"deposit_amount" bigint/, "").replace(/,\n {2}"flag" text/, "").replace(/,\n {2}"flagged_at" timestamp with time zone/, ""));
    expect(v04.join("\n")).not.toMatch(/deposit_|flag/);
    const db = new PGlite();
    for (const s of v04) await db.exec(s);
    await db.exec(`insert into invoices (id, tenant_id, invoice_number, view_token, total) values ('i1', 'primary', 'INV-2026-0001', 'tok', 5000)`);
    const upgrade = readFileSync(join(__dirname, "..", "..", "sql", "upgrade-0.4-to-0.5.sql"), "utf8");
    await db.exec(upgrade);
    await db.exec(upgrade);
    const fresh = new PGlite();
    for (const s of v05) await fresh.exec(s);
    expect(await shapeOf(db)).toEqual(await shapeOf(fresh));
    expect((await db.query(`select id, total, deposit_bp, deposit_amount from invoices`)).rows).toEqual([{ id: "i1", total: 5000, deposit_bp: null, deposit_amount: null }]);
    await db.close();
    await fresh.close();
  });
});
