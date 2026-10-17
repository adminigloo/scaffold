-- @adminigloo/commerce: upgrade 0.1 -> 0.2 (a store of its own for every business).
--
-- RUN THIS BEFORE YOU DEPLOY 0.2. Version 0.2's order queries read the new
-- columns, so 0.2 code against a 0.1 database fails every order request.
--
-- Added, nothing rewritten, nothing dropped — every 0.1 order (the site's own
-- storefront sales) stays exactly as it was:
--
--   1. orders.refunded_minor (0 on every existing order): how much Stripe has
--      refunded of an order, the running total.
--   2. orders.flag, orders.flagged_at (nullable): a dispute on the order;
--      orders.oversold_at: paid for after its stock ran out (kept apart);
--      orders.receipt_sent_at, orders.notice_sent_at: when its emails went,
--      so a webhook retry sends any that is missing, once.
--   3. store_checkouts: each "Check out" on a business's own store — the lines
--      the server priced, the amount and currency Stripe must report back,
--      the Checkout Session, and whether its stock is still held.
--   4. store_alerts: the store payments that need the owner ("Needs your
--      attention").
--   5. store_settings: how each business's customers get their order (shipped
--      with a flat price, or pickup/digital) and whether prices include tax.
--
-- With @adminigloo/catalog 0.3, also run node_modules/@adminigloo/catalog/sql/
-- upgrade-0.2-to-0.3.sql (product_variants.held: stock open checkouts hold).
--
-- A business's products are rows of @adminigloo/catalog's existing products
-- and product_variants tables under its own tenant id; the site's own stay
-- under "*". Catalog needs no change.
--
-- A project made with create-app gets the same from `pnpm db:generate`.
-- Safe to run twice.

alter table "orders" add column if not exists "refunded_minor" bigint default 0 not null;

alter table "orders" add column if not exists "flag" text;

alter table "orders" add column if not exists "flagged_at" timestamp with time zone;

alter table "orders" add column if not exists "oversold_at" timestamp with time zone;

alter table "orders" add column if not exists "receipt_sent_at" timestamp with time zone;

alter table "orders" add column if not exists "notice_sent_at" timestamp with time zone;

create table if not exists "store_checkouts" (
  "id" text primary key,
  "tenant_id" text not null,
  "account_id" text,
  "cart_key" text not null,
  "session_id" text,
  "session_url" text,
  "amount" bigint not null,
  "currency" text not null,
  "lines" jsonb not null,
  "shipping_minor" bigint default 0 not null,
  "visitor_key" text default 'unknown' not null,
  "status" text default 'creating' not null,
  "stock_held" boolean default false not null,
  "payment_intent_id" text,
  "order_id" text,
  "expires_at" timestamp with time zone not null,
  "processing_at" timestamp with time zone,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null
);

create index if not exists "store_checkouts_tenant_status_idx" on "store_checkouts" ("tenant_id", "status", "expires_at");

create index if not exists "store_checkouts_cart_idx" on "store_checkouts" ("tenant_id", "cart_key");

create index if not exists "store_checkouts_visitor_idx" on "store_checkouts" ("tenant_id", "visitor_key", "created_at");

create unique index if not exists "store_checkouts_session_uidx" on "store_checkouts" ("session_id") where "store_checkouts"."session_id" is not null;

create table if not exists "store_alerts" (
  "id" text primary key,
  "tenant_id" text not null,
  "kind" text not null,
  "message" text not null,
  "amount" bigint,
  "currency" text,
  "order_id" text,
  "payment_intent_id" text,
  "dedupe_key" text not null,
  "created_at" timestamp with time zone default now() not null,
  "resolved_at" timestamp with time zone,
  "resolved_by" text
);

create unique index if not exists "store_alerts_dedupe_uidx" on "store_alerts" ("tenant_id", "dedupe_key");

create index if not exists "store_alerts_open_idx" on "store_alerts" ("tenant_id", "resolved_at", "created_at");

create table if not exists "store_settings" (
  "tenant_id" text primary key,
  "fulfilment" text default 'pickup' not null,
  "ship_countries" jsonb default '["US"]'::jsonb not null,
  "shipping_minor" bigint default 0 not null,
  "currency" text default 'usd' not null,
  "prices_include_tax" boolean default true not null,
  "updated_at" timestamp with time zone default now() not null
);
