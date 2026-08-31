# @adminigloo/testing

## 0.1.3

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @adminigloo/env@0.3.0
  - @adminigloo/tenancy@0.3.0
  - @adminigloo/auth@0.1.3
  - @adminigloo/db@0.2.2
  - @adminigloo/stripe@0.1.3

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
- Updated dependencies
  - @adminigloo/auth@0.1.2
  - @adminigloo/db@0.2.1
  - @adminigloo/env@0.2.1
  - @adminigloo/permissions@0.1.2
  - @adminigloo/stripe@0.1.2
  - @adminigloo/tenancy@0.2.0

## 0.1.1

### Patch Changes

- Updated dependencies
  - @adminigloo/env@0.2.0
  - @adminigloo/db@0.2.0
  - @adminigloo/auth@0.1.1
  - @adminigloo/stripe@0.1.1
  - @adminigloo/permissions@0.1.1
  - @adminigloo/tenancy@0.1.1

## 0.1.0

### Minor Changes

- The helpers a generated project needs to test auth, permissions and Stripe with
  no live service.
  
  - `expectIdempotent` fires the same event twice and asserts exactly one side
    effect. Had it existed, both source repos' webhook bugs would have failed a
    test rather than reaching production.
  - Real signers, not stubs: `signStripePayload` is verified byte-for-byte against
    stripe-node's own generator, and `fakeIdentityProvider` signs with svix at the
    current time — a fixed timestamp makes the suite fail an hour later, which
    already happened here once.
  - `assertCatalogConformance` is what makes renaming a permission key safe:
    unknown references, unreachable keys, and stored grants pointing at a
    permission the catalog no longer declares.
  - `assertNotProduction` fails closed — it requires positive evidence that a
    target is disposable rather than trusting the absence of a red flag.
