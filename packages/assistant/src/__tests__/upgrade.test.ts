import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import { assemblePrompt } from "../assemble.js";
import { listGlossary, listSections, listTenantRules, type AssistantDb } from "../brain.js";
import { getConversation } from "../engine.js";
import { schemaDdl } from "./pglite.js";

/**
 * THE SHIPPED SQL (0.9.0): sql/assistant-0.9.0.sql builds exactly the tables
 * the code queries, and sql/upgrade-0.8-to-0.9.sql turns a 0.8 database (one
 * assistant for the whole install) into 0.9's — everything on one assistant,
 * '*' by default or the id the site's own assistant used — safely twice.
 */

const SQL_DIR = join(__dirname, "..", "..", "sql");
const read = (name: string) => readFileSync(join(SQL_DIR, name), "utf8");

/** The 0.8 tables the upgrade touches, as 0.8 shipped them (the embedding column as text: PGlite has no pgvector). */
const V08 = `
create table assistant_sections (id text primary key, key text not null, label text not null, description text, content text not null,
  sort_order integer not null default 0, is_core boolean not null default false, required_phrases jsonb not null default '[]'::jsonb,
  max_tokens integer not null default 600, is_active boolean not null default true, created_at timestamptz not null default now());
create unique index assistant_sections_key_idx on assistant_sections (key);
create table assistant_section_versions (id text primary key, section_id text not null references assistant_sections(id) on delete cascade,
  version_number integer not null, content text not null, change_summary text, created_by text, created_at timestamptz not null default now());
create unique index assistant_section_versions_idx on assistant_section_versions (section_id, version_number);
create table assistant_drafts (id text primary key, target_type text not null, target_id text not null, content text not null,
  ai_instruction text, ai_suggestion text, status text not null default 'draft', created_by text, created_at timestamptz not null default now());
create table assistant_tenant_rules (id text primary key, tenant_id text not null, section_key text, label text not null, instruction text not null,
  sort_order integer not null default 0, max_tokens integer not null default 200, is_active boolean not null default true, created_by text,
  created_at timestamptz not null default now());
create table assistant_glossary (id text primary key, term_key text not null, preferred text not null, aliases jsonb not null default '[]'::jsonb,
  definition text, category text, is_active boolean not null default true, created_at timestamptz not null default now());
create unique index assistant_glossary_term_idx on assistant_glossary (term_key);
create table assistant_change_log (id bigserial primary key, entity_type text not null, entity_id text not null, entity_key text, action text not null,
  section_id text, version_number integer, change_summary text, performed_by text, created_at timestamptz not null default now());
create table assistant_config_version (id text primary key default 'singleton', version integer not null default 1, updated_at timestamptz not null default now());
create table assistant_conversations (id text primary key, tenant_id text not null, user_id text not null, title text, status text not null default 'active',
  last_message_at timestamptz not null default now(), created_at timestamptz not null default now());
create table assistant_messages (id text primary key, conversation_id text not null, seq integer not null, role text not null,
  status text not null default 'complete', blocks jsonb not null default '[]'::jsonb, prompt_meta jsonb, created_at timestamptz not null default now());
create unique index assistant_messages_seq_idx on assistant_messages (conversation_id, seq);
create table assistant_page_docs (id text primary key, tenant_id text not null, page_key text not null, title text not null, body text not null,
  is_approved boolean not null default true, is_active boolean not null default true, embedding text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create unique index assistant_page_docs_key_idx on assistant_page_docs (tenant_id, page_key);
create table assistant_pending_actions (id text primary key, tenant_id text not null, conversation_id text not null, tool_name text not null,
  params jsonb not null default '{}'::jsonb, summary text not null, status text not null default 'pending', idempotency_key text not null,
  expires_at timestamptz not null, created_by text, created_at timestamptz not null default now());

insert into assistant_sections (id, key, label, content, is_core, required_phrases, max_tokens, sort_order)
  values ('s1', 'core_personality', 'Core', 'You are the site''s own assistant, tuned.', true, '["assistant"]', 500, 10);
insert into assistant_glossary (id, term_key, preferred, definition) values ('g1', 'the_yard', 'the yard', 'Our depot.');
insert into assistant_tenant_rules (id, tenant_id, label, instruction) values ('r1', 'default', 'Tone', 'Be brief.');
insert into assistant_change_log (entity_type, entity_id, action) values ('section', 's1', 'published');
insert into assistant_config_version (id, version) values ('singleton', 7);
insert into assistant_conversations (id, tenant_id, user_id) values ('c1', 'my-company-hq', 'staff1');
insert into assistant_messages (id, conversation_id, seq, role, blocks) values ('m1', 'c1', 1, 'user', '[{"kind":"text","text":"hi"}]');
insert into assistant_messages (id, conversation_id, seq, role) values ('m-orphan', 'gone', 1, 'user');
insert into assistant_page_docs (id, tenant_id, page_key, title, body, embedding) values ('p1', 'my-company-hq', '/admin', 'Admin', 'The admin shell.', '[0.1]');
`;

async function at08(): Promise<PGlite> {
  const client = new PGlite();
  await client.exec(V08);
  return client;
}

async function columns(client: PGlite, table: string): Promise<string[]> {
  const { rows } = await client.query<{ column_name: string }>(
    "select column_name from information_schema.columns where table_name = $1 order by column_name",
    [table],
  );
  return rows.map((row) => row.column_name);
}

describe("sql/assistant-0.9.0.sql", () => {
  it("builds the same tables and columns the code queries (and runs twice)", async () => {
    const shipped = new PGlite();
    await shipped.exec(read("assistant-0.9.0.sql"));
    await shipped.exec(read("assistant-0.9.0.sql"));
    const fromSchema = new PGlite();
    for (const statement of schemaDdl()) await fromSchema.exec(statement);
    const tables = "select table_name, column_name, data_type, is_nullable from information_schema.columns where table_schema = 'public' order by 1, 2";
    expect((await shipped.query(tables)).rows).toEqual((await fromSchema.query(tables)).rows);
    const indexes = "select indexname from pg_indexes where schemaname = 'public' order by 1";
    expect((await shipped.query(indexes)).rows).toEqual((await fromSchema.query(indexes)).rows);
    await shipped.close();
    await fromSchema.close();
  });
});

describe("sql/upgrade-0.8-to-0.9.sql", () => {
  it("puts 0.8's one assistant on the site's own ('*'), with every company column and index, safely twice", async () => {
    const client = await at08();
    await client.exec(read("upgrade-0.8-to-0.9.sql"));
    await client.exec(read("upgrade-0.8-to-0.9.sql"));
    const db = drizzle(client) as unknown as AssistantDb;

    expect(await columns(client, "assistant_sections")).toContain("tenant_id");
    expect(await columns(client, "assistant_glossary")).toContain("tenant_id");
    expect(await columns(client, "assistant_change_log")).toContain("tenant_id");
    expect(await columns(client, "assistant_messages")).toContain("tenant_id");
    expect(await columns(client, "assistant_page_docs")).toEqual(expect.arrayContaining(["kind"]));
    expect(await columns(client, "assistant_page_docs")).not.toContain("embedding");
    expect(await columns(client, "assistant_pending_actions")).toContain("decided_at");

    expect((await listSections(db, "*")).map((s) => s.content)).toEqual(["You are the site's own assistant, tuned."]);
    expect((await listGlossary(db, "*")).map((g) => g.preferred)).toEqual(["the yard"]);
    // The rule 0.8's page saved under the made-up "default" is the site's own now.
    expect((await listTenantRules(db, "*")).map((r) => r.instruction)).toEqual(["Be brief."]);
    // Messages took their conversation's company; an orphan is gone.
    expect((await getConversation(db, "my-company-hq", "c1"))?.messages.map((m) => m.id)).toEqual(["m1"]);
    expect((await client.query("select id from assistant_config_version")).rows).toEqual([{ id: "*" }]);

    // No default left behind: an insert that forgets the company fails.
    await expect(client.exec("insert into assistant_sections (id, key, label, content) values ('x', 'k', 'K', 'c')")).rejects.toThrow();
    // Two companies may now share a key.
    await client.exec("insert into assistant_sections (id, tenant_id, key, label, content) values ('a1', 'a', 'core_personality', 'K', 'c')");
    // And a 0.9 company assembles with its own guardrails, beside the site's.
    const prompt = await assemblePrompt(db, { tenantId: "green-acres", turnText: "hello" });
    expect(prompt.system).toMatch(/Never compute a number/);
    expect(prompt.system).not.toContain("tuned");
    await client.close();
  });

  it("puts it on the id the site's own assistant used, when told", async () => {
    const client = await at08();
    await client.exec(`select set_config('assistant.upgrade_tenant', 'my-company-hq', false);\n${read("upgrade-0.8-to-0.9.sql")}`);
    const db = drizzle(client) as unknown as AssistantDb;
    expect((await listSections(db, "my-company-hq")).map((s) => s.key)).toEqual(["core_personality"]);
    expect((await listTenantRules(db, "my-company-hq")).map((r) => r.instruction)).toEqual(["Be brief."]);
    expect(await listSections(db, "*")).toEqual([]);
    expect((await client.query("select id, version from assistant_config_version")).rows).toEqual([{ id: "my-company-hq", version: 7 }]);
    await client.close();
  });
});
