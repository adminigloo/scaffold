# create-adminigloo-app

## 0.5.1

### Patch Changes

- Generated projects install the CURRENT package versions.
  
  Every dependency was pinned at `^0.1.0`. A caret range on a 0.x version means
  `>=0.1.0 <0.2.0`, so the moment `@adminigloo/env` shipped 0.2.0 a freshly
  generated project quietly installed the old one — everything resolved,
  everything built, and the feature the release added simply was not there.
  
  Versions are now explicit and a test reads the workspace manifests, so the build
  fails if the list drifts.

## 0.5.0

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

## 0.4.0

### Minor Changes

- A signed-in user now always has a local row, so local development works.
  
  The `users` row is created by the Clerk webhook, and a webhook needs a public
  URL — which localhost is not. On a laptop you signed in successfully, no row was
  ever written, every `currentPrincipal()` returned null, and the app treated you
  as a stranger while Clerk's UI showed you as signed in. There was no error to
  search for.
  
  `currentPrincipal` now mirrors the user from the session it already holds, and
  mints their personal workspace. Deliberately NOT gated on NODE_ENV: webhook
  delivery is best-effort everywhere, and a dropped delivery in production leaves
  a paying customer permanently locked out of a product they can see. The webhook
  still keeps the row fresh; this only guarantees it exists. The unique index on
  (identity_provider, external_id) makes the two safe to race, and a soft-deleted
  row is never resurrected.

## 0.3.1

### Patch Changes

- A clean first build.
  
  - `middleware.ts` becomes `proxy.ts`, Next 16's rename. The old name still works
    and warns on every single build, which is exactly the kind of noise you learn
    to scroll past — and then miss the warning that matters.
  - Pins `turbopack.root` to the generated project. Next walks up looking for a
    lockfile, so a project created below another one infers the wrong workspace
    root and warns forever.

## 0.3.0

### Minor Changes

- The generated app can now actually call its own API.
  
  - Adds `src/trpc/client.tsx` (typed React client + provider, wired into the root
    layout) and `src/trpc/server.ts` (RSC caller). Without these the server route
    existed and no component could reach it — `@trpc/react-query` was a dependency
    with nothing importing it.
  - Both clients are created inside `useState` initialisers. A module-level
    QueryClient is shared across every request the server handles, so one user's
    cached data can render for the next.
  - Authorization failures are never retried: the answer will not change, and
    retrying turns one 403 into four in the log.
  - Adds `tsx` (the seed script is run, not built) and `server-only`, plus a
    `db:seed` script — `scripts/seed-roles.ts` told you to run `pnpm tsx` with tsx
    absent from devDependencies.

## 0.2.0

### Minor Changes

- The generator now wires the whole base.
  
  - Re-exports a schema for EVERY installed package that owns a table. It omitted
    `ai`, `email` and `observability`; `drizzle.config` points at that one file, so
    their tables were absent from every migration — the app compiled, booted, and
    failed on the first insert against a table nobody created.
  - Composes an env fragment per installed package, and asks only for variables
    those packages declare. It listed `RESEND_FROM_EMAIL`, which nothing reads,
    while `EMAIL_FROM`, which is required, went unmentioned and the app refused to
    boot.
  - Admin shell as copied source, layered additively. Overlays collide loudly
    rather than overwriting a base file. The permission checklist has three states
    per row — inherit / allow / deny — because a checkbox cannot distinguish
    "inherited from the template" from "set for this person", and sealed rows say
    so instead of silently refusing to stick.
  - Stripe webhook route implementing the full claim protocol, including
    release-on-failure — the step whose absence wedges an event forever.
  - `--model`, `--admin`, `--tenant-noun`, `--ai`, `--email` make it scriptable,
    and reject an unknown value rather than silently defaulting.
  - Seeds role templates idempotently, and never rewrites a template someone has
    customised.

## 0.1.0

### Minor Changes

- The generator. `npx create-adminigloo-app <name>` emits a Next.js project with
  auth, tenancy, permissions, tRPC and the environment contract already wired.
  
  - Answers resolve at generation time into a different set of files and
    dependencies. Nothing becomes a conditional in the emitted app.
  - Plans every file before writing any, so a failure leaves an empty directory
    rather than a half-generated project that looks complete.
  - Non-interactive whenever stdin is not a TTY, so it cannot hang inside CI
    waiting on a prompt nobody can answer.
  - Only depends on packages that are actually published — a generated project
    whose first `pnpm install` 404s is worse than one missing a feature.
  - Writes `SCAFFOLD.md` recording every answer and the packages installed, so a
    later fork can be diffed against the version that produced it.
