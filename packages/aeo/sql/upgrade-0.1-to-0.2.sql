-- @adminigloo/aeo 0.1 -> 0.2: who the business is moves to one row per
-- company (aeo_profiles), and every answer keeps what code found in it.
--
-- Each company's profile is taken from its newest 0.1 question (0.1 kept the
-- brand on every question). Nothing is deleted; every statement is safe to
-- run twice.

create table if not exists "aeo_profiles" (
  "tenant_id" text primary key,
  "brand" text not null,
  "domain" text,
  "aliases" jsonb not null default '[]'::jsonb,
  "competitors" jsonb not null default '[]'::jsonb,
  "updated_by" text,
  "updated_at" timestamptz not null default now()
);

insert into "aeo_profiles" ("tenant_id", "brand", "domain", "aliases")
select distinct on ("tenant_id") "tenant_id", "brand", "domain", "aliases"
  from "aeo_queries"
 where "brand" is not null and trim("brand") <> ''
 order by "tenant_id", "created_at" desc
on conflict ("tenant_id") do nothing;

-- 0.2 questions don't carry the brand (the profile does).
alter table "aeo_queries" alter column "brand" drop not null;
alter table "aeo_queries" add column if not exists "created_by" text;

alter table "aeo_checks" add column if not exists "model" text;
alter table "aeo_checks" add column if not exists "status" text not null default 'done';
alter table "aeo_checks" add column if not exists "trigger" text not null default 'manual';
alter table "aeo_checks" add column if not exists "mentioned" boolean not null default false;
alter table "aeo_checks" add column if not exists "source_cited" boolean not null default false;
alter table "aeo_checks" add column if not exists "matched_url" text;
alter table "aeo_checks" add column if not exists "cited_urls" jsonb not null default '[]'::jsonb;
alter table "aeo_checks" add column if not exists "competitors_named" jsonb not null default '[]'::jsonb;
alter table "aeo_checks" add column if not exists "cost_micros" bigint;
alter table "aeo_checks" add column if not exists "error" text;

-- 0.1's "cited" meant "named in the words": say so in 0.2's column too.
update "aeo_checks" set "mentioned" = true where "cited" and not "mentioned" and "model" is null;

create index if not exists "aeo_checks_tenant_idx" on "aeo_checks" ("tenant_id", "checked_at");
