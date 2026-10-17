-- @adminigloo/invoicing: upgrade 0.4 -> 0.5 (customers pay invoices and deposits online).
--
-- RUN THIS BEFORE YOU DEPLOY 0.5. Version 0.5's queries read the new columns
-- and table, so 0.5 code against a 0.4 database fails every invoice request.
--
-- Added, nothing rewritten, nothing dropped — every 0.4 invoice and payment
-- stays exactly as it was:
--
--   1. invoices.deposit_bp, invoices.deposit_amount (nullable): the deposit an
--      invoice asks first. Null on every existing invoice, which 0.5 reads as
--      "the company's default" — 0% until the owner sets one, so nothing
--      changes for an existing invoice.
--   2. invoice_payments.flag, invoice_payments.flagged_at (nullable): a card
--      payment Stripe later reported as disputed or partly refunded.
--   3. invoice_checkouts: each "Pay now" — the amount and currency the server
--      asked for, the Stripe Checkout Session it opened, its page and when it
--      closes, and when a bank payment started.
--   4. invoice_payments' one-reversal-per-payment UNIQUE index becomes a plain
--      index: a part refund reverses part of a payment, and the code keeps a
--      payment's reversals to at most its amount (under the invoice lock).
--
-- A project made with create-app gets the same from `pnpm db:generate`.
-- Safe to run twice.

alter table "invoices" add column if not exists "deposit_bp" integer;

alter table "invoices" add column if not exists "deposit_amount" bigint;

alter table "invoice_payments" add column if not exists "flag" text;

alter table "invoice_payments" add column if not exists "flagged_at" timestamptz;

create table if not exists "invoice_checkouts" (
  "id" text primary key,
  "tenant_id" text not null,
  "invoice_id" text not null,
  "account_id" text,
  "session_id" text,
  "purpose" text not null,
  "amount" bigint not null default 0,
  "currency" text not null,
  "status" text not null default 'creating',
  "payment_intent_id" text,
  "session_url" text,
  "expires_at" timestamptz,
  "processing_at" timestamptz,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

create index if not exists "invoice_checkouts_invoice_idx" on "invoice_checkouts" ("tenant_id", "invoice_id", "status");

create unique index if not exists "invoice_checkouts_session_uidx" on "invoice_checkouts" ("session_id") where "session_id" is not null;

drop index if exists "invoice_payments_reverses_uidx";

create index if not exists "invoice_payments_reverses_idx" on "invoice_payments" ("reverses_payment_id") where "reverses_payment_id" is not null;

-- 5. invoice_card_alerts: the card payments that need the company's owner
--    ("Needs your attention" on its payments screen), until marked handled.
create table if not exists "invoice_card_alerts" (
  "id" text primary key,
  "tenant_id" text not null,
  "kind" text not null,
  "message" text not null,
  "amount" bigint,
  "currency" text,
  "invoice_id" text,
  "payment_intent_id" text,
  "dedupe_key" text not null,
  "created_at" timestamptz not null default now(),
  "resolved_at" timestamptz,
  "resolved_by" text
);

create unique index if not exists "invoice_card_alerts_dedupe_uidx" on "invoice_card_alerts" ("tenant_id", "dedupe_key");

create index if not exists "invoice_card_alerts_open_idx" on "invoice_card_alerts" ("tenant_id", "resolved_at", "created_at");
