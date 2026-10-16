-- @adminigloo/feedback: upgrade 0.10 -> 0.11 (the complete board).
--
-- Additions only — nothing is moved, renamed or dropped, and every 0.10 query
-- keeps working on the upgraded tables:
--
--   1. Tickets gain `assignee_id` (the person picked from the company's people,
--      what the "Assigned to" and "Mine" filters match), `source` (where the
--      ticket came from: the feedback button, the company's feedback page, or
--      the team) and `created_by` (who on the team filed it). Every 0.10
--      ticket arrived through the intake, so `source` is 'widget' for all of
--      them — including ones sent from a company's feedback page, which 0.10
--      didn't record. Tickets assigned in 0.10 keep their typed name; their
--      `assignee_id` stays empty until someone picks a person.
--      They also gain `notify_reporter` (is the reporter emailed about it): true
--      for every 0.10 ticket, as before.
--   2. `feedback_ticket_events` is created: each ticket's activity trail, with
--      the company on every row. 0.10 tickets start with an empty trail.
--   3. `feedback_boards` is created and every board that already has columns
--      AND categories is marked as set up, so its defaults never come back. (A
--      board missing one list gets it the next time it opens, as in 0.10, and
--      is marked then.)
--
-- Assignees typed by name in 0.10 are linked to the person with that name
-- (when exactly one has it) by the package itself, the first time each
-- board is opened (`linkTypedAssignees`): the people live in your app's own
-- tables, which this file can't see.
--
-- Safe to run twice. A project made with create-app: run `pnpm db:generate`,
-- then `pnpm db:migrate` — its migration comes from the schema, and this file
-- is the same change written out for a host that doesn't run drizzle-kit.

do $$
begin
  if to_regclass('"feedback_tickets"') is null then
    raise exception 'There are no feedback tables to upgrade. Run sql/feedback-0.11.0.sql to create them.';
  end if;
  if not exists (
    select 1 from pg_attribute
     where attrelid = to_regclass('"feedback_statuses"') and attname = 'tenant_id' and attnum > 0 and not attisdropped
  ) then
    raise exception 'This is a 0.9 database. Run sql/upgrade-0.9-to-0.10.sql first, then this file.';
  end if;

  -- Step 1: tickets.
  alter table "feedback_tickets" add column if not exists "assignee_id" text;
  alter table "feedback_tickets" add column if not exists "source" text not null default 'widget';
  alter table "feedback_tickets" add column if not exists "created_by" text;
  alter table "feedback_tickets" add column if not exists "notify_reporter" boolean not null default true;

  -- Step 2: the activity trail.
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
  create index if not exists "feedback_ticket_events_ticket_idx"
    on "feedback_ticket_events" ("tenant_id", "ticket_id", "created_at");

  -- Step 3: boards already set up stay set up.
  create table if not exists "feedback_boards" (
    "tenant_id" text primary key,
    "created_at" timestamptz not null default now()
  );
  insert into "feedback_boards" ("tenant_id")
    select "tenant_id" from "feedback_statuses"
    intersect select "tenant_id" from "feedback_categories"
  on conflict do nothing;
end $$;
