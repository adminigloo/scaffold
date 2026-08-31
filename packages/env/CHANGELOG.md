# @adminigloo/env

## 0.3.0

### Minor Changes

- `resolveAppEnv()` works on any host, and an unlabelled deployment no longer
  reads as somebody's laptop.
  
  **The old body was four lines and it failed open.** It switched on `VERCEL_ENV`
  — `production` → production, `preview` → staging, DEFAULT → `local` — and
  consulted nothing else. On any host that is not Vercel there is no `VERCEL_ENV`,
  so a real production server resolved to "a developer's machine" and every gate
  built on "are we deployed?" opened at once. That was demonstrated, not argued:
  a shop served with `next start` and `NODE_ENV=production` minted a licence key
  against a £29 product for free, because the gate meant to close on production
  asked this function and was told it was a laptop. The bootstrap admin grant had
  the identical hole from the identical line — on a self-hosted deployment it
  handed `staff:admin` to whichever stranger signed up first, which is precisely
  what the deployed branch of that grant exists to prevent.
  
  **Precedence, highest first.**
  
  1. `VERCEL_ENV`, unchanged and still first. It is injected by the platform and
     no dashboard row can override it, which is what makes the key-mode binding
     non-negotiable there. Behaviour on Vercel is unchanged to the byte: a preview
     deployment still cannot declare itself production. `development` — what
     `vercel dev` sets — is recognised as a laptop. An unrecognised value now
     falls through instead of mapping to `local`; a typo must not be the
     permissive answer.
  2. `APP_ENV`, exactly `local`, `staging` or `production`, trimmed and
     lowercased. The host-agnostic source, because every host has environment
     variables and none of them has Vercel's.
  3. `NODE_ENV`, as the discriminator that needs no configuration.
  
  **The discriminator.** A laptop must be `local` with nothing configured and a
  server must not be, and neither can be asked to set a variable for that to work.
  `NODE_ENV` is the signal the framework sets in both directions and a person
  never does: `next dev` sets `development`, the test runner sets `test`, and
  `next build` and `next start` set `production` on every host. Anything other
  than `production` — including unset, which is what a `tsx` script has — is the
  toolchain saying "not a production artefact", and means `local`.
  
  **The default is now `staging`, not `local`.** An unlabelled production artefact
  is treated as a deployment. `staging` rather than `production` because it is
  conservative in both directions at once: it closes everything that keys on "is
  this a deployment", and it still refuses live credentials, so an environment we
  could not identify is never allowed to move real money. Defaulting to
  `production` would have closed the same gates while starting to *require* live
  keys on a box we cannot identify, which is worse than the bug.
  
  **`assertKeyMode` is not weakened anywhere.** `expectedKeyMode` is `test` for
  both `local` and `staging`, so an unidentified host demanded a test key before
  this change and demands one after it — identical behaviour, not merely
  comparable. `APP_ENV` cannot smuggle a live key anywhere: there is no value of
  it that lets a live key run somewhere the app then treats as non-production.
  `production` demands live keys and closes the dangerous paths; `staging` and
  `local` refuse live keys outright. Off Vercel the previous answer to "deploy to
  Fly with live keys" was "the boot refuses", so `APP_ENV` does not weaken a
  guarantee, it creates the only honest way to hold one.
  
  **`isDeployed()` now answers a deliberately different question, and that is what
  keeps the zero-credential promise.** It is true only where the platform or the
  operator *said* this is a deployment. `resolveAppEnv()` answers "how dangerous
  may this process be" and fails closed; `isDeployed()` answers "is a missing
  credential a mistake or merely something not done yet" and fails to the tolerant
  side. `defineEnv` and `describeEnv` now key credential strictness off
  `isDeployed()` rather than `appEnv === "local"`, which on Vercel is the same
  predicate it always was — so nothing there changes — and off Vercel means
  `pnpm build` and `pnpm start` on a laptop with no credentials still boot, even
  though both set `NODE_ENV=production`. Setting `APP_ENV=staging` or
  `APP_ENV=production` is what turns deferred credentials into required ones.
  
  **New exports.** `describeAppEnv()` returns `{ appEnv, origin }`;
  `appEnvOrigin()` returns just the origin — `vercel`, `app-env`, `node-env` or
  `unidentified`. `EnvReport` gains `origin` and `deployed`, and
  `formatEnvReport` prints, on an unlabelled host only, that nothing named the
  environment and which variable would.
  
  `KeyModeMismatchError`'s message no longer tells somebody deploying to Fly to
  go and fix a Vercel scope, and now names the likelier off-Vercel fault: not the
  key, but that nothing declared the environment.

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
