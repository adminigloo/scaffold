# @adminigloo/stripe

## 0.1.3

### Patch Changes

- Updated dependencies
  - @adminigloo/env@0.3.0
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
  - @adminigloo/env@0.2.1
  - @adminigloo/permissions@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies
  - @adminigloo/env@0.2.0
  - @adminigloo/db@0.2.0
  - @adminigloo/permissions@0.1.1

## 0.1.0

### Minor Changes

- The Stripe primitive: sessions, signature verification, an event ledger with
  leased two-phase idempotency, and a typed handler registry.
  
  - The ledger fixes both source repos. riddler-go tracks "did I just insert
    this" in a process-local `Set`, which returns the wrong answer on the first
    delivery to a cold instance and still answers 200, so the event is dropped
    permanently. trailcards has no ledger and lets both
    `checkout.session.completed` and `payment_intent.succeeded` create orders.
  - Claims are LEASED. Without that, a handler that throws leaves the row
    existing-but-unprocessed forever, every retry defers, and Stripe disables the
    endpoint after three days — the ledger reintroducing the loss it prevents. A
    thrown handler releases its claim immediately; a dead process ages out.
  - `attempts` and `last_error` are written by the documented statements, so a row
    stuck at attempts 12 is an alert that can actually fire.
  - Owns the whole `billing.*` permission namespace, including its defaults.
    `billing.refund.issue` is sealed and seeded to nobody.
