# @adminigloo/ai

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
  - @adminigloo/auth@0.1.2
  - @adminigloo/db@0.2.1
  - @adminigloo/env@0.2.1
  - @adminigloo/permissions@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies
  - @adminigloo/env@0.2.0
  - @adminigloo/db@0.2.0
  - @adminigloo/auth@0.1.1
  - @adminigloo/permissions@0.1.1

## 0.1.0

### Minor Changes

- Conventions for streaming routes: authorize before the stream opens, and record
  what it cost.
  
  - The ordering is the point. Once headers are flushed there is no clean way to
    send a 403 — the client has already begun rendering a response that will
    simply stop. Permission resolution completes before the handler is called.
  - Usage is recorded on completion, error AND cancellation. A row that only
    writes on clean completion under-reports every abandoned request, and a user
    closing the tab still consumed tokens.
  - Cost is integer micros supplied by the app. Per-million-token rates lose
    precision as floats at exactly the volumes that matter, and a price baked into
    a package is wrong the week after it ships.
