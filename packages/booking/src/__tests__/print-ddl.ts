// Writes the 0.2 DDL the test database is built from, in the shipped file's
// style — the helper that keeps sql/booking-0.2.0.sql from drifting from
// ./schema (not a suite): `pnpm tsx src/__tests__/print-ddl.ts > sql/booking-0.2.0.sql`.
// The SQL test checks the shipped file still builds the same tables.
import { schemaDdl } from "./pglite.js";

const header = `-- @adminigloo/booking 0.2.0: every table, for a host that doesn't run
-- drizzle-kit. A project made with create-app doesn't need this: its
-- migrations come from the schema.
-- Upgrading from 0.1? Run upgrade-0.1-to-0.2.sql instead.
--
-- Every row carries its business in tenant_id. Tokens are stored as SHA-256
-- only. Safe to run twice.
`;

const out: string[] = [header];
for (const statement of schemaDdl()) {
  const s = statement
    .replace(/^CREATE TABLE "/, 'create table if not exists "')
    .replace(/^CREATE UNIQUE INDEX "/, 'create unique index if not exists "')
    .replace(/^CREATE INDEX "/, 'create index if not exists "')
    .replace(/ timestamp with time zone/g, " timestamptz")
    .replace(/ PRIMARY KEY/g, " primary key")
    .replace(/ NOT NULL/g, " not null")
    .replace(/ DEFAULT /g, " default ")
    .replace(/ ON "/g, ' on "')
    .replace(/ WHERE "[a-z_]+"."([a-z_]+)"/g, ' where "$1"');
  out.push(`${s};`);
}
console.log(out.join("\n\n"));
