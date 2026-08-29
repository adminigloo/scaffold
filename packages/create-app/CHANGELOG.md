# create-adminigloo-app

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
