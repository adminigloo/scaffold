# @adminigloo/catalog

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
