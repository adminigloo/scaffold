# @adminigloo/db

## 0.2.0

### Minor Changes

- A generated project now runs before its credentials exist.
  
  Requiring Neon, Clerk and Stripe accounts before `pnpm dev` works once is
  backwards for a scaffold whose point is starting fast. Strictness now scales
  with environment instead.
  
  - `defineEnv({ optionalUntilDeployed })` relaxes a variable ONLY when it is
    absent and only on a laptop. A value that is present but malformed still fails
    at boot everywhere — a mistyped connection string is not a deferred
    credential. Deployments relax nothing.
  - The relaxed keys widen to `| undefined` in the type, so a consumer cannot read
    one as a definite string and get undefined at runtime.
  - `describeEnv()` returns a serialisable report of what is configured, what is
    missing, and which feature each gap disables. It never returns a value — a
    setup page that echoes a secret is worse than no setup page.
  - `createDb()` accepts an absent connection string and returns a handle that
    throws a typed error naming `DATABASE_URL` and `.env.local` on first query,
    rather than crashing at import with "cannot read property select of null".
  - The generator writes a ready-to-run `.env.local`, mounts ClerkProvider only
    when Clerk is configured, and ships a `/setup` page reading the same schemas
    boot validation uses — so it cannot drift the first time a package is added.
  
  The key-mode assertion is untouched. A live key still refuses to run outside
  production, in every environment, and neither `SKIP_ENV_VALIDATION` nor listing
  that key as deferrable can switch it off.

### Patch Changes

- Updated dependencies
  - @adminigloo/env@0.2.0

## 0.1.0

### Minor Changes

- Neon Postgres primitives.
  
  - `createDb()` — pooled WebSocket client. WebSocket rather than HTTP mode so
    interactive transactions stay atomic; guards against pool leaks under Next's
    hot reload.
  - Column conventions: UUID v7 entity keys, bigserial log keys, bigint minor-unit
    money, timestamptz, soft-delete markers.
  - `withRollback()` — the integration-test sandbox. Real SQL, nothing committed,
    and it fails loudly rather than silently committing if the driver swallows the
    rollback signal.
  - `assertMigrationAllowed()` — blocks hand-run production migrations and blocks
    any migration handed a pooled connection string.
  - `dbServer()` env fragment enforcing the pooled/unpooled split.
