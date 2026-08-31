# @adminigloo/observability

## 0.2.1

### Patch Changes

- Updated dependencies
  - @adminigloo/env@0.3.0
  - @adminigloo/db@0.2.2

## 0.2.0

### Minor Changes

- `resolveRequestId` is now reachable from an edge proxy, at
  `@adminigloo/observability/request`.
  
  The three request-id exports were unusable in the one place they matter most.
  A root proxy is the only correct minting site — mint per handler and every hop
  of a request carries a different id, which joins nothing to anything — and a
  proxy runs on the edge runtime, where importing the package barrel pulls `pino`
  in behind it and the build fails before the first request. So every application
  kept its own dependency-free copy beside `proxy.ts`, and the copy drifted
  exactly where it mattered: it did not validate the inbound header, so a newline
  in `x-request-id` was a log injection. With line-delimited JSON,
  `{"requestId":"a\n{\"level\":\"info\",\"msg\":\"payment captured\"}"}` is two
  records to the aggregator, and the second one says whatever the caller wanted.
  
  `src/request.ts` is now published as its own subpath and imports **nothing at
  all** — not `pino`, not `node:crypto`. Ids are minted with
  `globalThis.crypto.randomUUID()`, a standard global in Node 19+ and in every
  edge and worker runtime by definition; the value is only ever a correlation key,
  so the two generators differ in availability and nothing else. A new
  `edge-safety.test.ts` holds the module to having no import statements, asserted
  against the source rather than the bundle — a bundler happily inlines
  `node:crypto` into the artefact, where the import disappears while remaining
  perfectly fatal on the edge.
  
  Nothing is removed and nothing moves: the barrel still re-exports all three, so
  existing consumers are unaffected.
- Three pieces of this package were finished, tested and had no callers. Now they
  have one.
  
  - **`createErrorReporter(db)` writes to `error_log`.** The table, the
    fingerprinter, `admin.recentErrors` and `/admin/errors` all shipped and the
    only code that had ever inserted a row was the demo seed, so every client got
    a beautiful error viewer that is empty forever — read once, believed, and
    taken as evidence that nothing is going wrong. The reporter deduplicates in
    the database with `INSERT … ON CONFLICT ("fingerprint") DO UPDATE`, inferring
    the `error_log_fingerprint_idx` unique index the schema already declares, so
    no migration is needed. Read-then-write was rejected: twenty concurrent
    requests from one bad deploy all read "no row", one wins the unique index and
    nineteen throw from inside the error handler. `occurrences` is incremented by
    the database, `last_seen_at` uses `now()` rather than an instance clock, and
    `resolved_at` is **cleared** — a bug someone ticked off last month that has
    fired again is not resolved, and a stale stamp sorts the row below the
    unresolved ones where nobody sees it again. `first_seen_at` and `id` are the
    two columns the update deliberately never touches.
  
    It never throws. A rejected write, a handle that throws synchronously (what
    `createUnconfiguredDb` does when `DATABASE_URL` is absent) and a logger whose
    own destination has closed are all swallowed, and the log line carries both
    the write failure and the error that was being reported — logging only the
    first would turn the reporter into a device for converting application errors
    into database errors.
  
    Next's `digest` participates in the fingerprint. In a production build a
    client error boundary sees one fixed message for every server error in the
    application; fingerprinting that alone collapses the lot into a single row
    with an enormous count and a useless message, which is the merge failure
    `fingerprint.ts` warns cannot be detected from the outside. `context` goes
    through `redactValue` before it is stored, because nothing redacts on read and
    the row outlives the incident.
  
  - **Rate limiting has call sites.** `createRateLimiter` resolves an Upstash REST
    store from `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` and falls
    back to `createMemoryRateLimitStore` when either is missing — no throw, no
    null, and `limiter.distributed` says which one you got. An in-process Map is
    the correct answer on a laptop and the wrong one on a fleet: across N
    instances the effective limit is N times what was configured and every cold
    start resets it, so the limiter is weakest exactly when traffic scales the
    fleet out. That is written on the limiter rather than implied. The Upstash
    adapter is two commands over `/pipeline` with `PEXPIRE … NX`, not a plain
    `PEXPIRE` that would slide the window forward for as long as traffic
    continues and lock a caller out permanently. Store failures fail **open** by
    default with a logged warning — failing closed takes the application down over
    an outage in the component protecting it — and `onStoreFailure: "deny"` is
    there for the AI route, where an unlimited request costs real money.
  
    `RATE_LIMIT_POLICIES` names the budgets once so the ladder, the webhook routes
    and the AI route cannot disagree. It carries both `ai` (per minute) and
    `aiDaily`, because 20 a minute is still 28,800 a day and the daily cap is the
    one that bounds the invoice; a model route is expected to check both.
    `rateLimitHeaders` produces `X-RateLimit-*` and a `Retry-After` that is never
    zero.
  
    `createProcedures(t, loaders, { rateLimit: { limiter } })` installs the check
    as a rung of the ladder. With the option omitted no middleware is installed at
    all — not one that checks a flag and returns. Anonymous public calls are keyed
    by IP and authenticated rungs by user id, with reads and writes on separate
    budgets and separate counters; the authenticated rungs are built from an
    unlimited root rather than from `publicProcedure`, so one call spends one
    budget instead of every budget it inherits. An anonymous caller with no
    resolvable IP is left unlimited rather than dropped into a shared "unknown"
    bucket that would rate-limit a developer out of their own dev server. The
    middleware is not scope-tagged, so `auditBuiltProcedures` still derives the
    same rung it did before.
  
  - **Every request has an id.** `ScaffoldContext` gains `requestId` and
    `ipAddress`, both filled by `createScaffoldContext({ headers })`. An inbound
    `x-request-id` is preferred — the platform in front of the app already minted
    one, and generating our own regardless means the trace and the logs carry
    different ids for the same request and cannot be joined at all. The inbound
    value is validated rather than trusted: with line-delimited JSON a newline in
    a request id is a second log record that the caller wrote. `requestId` is
    never null, so there is no "no id" case for a handler to get wrong, and the
    reporter lifts it to a top-level key in the `context` column — `context->>
    'requestId'` is what turns a row on `/admin/errors` into a search that finds
    the log lines around it.
  
  `ScaffoldContext` gaining two required fields is the only breaking change: code
  that builds the context by hand rather than through `createScaffoldContext` has
  to supply them.

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

## 0.1.1

### Patch Changes

- Updated dependencies
  - @adminigloo/env@0.2.0
  - @adminigloo/db@0.2.0

## 0.1.0

### Minor Changes

- Structured logging with credentials redacted, an audit vocabulary, error
  capture and rate limiting.
  
  - `REDACT_PATHS` names every credential-bearing variable this scaffold declares,
    and `redactValue` masks by VALUE shape for the ones whose path you cannot know
    in advance — including the hyphen-delimited Anthropic and OpenAI key formats
    that every underscore-based rule misses.
  - Connection strings mask userinfo only: the host is the diagnosis, and it is
    not the secret.
  - `defineAuditedActions` makes the registry the only way to name an action.
    askLou logs some actions as inline string literals, so an audit sweep that
    greps the registry silently misses them.
  - `errorFingerprint` is stable across deploys and machines, which is what lets
    `error_log` increment an occurrence count instead of inserting a millionth row.
  - Fixed-window rate limiting over an injected store, so nothing hard-depends on
    Upstash and the limiter is testable in memory.
