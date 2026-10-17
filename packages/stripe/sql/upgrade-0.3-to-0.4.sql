-- @adminigloo/stripe: upgrade 0.3 -> 0.4 (Connect: companies take card payments from their own customers).
--
-- RUN THIS BEFORE YOU DEPLOY 0.4 if the site's companies take card payments
-- (create-app with --invoicing in a companies project reads this table on
-- every invoice page).
--
-- One new table; stripe_events is unchanged — Connect events are ledgered in
-- it under "<account>:<event>" keys, beside the platform's own.
--
-- Every account a company ever connected is kept (refunds and disputes on an
-- old one still find the company); one is active at a time.
--
-- A project made with create-app gets the same from `pnpm db:generate`.
-- Safe to run twice.

create table if not exists "stripe_connected_accounts" (
  "id" text primary key,
  "tenant_id" text not null,
  "account_id" text not null,
  "display_name" text,
  "charges_enabled" boolean not null default false,
  "payouts_enabled" boolean not null default false,
  "details_submitted" boolean not null default false,
  "account_updated_at" timestamptz,
  "disconnected_at" timestamptz,
  "deauthorized_at" timestamptz,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

-- One Stripe account belongs to one company: the Connect webhook maps an event's account back through it.
create unique index if not exists "stripe_connected_accounts_account_uidx" on "stripe_connected_accounts" ("account_id");

-- One ACTIVE account per company (a deauthorized one is history).
create unique index if not exists "stripe_connected_accounts_active_uidx" on "stripe_connected_accounts" ("tenant_id") where "deauthorized_at" is null;

create index if not exists "stripe_connected_accounts_tenant_idx" on "stripe_connected_accounts" ("tenant_id");
