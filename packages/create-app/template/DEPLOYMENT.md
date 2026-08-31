# Deploying __PROJECT_NAME__

Two surfaces, one Neon project, one Vercel project, one GitHub workflow.

Everything here is enforced somewhere: `scripts/migrate.ts` refuses the runs
this document says are forbidden, `.github/workflows/deploy.yml` orders the
steps this document describes, and `src/env.ts` fails the build when a variable
is missing. If a rule below has no enforcement named next to it, treat it as a
gap rather than as a convention.

## 1. The model

| Surface              | Runs on               | Database             | Keys      |
| -------------------- | --------------------- | -------------------- | --------- |
| `localhost:3000`     | your laptop           | Neon `staging` branch | test mode |
| Vercel **Preview**   | `staging` branch push | Neon `staging` branch | test mode |
| Vercel **Production**| `main` branch push    | Neon `production` branch | live mode |

Local and Preview share the same backing services deliberately. A third
"development" instance of Clerk, Neon and Stripe is three more places for a
setting to drift, and the bugs it would catch are the ones staging already
catches.

The cost of sharing is real and worth naming: your laptop writes to the same
database the review URL reads from. With one developer that is a feature — you
can see your own change on staging a second after making it. With two, you race
each other's schema. When that day comes, give each developer their own Neon
branch off `staging` and change one line in their `.env.local`.

### Neon: one project, two branches

**Not two projects.** One project with two branches:

```
production   (default branch — the customer database)
└── staging  (child of production — localhost and Preview both use this)
```

`staging` being a *child* of `production` is what makes it useful: Neon can
reset it from its parent, so "staging has drifted into nonsense" is a
thirty-second fix rather than a rebuild.

> **Resetting staging from production copies production DATA into staging** —
> and staging credentials are on a laptop and in Preview builds. On a real
> customer database that is a data-protection event, not a housekeeping step.
> Reset from parent freely before launch. After launch, use Neon's anonymised
> branch or restore from a schema-only dump instead.

Each branch gives you two connection strings, and both are needed:

- **Pooled** (`...-pooler...`) → `DATABASE_URL`. The app uses this.
- **Direct** (no `-pooler`) → `DATABASE_URL_UNPOOLED`. Migrations use this, and
  only this. Drizzle through a pooler can report a successful migration while
  leaving the journal inconsistent — `assertMigrationAllowed` in
  `__SCOPE__/db` refuses a pooled string outright rather than letting you find
  out during a release.

### Clerk and Stripe

One Clerk application with its two built-in instances: **Development** (local +
Preview) and **Production**. Instance settings do not sync — every dashboard
change is made twice.

One Stripe account, test mode for local + Preview, live mode for Production,
with a separate webhook endpoint and signing secret per mode.

`src/env.ts` binds key mode to deployment: a `pk_live_` key outside production,
or a `pk_test_` key in it, throws at boot. That check reads the raw values
outside Zod, so neither `SKIP_ENV_VALIDATION` nor marking a key optional can
switch it off.

## 2. Environment variables

**Same names everywhere. No `_STAGING` / `_PROD` suffixes in code.**
`DATABASE_URL` holds the staging pooled string in the Vercel Preview scope and
the production pooled string in the Production scope. The scope carries the
difference; the code never asks which environment it is in.

Where values live:

| Location                      | Holds                                    |
| ----------------------------- | ---------------------------------------- |
| `.env.local` (gitignored)     | your local values — staging branch, test keys |
| `.env.example`                | the names only, no values. The authority on what this project needs |
| Vercel → Preview scope        | staging values                            |
| Vercel → Production scope     | production values                         |
| GitHub Environment `staging`  | `DATABASE_URL_UNPOOLED` for the staging branch |
| GitHub Environment `production` | `DATABASE_URL_UNPOOLED` for the production branch |

The production database URL exists in exactly one place: the `production`
GitHub Environment. It is not in anyone's `.env.local`, which is what makes
"nobody hand-runs a production migration" true rather than agreed.

### The rate limiter needs Upstash once there is more than one instance

`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are optional and the app
runs without them — `src/server/rate-limit.ts` falls back to counting in the
process's own memory, which is exactly right for one dev server. On Vercel it is
not: every instance keeps its own counter, so a limit of five a minute becomes
five a minute *per instance*, and every cold start resets it to zero. The
limiter is therefore weakest at the moment traffic has scaled the fleet out,
which is the moment it is being leant on. Set both in the Preview and Production
scopes, or accept that the limit is advisory. `/setup` reports the pair under
"Rate limiting", including the half-configured state.

There are two limiters and they answer a store outage differently, which is a
deployment decision rather than a detail. `limiter` — the procedure ladder and
both webhook routes — **fails open**: a Redis blip must not take the product
down with the component that was protecting it, and everything on it is either
authenticated, signature-verified or retried by a provider. `failClosedLimiter`
**refuses** while the store is unreachable, and the endpoints on it are the ones
where an unlimited request is expensive rather than merely untidy. Losing
telemetry for the length of an outage is the accepted cost; handing out an
unbounded write endpoint during the incident that took the store out is not.

### `NEXT_PUBLIC_*` values are baked in at build time

Correcting one in the Vercel dashboard changes nothing until the deployment is
**rebuilt**. This is why `.github/workflows/deploy.yml` runs `vercel build
--prod` for production rather than promoting a preview build: a preview-scope
build promoted to production serves live traffic with the staging app URL
inlined into every canonical tag, redirect and email link.

### `vercel.json` turns off Git deploys for `main` and `staging`

JSON cannot carry a comment, so the reason lives here:

```json
"git": { "deploymentEnabled": { "main": false, "staging": false } }
```

Left enabled, Vercel builds and promotes the moment a commit lands — in parallel
with the migration, not after it — and the new code meets the old schema. The
workflow is the only thing allowed to deploy those two branches.

Feature branches keep their automatic previews. They run against the **staging**
database, so a preview whose migration has not yet reached `staging` will fail
on the first query that touches the new column. Push to `staging` before asking
anyone to look.

## 3. Day to day

```
feature branch ──PR──▶ staging ──▶ Preview deploy   (test-mode, staging DB)
                          │
                          └──PR──▶ main ──▶ Production deploy
```

**Schema change:**

1. Edit `src/db/schema.ts` (or the package that owns the table).
2. `pnpm db:generate` — writes a migration under `drizzle/`.
3. **Commit the migration with the schema change, in the same commit.** A schema
   change without its migration passes CI, deploys, and fails at runtime.
4. `pnpm db:migrate` locally to apply it to the staging branch.
5. Push. The workflow applies it to staging again (a no-op, and the proof it
   applies from a clean checkout) before anything reaches production.

`pnpm db:push` is not in this project's scripts on purpose. It syncs a schema
without producing a migration file, and the file is the only record that ever
reaches production.

## 4. What a release does

`.github/workflows/deploy.yml`, on a push to `staging` or `main`:

```
verify (typecheck + test)
   └─ migrate-staging          ← always, both branches
        ├─ deploy-staging      ← only on `staging`
        └─ migrate-production  ← only on `main`, needs migrate-staging
             └─ deploy-production
```

**The `needs` edge from `migrate-production` to `migrate-staging` is the
protection.** A push to `main` applies the migration to a real database forked
from production, and only proceeds if that succeeded. Nothing about it is
advisory: if staging fails, the production job never starts.

Three more things hold it up:

- `verify` repeats what `ci.yml` checks on pull requests. GitHub gives no
  ordering between workflows, so without it a red typecheck would be running
  beside the production migration rather than blocking it.
- `migrate-production` sets `ALLOW_PRODUCTION_MIGRATION=true`. Nothing else
  does. `scripts/migrate.ts` refuses a production target without it, so the
  same command run from a laptop stops before it connects.
- The `production` GitHub Environment should carry a **required reviewer** and
  **deploy branches: `main` only**. That approval is the last gate before the
  customer database.

## 5. First-time setup

**Neon** — one project. Rename the default branch to `production`, create
`staging` as a child of it. Copy four connection strings (pooled and direct,
per branch).

**Vercel** — import the repo. Production branch = `main`. Set env vars in the
Preview scope (staging values) and the Production scope (production values);
`.env.example` lists the names. Add `GITHUB_TOKEN` to both scopes — `.npmrc`
interpolates it to install `__SCOPE__/*` from GitHub Packages during the build.

**GitHub** — create two Environments:

| Environment  | Protection                              | Secret                   |
| ------------ | --------------------------------------- | ------------------------ |
| `staging`    | none                                     | `DATABASE_URL_UNPOOLED` (staging branch, direct) |
| `production` | required reviewer, branch `main` only    | `DATABASE_URL_UNPOOLED` (production branch, direct) |

Repository secrets:

| Secret                 | What it is                                                              |
| ---------------------- | ----------------------------------------------------------------------- |
| `VERCEL_TOKEN`         | Vercel account token, used by the CLI in the deploy jobs                 |
| `VERCEL_ORG_ID`        | from `.vercel/project.json` after `vercel link`                          |
| `VERCEL_PROJECT_ID`    | same file                                                                |
| `PACKAGES_READ_TOKEN`  | PAT with `read:packages`. The automatic `secrets.GITHUB_TOKEN` is scoped to this repository and cannot read packages published from the scaffold repo |

Repository variable (optional):

| Variable         | Effect                                                                  |
| ---------------- | ----------------------------------------------------------------------- |
| `STAGING_DOMAIN` | A domain on the Vercel project. Every `staging` deploy is aliased to it, so reviewers get one stable URL instead of a new one per push |

**Branch protection on `main`** — pull requests required, `ci.yml` required to
pass, linear history, no direct pushes.

## 6. When a migration fails mid-deploy

The deploy has not happened. The workflow stops at the failed job; Vercel was
never asked to build. Whatever is live is still live and still matching the
schema it was written against.

1. **Read the job log.** `scripts/migrate.ts` prints the target, the database
   host and the migration list before it connects, so the first question — which
   database did this touch — is answered above the stack trace.
2. **Identify how far it got.** Postgres runs each migration file in a
   transaction, so an individual file is all-or-nothing. What is not atomic is
   the *sequence*: with three pending migrations, file 2 failing leaves file 1
   applied and file 3 not. `drizzle.__drizzle_migrations` lists what landed.
3. **Fix forward.** Write a new migration that reconciles the state, commit it,
   and merge again. Editing the failed migration file in place does not work —
   the ones that already applied on staging are recorded as applied and will
   never run again.
4. **If forward is not possible**, restore from Neon's point-in-time history:
   Neon → branch → Restore, to a timestamp before the deploy started. Then treat
   the whole release as reverted and start over.
5. **Never** hand-run the migration against production to "unstick" it.
   `ALLOW_PRODUCTION_MIGRATION` is set in one file, and that file is the record
   of who released what.

A migration that fails on **staging** during a push to `main` is the system
working. The production database has not been touched.

## 7. Troubleshooting

| Symptom | First check | Fix |
| --- | --- | --- |
| `ProductionMigrationBlockedError: … the connection string is the POOLED endpoint` | the secret's value | Use the direct string. The pooled host contains `-pooler`. |
| `ProductionMigrationBlockedError: … allowProduction was not set` | who is running it | Expected. Production migrations run from `deploy.yml`, not from a shell. |
| `MIGRATION FAILED … VERCEL_ENV is set` | where the command ran | Something moved the migration into the Vercel build. Builds re-run on every rollback and promote; put it back in the workflow. |
| Deploy succeeded, site serves the wrong URLs in links and emails | `NEXT_PUBLIC_APP_URL` in the Vercel scope | Fix the variable, then **redeploy**. `NEXT_PUBLIC_*` is inlined at build time; editing it alone changes nothing. |
| Boot fails with `KeyModeMismatchError` | which key is in which scope | A `_test_` key in Production or a `_live_` key in Preview. This check cannot be disabled — the values are wrong, not the check. |
| Preview 500s on a query against a new column | whether `staging` has the migration | Merge to `staging` first; feature-branch previews share the staging database. |
| A `staging` push seems to have been skipped | the Actions queue | Deploys serialise on one concurrency group. A run queued behind a production approval is superseded by the next push to the same branch. Approve or cancel the pending production run. |
| `pnpm install` fails in Actions with 401 from `npm.pkg.github.com` | `PACKAGES_READ_TOKEN` | Expired or missing `read:packages`. |

## 8. Demo data

`pnpm db:seed:demo` creates one __TENANT_LABEL__ with five members, a permission
story that exercises every state of the checklist, an audit trail and a triage
queue. It is idempotent, and it **refuses to run unless the app environment is
local and `NEXT_PUBLIC_APP_URL` points at localhost** — the second check exists
because the first one passes on any machine that is not Vercel, including one
whose `.env.local` was filled in with `vercel env pull`.

Demo people are created under the `demo` identity provider with `.invalid`
email addresses, so they can never collide with a real Clerk webhook and can
never be sent mail.
