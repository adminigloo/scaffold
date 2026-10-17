-- @adminigloo/audience 0.2.0: the four tables, under the default prefix
-- (aig_audience_), for a host that doesn't run drizzle-kit. A project made
-- with create-app doesn't need this: its migrations come from the schema.
-- Upgrading from 0.1: nothing to run — 0.2 changes no table.
--
-- Every row carries its company in tenant_id. There is no IP column anywhere.
-- Under another prefix, replace "aig_audience_" throughout.


create table if not exists "aig_audience_rules" (
  "id" text primary key,
  "tenant_id" text not null,
  "kind" text not null,
  "value" text not null,
  "reason_label" text,
  "note" text,
  "created_by" text,
  "created_at" timestamptz not null default now(),
  "disabled_at" timestamptz,
  "disabled_by" text,
  "applies_from" timestamptz
);

create index if not exists "aig_audience_rules_tenant_idx" on "aig_audience_rules" ("tenant_id");

create unique index if not exists "aig_audience_rules_active_uq" on "aig_audience_rules" ("tenant_id", "kind", "value") where disabled_at is null;

create table if not exists "aig_audience_marks" (
  "id" text primary key,
  "tenant_id" text not null,
  "subject_kind" text not null,
  "subject_id" text not null,
  "reason" text not null,
  "rule_id" text,
  "source" text not null,
  "marked_by" text,
  "marked_at" timestamptz not null default now(),
  "cleared_at" timestamptz,
  "cleared_by" text,
  "applies_from" timestamptz,
  CONSTRAINT "aig_audience_marks_rule_fk" FOREIGN KEY ("rule_id") REFERENCES "aig_audience_rules" ("id")
);

create unique index if not exists "aig_audience_marks_active_uq" on "aig_audience_marks" ("tenant_id", "subject_kind", "subject_id", (coalesce(rule_id, reason))) where cleared_at is null;

create index if not exists "aig_audience_marks_rule_idx" on "aig_audience_marks" ("tenant_id", "rule_id");

create table if not exists "aig_audience_links" (
  "tenant_id" text not null,
  "visitor_id" text not null,
  "user_key" text not null,
  "first_seen" timestamptz not null default now(),
  "last_seen" timestamptz not null default now(),
  CONSTRAINT "aig_audience_links_pk" primary key ("tenant_id", "visitor_id", "user_key")
);

create index if not exists "aig_audience_links_user_idx" on "aig_audience_links" ("tenant_id", "user_key");

create table if not exists "aig_audience_runs" (
  "id" text primary key,
  "tenant_id" text not null,
  "rule_id" text,
  "action" text not null,
  "subjects_changed" integer not null default 0,
  "sessions_affected" integer,
  "range_from" timestamptz,
  "range_to" timestamptz,
  "run_by" text,
  "run_at" timestamptz not null default now(),
  "summary" text
);

create index if not exists "aig_audience_runs_tenant_at_idx" on "aig_audience_runs" ("tenant_id", "run_at");
