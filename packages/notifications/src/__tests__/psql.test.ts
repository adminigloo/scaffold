import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The shipped files the way a host without drizzle-kit really runs them
 * (reviews FH-1, FH-3), next to Ridgeline's OWN `notifications` table:
 *
 *   - `psql -f file.sql` with psql's DEFAULTS: autocommit on and
 *     ON_ERROR_STOP off, so psql prints an error and carries on with the next
 *     statement. A guard that is a statement of its own then stops nothing:
 *     every later `create index if not exists` whose columns happen to exist
 *     lands on the host's table. Each script is one statement now, so a
 *     failed guard creates nothing, however the file is split.
 *   - in one transaction (a Prisma migration, `psql -1`): a host table that
 *     tracks email (`email_status`) gets the guard's sentence, never a raw
 *     "column dedupe_key does not exist".
 *   - the 0.1 upgrade never ALTERs a host's table that merely shares 0.1's
 *     generic column names (and even carries 0.1's index name).
 */

const here = dirname(fileURLToPath(import.meta.url));
const file = (name: string) => readFileSync(resolve(here, "../../sql", name), "utf8").replace(/\r\n/g, "\n");

/** Ridgeline's own notifications: it tracks email, so it has `email_status` (and `tenant_id`). */
const RIDGELINE = `
create table notifications (
  id serial primary key, user_id int, tenant_id text, recipient_id text, kind text, title text, body text,
  href text, read_at timestamptz, created_at timestamptz not null default now(), email_status text, message text
);
create index notifications_user_idx on notifications (user_id);
insert into notifications (user_id, tenant_id, recipient_id, kind, title, email_status, message)
select g, '1', g::text, 'ridgeline.job', 'Job ' || g, 'sent', 'msg ' || g from generate_series(1, 5) g;
`;

/** The statements of a file as psql sends them: split at each `;` that ends a line outside dollar quotes. */
function statements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inDollar = false;
  for (const line of sql.split("\n")) {
    buf += `${line}\n`;
    if ((line.match(/\$\$/g) ?? []).length % 2 === 1) inDollar = !inDollar;
    if (!inDollar && /;\s*$/.test(line)) {
      out.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter((statement) => statement.replace(/--.*$/gm, "").trim() !== "");
}

/** `psql -f` with its defaults: every statement on its own, carrying on after an error. */
async function psqlDefaults(client: PGlite, sql: string): Promise<string[]> {
  const errors: string[] = [];
  for (const statement of statements(sql)) {
    try {
      await client.exec(statement);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return errors;
}

async function snapshot(client: PGlite) {
  const one = async (sql: string) => ((await client.query<{ v: string | null }>(sql)).rows[0]?.v ?? null);
  return {
    columns: await one(`select string_agg(attname, ',' order by attnum) as v from pg_attribute where attrelid = 'public.notifications'::regclass and attnum > 0 and not attisdropped`),
    indexes: await one(`select string_agg(indexname, ',' order by indexname) as v from pg_indexes where schemaname = 'public' and tablename = 'notifications'`),
    tables: await one(`select string_agg(table_name, ',' order by table_name) as v from information_schema.tables where table_schema = 'public'`),
    rows: await one(`select md5(string_agg(t::text, '|' order by id)) as v from public.notifications t`),
  };
}

const GUARD_SENTENCE =
  "A table named notifications already exists and isn't AdminIgloo's 0.2 table. If it is AdminIgloo's 0.1 table, run sql/upgrade-0.1-to-0.2.sql; otherwise pass a prefix or a schema.";
const UPGRADE_SENTENCE = "The table named notifications isn't AdminIgloo's 0.1 table. Pass a prefix or a schema and run notificationsSql() instead.";

const clients: PGlite[] = [];
async function ridgeline(extra = ""): Promise<PGlite> {
  const client = new PGlite();
  clients.push(client);
  await client.exec(RIDGELINE + extra);
  return client;
}
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});

describe("psql -f with its defaults, next to a host's own notifications (review FH-1)", () => {
  it("sql/notifications-0.2.0.sql: the guard's sentence, and NOTHING created: no index on the host's table, no new table", async () => {
    const client = await ridgeline();
    const before = await snapshot(client);
    const errors = await psqlDefaults(client, file("notifications-0.2.0.sql"));
    expect(errors).toEqual([GUARD_SENTENCE]);
    expect(await snapshot(client)).toEqual(before);
  });

  it("the same for a host table that has none of the package's columns", async () => {
    const client = new PGlite();
    clients.push(client);
    await client.exec("create table notifications (id serial primary key, user_id int, read_at timestamptz, created_at timestamptz not null default now());");
    const before = await snapshot(client);
    expect(await psqlDefaults(client, file("notifications-0.2.0.sql"))).toEqual([GUARD_SENTENCE]);
    expect(await snapshot(client)).toEqual(before);
  });

  it("sql/upgrade-0.1-to-0.2.sql: refused, and the host's table keeps its columns and indexes", async () => {
    const client = await ridgeline();
    const before = await snapshot(client);
    expect(await psqlDefaults(client, file("upgrade-0.1-to-0.2.sql"))).toEqual([UPGRADE_SENTENCE]);
    expect(await snapshot(client)).toEqual(before);
  });

  it("each shipped file is one statement, so no runner can split the guard from the tables", () => {
    for (const name of ["notifications-0.2.0.sql", "upgrade-0.1-to-0.2.sql"]) {
      const parts = statements(file(name));
      expect(parts, name).toHaveLength(1);
      expect(parts[0]?.replace(/^--.*\n/gm, "").trimStart(), name).toMatch(/^do \$\$ begin\n {2}if to_regclass/);
    }
  });
});

describe("the guards look for the package's own columns (review FH-3)", () => {
  it("in one transaction, a host table that tracks email (email_status) gets the guard's sentence", async () => {
    const client = await ridgeline();
    const before = await snapshot(client);
    await expect(client.exec(file("notifications-0.2.0.sql"))).rejects.toThrow(GUARD_SENTENCE);
    expect(await snapshot(client)).toEqual(before);
  });

  it("the upgrade refuses a host table that has 0.1's eight column names and even 0.1's index name", async () => {
    const client = await ridgeline("create index notifications_recipient_created_idx on notifications (recipient_id, created_at);");
    const before = await snapshot(client);
    await expect(client.exec(file("upgrade-0.1-to-0.2.sql"))).rejects.toThrow(UPGRADE_SENTENCE);
    expect(await snapshot(client)).toEqual(before);
  });

  it("a host's own notification_choices with a channel column is refused too", async () => {
    const client = new PGlite();
    clients.push(client);
    await client.exec("create table notification_choices (id serial primary key, user_id int, channel text);");
    await expect(client.exec(file("notifications-0.2.0.sql"))).rejects.toThrow(
      "A table named notification_choices already exists and isn't AdminIgloo's. Pass a prefix or a schema.",
    );
    const tables = (await client.query<{ n: number }>(`select count(*)::int as n from information_schema.tables where table_name = 'notifications'`)).rows[0];
    expect(tables?.n).toBe(0);
  });
});
