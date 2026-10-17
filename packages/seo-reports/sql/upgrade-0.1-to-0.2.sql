-- @adminigloo/seo-reports 0.1 -> 0.2: every report belongs to one company.
--
-- 0.1's reports were of the one site the app ran, so they become THIS SITE'S
-- OWN ('*'), shown at /admin/seo. Nothing is deleted or rewritten; every
-- statement is safe to run twice.

alter table "seo_reports" add column if not exists "tenant_id" text not null default '*';
-- The default was only for the rows already here: a new row must name its company.
alter table "seo_reports" alter column "tenant_id" drop default;

alter table "seo_reports" add column if not exists "status" text not null default 'done';
alter table "seo_reports" add column if not exists "trigger" text not null default 'manual';
alter table "seo_reports" add column if not exists "requested_by" text;
alter table "seo_reports" add column if not exists "addresses" jsonb not null default '[]'::jsonb;
alter table "seo_reports" add column if not exists "pass_count" integer not null default 0;
alter table "seo_reports" add column if not exists "warn_count" integer not null default 0;
alter table "seo_reports" add column if not exists "fail_count" integer not null default 0;
alter table "seo_reports" add column if not exists "stopped" text;
alter table "seo_reports" add column if not exists "error" text;

create index if not exists "seo_reports_tenant_started_idx" on "seo_reports" ("tenant_id", "started_at");

-- 0.1's reports kept every verdict in their jsonb: count them, so the history
-- shows real numbers. Only rows with no counts yet (a re-run changes nothing).
update "seo_reports" r
   set "pass_count" = c.pass, "warn_count" = c.warn, "fail_count" = c.fail
  from (
    select x.id,
           count(*) filter (where x.status = 'pass')::int as pass,
           count(*) filter (where x.status = 'warn')::int as warn,
           count(*) filter (where x.status = 'fail')::int as fail
      from (
        select s.id, e->>'status' as status
          from "seo_reports" s, jsonb_array_elements(case when jsonb_typeof(s.site_checks) = 'array' then s.site_checks else '[]'::jsonb end) e
        union all
        select s.id, k->>'status'
          from "seo_reports" s,
               jsonb_array_elements(case when jsonb_typeof(s.pages) = 'array' then s.pages else '[]'::jsonb end) p,
               jsonb_array_elements(case when jsonb_typeof(p->'checks') = 'array' then p->'checks' else '[]'::jsonb end) k
      ) x
     group by x.id
  ) c
 where r.id = c.id and r.pass_count = 0 and r.warn_count = 0 and r.fail_count = 0;
