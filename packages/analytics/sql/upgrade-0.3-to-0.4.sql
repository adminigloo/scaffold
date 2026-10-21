-- @adminigloo/analytics: upgrade 0.3 -> 0.4 (past visits brought in from records).
--
-- One addition, nothing rewritten, nothing dropped: analytics_sessions gets
-- import_key (nullable, no default) — the importer's own key for a visit
-- brought in by `importVisits`, unique per company, so importing the same
-- file twice brings each visit in once. Every existing row keeps null.
--
-- Under another prefix (aig_analytics_ …), replace "analytics_" throughout.
-- A project made with create-app gets the same from `pnpm db:generate`.
--
-- Safe to run twice.

alter table "analytics_sessions" add column if not exists "import_key" text;

create unique index if not exists "analytics_sessions_tenant_import_idx" on "analytics_sessions" ("tenant_id", "import_key") where import_key is not null;
