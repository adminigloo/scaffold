import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  CLIENT_KEY_HEADER,
  createFeedbackHandlers,
  createTicket,
  hashClientKey,
  issueClientKey,
  listBoardData,
  verifyClientKey,
  ensureFeedbackBoard,
  FEEDBACK_PLATFORM_BOARD,
  listCategories,
  listStatuses,
  submitPayloadSchema,
} from "../index.js";
import { createTestDb, report, schemaDdl } from "./pglite.js";

/**
 * The shipped SQL (sql/): the 0.10 create builds tables the package works on,
 * and the 0.9 → 0.10 upgrade turns a 0.9 install's one board into the
 * platform's own board ('*'), with per-company keys and numbers, twice over
 * without harm.
 */

const SQL_DIR = join(__dirname, "..", "..", "sql");
const read = (name: string) => readFileSync(join(SQL_DIR, name), "utf8");

/** 0.9.1's tables, as its drizzle schema made them. */
const V09 = [
  `CREATE TABLE "feedback_client_keys" ("id" text PRIMARY KEY, "tenant_id" text NOT NULL, "key_hash" text NOT NULL, "label" text NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now(), "revoked_at" timestamptz)`,
  `CREATE UNIQUE INDEX "feedback_client_keys_key_hash_idx" ON "feedback_client_keys" ("key_hash")`,
  `CREATE INDEX "feedback_client_keys_tenant_idx" ON "feedback_client_keys" ("tenant_id")`,
  `CREATE TABLE "feedback_statuses" ("id" text PRIMARY KEY, "key" text NOT NULL, "label" text NOT NULL, "color" text, "sort_order" integer NOT NULL DEFAULT 0, "is_terminal" boolean NOT NULL DEFAULT false, "wip_limit" integer, "aging_warn_hours" integer, "aging_stale_hours" integer, "allow_ai_transition" boolean NOT NULL DEFAULT false, "created_at" timestamptz NOT NULL DEFAULT now())`,
  `CREATE UNIQUE INDEX "feedback_statuses_key_idx" ON "feedback_statuses" ("key")`,
  `CREATE TABLE "feedback_categories" ("id" text PRIMARY KEY, "key" text NOT NULL, "label" text NOT NULL, "description" text, "sort_order" integer NOT NULL DEFAULT 0, "show_to_customer" boolean NOT NULL DEFAULT true, "created_at" timestamptz NOT NULL DEFAULT now())`,
  `CREATE UNIQUE INDEX "feedback_categories_key_idx" ON "feedback_categories" ("key")`,
  `CREATE TABLE "feedback_tickets" ("id" text PRIMARY KEY, "tenant_id" text NOT NULL, "ticket_number" text NOT NULL, "title" text NOT NULL, "description" text NOT NULL, "priority" text NOT NULL DEFAULT 'medium', "category" text, "status" text NOT NULL DEFAULT 'open', "screenshot_url" text, "annotated_screenshot_url" text, "reporter_name" text, "reporter_email" text, "assignee" text, "reporter_token_hash" text, "last_staff_read_at" timestamptz, "status_changed_at" timestamptz, "archived_at" timestamptz, "archived_by" text, "page_pathname" text, "client_metadata" jsonb, "recent_errors" jsonb, "created_at" timestamptz NOT NULL DEFAULT now())`,
  `CREATE UNIQUE INDEX "feedback_tickets_number_idx" ON "feedback_tickets" ("ticket_number")`,
  `CREATE TABLE "feedback_messages" ("id" text PRIMARY KEY, "ticket_id" text NOT NULL REFERENCES "feedback_tickets" ("id") ON DELETE CASCADE, "sender_type" text NOT NULL, "sender_name" text NOT NULL, "body" text NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now())`,
];

async function columnsOf(client: { query: (q: string) => Promise<{ rows: unknown[] }> }, table: string): Promise<string[]> {
  const result = await client.query(`select column_name from information_schema.columns where table_name = '${table}' order by column_name`);
  return (result.rows as Array<{ column_name: string }>).map((row) => row.column_name);
}

async function indexesOf(client: { query: (q: string) => Promise<{ rows: unknown[] }> }, table: string): Promise<string[]> {
  const result = await client.query(`select indexname from pg_indexes where tablename = '${table}' order by indexname`);
  return (result.rows as Array<{ indexname: string }>).map((row) => row.indexname);
}

describe("sql/feedback-0.10.0.sql", () => {
  it("makes the same tables, columns and indexes as the schema", async () => {
    const fromSchema = await createTestDb();
    const fromSql = await createTestDb({ sql: [read("feedback-0.10.0.sql")] });
    for (const table of ["feedback_client_keys", "feedback_statuses", "feedback_categories", "feedback_tickets", "feedback_messages"]) {
      expect(await columnsOf(fromSql.client, table), table).toEqual(await columnsOf(fromSchema.client, table));
      expect((await indexesOf(fromSql.client, table)).filter((n) => !n.endsWith("_pkey")), table).toEqual(
        (await indexesOf(fromSchema.client, table)).filter((n) => !n.endsWith("_pkey")),
      );
    }
    // And the package runs on it.
    await createTicket(fromSql.db, { tenantId: "co-1", payload: submitPayloadSchema.parse(report()) });
    expect((await listBoardData(fromSql.db, "co-1")).tickets).toHaveLength(1);
    await fromSchema.close();
    await fromSql.close();
    expect(schemaDdl().length).toBeGreaterThan(0);
  });
});

describe("sql/upgrade-0.9-to-0.10.sql", () => {
  it("turns a 0.9 board into the platform's own, keeps every ticket, and runs twice without harm", async () => {
    const t = await createTestDb({ sql: V09 });
    await t.client.exec(`insert into feedback_statuses (id, key, label, sort_order) values ('s1', 'open', 'Open', 10), ('s2', 'shipped', 'Shipped', 20)`);
    await t.client.exec(`update feedback_statuses set is_terminal = true where key = 'shipped'`);
    await t.client.exec(`insert into feedback_categories (id, key, label) values ('c1', 'bug', 'Bug report')`);
    await t.client.exec(
      `insert into feedback_tickets (id, tenant_id, ticket_number, title, description, status) values ('t1', 'client-a', 'FB-00001', 'One', 'One long enough', 'open'), ('t2', 'client-b', 'FB-00002', 'Two', 'Two long enough', 'shipped')`,
    );
    const upgrade = read("upgrade-0.9-to-0.10.sql");
    await t.client.exec(upgrade);
    await t.client.exec(upgrade);

    expect(await columnsOf(t.client, "feedback_statuses")).toContain("tenant_id");
    expect(await indexesOf(t.client, "feedback_statuses")).toContain("feedback_statuses_tenant_key_idx");
    expect(await indexesOf(t.client, "feedback_statuses")).not.toContain("feedback_statuses_key_idx");
    expect(await indexesOf(t.client, "feedback_tickets")).toContain("feedback_tickets_tenant_number_idx");
    expect(await indexesOf(t.client, "feedback_tickets")).not.toContain("feedback_tickets_number_idx");

    // The 0.9 board, exactly as it was, is the platform's own.
    expect((await listStatuses(t.db, FEEDBACK_PLATFORM_BOARD)).map((s) => [s.key, s.isTerminal])).toEqual([
      ["open", false],
      ["shipped", true],
    ]);
    expect((await listCategories(t.db, FEEDBACK_PLATFORM_BOARD)).map((c) => c.key)).toEqual(["bug"]);
    // The platform's board isn't re-seeded over the columns it already has.
    expect(await ensureFeedbackBoard(t.db, FEEDBACK_PLATFORM_BOARD)).toEqual({ statuses: 0, categories: 0 });
    // H1: every 0.9 ticket and key is the site's own — whatever company id
    // 0.9's issue-key script filed them under.
    expect((await listBoardData(t.db, FEEDBACK_PLATFORM_BOARD)).tickets.map((x) => x.ticketNumber).sort()).toEqual(["FB-00001", "FB-00002"]);
    expect((await listBoardData(t.db, "client-a")).tickets).toEqual([]);
    expect((await listBoardData(t.db, "client-b")).tickets).toEqual([]);
    // The site's board counts on from its own highest number; a new company starts at 1.
    expect((await createTicket(t.db, { tenantId: FEEDBACK_PLATFORM_BOARD, payload: submitPayloadSchema.parse(report()) })).ticketNumber).toBe("FB-00003");
    expect((await createTicket(t.db, { tenantId: "client-new", payload: submitPayloadSchema.parse(report()) })).ticketNumber).toBe("FB-00001");
    // Two companies may now share a column key.
    await t.db.execute(sql`insert into feedback_statuses (id, tenant_id, key, label) values ('s9', 'client-a', 'shipped', 'Shipped')`);
    await t.close();
  });

  it("keeps the site's own button feeding the site's own board, with the key 0.9 issued under a company", async () => {
    const t = await createTestDb({ sql: V09 });
    const key = "aik_" + "ab".repeat(20);
    await t.client.exec(`insert into feedback_client_keys (id, tenant_id, key_hash, label) values ('k1', 'acme-id', '${await hashClientKey(key)}', 'default')`);
    await t.client.exec(`insert into feedback_statuses (id, key, label, sort_order, is_terminal) values ('s1','open','Open',10,false),('s2','triage','Triage',15,false),('s3','closed','Closed',40,true)`);
    await t.client.exec(`insert into feedback_tickets (id, tenant_id, ticket_number, title, description, status, reporter_email) values ('t1','acme-id','FB-00001','From a Bravo user','long enough text','triage','bob@bravo.test')`);
    await t.client.exec(read("upgrade-0.9-to-0.10.sql"));
    const platform = await listBoardData(t.db, FEEDBACK_PLATFORM_BOARD);
    // L6: the old ticket sits in its own (custom) column on the site's board…
    expect(platform.tickets.map((x) => [x.ticketNumber, x.status])).toEqual([["FB-00001", "triage"]]);
    expect(platform.statuses.map((s) => s.key)).toContain("triage");
    // …and the company the old key named has nothing of it: no ticket in an
    // unknown column, just its own fresh board.
    const acme = await listBoardData(t.db, "acme-id");
    expect(acme.tickets).toEqual([]);
    expect(acme.statuses.map((s) => s.key)).toEqual(["open", "in_progress", "resolved", "closed"]);
    // The button keeps working, onto the site's board.
    const { handle } = createFeedbackHandlers({ db: t.db });
    const res = await handle(
      new Request("http://x/api/igloo/v1/submit", {
        method: "POST",
        headers: { [CLIENT_KEY_HEADER]: key, "content-type": "application/json" },
        body: JSON.stringify(report("A Charlie user: the invoices page crashed for me")),
      }),
    );
    expect(res.status).toBe(201);
    expect((await listBoardData(t.db, FEEDBACK_PLATFORM_BOARD)).tickets).toHaveLength(2);
    expect((await listBoardData(t.db, "acme-id")).tickets).toEqual([]);
    await t.close();
  });

  it("run again after companies have boards and keys of their own, moves none of them", async () => {
    const t = await createTestDb({ sql: V09 });
    const upgrade = read("upgrade-0.9-to-0.10.sql");
    await t.client.exec(upgrade);
    const company = await issueClientKey(t.db, { tenantId: "green-acres", label: "Website" });
    await createTicket(t.db, { tenantId: "green-acres", payload: submitPayloadSchema.parse(report()) });
    await t.client.exec(upgrade);
    expect(await verifyClientKey(t.db, company.key)).toMatchObject({ tenantId: "green-acres" });
    expect((await listBoardData(t.db, "green-acres")).tickets).toHaveLength(1);
    await t.close();
  });

  it("drops the default after filling it (L4): an insert that forgets the company fails", async () => {
    for (const sqlText of [read("upgrade-0.9-to-0.10.sql"), read("feedback-0.10.0.sql")]) {
      const t = await createTestDb({ sql: sqlText.startsWith("-- @adminigloo/feedback: upgrade") ? V09 : [] });
      await t.client.exec(sqlText);
      await expect(t.client.exec(`insert into feedback_statuses (id, key, label) values ('x', 'loose', 'Loose')`)).rejects.toThrow();
      await expect(t.client.exec(`insert into feedback_categories (id, key, label) values ('x', 'loose', 'Loose')`)).rejects.toThrow();
      await t.close();
    }
    const fresh = await createTestDb();
    await expect(fresh.client.exec(`insert into feedback_statuses (id, key, label) values ('x', 'loose', 'Loose')`)).rejects.toThrow();
    await fresh.close();
  });

  it("stops with a sentence when there is nothing to upgrade", async () => {
    const t = await createTestDb({ sql: [] });
    await expect(t.client.exec(read("upgrade-0.9-to-0.10.sql"))).rejects.toThrow(/no feedback tables to upgrade/);
    await t.close();
  });
});
