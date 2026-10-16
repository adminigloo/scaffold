-- @adminigloo/notifications 0.2.0: the alert tables.
-- Tables: notifications, notification_choices, notification_routing.
-- One statement: the guards first, then every table and index. If a guard finds a table of the
-- same name that isn't AdminIgloo's, it stops with a sentence saying so, and nothing is created.
-- With Prisma, use notificationsSql({ schema: "adminigloo" }) instead: Prisma drops tables in public that schema.prisma has no model for.

do $$ begin
  if to_regclass('"notifications"') is not null and not (
    array(select attname::text from pg_attribute where attrelid = to_regclass('"notifications"') and attnum > 0 and not attisdropped)
      @> array['id', 'tenant_id', 'recipient_id', 'reached_via', 'kind', 'title', 'body', 'href', 'dedupe_key', 'subject_type', 'subject_id', 'actor_id', 'read_at', 'created_at', 'email_status', 'email_to', 'email_attempts', 'email_next_at', 'email_claimed_at', 'emailed_at', 'email_error']::text[]
  ) then
    raise exception 'A table named notifications already exists and isn''t AdminIgloo''s 0.2 table. If it is AdminIgloo''s 0.1 table, run sql/upgrade-0.1-to-0.2.sql; otherwise pass a prefix or a schema.';
  end if;

  if to_regclass('"notification_choices"') is not null and not (
    array(select attname::text from pg_attribute where attrelid = to_regclass('"notification_choices"') and attnum > 0 and not attisdropped)
      @> array['tenant_id', 'user_id', 'kind', 'channel', 'updated_at']::text[]
  ) then
    raise exception 'A table named notification_choices already exists and isn''t AdminIgloo''s. Pass a prefix or a schema.';
  end if;

  if to_regclass('"notification_routing"') is not null and not (
    array(select attname::text from pg_attribute where attrelid = to_regclass('"notification_routing"') and attnum > 0 and not attisdropped)
      @> array['tenant_id', 'routing', 'mode', 'user_ids', 'extra_emails', 'updated_at', 'updated_by']::text[]
  ) then
    raise exception 'A table named notification_routing already exists and isn''t AdminIgloo''s. Pass a prefix or a schema.';
  end if;

  create table if not exists "notifications" (
    "id" text primary key,
    "tenant_id" text not null default '*',
    "recipient_id" text not null,
    "reached_via" text not null default 'audience',
    "kind" text not null,
    "title" text not null,
    "body" text,
    "href" text,
    "dedupe_key" text,
    "subject_type" text,
    "subject_id" text,
    "actor_id" text,
    "read_at" timestamptz,
    "created_at" timestamptz not null default now(),
    "email_status" text not null default 'none',
    "email_to" text,
    "email_attempts" integer not null default 0,
    "email_next_at" timestamptz,
    "email_claimed_at" timestamptz,
    "emailed_at" timestamptz,
    "email_error" text
  );

  create index if not exists "notifications_recipient_created_idx" on "notifications" ("recipient_id", "created_at");
  create index if not exists "notifications_recipient_read_idx" on "notifications" ("recipient_id", "read_at");
  create unique index if not exists "notifications_dedupe_uidx" on "notifications" ("tenant_id", "recipient_id", "dedupe_key");
  create index if not exists "notifications_inbox_idx" on "notifications" ("tenant_id", "recipient_id", "created_at", "id");
  create index if not exists "notifications_unread_idx" on "notifications" ("tenant_id", "recipient_id") where "read_at" is null;
  create index if not exists "notifications_email_due_idx" on "notifications" ("email_next_at") where "email_status" in ('pending', 'sending');
  create index if not exists "notifications_dedupe_lookup_idx" on "notifications" ("tenant_id", "dedupe_key");
  create index if not exists "notifications_created_idx" on "notifications" ("created_at");

  create table if not exists "notification_choices" (
    "tenant_id" text not null,
    "user_id" text not null,
    "kind" text not null,
    "channel" text not null,
    "updated_at" timestamptz not null default now(),
    constraint "notification_choices_pk" primary key ("tenant_id", "user_id", "kind")
  );

  create table if not exists "notification_routing" (
    "tenant_id" text not null,
    "routing" text not null,
    "mode" text not null default 'owner',
    "user_ids" text[] not null default '{}',
    "extra_emails" text[] not null default '{}',
    "updated_at" timestamptz not null default now(),
    "updated_by" text,
    constraint "notification_routing_pk" primary key ("tenant_id", "routing")
  );
end $$;
