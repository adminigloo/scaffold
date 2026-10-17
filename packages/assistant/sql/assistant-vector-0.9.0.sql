-- @adminigloo/assistant 0.9.0: the OPTIONAL vector table (`@adminigloo/assistant/vector`).
--
-- The assistant finds knowledge by keyword out of the box and needs none of
-- this. Install it only to add "means the same in other words" matching: it
-- needs the pgvector extension, an embedder passed to the handlers, and
-- `reindexPageDoc` called after a page is saved.

create extension if not exists vector;

create table if not exists "assistant_page_doc_vectors" (
  "page_doc_id" text primary key,
  "tenant_id" text not null,
  "embedding" vector(1536) not null,
  "updated_at" timestamptz not null default now()
);
