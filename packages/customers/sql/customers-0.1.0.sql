-- @adminigloo/customers 0.1.0: one customer list per company.
--
-- RUN THIS BEFORE YOU DEPLOY a project with the customer list (or let
-- `pnpm db:generate` write the same from the drizzle tables). New tables
-- only; nothing of any other package is changed. Safe to run twice.
--
--   1. customers: each company's customers — name, company name, every email
--      and phone they've used, their match keys (Gmail's dots and +tags
--      folded), notes, tags, where they came from, and who they were merged
--      into. The first email and first phone are unique per company among
--      customers not merged away: two requests making the same new customer
--      at once make one.
--   2. customer_addresses: their addresses, one row per address.
--   3. customer_links: what is theirs — one row per thing that happened to a
--      quote, visit, invoice, call, order or message (each time it happened:
--      a visit moved twice is two rows), once per company.
--   4. customer_merges: every merge, with the merged customer as it was.
--   5. customer_notices: what waits for staff on a record — new details a
--      public form brought (never applied until someone presses Add), a
--      possible duplicate (a form that matched only by phone), a detail
--      another customer already has.
--
-- Then fill the timelines from what each company already has:
--   pnpm customers:backfill        (a project made with create-app)

create table if not exists "customers" (
  "id" text primary key,
  "tenant_id" text not null,
  "name" text not null,
  "company_name" text,
  "emails" jsonb default '[]'::jsonb not null,
  "phones" jsonb default '[]'::jsonb not null,
  "match_keys" jsonb default '[]'::jsonb not null,
  "email_key" text,
  "phone_key" text,
  "notes" text,
  "tags" jsonb default '[]'::jsonb not null,
  "created_from" text default 'staff' not null,
  "merged_into" text,
  "last_activity_at" timestamp with time zone,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null
);

create unique index if not exists "customers_tenant_email_key_uidx" on "customers" ("tenant_id", "email_key") where "email_key" is not null and "merged_into" is null;
create unique index if not exists "customers_tenant_phone_key_uidx" on "customers" ("tenant_id", "phone_key") where "phone_key" is not null and "merged_into" is null;
create index if not exists "customers_tenant_activity_idx" on "customers" ("tenant_id", "last_activity_at");
create index if not exists "customers_tenant_name_idx" on "customers" ("tenant_id", "name");

create table if not exists "customer_addresses" (
  "id" text primary key,
  "tenant_id" text not null,
  "customer_id" text not null references "customers"("id") on delete cascade,
  "label" text,
  "text" text not null,
  "match_key" text not null,
  "created_at" timestamp with time zone default now() not null
);

create unique index if not exists "customer_addresses_customer_key_uidx" on "customer_addresses" ("tenant_id", "customer_id", "match_key");
create index if not exists "customer_addresses_tenant_idx" on "customer_addresses" ("tenant_id");

create table if not exists "customer_links" (
  "id" text primary key,
  "tenant_id" text not null,
  "customer_id" text not null references "customers"("id") on delete cascade,
  "kind" text not null,
  "ref_id" text not null,
  "action" text default 'linked' not null,
  "occurrence" text default '' not null,
  "occurred_at" timestamp with time zone not null,
  "summary" text not null,
  "created_at" timestamp with time zone default now() not null
);

create unique index if not exists "customer_links_ref_uidx" on "customer_links" ("tenant_id", "kind", "ref_id", "action", "occurrence");
create index if not exists "customer_links_timeline_idx" on "customer_links" ("tenant_id", "customer_id", "occurred_at");

create table if not exists "customer_merges" (
  "id" text primary key,
  "tenant_id" text not null,
  "kept_id" text not null,
  "merged_id" text not null,
  "merged_by" text,
  "snapshot" jsonb not null,
  "links_moved" integer default 0 not null,
  "created_at" timestamp with time zone default now() not null
);

create index if not exists "customer_merges_tenant_idx" on "customer_merges" ("tenant_id", "kept_id");

create table if not exists "customer_notices" (
  "id" text primary key,
  "tenant_id" text not null,
  "customer_id" text not null references "customers"("id") on delete cascade,
  "kind" text not null,
  "other_customer_id" text,
  "details" jsonb default '{}'::jsonb not null,
  "source_label" text,
  "dedupe_key" text not null,
  "created_at" timestamp with time zone default now() not null,
  "resolved_at" timestamp with time zone,
  "resolution" text,
  "resolved_by" text
);

create unique index if not exists "customer_notices_dedupe_uidx" on "customer_notices" ("tenant_id", "customer_id", "dedupe_key");
create index if not exists "customer_notices_open_idx" on "customer_notices" ("tenant_id", "customer_id", "resolved_at");
