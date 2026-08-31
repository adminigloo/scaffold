# @adminigloo/env

## 0.2.1

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

## 0.1.1

### Patch Changes

- `defineEnv` now returns usable value types instead of `unknown`.
  
  TypeScript cannot compute `createEnv`'s mapped return type while the schema
  records are still generic parameters, so every variable arrived as `unknown` and
  `env.DATABASE_URL` failed to typecheck at the first use. Found by generating a
  project and running `tsc` on it, not by a unit test — the package's own tests
  never read a value back out. `InferEnvSchemas` spells the result out, and a
  compile-time assertion now guards it.

## 0.1.0

### Minor Changes

- Boot-time environment validation.
  
  - `resolveAppEnv()` derives local/staging/production from `VERCEL_ENV` — never
    from a variable of its own, so the deployment cannot be spoofed from a dashboard.
  - `assertKeyMode()` binds provider key mode to the deployment. Runs outside Zod,
    so `SKIP_ENV_VALIDATION` cannot switch it off: a live key can never run outside
    production.
  - `appUrl()` refuses a localhost origin on a real deployment, and says in the
    error that `NEXT_PUBLIC_*` requires a rebuild.
  - Pooled vs unpooled Postgres URL discrimination, prefixed-secret and
    generated-secret helpers.
  - `defineEnv()` composes per-package env fragments.
