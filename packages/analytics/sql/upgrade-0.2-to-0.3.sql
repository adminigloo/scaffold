-- @adminigloo/analytics: upgrade 0.2 -> 0.3 (every company's websites).
--
-- Two additions, nothing rewritten, nothing dropped:
--
--   1. analytics_sessions gets site_id (nullable, no default): which of a
--      company's registered websites a visit landed on. Every existing row
--      keeps null, which means "the tenant's own pages here" — exactly what
--      0.2 recorded — so every report gives the same numbers as before.
--   2. analytics_websites, the site register: a company's websites, their
--      web addresses and the public site key each snippet carries.
--
-- Under another prefix (aig_analytics_ …), replace "analytics_" throughout.
-- A project made with create-app gets the same from `pnpm db:generate`.
--
-- Safe to run twice.

alter table "analytics_sessions" add column if not exists "site_id" text;

create index if not exists "analytics_sessions_tenant_site_idx" on "analytics_sessions" ("tenant_id", "site_id", "started_at");

create table if not exists "analytics_websites" (
  "id" text primary key,
  "tenant_id" text not null,
  "name" text not null,
  "domains" text[] not null,
  "site_key" text not null,
  "created_by" text,
  "created_at" timestamptz not null default now(),
  "removed_at" timestamptz
);

create unique index if not exists "analytics_websites_key_idx" on "analytics_websites" ("site_key");

create index if not exists "analytics_websites_tenant_idx" on "analytics_websites" ("tenant_id", "created_at");
