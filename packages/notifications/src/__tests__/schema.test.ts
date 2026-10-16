import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  defineNotificationTables,
  InvalidTableNameError,
  notificationChoices,
  notificationRouting,
  notifications,
  notificationsSql,
  notificationTables,
} from "../schema.js";

/**
 * The schema (Tenancy 2b-1, 4.1): the default names are 0.1's exactly, a
 * prefix and a schema give an independent set, and the drizzle tables agree
 * column for column and index for index with the shipped SQL on a real
 * Postgres.
 */

function names(table: PgTable) {
  const config = getTableConfig(table);
  return {
    table: config.name,
    schema: config.schema ?? null,
    indexes: config.indexes.map((index) => index.config.name ?? "").sort(),
    primaryKeys: config.primaryKeys.map((pk) => pk.getName()).sort(),
  };
}

describe("default names (the 0.1 names, pinned)", () => {
  it("snapshots every table, index and key name", () => {
    expect(names(notificationTables.alerts)).toEqual({
      table: "notifications",
      schema: null,
      indexes: [
        "notifications_created_idx",
        "notifications_dedupe_lookup_idx",
        "notifications_dedupe_uidx",
        "notifications_email_due_idx",
        "notifications_inbox_idx",
        "notifications_recipient_created_idx",
        "notifications_recipient_read_idx",
        "notifications_unread_idx",
      ],
      primaryKeys: [],
    });
    expect(names(notificationTables.choices)).toEqual({
      table: "notification_choices",
      schema: null,
      indexes: [],
      primaryKeys: ["notification_choices_pk"],
    });
    expect(names(notificationTables.routing)).toEqual({
      table: "notification_routing",
      schema: null,
      indexes: [],
      primaryKeys: ["notification_routing_pk"],
    });
    expect(notificationTables.prefix).toBe("");
    expect(notificationTables.schema).toBeNull();
  });

  it("keeps 0.1's export names on the same tables", () => {
    expect(notifications).toBe(notificationTables.alerts);
    expect(notificationChoices).toBe(notificationTables.choices);
    expect(notificationRouting).toBe(notificationTables.routing);
  });
});

describe("a prefix and a schema", () => {
  it("builds every name from the prefix, under the schema", () => {
    const set = defineNotificationTables({ prefix: "aig_", schema: "adminigloo" });
    expect(names(set.alerts).table).toBe("aig_notifications");
    expect(names(set.alerts).schema).toBe("adminigloo");
    expect(names(set.alerts).indexes).toContain("aig_notifications_recipient_created_idx");
    expect(names(set.choices).primaryKeys).toEqual(["aig_notification_choices_pk"]);
    expect(names(set.routing).primaryKeys).toEqual(["aig_notification_routing_pk"]);
    expect(set.prefix).toBe("aig_");
    expect(set.schema).toBe("adminigloo");
  });

  it("keeps every name within Postgres' 63 characters under the longest prefix", () => {
    const prefix = `p${"x".repeat(30)}_`;
    expect(prefix.length).toBe(32);
    const set = defineNotificationTables({ prefix });
    for (const table of [set.alerts, set.choices, set.routing]) {
      const n = names(table);
      for (const name of [n.table, ...n.indexes, ...n.primaryKeys]) expect(name.length, name).toBeLessThanOrEqual(63);
    }
    expect(names(set.alerts).indexes).toContain(`${prefix}ntf_recipient_created_idx`);
  });

  it("refuses a bad prefix or schema name, in words", () => {
    for (const prefix of ["Aig_", "aig", "_aig_", "aig-x_", `a${"b".repeat(31)}_`]) {
      expect(() => defineNotificationTables({ prefix }), prefix).toThrow(InvalidTableNameError);
    }
    for (const schema of ["Admin", "a-b", "x".repeat(64), ""]) {
      expect(() => defineNotificationTables({ schema }), schema).toThrow(InvalidTableNameError);
    }
    expect(() => notificationsSql({ prefix: "drop table x;--" })).toThrow(/table prefix/);
  });
});

describe("the drizzle tables agree with the shipped SQL", () => {
  let client: PGlite;
  beforeAll(async () => {
    client = new PGlite();
    await client.exec(notificationsSql());
    await client.exec(notificationsSql({ prefix: "aig_" }));
    await client.exec(notificationsSql({ schema: "adminigloo" }));
    await client.exec(notificationsSql({ schema: "adminigloo", prefix: "aig_" }));
  });
  afterAll(async () => {
    await client.close();
  });

  const SETS = [
    ["default", {}],
    ["prefix", { prefix: "aig_" }],
    ["schema", { schema: "adminigloo" }],
    ["both", { schema: "adminigloo", prefix: "aig_" }],
  ] as const;

  for (const [label, options] of SETS) {
    it(`${label}: four independent sets live in one database, each matching its drizzle tables`, async () => {
      const set = defineNotificationTables(options);
      for (const table of [set.alerts, set.choices, set.routing]) {
        const config = getTableConfig(table);
        const schema = config.schema ?? "public";
        const columns = (
          await client.query<{ column_name: string; data_type: string; is_nullable: string }>(
            `select column_name, data_type, is_nullable from information_schema.columns where table_schema = $1 and table_name = $2 order by column_name`,
            [schema, config.name],
          )
        ).rows;
        const expected = config.columns
          .map((column) => ({
            column_name: column.name,
            // information_schema calls every array "ARRAY".
            data_type: column.getSQLType().endsWith("[]") ? "ARRAY" : column.getSQLType(),
            is_nullable: column.notNull || column.primary ? "NO" : "YES",
          }))
          .sort((a, b) => (a.column_name < b.column_name ? -1 : 1));
        expect(columns, config.name).toEqual(expected);
        const indexes = (
          await client.query<{ indexname: string }>(`select indexname from pg_indexes where schemaname = $1 and tablename = $2`, [schema, config.name])
        ).rows.map((row) => row.indexname);
        for (const index of config.indexes) expect(indexes, config.name).toContain(index.config.name);
        for (const pk of config.primaryKeys) expect(indexes, config.name).toContain(pk.getName());
      }
    });
  }

  it("keeps the partial indexes' predicates", async () => {
    const rows = (
      await client.query<{ indexname: string; indexdef: string }>(
        `select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'notifications'`,
      )
    ).rows;
    const def = (name: string) => rows.find((row) => row.indexname === name)?.indexdef ?? "";
    expect(def("notifications_unread_idx")).toMatch(/WHERE \(read_at IS NULL\)/);
    expect(def("notifications_email_due_idx")).toMatch(/WHERE \(email_status = ANY \(ARRAY\['pending'::text, 'sending'::text\]\)\)/);
    expect(def("notifications_dedupe_uidx")).toMatch(/^CREATE UNIQUE INDEX/);
  });
});
