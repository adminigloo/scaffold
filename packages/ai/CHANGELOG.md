# @adminigloo/ai

## 0.2.0

### Minor Changes

- b525490: The ledger and an allowance, in the package (0.2.0).
  
  - **`@adminigloo/ai/server`** (new entry): `recordAiUsage(db, rates, input)` — one `ai_usage` row per call, priced in integer micros from the PROVIDER's token counts (cache writes included), cost null when unknown, never throws; `aiSpendSince(db, { tenantId?, since, operations? })` — one company's or the whole site's spend, cents rounded once on the total; and **`checkAiAllowance(db, { tenantId, operations, allowance: { monthlyMessages, monthlyCents }, siteDailyCents })`** — a company's month (calls and/or cents, starting again on the 1st, UTC) and the site's day, counted from the rows themselves, refusing in a plain sentence and **failing closed** when the ledger can't be read. Before 0.2 every project carried its own copy of the first two in src/server/ai.ts.
  - **`reserveAiAllowance`** (after an independent review): check AND hold, inside one lock — a "reserved" `ai_usage` row at the call's worst case, counted by every allowance — so calls in flight can't all slip through (40 at once on a 3-question month: 3 pass). `settleAiReservation` writes the real, priced cost (keeping the worst case when the cost is unknown: never null), `releaseAiReservation` frees an unused one. Messages count only ANSWERED calls (`answered` on `aiSpendSince`; a failed one still counts as money). `allowance.dailyCents`: one company's share of the site's day. The site ceiling's sentence says it's the whole site and resets at midnight UTC, with `limitedBy` and `siteResetsAt`, and `onSiteCeiling` tells the site owner.
  - **`DEFAULT_AI_MODEL`** = `"claude-haiku-4-5"` (both entries): the cheapest capable model, the founder's default for every AI feature.

## 0.1.5

### Patch Changes

- Updated dependencies [cc16902]
- Updated dependencies [cc16902]
  - @adminigloo/auth@0.2.0
  - @adminigloo/permissions@0.2.0

## 0.1.3

### Patch Changes

- Updated dependencies
  - @adminigloo/env@0.3.0
  - @adminigloo/auth@0.1.3
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
