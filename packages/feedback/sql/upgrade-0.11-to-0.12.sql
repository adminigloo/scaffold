-- @adminigloo/feedback: upgrade 0.11 -> 0.12 (epics).
--
-- Additions only — nothing is moved, renamed or dropped, and every 0.11 query
-- keeps working on the upgraded tables:
--
--   1. `feedback_epics` is created: each company's epics, with the company on
--      every row, one per name per company (case and spacing don't count).
--      Nobody has any yet.
--   2. Tickets gain `epic_id` (the epic a ticket is part of; empty for every
--      0.11 ticket), pointing at the epic so deleting one clears it on its
--      tickets, and an index for an epic's tickets and the board's Epic filter.
--   3. Columns gain `is_waiting` ("work here waits on someone else"), off for
--      every column. An epic's progress counts a ticket in such a column as
--      waiting; turn it on in the column editor for a column like "Waiting on
--      customer".
--
-- Safe to run twice. A project made with create-app: run `pnpm db:generate`,
-- then `pnpm db:migrate` — its migration comes from the schema, and this file
-- is the same change written out for a host that doesn't run drizzle-kit.

do $$
begin
  if to_regclass('"feedback_tickets"') is null then
    raise exception 'There are no feedback tables to upgrade. Run sql/feedback-0.12.0.sql to create them.';
  end if;
  if to_regclass('"feedback_ticket_events"') is null then
    raise exception 'This is a 0.10 database (or older). Run sql/upgrade-0.10-to-0.11.sql first, then this file.';
  end if;

  -- Step 1: the epics.
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
  create unique index if not exists "feedback_epics_tenant_name_idx"
    on "feedback_epics" ("tenant_id", lower(regexp_replace(btrim("name"), '\s+', ' ', 'g')));

  -- Step 2: a ticket's epic, cleared when the epic is deleted.
  alter table "feedback_tickets" add column if not exists "epic_id" text;
  if not exists (select 1 from pg_constraint where conname = 'feedback_tickets_epic_id_feedback_epics_id_fk') then
    alter table "feedback_tickets" add constraint "feedback_tickets_epic_id_feedback_epics_id_fk"
      foreign key ("epic_id") references "feedback_epics" ("id") on delete set null;
  end if;
  create index if not exists "feedback_tickets_tenant_epic_idx" on "feedback_tickets" ("tenant_id", "epic_id");

  -- Step 3: waiting columns.
  alter table "feedback_statuses" add column if not exists "is_waiting" boolean not null default false;
end $$;
