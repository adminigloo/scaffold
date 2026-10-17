// Writes the 0.9 DDL the test database is built from, in the shipped file's
// style — the helper that keeps sql/assistant-0.9.0.sql from drifting from
// ./schema (not a suite): `pnpm tsx src/__tests__/print-ddl.ts > sql/assistant-0.9.0.sql`.
// The upgrade test checks the shipped file still builds the same tables.
import { schemaDdl } from "./pglite.js";

const header = `-- @adminigloo/assistant 0.9.0: every table, for a host that doesn't run drizzle-kit.
-- A project made with create-app doesn't need this: its migrations come from the schema.
-- Upgrading from 0.8? Run upgrade-0.8-to-0.9.sql instead.
--
-- Every company's rows carry its id in tenant_id ('*' is the site's own
-- assistant). No default on any of them: an insert that forgets the company
-- fails instead of landing on the site's own assistant.
--
-- No database extension is needed. Vector search is optional: see
-- assistant-vector-0.9.0.sql (pgvector).
`;

const out: string[] = [header];
// assistant_sections first: assistant_section_versions references it.
const statements = schemaDdl().sort((a, b) => Number(!/"assistant_sections"/.test(a)) - Number(!/"assistant_sections"/.test(b)));
for (const statement of statements) {
  let s = statement
    .replace(/^CREATE TABLE "/, 'create table if not exists "')
    .replace(/^CREATE UNIQUE INDEX "/, 'create unique index if not exists "')
    .replace(/^CREATE INDEX "/, 'create index if not exists "')
    .replace(/ timestamp with time zone/g, " timestamptz")
    .replace(/ PRIMARY KEY/g, " primary key")
    .replace(/ NOT NULL/g, " not null")
    .replace(/ DEFAULT /g, " default ")
    .replace(/ WHERE /g, " where ")
    .replace(/ ON "/g, ' on "');
  if (s.startsWith('create table if not exists "assistant_section_versions"')) {
    s = s.replace('"section_id" text not null', '"section_id" text not null references "assistant_sections" ("id") on delete cascade');
  }
  out.push(`${s};`);
}
console.log(out.join("\n\n"));
