-- @adminigloo/aeo 0.2.0: the AI mentions tables,
-- for a host that doesn't run drizzle-kit. A project made with create-app
-- doesn't need this: its migrations come from the schema.
-- Upgrading from 0.1? Run upgrade-0.1-to-0.2.sql instead.
--
-- Every row carries its company in tenant_id ('*' is the site's own).


create table if not exists "aeo_profiles" (
  "tenant_id" text primary key,
  "brand" text not null,
  "domain" text,
  "aliases" jsonb not null default '[]'::jsonb,
  "competitors" jsonb not null default '[]'::jsonb,
  "updated_by" text,
  "updated_at" timestamptz not null default now()
);

create table if not exists "aeo_queries" (
  "id" text primary key,
  "tenant_id" text not null,
  "query" text not null,
  "brand" text,
  "domain" text,
  "aliases" jsonb not null default '[]'::jsonb,
  "is_active" boolean not null default true,
  "created_by" text,
  "created_at" timestamptz not null default now()
);

create table if not exists "aeo_checks" (
  "id" text primary key,
  "tenant_id" text not null,
  "query_id" text not null,
  "engine" text not null,
  "model" text,
  "status" text not null default 'done',
  "trigger" text not null default 'manual',
  "cited" boolean not null,
  "mentioned" boolean not null default false,
  "source_cited" boolean not null default false,
  "matched_on" text,
  "matched_url" text,
  "answer_snippet" text,
  "cited_urls" jsonb not null default '[]'::jsonb,
  "competitors_named" jsonb not null default '[]'::jsonb,
  "cost_micros" bigint,
  "error" text,
  "checked_at" timestamptz not null default now(),
  "created_at" timestamptz not null default now()
);

create index if not exists "aeo_queries_tenant_idx" on "aeo_queries" ("tenant_id", "is_active");

create index if not exists "aeo_checks_query_idx" on "aeo_checks" ("query_id", "checked_at");

create index if not exists "aeo_checks_tenant_idx" on "aeo_checks" ("tenant_id", "checked_at");
