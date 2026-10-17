// Writes the audience's four tables in the shipped file's style — the helper
// that keeps sql/audience-0.2.0.sql from drifting from ./schema (not a suite):
// `pnpm tsx src/__tests__/print-ddl.ts > sql/audience-0.2.0.sql`.
import { defineAudienceTables } from "../schema.js";
import { audienceDdl } from "./pglite.js";

const header = `-- @adminigloo/audience 0.2.0: the four tables, under the default prefix
-- (aig_audience_), for a host that doesn't run drizzle-kit. A project made
-- with create-app doesn't need this: its migrations come from the schema.
-- Upgrading from 0.1: nothing to run — 0.2 changes no table.
--
-- Every row carries its company in tenant_id. There is no IP column anywhere.
-- Under another prefix, replace "aig_audience_" throughout.
`;

const out: string[] = [header];
for (const statement of audienceDdl(defineAudienceTables())) {
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
