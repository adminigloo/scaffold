# @adminigloo/catalog

## 0.2.0

### Minor Changes

- The product builder could never publish anything. Fixed, with the rules that
  made it reachable moved into the validator.
  
  **No product could be published, so the storefront could never have anything on
  it, so checkout could never be exercised.** `handleSave` awaited
  `catalog.upsertVariant`, used the returned id for the `setGrant` call on the
  very next line, and then dropped it. `setRows` was never called after a save, so
  `row.id` stayed `null` for the lifetime of the component — and `row.id` is what
  the Publish button, the "has not been written yet" line under it, the
  `· unsaved` marker on the row header and the Stripe plan's "not in this plan"
  note all read. The variant WAS in `product_variants`. Nothing threw. The form
  simply went on insisting the row did not exist, and saving again re-upserted and
  changed nothing, so the only way out was a page reload that nothing on screen
  suggested.
  
  The save chain now adopts every id the server hands back, on the row that
  produced the write, before the next call. That is a stronger fix than re-seeding
  the form from a refetch: `rows` is `useState` seeded from props, and an effect
  syncing it from props would overwrite whatever the admin was typing on any
  `router.refresh()`. Adopting ids as they arrive is also what makes a
  half-finished save recoverable — on the next press the product has an id so it
  is updated rather than created a second time, and each written row has an id so
  it is updated rather than duplicated.
  
  **`validateProduct` gains the rules the write procedures already enforced.** A
  blank variant name validated clean, so the form offered Save, created the
  product, and only then had `upsertVariant` refuse it — leaving a draft product
  with no variants and a stringified list of zod issues on the page. `path:
  ["name"]` does not say whether it means the product or one of six variant rows.
  Four new problem codes close it: `product-name-missing`,
  `product-name-too-long`, `variant-name-missing` and `variant-name-too-long`,
  capped at the 200 characters the columns and the procedures already used. A
  blank variant name is now `variants[0].name` before anything is written, and the
  form refuses to start the chain rather than half-writing the product.
  
  `validateProduct` also stops treating a blank name as a name. `variant.name ??
  variant.sku` reported every OTHER problem on a nameless row as
  `"" has no billing interval` — a message identifying nothing on a form holding
  six of them. It falls through to the SKU and then to the row's position, as it
  always meant to.
  
  **A refusal that does get through is now a sentence.** Anything a zod schema
  rejects is mapped back to the field label printed above the input — "“Name” on
  variant 2 (“Deluxe”) cannot be empty." — rendered under that input, with the
  cursor moved to it. Messages the server wrote for a human, such as a taken slug
  or the publish validator's list, pass through untouched. A dropped connection
  says so instead of "Failed to fetch". And "1 change were already saved" is now
  "1 change was already written before this failed", with advice to press the
  button again rather than to reload a create page that has nothing to reload.
  
  The chain, the draft review and the error mapping moved out of `ProductForm.tsx`
  into plain `.ts` modules, because `jsx: "preserve"` keeps vitest out of a `.tsx`
  entirely — every one of these defects was invisible reading the code and obvious
  the first time the sequence could be run by a test. Those tests now execute:
  `packages/create-app` gained a second vitest project that runs the
  `catalog-admin` overlay's suite against workspace source, with `__SCOPE__` and
  `@/` aliased the way the generator renders them. They previously ran nowhere at
  all, which is why the whole monorepo suite was green while this shipped.
  
  `PACKAGE_VERSIONS.catalog` moves to `0.2.0` with it. A generated project
  resolving `^0.1.x` would get a validator with no opinion about a blank variant
  name, which is precisely the hole the form used to fall through.

### Patch Changes

- @adminigloo/db@0.2.2

## 0.1.2

### Patch Changes

- Shared dependency versions moved to pnpm's `catalog:` protocol.
  
  `drizzle-orm` was written out in eleven manifests and `zod` in nine, so bumping
  either was a bulk edit nobody could review — and the failure mode of a missed
  line is silent: two packages built against two different minors of drizzle emit
  .d.ts files whose column types are structurally incompatible, and the error
  surfaces in a generated project as an unreadable mismatch between two packages
  that each look correct on their own. `pnpm-workspace.yaml` now names each
  version once.
  
  **Nothing changes in the published tarballs.** pnpm rewrites `catalog:` to the
  literal range when a package is packed, and the packed manifests were compared
  against the previous ones to confirm it: every dependency, devDependency and
  peerDependency range is byte-for-byte what it was. This is recorded because the
  manifests changed and because the replacement is a publish-time behaviour worth
  being able to find in a changelog, not because a consumer will see anything.
  
  There are TWO catalogs on purpose. The default names the single version this
  workspace builds and tests against; the `peers` catalog names the wider range
  published packages promise their consumers — `drizzle-orm` is built against
  `^0.45.2` and accepts `^0.45.0`, `zod` is built against v4 and still accepts
  v3.25+. Collapsing them into one entry would silently narrow every published
  peer range, which is a breaking change for every consumer one patch behind.
  
  A new test in `@adminigloo/create-app` fails if any workspace manifest goes back
  to spelling a catalogued range out, and if the ranges the generator writes into
  a new project drift from the catalog.
- Updated dependencies
  - @adminigloo/db@0.2.1
  - @adminigloo/permissions@0.1.2

## 0.1.1

### Patch Changes

- Tailwind, the product builder, in-app checkout — and three bugs that made the
  whole thing unusable.
  
  - **commerce could never create its tables.** `minSubtotalMinor.default(0n)`
    crashed drizzle-kit with "Do not know how to serialize a BigInt" during
    `generate` — while still leaving a journal behind, so the next `migrate`
    reported "applied successfully" having applied nothing. Now `sql\`0\``.
  - **The generated schema barrel omitted commerce and billing.** Orders, plans,
    subscriptions and entitlements were absent from every migration.
  - **catalog's permissions were tenant-scoped but gated with `requireStaff`.**
    Defining what is for sale is an operator activity; declared under "tenant"
    those keys could never match, so the whole Products section was invisible with
    no error anywhere. Now staff-scoped with staff defaults, and a test asserts no
    key names a non-staff template.
  
  Also: Tailwind v4 with a token set both themes share, a real admin shell, the
  product builder with a Stripe sync plan shown before you publish, embedded
  Payment Element checkout, and `src/permissions/catalog.ts` is now generated so
  package fragments land in the scope their callers actually read.

## 0.1.0

### Minor Changes

- A product catalog both commerce and billing can sell from.
  
  There was nowhere to define a product. `commerce` stores `orderItems.productRef`
  as a bare string, and `billing.plans` models recurring subscriptions only — so a
  project selling a physical thing had no catalog at all.
  
  - `products` / `product_variants` / `product_grants`. The grant is the seam that
    lets one checkout serve a deck of cards and a SaaS seat without either knowing
    about the other.
  - `planStripeSync()` is a PLANNER, not a caller, because Stripe prices are
    immutable: you cannot change an amount, currency or interval on an existing
    Price. A sync that tries to patch one silently no-ops and the customer is
    charged the old amount forever. Currency comparison is case-normalised —
    case-sensitive, a hand-typed `USD` reads as a change and archives-and-recreates
    the price on every run, orphaning subscriptions across a trail of prices.
  - `formatMinor()` never converts through `number`. JPY has no minor unit, so
    dividing by 100 is wrong, and a large bigint loses its last digit.
  - Archived is not deleted: an archived product must still render on the order
    that bought it.
