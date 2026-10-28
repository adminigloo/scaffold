-- @adminigloo/social 0.1.0: the posts queue, under the default prefix (social_),
-- for a host that doesn't run drizzle-kit. A project made with create-app
-- doesn't need this: its migrations come from the schema
-- (`export * from "@adminigloo/social/schema"` in src/db/schema.ts, then
-- `pnpm db:generate`).
--
-- One row per post per platform, per company: every row carries its company in
-- tenant_id ('*' is the site's own posts), and the package reads and writes
-- inside one company only. New table only; nothing of any other package is
-- changed. Safe to run twice.
--
-- Under another prefix (`defineSocialTables({ prefix: "aig_social_" })`),
-- replace "social_" throughout.

create table if not exists "social_posts" (
  "id" text primary key,
  "tenant_id" text not null,
  "key" text not null,
  "kind" text not null,
  "platform" text not null,
  "author" text not null,
  "day" date not null,
  "text" text not null,
  "hook" text not null,
  "images" jsonb not null,
  "first_comment" text,
  "template_text" text not null,
  "written_by" text not null,
  "note" text,
  "link_url" text,
  "facts" jsonb not null,
  "status" text not null default 'draft',
  "posted_url" text,
  "created_by" text,
  "approved_by" text,
  "posted_by" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  "approved_at" timestamptz,
  "posted_at" timestamptz
);

create unique index if not exists "social_posts_tenant_key_platform_uidx" on "social_posts" ("tenant_id", "key", "platform");
create index if not exists "social_posts_tenant_status_idx" on "social_posts" ("tenant_id", "status");
create index if not exists "social_posts_tenant_day_idx" on "social_posts" ("tenant_id", "day");
