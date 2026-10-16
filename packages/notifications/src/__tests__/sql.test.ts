import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { createNotifications } from "../instance.js";
import { listNotifications, notify as legacyNotify, unreadCount as legacyUnread } from "../legacy.js";
import { defineNotificationTables, notificationsSql, notificationTables } from "../schema.js";
import { notificationsUpgradeSql } from "../sql.js";
import type { NotificationsDb } from "../types.js";
import { Directory, draft, greenAcres, REGISTRY } from "./fixtures.js";
import { FOREIGN_OPTIONS, HOST_TABLE_SQL, hostRowsOf, tenant } from "./pglite.js";

/**
 * The shipped SQL (Tenancy 2b-1, 4.1; D14): the files are the functions'
 * output, they build working tables (for any prefix and schema, next to a
 * host's own `notifications`), they are safe to run twice, and 0.1's table
 * upgrades in place with its rows kept as the firm-wide inbox.
 */

const here = dirname(fileURLToPath(import.meta.url));
const file = (name: string) => readFileSync(resolve(here, "../../sql", name), "utf8").replace(/\r\n/g, "\n");

/** 0.1's own DDL, as its drizzle schema made it (0.1.0's schema.ts). */
const V01_DDL = `
create table notifications (
  id text primary key,
  recipient_id text not null,
  kind text not null,
  title text not null,
  body text,
  href text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_recipient_created_idx on notifications (recipient_id, created_at);
create index notifications_recipient_read_idx on notifications (recipient_id, read_at);
insert into notifications (id, recipient_id, kind, title, href, created_at) values
  ('n-old-1', 'staff-1', 'feedback.ticket-created', 'FB-00007: Export crashes', '/admin/feedback/board', '2026-09-01T10:00:00Z'),
  ('n-old-2', 'staff-1', 'feedback.reporter-replied', 'FB-00007: a reply', null, '2026-09-02T10:00:00Z');
`;

const clients: PGlite[] = [];
async function fresh(): Promise<PGlite> {
  const client = new PGlite();
  clients.push(client);
  return client;
}
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});

async function columnsOf(client: PGlite, table: string) {
  return (
    await client.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'public' and table_name = $1 order by column_name`,
      [table],
    )
  ).rows;
}

describe("the shipped files", () => {
  it("sql/notifications-0.2.0.sql is exactly notificationsSql()", () => {
    expect(file("notifications-0.2.0.sql")).toBe(notificationsSql());
  });

  it("sql/upgrade-0.1-to-0.2.sql is exactly the upgrade the package knows", () => {
    expect(file("upgrade-0.1-to-0.2.sql")).toBe(notificationsUpgradeSql());
  });

  it("a host script finds the shipped files through the package's own exports (review FH-10)", () => {
    const require = createRequire(import.meta.url);
    for (const name of ["notifications-0.2.0.sql", "upgrade-0.1-to-0.2.sql"]) {
      const found = require.resolve(`@adminigloo/notifications/sql/${name}`);
      expect(readFileSync(found, "utf8").replace(/\r\n/g, "\n")).toBe(file(name));
    }
    expect(require.resolve("@adminigloo/notifications/package.json")).toMatch(/package\.json$/);
  });

  it("without a schema, the SQL says that a Prisma project needs one, since Prisma drops tables in public it has no model for (review FH-2)", () => {
    const prisma = /^-- With Prisma, use notificationsSql\(\{ schema: "adminigloo" \}\) instead: Prisma drops tables in public that schema\.prisma has no model for\.$/m;
    expect(notificationsSql({ prefix: "aig_" })).toMatch(prisma);
    expect(notificationsSql()).toMatch(prisma);
    expect(notificationsSql({ schema: "adminigloo" })).not.toMatch(prisma);
    expect(notificationsSql(FOREIGN_OPTIONS)).not.toMatch(prisma);
  });

  it("each script opens with its guard", () => {
    for (const sql of [notificationsSql(), notificationsSql(FOREIGN_OPTIONS), notificationsUpgradeSql()]) {
      const firstStatement = sql.split("\n\n").find((part) => !part.startsWith("--"));
      expect(firstStatement).toMatch(/^do \$\$ begin/);
    }
  });
});

describe("running it", () => {
  it("is safe to run twice", async () => {
    const client = await fresh();
    await client.exec(notificationsSql());
    await client.exec(notificationsSql());
    await client.exec(notificationsSql(FOREIGN_OPTIONS));
    await client.exec(notificationsSql(FOREIGN_OPTIONS));
    const tables = (await client.query<{ n: number }>(`select count(*)::int as n from information_schema.tables where table_name like '%notification%'`)).rows[0];
    expect(tables?.n).toBe(6);
  });

  it("builds the adminigloo/aig_ set next to a host's own notifications table, and leaves the host's alone", async () => {
    const client = await fresh();
    await client.exec(HOST_TABLE_SQL);
    const before = await hostRowsOf(client);
    await client.exec(notificationsSql(FOREIGN_OPTIONS));
    const db = drizzle(client) as unknown as NotificationsDb;
    const directory = new Directory();
    const a = tenant("a");
    const people = greenAcres(directory, a);
    const alerts = createNotifications({ db, tables: defineNotificationTables(FOREIGN_OPTIONS), registry: REGISTRY, people: directory.people, onError: () => {} });
    const report = await alerts.notify(draft(a, "tenancy.member.joined"));
    expect(report.alerted).toBe(2); // the owner and the admin hold members.invite
    const page = await alerts.list({ tenantId: a, userId: people.owner.userId, permissions: directory.permissionsOf(a, people.owner.userId) });
    expect(page.alerts).toHaveLength(1);
    await alerts.cleanup({ readOlderThanDays: 0, anyOlderThanDays: 0 });
    expect(await hostRowsOf(client)).toEqual(before);
    // The host's table kept its own shape: no package column was added to it.
    expect((await columnsOf(client, "notifications")).map((c) => c.column_name)).toEqual(["created_at", "id", "read_at", "user_id"]);
  });
});

describe("0.1 → 0.2", () => {
  it("upgrades 0.1's table in place: the same shape as a fresh 0.2 table, 0.1's rows kept as the firm-wide inbox", async () => {
    const old = await fresh();
    await old.exec(V01_DDL);
    await old.exec(notificationsUpgradeSql());
    const brandNew = await fresh();
    await brandNew.exec(notificationsSql());
    for (const table of ["notifications", "notification_choices", "notification_routing"]) {
      expect(await columnsOf(old, table), table).toEqual(await columnsOf(brandNew, table));
    }
    const indexes = async (client: PGlite) =>
      (await client.query<{ indexname: string }>(`select indexname from pg_indexes where tablename = 'notifications' order by indexname`)).rows;
    expect(await indexes(old)).toEqual(await indexes(brandNew));
    const rows = (await old.query<{ id: string; tenant_id: string; dedupe_key: string | null; email_status: string }>(
      `select id, tenant_id, dedupe_key, email_status from notifications order by id`,
    )).rows;
    expect(rows).toEqual([
      { id: "n-old-1", tenant_id: "*", dedupe_key: null, email_status: "none" },
      { id: "n-old-2", tenant_id: "*", dedupe_key: null, email_status: "none" },
    ]);
  });

  it("is a no-op the second time", async () => {
    const old = await fresh();
    await old.exec(V01_DDL);
    await old.exec(notificationsUpgradeSql());
    await old.exec(notificationsUpgradeSql());
    expect((await old.query<{ n: number }>(`select count(*)::int as n from notifications`)).rows[0]?.n).toBe(2);
  });

  it("0.1's rows stay in 0.1's inbox, and no company's bell shows them", async () => {
    const old = await fresh();
    await old.exec(V01_DDL);
    await old.exec(notificationsUpgradeSql());
    const db = drizzle(old) as unknown as NotificationsDb;
    // 0.1's API, on the upgraded table.
    expect((await listNotifications(db, "staff-1")).map((row) => row.id)).toEqual(["n-old-2", "n-old-1"]);
    expect(await legacyUnread(db, "staff-1")).toBe(2);
    await legacyNotify(db, { recipientIds: ["staff-1"], kind: "feedback.ticket-created", title: "FB-00008" });
    expect(await legacyUnread(db, "staff-1")).toBe(3);
    // 0.2's instance on the same table: a company reader named like 0.1's
    // recipient sees nothing of 0.1's inbox, whatever they hold.
    const directory = new Directory();
    const alerts = createNotifications({ db, tables: notificationTables, registry: REGISTRY, people: directory.people, onError: () => {} });
    const reader = { tenantId: "green-acres", userId: "staff-1", permissions: [...REGISTRY.permissions] };
    expect((await alerts.list(reader)).alerts).toEqual([]);
    expect(await alerts.unreadCount(reader)).toBe(0);
    // Cleanup leaves 0.1's rows to 0.1's rules (no dedupe key).
    await alerts.cleanup({ readOlderThanDays: 0, anyOlderThanDays: 0 });
    expect((await old.query<{ n: number }>(`select count(*)::int as n from notifications where tenant_id = '*'`)).rows[0]?.n).toBe(3);
  });
});
