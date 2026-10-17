-- @adminigloo/assistant: upgrade 0.8 -> 0.9 (an assistant per company).
--
-- 0.8 HAD ONE ASSISTANT: one personality, one glossary, one change log for
-- the whole install. 0.9 gives every company its own, under its own id, and
-- the site's own assistant (its staff's) is '*'. So the upgrade puts what 0.8
-- had on ONE assistant — '*' by default:
--
--   1. Sections, drafts, glossary terms and change-log lines get a company
--      column, filled with that assistant's id, then its default is dropped:
--      from 0.9 an insert that forgets the company fails instead of landing
--      on the site's own assistant. Section keys and glossary keys become
--      unique per company.
--   2. House rules 0.8's generated settings page saved under the made-up id
--      "default" move to that assistant too.
--   3. Messages get their company from their conversation (a message with no
--      conversation is removed: nothing could ever show it).
--   4. Knowledge pages get a kind ("page"; FAQs are new). 0.8's embedding
--      column moves to the OPTIONAL vector table (assistant_page_doc_vectors),
--      so a 0.9 install needs no database extension; pages keep working by
--      keyword either way.
--   5. Proposed changes get decided_at (set by the one update that answers
--      them), and the counter row 'singleton' becomes that assistant's.
--
-- IF YOUR SITE'S OWN ASSISTANT USED ANOTHER ID in 0.8 (its chat route passed
-- one, e.g. "my-company-hq"), say so first, in the same session, so its
-- personality lands beside its conversations:
--
--   select set_config('assistant.upgrade_tenant', 'my-company-hq', false);
--
-- Safe to run twice. All of it runs in one statement: all of it, or none.
--
-- A project made with create-app: run `pnpm db:generate`, then replace the
-- assistant statements in the migration it wrote with this file's contents
-- (see the generated DEPLOYMENT.md, "Upgrading").

do $$
declare
  owner_id text := coalesce(nullif(current_setting('assistant.upgrade_tenant', true), ''), '*');
  embedding_type text;
begin
  if to_regclass('"assistant_sections"') is null then
    raise exception 'There are no assistant tables to upgrade. Run sql/assistant-0.9.0.sql to create them.';
  end if;

  -- Step 1: sections.
  if not exists (select 1 from pg_attribute where attrelid = to_regclass('"assistant_sections"') and attname = 'tenant_id' and attnum > 0 and not attisdropped) then
    execute format('alter table "assistant_sections" add column "tenant_id" text not null default %L', owner_id);
  end if;
  alter table "assistant_sections" alter column "tenant_id" drop default;
  drop index if exists "assistant_sections_key_idx";
  create unique index if not exists "assistant_sections_tenant_key_idx" on "assistant_sections" ("tenant_id", "key");

  -- Step 1: drafts.
  if to_regclass('"assistant_drafts"') is not null then
    if not exists (select 1 from pg_attribute where attrelid = to_regclass('"assistant_drafts"') and attname = 'tenant_id' and attnum > 0 and not attisdropped) then
      execute format('alter table "assistant_drafts" add column "tenant_id" text not null default %L', owner_id);
    end if;
    alter table "assistant_drafts" alter column "tenant_id" drop default;
  end if;

  -- Step 1: glossary.
  if not exists (select 1 from pg_attribute where attrelid = to_regclass('"assistant_glossary"') and attname = 'tenant_id' and attnum > 0 and not attisdropped) then
    execute format('alter table "assistant_glossary" add column "tenant_id" text not null default %L', owner_id);
  end if;
  alter table "assistant_glossary" alter column "tenant_id" drop default;
  drop index if exists "assistant_glossary_term_idx";
  create unique index if not exists "assistant_glossary_tenant_term_idx" on "assistant_glossary" ("tenant_id", "term_key");

  -- Step 1: the change log.
  if not exists (select 1 from pg_attribute where attrelid = to_regclass('"assistant_change_log"') and attname = 'tenant_id' and attnum > 0 and not attisdropped) then
    execute format('alter table "assistant_change_log" add column "tenant_id" text not null default %L', owner_id);
  end if;
  alter table "assistant_change_log" alter column "tenant_id" drop default;
  create index if not exists "assistant_change_log_tenant_idx" on "assistant_change_log" ("tenant_id", "id");

  -- Step 2: house rules saved under 0.8's made-up "default".
  update "assistant_tenant_rules" set "tenant_id" = owner_id where "tenant_id" = 'default';

  -- Step 3: messages, from their conversation.
  if to_regclass('"assistant_messages"') is not null then
    alter table "assistant_messages" add column if not exists "tenant_id" text;
    update "assistant_messages" m set "tenant_id" = c."tenant_id"
      from "assistant_conversations" c
     where c."id" = m."conversation_id" and m."tenant_id" is null;
    delete from "assistant_messages" where "tenant_id" is null;
    alter table "assistant_messages" alter column "tenant_id" set not null;
    create index if not exists "assistant_conversations_tenant_user_idx" on "assistant_conversations" ("tenant_id", "user_id", "last_message_at");
  end if;

  -- Step 4: knowledge pages.
  if to_regclass('"assistant_page_docs"') is not null then
    alter table "assistant_page_docs" add column if not exists "kind" text not null default 'page';
    create index if not exists "assistant_page_docs_tenant_kind_idx" on "assistant_page_docs" ("tenant_id", "kind");
    select format_type(atttypid, null) into embedding_type
      from pg_attribute
     where attrelid = to_regclass('"assistant_page_docs"') and attname = 'embedding' and attnum > 0 and not attisdropped;
    if embedding_type = 'vector' then
      -- pgvector is installed (0.8's column needed it): keep the vectors, in their own table.
      execute 'create table if not exists "assistant_page_doc_vectors" (
        "page_doc_id" text primary key,
        "tenant_id" text not null,
        "embedding" vector(1536) not null,
        "updated_at" timestamptz not null default now()
      )';
      execute 'insert into "assistant_page_doc_vectors" ("page_doc_id", "tenant_id", "embedding")
        select "id", "tenant_id", "embedding" from "assistant_page_docs" where "embedding" is not null
        on conflict ("page_doc_id") do nothing';
    end if;
    if embedding_type is not null then
      alter table "assistant_page_docs" drop column "embedding";
    end if;
  end if;

  -- Step 5: proposed changes and the counter.
  if to_regclass('"assistant_pending_actions"') is not null then
    alter table "assistant_pending_actions" add column if not exists "decided_at" timestamptz;
    create index if not exists "assistant_pending_actions_tenant_idx" on "assistant_pending_actions" ("tenant_id", "status");
  end if;
  if to_regclass('"assistant_config_version"') is not null then
    alter table "assistant_config_version" alter column "id" drop default;
    if not exists (select 1 from "assistant_config_version" where "id" = owner_id) then
      update "assistant_config_version" set "id" = owner_id where "id" = 'singleton';
    end if;
    delete from "assistant_config_version" where "id" = 'singleton';
  end if;
end $$;
