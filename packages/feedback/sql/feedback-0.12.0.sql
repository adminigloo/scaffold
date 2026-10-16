-- @adminigloo/feedback 0.12.0: every table, for a host that doesn't run drizzle-kit.
-- A project made with create-app doesn't need this: its migrations come from the schema.
-- Upgrading? From 0.11 run upgrade-0.11-to-0.12.sql; from 0.10, upgrade-0.10-to-0.11.sql and then that;
-- from 0.9, upgrade-0.9-to-0.10.sql first.

create table if not exists "feedback_client_keys" (
  "id" text primary key,
  "tenant_id" text not null,
  "key_hash" text not null,
  "label" text not null,
  "created_at" timestamptz not null default now(),
  "revoked_at" timestamptz
);
create unique index if not exists "feedback_client_keys_key_hash_idx" on "feedback_client_keys" ("key_hash");
create index if not exists "feedback_client_keys_tenant_idx" on "feedback_client_keys" ("tenant_id");

-- Each company's board columns. '*' is the platform's own board. No default:
-- an insert that forgets the company fails instead of landing on '*'.
create table if not exists "feedback_statuses" (
  "id" text primary key,
  "tenant_id" text not null,
  "key" text not null,
  "label" text not null,
  "color" text,
  "sort_order" integer not null default 0,
  "is_terminal" boolean not null default false,
  "is_waiting" boolean not null default false,
  "wip_limit" integer,
  "aging_warn_hours" integer,
  "aging_stale_hours" integer,
  "allow_ai_transition" boolean not null default false,
  "created_at" timestamptz not null default now()
);
create unique index if not exists "feedback_statuses_tenant_key_idx" on "feedback_statuses" ("tenant_id", "key");

-- Each company's categories (the widget's dropdown).
create table if not exists "feedback_categories" (
  "id" text primary key,
  "tenant_id" text not null,
  "key" text not null,
  "label" text not null,
  "description" text,
  "sort_order" integer not null default 0,
  "show_to_customer" boolean not null default true,
  "created_at" timestamptz not null default now()
);
create unique index if not exists "feedback_categories_tenant_key_idx" on "feedback_categories" ("tenant_id", "key");

-- Each company's epics: bigger pieces of work its tickets are grouped under.
-- One per name per company (case and spacing don't count).
create table if not exists "feedback_epics" (
  "id" text primary key,
  "tenant_id" text not null,
  "name" text not null,
  "description" text,
  "status" text not null default 'open',
  "owner_id" text,
  "owner_name" text,
  "target_date" date,
  "color" text not null default 'blue',
  "completed_at" timestamptz,
  "archived_at" timestamptz,
  "created_by" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);
create index if not exists "feedback_epics_tenant_idx" on "feedback_epics" ("tenant_id", "status");
create unique index if not exists "feedback_epics_tenant_name_idx" on "feedback_epics" ("tenant_id", lower(regexp_replace(btrim("name"), '\s+', ' ', 'g')));

-- Tickets, numbered per company. A ticket's epic is cleared when the epic is deleted.
create table if not exists "feedback_tickets" (
  "id" text primary key,
  "tenant_id" text not null,
  "ticket_number" text not null,
  "title" text not null,
  "description" text not null,
  "priority" text not null default 'medium',
  "category" text,
  "status" text not null default 'open',
  "screenshot_url" text,
  "annotated_screenshot_url" text,
  "reporter_name" text,
  "reporter_email" text,
  "assignee" text,
  "assignee_id" text,
  "source" text not null default 'widget',
  "created_by" text,
  "notify_reporter" boolean not null default true,
  "epic_id" text constraint "feedback_tickets_epic_id_feedback_epics_id_fk" references "feedback_epics" ("id") on delete set null,
  "reporter_token_hash" text,
  "last_staff_read_at" timestamptz,
  "status_changed_at" timestamptz,
  "archived_at" timestamptz,
  "archived_by" text,
  "page_pathname" text,
  "client_metadata" jsonb,
  "recent_errors" jsonb,
  "created_at" timestamptz not null default now()
);
create unique index if not exists "feedback_tickets_tenant_number_idx" on "feedback_tickets" ("tenant_id", "ticket_number");
create index if not exists "feedback_tickets_tenant_idx" on "feedback_tickets" ("tenant_id");
create index if not exists "feedback_tickets_status_idx" on "feedback_tickets" ("status");
create index if not exists "feedback_tickets_created_idx" on "feedback_tickets" ("created_at");
create index if not exists "feedback_tickets_archived_idx" on "feedback_tickets" ("archived_at");
create index if not exists "feedback_tickets_tenant_epic_idx" on "feedback_tickets" ("tenant_id", "epic_id");


-- The conversation on each ticket (reached through its ticket's company).
create table if not exists "feedback_messages" (
  "id" text primary key,
  "ticket_id" text not null references "feedback_tickets" ("id") on delete cascade,
  "sender_type" text not null,
  "sender_name" text not null,
  "body" text not null,
  "created_at" timestamptz not null default now()
);
create index if not exists "feedback_messages_ticket_idx" on "feedback_messages" ("ticket_id", "created_at");

-- Which companies' boards have had their default columns and categories (once, ever).
create table if not exists "feedback_boards" (
  "tenant_id" text primary key,
  "created_at" timestamptz not null default now()
);

-- Each ticket's activity trail: what changed, by whom (carries the company).
create table if not exists "feedback_ticket_events" (
  "id" text primary key,
  "tenant_id" text not null,
  "ticket_id" text not null references "feedback_tickets" ("id") on delete cascade,
  "kind" text not null,
  "from_value" text,
  "to_value" text,
  "actor_id" text,
  "actor_name" text not null,
  "created_at" timestamptz not null default now()
);
create index if not exists "feedback_ticket_events_ticket_idx" on "feedback_ticket_events" ("tenant_id", "ticket_id", "created_at");

-- Every screenshot the intake took, until a report uses it (swept after a day otherwise).
create table if not exists "feedback_uploads" (
  "id" text primary key,
  "tenant_id" text not null,
  "url" text not null,
  "file_id" text,
  "kind" text not null,
  "content_type" text not null,
  "size_bytes" integer not null,
  "ticket_id" text,
  "created_at" timestamptz not null default now()
);
create unique index if not exists "feedback_uploads_tenant_url_idx" on "feedback_uploads" ("tenant_id", "url");
create index if not exists "feedback_uploads_created_idx" on "feedback_uploads" ("created_at");
