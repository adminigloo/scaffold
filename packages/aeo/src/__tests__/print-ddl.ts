// Writes the 0.2 DDL the test database is built from, in the shipped file's
// style — the helper that keeps sql/aeo-0.2.0.sql from drifting from
// ./schema (not a suite): `pnpm tsx src/__tests__/print-ddl.ts > sql/aeo-0.2.0.sql`.
// The SQL test checks the shipped file still builds the same tables.

import { aeoDdl } from "./pglite.js";

const header = `-- @adminigloo/aeo 0.2.0: the AI mentions tables,
-- for a host that doesn't run drizzle-kit. A project made with create-app
-- doesn't need this: its migrations come from the schema.
-- Upgrading from 0.1? Run upgrade-0.1-to-0.2.sql instead.
--
-- Every row carries its company in tenant_id ('*' is the site's own).
`;

const out: string[] = [header];
for (const statement of aeoDdl()) {
  const s = statement
    .replace(/^CREATE TABLE "/, 'create table if not exists "')
    .replace(/^CREATE UNIQUE INDEX "/, 'create unique index if not exists "')
    .replace(/^CREATE INDEX "/, 'create index if not exists "')
    .replace(/ timestamp with time zone/g, " timestamptz")
    .replace(/ PRIMARY KEY/g, " primary key")
    .replace(/ NOT NULL/g, " not null")
    .replace(/ DEFAULT /g, " default ")
    .replace(/ WHERE /g, " where ")
    .replace(/ ON "/g, ' on "');
  // A foreign key has no "if not exists": run twice, the second is a no-op.
  out.push(s.startsWith("ALTER TABLE") ? `do $$ begin\n  ${s};\nexception when duplicate_object then null;\nend $$;` : `${s};`);
}
console.log(out.join("\n\n"));
