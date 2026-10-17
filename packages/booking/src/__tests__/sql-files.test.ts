import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { schemaDdl } from "./pglite.js";

/**
 * THE SHIPPED SQL (0.2.0): sql/booking-0.2.0.sql builds exactly the tables the
 * code queries, and sql/upgrade-0.1-to-0.2.sql turns a 0.1 database into
 * 0.2's without touching a row — adminigloo.com's own tenant included —
 * safely twice.
 */

const SQL_DIR = join(__dirname, "..", "..", "sql");
const read = (name: string) => readFileSync(join(SQL_DIR, name), "utf8");

async function shapeOf(db: PGlite): Promise<string[]> {
  const columns = await db.query<{ t: string; c: string; ty: string; n: string; d: string | null }>(
    `select table_name as t, column_name as c, data_type as ty, is_nullable as n, column_default as d
       from information_schema.columns where table_name like 'booking_%' order by table_name, column_name`,
  );
  const indexes = await db.query<{ def: string }>(`select indexdef as def from pg_indexes where tablename like 'booking_%' order by indexname`);
  return [...columns.rows.map((r) => `${r.t}.${r.c} ${r.ty} ${r.n} ${r.d ?? ""}`), ...indexes.rows.map((r) => r.def)];
}

describe("sql/booking-0.2.0.sql", () => {
  it("builds the same tables as the schema, and runs twice", async () => {
    const fromFile = new PGlite();
    await fromFile.exec(read("booking-0.2.0.sql"));
    await fromFile.exec(read("booking-0.2.0.sql"));
    const fromSchema = new PGlite();
    for (const statement of schemaDdl()) await fromSchema.exec(statement);
    expect(await shapeOf(fromFile)).toEqual(await shapeOf(fromSchema));
    await fromFile.close();
    await fromSchema.close();
  });
});

describe("sql/upgrade-0.1-to-0.2.sql", () => {
  it("adds the three columns and the one-host-per-person index to a 0.1 database, keeps adminigloo.com's rows, and runs twice", async () => {
    const v02 = read("booking-0.2.0.sql");
    const v01 = v02
      .replace(/\n {2}"user_id" text,/, "")
      .replace(/\n {2}"reminded_at" timestamptz,/, "")
      .replace(/\n {2}"reminder_attempts" integer not null default 0,/, "")
      .replace(/create unique index if not exists "booking_hosts_tenant_user_idx"[^;]*;/, "");
    expect(v01).not.toContain("user_id");
    expect(v01).not.toContain("reminded_at");
    expect(v01).not.toContain("reminder_attempts");
    const db = new PGlite();
    await db.exec(v01);
    await db.exec(`insert into booking_hosts (id, tenant_id, display_name, email, timezone) values ('h1', 'adminigloo-calls', 'Dallin', 'dallin@adminigloo.com', 'America/Denver')`);
    await db.exec(
      `insert into booking_bookings (id, tenant_id, type_id, host_id, status, start_utc, end_utc, host_timezone) values ('b1', 'adminigloo-calls:staging', 't1', 'h1', 'confirmed', now(), now(), 'America/Denver')`,
    );
    await db.exec(read("upgrade-0.1-to-0.2.sql"));
    await db.exec(read("upgrade-0.1-to-0.2.sql"));
    const fresh = new PGlite();
    await fresh.exec(v02);
    expect(await shapeOf(db)).toEqual(await shapeOf(fresh));
    expect((await db.query(`select id, tenant_id, user_id from booking_hosts`)).rows).toEqual([{ id: "h1", tenant_id: "adminigloo-calls", user_id: null }]);
    expect((await db.query(`select id, tenant_id, reminded_at from booking_bookings`)).rows).toEqual([
      { id: "b1", tenant_id: "adminigloo-calls:staging", reminded_at: null },
    ]);
    await db.close();
    await fresh.close();
  });
});
