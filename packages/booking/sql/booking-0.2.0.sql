-- @adminigloo/booking 0.2.0: every table, for a host that doesn't run
-- drizzle-kit. A project made with create-app doesn't need this: its
-- migrations come from the schema.
-- Upgrading from 0.1? Run upgrade-0.1-to-0.2.sql instead.
--
-- Every row carries its business in tenant_id. Tokens are stored as SHA-256
-- only. Safe to run twice.


create table if not exists "booking_hosts" (
  "id" text primary key,
  "tenant_id" text not null,
  "user_id" text,
  "display_name" text not null,
  "email" text not null,
  "timezone" text not null,
  "meeting_link" text,
  "phone" text,
  "invite_mailbox" text,
  "busy_ics_url" text,
  "feed_token_hash" text,
  "auto_confirm" boolean not null default true,
  "is_active" boolean not null default true,
  "busy_sync_error" text,
  "busy_sync_failing_since" timestamptz,
  "busy_sync_ok_at" timestamptz,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

create index if not exists "booking_hosts_tenant_idx" on "booking_hosts" ("tenant_id");

create unique index if not exists "booking_hosts_tenant_user_idx" on "booking_hosts" ("tenant_id", "user_id") where "user_id" is not null;

create unique index if not exists "booking_hosts_feed_token_idx" on "booking_hosts" ("feed_token_hash");

create table if not exists "booking_availability" (
  "id" text primary key,
  "tenant_id" text not null,
  "host_id" text not null,
  "day_of_week" integer not null,
  "start_minute" integer not null,
  "end_minute" integer not null,
  "created_at" timestamptz not null default now(),
  FOREIGN KEY ("host_id") REFERENCES "booking_hosts" ("id") ON DELETE cascade
);

create index if not exists "booking_availability_host_idx" on "booking_availability" ("tenant_id", "host_id");

create table if not exists "booking_exceptions" (
  "id" text primary key,
  "tenant_id" text not null,
  "host_id" text not null,
  "date" date not null,
  "kind" text not null,
  "start_minute" integer,
  "end_minute" integer,
  "note" text,
  "created_at" timestamptz not null default now(),
  FOREIGN KEY ("host_id") REFERENCES "booking_hosts" ("id") ON DELETE cascade
);

create index if not exists "booking_exceptions_host_date_idx" on "booking_exceptions" ("tenant_id", "host_id", "date");

create table if not exists "booking_blackouts" (
  "id" text primary key,
  "tenant_id" text not null,
  "date" date not null,
  "label" text,
  "created_at" timestamptz not null default now()
);

create unique index if not exists "booking_blackouts_tenant_date_idx" on "booking_blackouts" ("tenant_id", "date");

create table if not exists "booking_types" (
  "id" text primary key,
  "tenant_id" text not null,
  "key" text not null,
  "name" text not null,
  "description" text,
  "duration_minutes" integer not null,
  "buffer_before_minutes" integer not null default 0,
  "buffer_after_minutes" integer not null default 0,
  "step_minutes" integer not null default 30,
  "min_notice_minutes" integer not null default 240,
  "horizon_days" integer not null default 21,
  "max_per_day" integer,
  "media" text[] not null default ARRAY['video']::text[],
  "host_ids" text[] not null default ARRAY[]::text[],
  "is_active" boolean not null default true,
  "sort_order" integer not null default 0,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

create unique index if not exists "booking_types_tenant_key_idx" on "booking_types" ("tenant_id", "key");

create table if not exists "booking_bookings" (
  "id" text primary key,
  "tenant_id" text not null,
  "type_id" text not null,
  "host_id" text not null,
  "status" text not null,
  "start_utc" timestamptz not null,
  "end_utc" timestamptz not null,
  "host_timezone" text not null,
  "invitee_timezone" text,
  "hold_token_hash" text,
  "hold_expires_at" timestamptz,
  "hold_subject_hash" text,
  "manage_token_hash" text,
  "invitee_name" text,
  "invitee_email" text,
  "invitee_phone" text,
  "invitee_company" text,
  "notes" text,
  "medium" text,
  "source" text,
  "sequence" integer not null default 0,
  "cancelled_at" timestamptz,
  "cancelled_by" text,
  "cancel_reason" text,
  "outcome" text,
  "reminded_at" timestamptz,
  "reminder_attempts" integer not null default 0,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

create index if not exists "booking_bookings_host_start_idx" on "booking_bookings" ("tenant_id", "host_id", "start_utc");

create index if not exists "booking_bookings_status_start_idx" on "booking_bookings" ("tenant_id", "status", "start_utc");

create index if not exists "booking_bookings_hold_expiry_idx" on "booking_bookings" ("tenant_id", "hold_expires_at");

create index if not exists "booking_bookings_hold_token_idx" on "booking_bookings" ("tenant_id", "hold_token_hash");

create index if not exists "booking_bookings_hold_subject_idx" on "booking_bookings" ("tenant_id", "hold_subject_hash");

create unique index if not exists "booking_bookings_manage_token_idx" on "booking_bookings" ("manage_token_hash");

create table if not exists "booking_events" (
  "id" bigserial primary key,
  "tenant_id" text not null,
  "booking_id" text not null,
  "kind" text not null,
  "actor" text not null,
  "detail" jsonb,
  "at" timestamptz not null default now()
);

create index if not exists "booking_events_booking_idx" on "booking_events" ("tenant_id", "booking_id", "at");
