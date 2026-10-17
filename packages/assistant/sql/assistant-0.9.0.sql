-- @adminigloo/assistant 0.9.0: every table, for a host that doesn't run drizzle-kit.
-- A project made with create-app doesn't need this: its migrations come from the schema.
-- Upgrading from 0.8? Run upgrade-0.8-to-0.9.sql instead.
--
-- Every company's rows carry its id in tenant_id ('*' is the site's own
-- assistant). No default on any of them: an insert that forgets the company
-- fails instead of landing on the site's own assistant.
--
-- No database extension is needed. Vector search is optional: see
-- assistant-vector-0.9.0.sql (pgvector).


create table if not exists "assistant_sections" (
  "id" text primary key,
  "tenant_id" text not null,
  "key" text not null,
  "label" text not null,
  "description" text,
  "content" text not null,
  "sort_order" integer not null default 0,
  "is_core" boolean not null default false,
  "required_phrases" jsonb not null default '[]'::jsonb,
  "max_tokens" integer not null default 600,
  "is_active" boolean not null default true,
  "created_at" timestamptz not null default now()
);

create unique index if not exists "assistant_sections_tenant_key_idx" on "assistant_sections" ("tenant_id", "key");

create table if not exists "assistant_change_log" (
  "id" bigserial primary key,
  "tenant_id" text not null,
  "entity_type" text not null,
  "entity_id" text not null,
  "entity_key" text,
  "action" text not null,
  "section_id" text,
  "version_number" integer,
  "change_summary" text,
  "performed_by" text,
  "created_at" timestamptz not null default now()
);

create index if not exists "assistant_change_log_entity_idx" on "assistant_change_log" ("entity_type", "entity_id");

create index if not exists "assistant_change_log_tenant_idx" on "assistant_change_log" ("tenant_id", "id");

create table if not exists "assistant_config_version" (
  "id" text primary key,
  "version" integer not null default 1,
  "updated_at" timestamptz not null default now()
);

create table if not exists "assistant_conversations" (
  "id" text primary key,
  "tenant_id" text not null,
  "user_id" text not null,
  "title" text,
  "status" text not null default 'active',
  "last_message_at" timestamptz not null default now(),
  "created_at" timestamptz not null default now()
);

create index if not exists "assistant_conversations_tenant_idx" on "assistant_conversations" ("tenant_id", "last_message_at");

create index if not exists "assistant_conversations_user_idx" on "assistant_conversations" ("user_id");

create index if not exists "assistant_conversations_tenant_user_idx" on "assistant_conversations" ("tenant_id", "user_id", "last_message_at");

create table if not exists "assistant_drafts" (
  "id" text primary key,
  "tenant_id" text not null,
  "target_type" text not null,
  "target_id" text not null,
  "content" text not null,
  "ai_instruction" text,
  "ai_suggestion" text,
  "status" text not null default 'draft',
  "created_by" text,
  "created_at" timestamptz not null default now()
);

create unique index if not exists "assistant_drafts_active_idx" on "assistant_drafts" ("target_type", "target_id") where "assistant_drafts"."status" <> 'applied';

create index if not exists "assistant_drafts_target_idx" on "assistant_drafts" ("target_type", "target_id");

create table if not exists "assistant_eval_results" (
  "id" bigserial primary key,
  "run_id" text not null,
  "golden_id" text not null,
  "question" text not null,
  "answer" text not null,
  "passed" boolean not null,
  "missing" jsonb not null default '[]'::jsonb,
  "forbidden" jsonb not null default '[]'::jsonb,
  "created_at" timestamptz not null default now()
);

create index if not exists "assistant_eval_results_run_idx" on "assistant_eval_results" ("run_id");

create table if not exists "assistant_eval_runs" (
  "id" text primary key,
  "tenant_id" text not null,
  "total" integer not null default 0,
  "passed" integer not null default 0,
  "fingerprint" text,
  "trigger" text not null default 'manual',
  "created_at" timestamptz not null default now()
);

create index if not exists "assistant_eval_runs_tenant_idx" on "assistant_eval_runs" ("tenant_id", "created_at");

create table if not exists "assistant_glossary" (
  "id" text primary key,
  "tenant_id" text not null,
  "term_key" text not null,
  "preferred" text not null,
  "aliases" jsonb not null default '[]'::jsonb,
  "definition" text,
  "category" text,
  "is_active" boolean not null default true,
  "created_at" timestamptz not null default now()
);

create unique index if not exists "assistant_glossary_tenant_term_idx" on "assistant_glossary" ("tenant_id", "term_key");

create table if not exists "assistant_goldens" (
  "id" text primary key,
  "tenant_id" text not null,
  "question" text not null,
  "must_include" jsonb not null default '[]'::jsonb,
  "must_not_include" jsonb not null default '[]'::jsonb,
  "category" text,
  "is_active" boolean not null default true,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

create index if not exists "assistant_goldens_tenant_idx" on "assistant_goldens" ("tenant_id", "is_active");

create table if not exists "assistant_messages" (
  "id" text primary key,
  "tenant_id" text not null,
  "conversation_id" text not null,
  "seq" integer not null,
  "role" text not null,
  "status" text not null default 'complete',
  "blocks" jsonb not null default '[]'::jsonb,
  "prompt_meta" jsonb,
  "created_at" timestamptz not null default now()
);

create unique index if not exists "assistant_messages_seq_idx" on "assistant_messages" ("conversation_id", "seq");

create index if not exists "assistant_messages_conversation_idx" on "assistant_messages" ("conversation_id");

create table if not exists "assistant_page_doc_versions" (
  "id" bigserial primary key,
  "page_doc_id" text not null,
  "version_number" integer not null,
  "title" text not null,
  "body" text not null,
  "change_summary" text,
  "created_by" text,
  "created_at" timestamptz not null default now()
);

create index if not exists "assistant_page_doc_versions_doc_idx" on "assistant_page_doc_versions" ("page_doc_id");

create table if not exists "assistant_page_docs" (
  "id" text primary key,
  "tenant_id" text not null,
  "page_key" text not null,
  "title" text not null,
  "body" text not null,
  "kind" text not null default 'page',
  "is_approved" boolean not null default true,
  "is_active" boolean not null default true,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

create unique index if not exists "assistant_page_docs_key_idx" on "assistant_page_docs" ("tenant_id", "page_key");

create index if not exists "assistant_page_docs_tenant_kind_idx" on "assistant_page_docs" ("tenant_id", "kind");

create table if not exists "assistant_pending_actions" (
  "id" text primary key,
  "tenant_id" text not null,
  "conversation_id" text not null,
  "tool_name" text not null,
  "params" jsonb not null default '{}'::jsonb,
  "summary" text not null,
  "status" text not null default 'pending',
  "idempotency_key" text not null,
  "expires_at" timestamptz not null,
  "created_by" text,
  "decided_at" timestamptz,
  "created_at" timestamptz not null default now()
);

create unique index if not exists "assistant_pending_actions_idem_idx" on "assistant_pending_actions" ("idempotency_key");

create index if not exists "assistant_pending_actions_tenant_idx" on "assistant_pending_actions" ("tenant_id", "status");

create index if not exists "assistant_pending_actions_conversation_idx" on "assistant_pending_actions" ("conversation_id");

create table if not exists "assistant_section_versions" (
  "id" text primary key,
  "section_id" text not null references "assistant_sections" ("id") on delete cascade,
  "version_number" integer not null,
  "content" text not null,
  "change_summary" text,
  "created_by" text,
  "created_at" timestamptz not null default now()
);

create unique index if not exists "assistant_section_versions_idx" on "assistant_section_versions" ("section_id", "version_number");

create table if not exists "assistant_tenant_rules" (
  "id" text primary key,
  "tenant_id" text not null,
  "section_key" text,
  "label" text not null,
  "instruction" text not null,
  "sort_order" integer not null default 0,
  "max_tokens" integer not null default 200,
  "is_active" boolean not null default true,
  "created_by" text,
  "created_at" timestamptz not null default now()
);

create index if not exists "assistant_tenant_rules_tenant_idx" on "assistant_tenant_rules" ("tenant_id", "sort_order");
