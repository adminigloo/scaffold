-- @adminigloo/storage: upgrade AdminIgloo's storage 0.1 table to 0.2 (the default name, stored_files).
-- Every 0.1 row (and every 2a estimator photo) becomes a PUBLIC file of the company it was stored for
-- (tenant '*': 0.1's firm-wide library, which no company's Files screen lists until it is given to one)
-- and stays at its old public address until storage.moveToPrivate({ purpose }) moves it into the private store.
-- The guard refuses to alter a table that isn't AdminIgloo's 0.1 (or 0.2) table.
-- One statement (a DO block): the guard's refusal stops all of it, however it is run. By hand: psql -1 -v ON_ERROR_STOP=1 -f <this file>.

do $$
begin
  if to_regclass('"stored_files"') is null then
    raise exception 'There''s no table named stored_files to upgrade. Run sql/storage-0.2.0.sql to create it.';
  end if;
  if not (
    ((array(select attname::text from pg_attribute where attrelid = to_regclass('"stored_files"') and attnum > 0 and not attisdropped) @> array['id', 'tenant_id', 'owner_id', 'kind', 'filename', 'content_type', 'size_bytes', 'pathname', 'url', 'created_at']::text[] and array(select attname::text from pg_attribute where attrelid = to_regclass('"stored_files"') and attnum > 0 and not attisdropped) <@ array['id', 'tenant_id', 'owner_id', 'kind', 'filename', 'content_type', 'size_bytes', 'pathname', 'url', 'created_at']::text[]) and exists (
      select 1 from pg_index i join pg_class c on c.oid = i.indexrelid
       where i.indrelid = to_regclass('"stored_files"') and c.relname = 'stored_files_tenant_created_idx'
    ))
    or (array(select attname::text from pg_attribute where attrelid = to_regclass('"stored_files"') and attnum > 0 and not attisdropped) @> array['id', 'tenant_id', 'owner_id', 'kind', 'filename', 'content_type', 'size_bytes', 'pathname', 'url', 'created_at', 'access', 'record_type', 'record_id', 'width', 'height', 'sha256', 'deleted_at', 'purge_attempts']::text[] and array(select attname::text from pg_attribute where attrelid = to_regclass('"stored_files"') and attnum > 0 and not attisdropped) <@ array['id', 'tenant_id', 'owner_id', 'kind', 'filename', 'content_type', 'size_bytes', 'pathname', 'url', 'created_at', 'access', 'record_type', 'record_id', 'width', 'height', 'sha256', 'deleted_at', 'purge_attempts']::text[])
  ) then
    raise exception 'The table named stored_files isn''t AdminIgloo''s storage 0.1 table. Pass a prefix or a schema and run storageSql() instead.';
  end if;

  alter table "stored_files"
    alter column owner_id drop not null,
    alter column url drop not null,
    add column if not exists access text not null default 'public',
    add column if not exists record_type text,
    add column if not exists record_id text,
    add column if not exists width integer,
    add column if not exists height integer,
    add column if not exists sha256 text,
    add column if not exists deleted_at timestamptz,
    add column if not exists purge_attempts integer not null default 0;

  create index if not exists "stored_files_tenant_created_idx" on "stored_files" ("tenant_id", "created_at");
  create index if not exists "stored_files_tenant_kind_idx" on "stored_files" ("tenant_id", "kind");
  create unique index if not exists "stored_files_pathname_uidx" on "stored_files" ("pathname");
  create index if not exists "stored_files_record_idx" on "stored_files" ("tenant_id", "record_type", "record_id") where deleted_at is null;
  create index if not exists "stored_files_live_idx" on "stored_files" ("tenant_id", "created_at", "id") where deleted_at is null;
  create index if not exists "stored_files_purge_idx" on "stored_files" ("deleted_at") where deleted_at is not null;
end $$;
