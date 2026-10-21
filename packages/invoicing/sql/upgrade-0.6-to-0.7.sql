-- @adminigloo/invoicing: upgrade 0.6 -> 0.7 (past records with their real dates).
--
-- Two nullable columns, nothing rewritten: when and by whom an invoice issued
-- on an earlier day (createInvoice's `issuedAt`) was typed in. Null on every
-- existing invoice, which 0.7 reads as "made the day it was issued".
--
-- A project made with create-app gets the same from `pnpm db:generate`.
-- Safe to run twice.

alter table "invoices" add column if not exists "entered_at" timestamptz;

alter table "invoices" add column if not exists "entered_by" text;
