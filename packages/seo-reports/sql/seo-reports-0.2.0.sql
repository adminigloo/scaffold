-- @adminigloo/seo-reports 0.2.0: the search check table,
-- for a host that doesn't run drizzle-kit. A project made with create-app
-- doesn't need this: its migrations come from the schema.
-- Upgrading from 0.1? Run upgrade-0.1-to-0.2.sql instead.
--
-- Every row carries its company in tenant_id ('*' is the site's own checks).


create table if not exists "seo_reports" (
  "id" text primary key,
  "tenant_id" text not null,
  "status" text not null default 'done',
  "trigger" text not null default 'manual',
  "requested_by" text,
  "base_url" text not null,
  "addresses" jsonb not null default '[]'::jsonb,
  "started_at" timestamptz not null,
  "finished_at" timestamptz not null,
  "score" integer not null,
  "seo_score" integer not null,
  "aeo_score" integer not null,
  "page_count" integer not null,
  "pass_count" integer not null default 0,
  "warn_count" integer not null default 0,
  "fail_count" integer not null default 0,
  "stopped" text,
  "error" text,
  "site_checks" jsonb not null,
  "pages" jsonb not null,
  "created_at" timestamptz not null default now()
);

create index if not exists "seo_reports_tenant_started_idx" on "seo_reports" ("tenant_id", "started_at");
