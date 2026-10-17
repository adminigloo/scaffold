-- @adminigloo/analytics 0.3.0: every table, under the default prefix (analytics_),
-- for a host that doesn't run drizzle-kit. A project made with create-app
-- doesn't need this: its migrations come from the schema.
-- Upgrading from 0.2? Run upgrade-0.2-to-0.3.sql instead.
--
-- Every row carries its company in tenant_id ('*' is the site's own numbers).
-- No IP address, user agent or cookie is stored anywhere.
-- Under another prefix, replace "analytics_" throughout.


create table if not exists "analytics_sessions" (
  "id" text primary key,
  "tenant_id" text not null,
  "visitor_key" text not null,
  "last_doc_id" text,
  "started_at" timestamptz not null default now(),
  "last_seen_at" timestamptz not null default now(),
  "landing_path" text not null,
  "referrer_host" text,
  "utm_source" text,
  "utm_medium" text,
  "utm_campaign" text,
  "utm_content" text,
  "utm_term" text,
  "click_id_kind" text,
  "source_bucket" text not null,
  "country" text,
  "device" text,
  "browser" text,
  "os" text,
  "page_view_count" integer not null default 0,
  "event_count" integer not null default 0,
  "duration_ms" integer not null default 0,
  "is_engaged" boolean not null default false,
  "converted" boolean not null default false,
  "internal_reason" text,
  "actor_key" text,
  "classifier_version" integer,
  "site_id" text
);

create table if not exists "analytics_page_views" (
  "id" bigserial primary key,
  "session_id" text not null,
  "tenant_id" text not null,
  "path" text not null,
  "content_type" text,
  "content_key" text,
  "sequence" integer not null default 1,
  "occurred_at" timestamptz not null default now()
);

create table if not exists "analytics_events" (
  "id" bigserial primary key,
  "session_id" text not null,
  "tenant_id" text not null,
  "name" text not null,
  "path" text not null,
  "label" text,
  "value" double precision,
  "metric_id" text,
  "occurred_at" timestamptz not null default now()
);

create table if not exists "analytics_crawler_hits" (
  "id" bigserial primary key,
  "tenant_id" text not null,
  "bot_name" text not null,
  "bot_kind" text not null,
  "operator" text,
  "path" text not null,
  "country" text,
  "verified" boolean not null default false,
  "bucket_start" timestamptz not null,
  "hits" integer not null default 1,
  "last_at" timestamptz not null default now()
);

create table if not exists "analytics_salts" (
  "day" text primary key,
  "salt" text not null,
  "created_at" timestamptz not null default now()
);

create table if not exists "analytics_rate" (
  "tenant_id" text not null,
  "net_key" text not null,
  "window_start" timestamptz not null,
  "sessions" integer not null default 0,
  "hits" integer not null default 0,
  CONSTRAINT "analytics_rate_tenant_id_net_key_window_start_pk" primary key ("tenant_id", "net_key", "window_start")
);

create table if not exists "analytics_sites" (
  "tenant_id" text primary key,
  "tracking_since" timestamptz not null default now()
);

create table if not exists "analytics_annotations" (
  "id" text primary key,
  "tenant_id" text not null,
  "day" text not null,
  "label" text not null,
  "kind" text not null default 'note',
  "created_by" text,
  "created_at" timestamptz not null default now()
);

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

create index if not exists "analytics_sessions_tenant_started_idx" on "analytics_sessions" ("tenant_id", "started_at");

create index if not exists "analytics_sessions_tenant_visitor_idx" on "analytics_sessions" ("tenant_id", "visitor_key", "last_seen_at");

create index if not exists "analytics_sessions_tenant_doc_idx" on "analytics_sessions" ("tenant_id", "last_doc_id");

create index if not exists "analytics_sessions_tenant_source_idx" on "analytics_sessions" ("tenant_id", "source_bucket", "started_at");

create index if not exists "analytics_sessions_started_idx" on "analytics_sessions" ("started_at");

create index if not exists "analytics_sessions_tenant_site_idx" on "analytics_sessions" ("tenant_id", "site_id", "started_at");

do $$ begin
  ALTER TABLE "analytics_page_views" ADD CONSTRAINT "analytics_page_views_session_id_analytics_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "analytics_sessions" ("id") ON DELETE cascade ON UPDATE no action;
exception when duplicate_object then null;
end $$;

create index if not exists "analytics_page_views_tenant_time_idx" on "analytics_page_views" ("tenant_id", "occurred_at");

create index if not exists "analytics_page_views_session_idx" on "analytics_page_views" ("session_id");

create index if not exists "analytics_page_views_tenant_path_idx" on "analytics_page_views" ("tenant_id", "path", "occurred_at");

do $$ begin
  ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_session_id_analytics_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "analytics_sessions" ("id") ON DELETE cascade ON UPDATE no action;
exception when duplicate_object then null;
end $$;

create index if not exists "analytics_events_tenant_name_time_idx" on "analytics_events" ("tenant_id", "name", "occurred_at");

create index if not exists "analytics_events_session_idx" on "analytics_events" ("session_id");

create unique index if not exists "analytics_crawler_hits_bucket_idx" on "analytics_crawler_hits" ("tenant_id", "bot_name", "path", "bucket_start", "verified");

create index if not exists "analytics_crawler_hits_tenant_time_idx" on "analytics_crawler_hits" ("tenant_id", "bucket_start");

create index if not exists "analytics_crawler_hits_bucket_time_idx" on "analytics_crawler_hits" ("bucket_start");

create index if not exists "analytics_annotations_tenant_day_idx" on "analytics_annotations" ("tenant_id", "day");

create unique index if not exists "analytics_websites_key_idx" on "analytics_websites" ("site_key");

create index if not exists "analytics_websites_tenant_idx" on "analytics_websites" ("tenant_id", "created_at");
