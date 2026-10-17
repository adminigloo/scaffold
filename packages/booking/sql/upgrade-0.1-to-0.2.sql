-- @adminigloo/booking: upgrade 0.1 -> 0.2 (book-a-call per company).
--
-- RUN THIS BEFORE YOU DEPLOY 0.2. Version 0.2's queries read the new columns,
-- so 0.2 code against a 0.1 database fails every booking request.
--
-- Three columns added, nothing rewritten, nothing dropped — every 0.1 row
-- (adminigloo.com's `adminigloo-calls` and `adminigloo-calls:<env>` tenants,
-- and the `bookdemo:<hash>` sandboxes) stays exactly as it was:
--
--   1. booking_hosts.user_id (nullable): the person a host is, when they
--      have a sign-in. Existing hosts keep null, which 0.2 reads as "a host
--      with no account" — exactly what 0.1 had.
--   2. booking_bookings.reminded_at (nullable): when a call's reminder was
--      claimed. Existing calls keep null: a reminder job started after the
--      upgrade may remind an upcoming call once.
--   3. booking_bookings.reminder_attempts (0 for every row): failed sends,
--      retried up to three times.
--
-- The tenant ids do not change: a site that passed `tenantId:
-- "adminigloo-calls"` (or `adminigloo-calls:staging`) to 0.1's handlers
-- passes the same one to 0.2's.
--
-- A project made with create-app gets the same from `pnpm db:generate`.
-- Safe to run twice.

alter table "booking_hosts" add column if not exists "user_id" text;

-- One host per person per business.
create unique index if not exists "booking_hosts_tenant_user_idx" on "booking_hosts" ("tenant_id", "user_id") where "user_id" is not null;

alter table "booking_bookings" add column if not exists "reminded_at" timestamptz;

alter table "booking_bookings" add column if not exists "reminder_attempts" integer not null default 0;
