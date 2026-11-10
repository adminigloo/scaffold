-- @adminigloo/assistant: upgrade 0.10 -> 0.11 (who wrote each version).
--
-- 0.11 RECORDS WHO WROTE A SECTION'S TEXT: a person (an edit in the editor)
-- or the app's own code (a seed, a shipped default). `ensureSection` keeps a
-- section whose default lives in code in step with the code, and must never
-- replace what a person wrote, so it needs to know which is which:
--
--   1. assistant_section_versions gets created_by_kind, 'person' or 'code'.
--      Every existing version becomes 'person': nothing is ever overwritten
--      on a guess. A section with no versions at all (a pre-0.11 seed) counts
--      as the code's.
--   2. OPTIONAL: if your code published versions under ids of its own (a seed
--      script that signed "seed", say), name them first, in the same session,
--      and those versions become the code's:
--
--        select set_config('assistant.code_actors', 'seed,my-seed-script', false);
--
-- Safe to run twice.
--
-- A project made with create-app: `pnpm db:generate` writes step 1 for you
-- (the column has a default, so nothing else is needed); run step 2 by hand
-- only if your code signed versions under ids of its own.

alter table assistant_section_versions
  add column if not exists created_by_kind text not null default 'person';

do $$
declare
  actors text[] := string_to_array(nullif(current_setting('assistant.code_actors', true), ''), ',');
begin
  if actors is not null then
    update assistant_section_versions
      set created_by_kind = 'code'
      where created_by = any (actors) and created_by_kind <> 'code';
  end if;
end $$;
