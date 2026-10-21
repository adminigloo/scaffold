-- @adminigloo/commerce: upgrade 0.3 -> 0.4 (sales recorded by hand).
--
-- Three nullable columns on orders, nothing rewritten: how a sale staff
-- recorded by hand was paid (cash, check, card terminal, other), its check or
-- slip number, and who recorded it. Null on every existing order, which 0.4
-- reads as "paid online by card".
--
-- A project made with create-app gets the same from `pnpm db:generate`.
-- Safe to run twice.

alter table "orders" add column if not exists "payment_method" text;

alter table "orders" add column if not exists "payment_reference" text;

alter table "orders" add column if not exists "recorded_by" text;
