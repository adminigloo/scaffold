-- @adminigloo/feedback: upgrade 0.9 -> 0.10 (a feedback board per company).
--
-- 0.9 HAD ONE BOARD: the install's own. Every column, category, website key
-- and ticket in a 0.9 database is on it — whatever company id a 0.9 key was
-- issued under (0.9's issue-key script asked for one), because a company had
-- no board of its own to see it on, and company website keys didn't exist
-- before 0.10. So the upgrade puts ALL of it on '*', the platform's own board
-- (FEEDBACK_PLATFORM_BOARD):
--
--   1. Every website key and every ticket (with its conversation) moves to
--      '*'. The site's own feedback button keeps working with the key it has,
--      and its tickets keep feeding the site's own board. No company's board
--      shows another company's users' reports.
--   2. Columns and categories get a company column, filled with '*' for every
--      existing row, then its default is dropped: from 0.10 an insert that
--      forgets the company fails instead of landing on '*'.
--   3. Column and category keys, and ticket numbers, become unique per
--      company. 0.9's numbers were unique across the install, so they stay
--      unique on '*'.
--   4. The screenshots table (feedback_uploads) is created.
--
-- Step 1 runs ONLY on a 0.9 database (its columns table has no company column
-- yet), so running this file a second time, after companies have boards and
-- keys of their own, moves nothing. All of it runs in one statement: all of
-- it, or none of it.
--
-- A project made with create-app: run `pnpm db:generate`, then replace the
-- feedback statements in the migration it wrote with this file's contents
-- (see the generated DEPLOYMENT.md, "Upgrading").

do $$
declare
  from_09 boolean;
begin
  if to_regclass('"feedback_statuses"') is null or to_regclass('"feedback_tickets"') is null then
    raise exception 'There are no feedback tables to upgrade. Run sql/feedback-0.10.0.sql to create them.';
  end if;

  from_09 := not exists (
    select 1 from pg_attribute
     where attrelid = to_regclass('"feedback_statuses"') and attname = 'tenant_id' and attnum > 0 and not attisdropped
  );

  if from_09 then
    -- Step 1: everything 0.9 had is the site's own board.
    if to_regclass('"feedback_client_keys"') is not null then
      update "feedback_client_keys" set "tenant_id" = '*';
    end if;
    update "feedback_tickets" set "tenant_id" = '*';
  end if;

  -- Step 2: columns.
  alter table "feedback_statuses" add column if not exists "tenant_id" text not null default '*';
  alter table "feedback_statuses" alter column "tenant_id" drop default;
  drop index if exists "feedback_statuses_key_idx";
  create unique index if not exists "feedback_statuses_tenant_key_idx" on "feedback_statuses" ("tenant_id", "key");

  -- Step 2: categories (a 0.6 install never made the table).
  if to_regclass('"feedback_categories"') is null then
    create table "feedback_categories" (
      "id" text primary key,
      "tenant_id" text not null,
      "key" text not null,
      "label" text not null,
      "description" text,
      "sort_order" integer not null default 0,
      "show_to_customer" boolean not null default true,
      "created_at" timestamptz not null default now()
    );
  else
    alter table "feedback_categories" add column if not exists "tenant_id" text not null default '*';
    alter table "feedback_categories" alter column "tenant_id" drop default;
  end if;
  drop index if exists "feedback_categories_key_idx";
  create unique index if not exists "feedback_categories_tenant_key_idx" on "feedback_categories" ("tenant_id", "key");

  -- Step 3: ticket numbers per company.
  drop index if exists "feedback_tickets_number_idx";
  create unique index if not exists "feedback_tickets_tenant_number_idx" on "feedback_tickets" ("tenant_id", "ticket_number");

  -- Step 4: screenshots.
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
end $$;
