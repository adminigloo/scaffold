-- @adminigloo/notifications: upgrade 0.1 -> 0.2 (the default table names).
-- 0.1's rows become the firm-wide staff inbox (tenant_id '*'); no company's bell shows them.
-- One statement: the guards first. If the table named notifications isn't AdminIgloo's 0.1 table,
-- it stops with a sentence saying so, and nothing is altered or created.

do $$ begin
  if to_regclass('"notifications"') is null then
    raise exception 'There''s no table named notifications to upgrade. Run sql/notifications-0.2.0.sql to create it.';
  end if;
  if not (
    (array(select attname::text from pg_attribute where attrelid = to_regclass('"notifications"') and attnum > 0 and not attisdropped) @> array['id', 'recipient_id', 'kind', 'title', 'body', 'href', 'read_at', 'created_at']::text[]
      and array(select attname::text from pg_attribute where attrelid = to_regclass('"notifications"') and attnum > 0 and not attisdropped) <@ array['id', 'recipient_id', 'kind', 'title', 'body', 'href', 'read_at', 'created_at']::text[]
      and exists (
        select 1 from pg_index i join pg_class c on c.oid = i.indexrelid
         where i.indrelid = to_regclass('"notifications"') and c.relname = 'notifications_recipient_created_idx'
      ))
    or array(select attname::text from pg_attribute where attrelid = to_regclass('"notifications"') and attnum > 0 and not attisdropped) @> array['id', 'tenant_id', 'recipient_id', 'reached_via', 'kind', 'title', 'body', 'href', 'dedupe_key', 'subject_type', 'subject_id', 'actor_id', 'read_at', 'created_at', 'email_status', 'email_to', 'email_attempts', 'email_next_at', 'email_claimed_at', 'emailed_at', 'email_error']::text[]
  ) then
    raise exception 'The table named notifications isn''t AdminIgloo''s 0.1 table. Pass a prefix or a schema and run notificationsSql() instead.';
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

  alter table "notifications"
    add column if not exists "tenant_id" text not null default '*',
    add column if not exists "reached_via" text not null default 'audience',
    add column if not exists "dedupe_key" text,
    add column if not exists "subject_type" text,
    add column if not exists "subject_id" text,
    add column if not exists "actor_id" text,
    add column if not exists "email_status" text not null default 'none',
    add column if not exists "email_to" text,
    add column if not exists "email_attempts" integer not null default 0,
    add column if not exists "email_next_at" timestamptz,
    add column if not exists "email_claimed_at" timestamptz,
    add column if not exists "emailed_at" timestamptz,
    add column if not exists "email_error" text;

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
