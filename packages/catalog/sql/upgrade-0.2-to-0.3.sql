-- @adminigloo/catalog: upgrade 0.2 -> 0.3 (stock held by open checkouts).
--
-- RUN THIS BEFORE YOU DEPLOY 0.3 (with @adminigloo/commerce 0.2's store):
-- the store's checkout reads and writes product_variants.held.
--
-- Added, nothing rewritten: product_variants.held (0 on every row) — how many
-- of `inventory` open checkout pages hold. Available is inventory - held.
-- Every existing product, price and stock count stays exactly as it was.
--
-- A project made with create-app gets the same from `pnpm db:generate`.
-- Safe to run twice.

alter table "product_variants" add column if not exists "held" integer default 0 not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'product_variants_held_non_negative') then
    alter table "product_variants" add constraint "product_variants_held_non_negative" check ("held" >= 0);
  end if;
end $$;
