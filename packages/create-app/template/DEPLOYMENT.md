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
change is made twice. Keep **"verify email at sign-up"** on in both: the first
administrator and every invitation are matched against VERIFIED addresses only,
and an instance that lets people skip verification lets anyone claim one.

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
| Vercel → Preview scope        | staging values, `DATABASE_URL_UNPOOLED` included |
| Vercel → Production scope     | production values, `DATABASE_URL_UNPOOLED` included |
| GitHub Environment `staging`  | `DATABASE_URL_UNPOOLED` for the staging branch |
| GitHub Environment `production` | `DATABASE_URL_UNPOOLED` for the production branch |

The production database URL is never on anyone's laptop: it lives in Vercel's
**Production** scope (the app reads it, and the build refuses to start
without it) and in the `production` GitHub Environment (the migrations run
from there). It is not in anyone's `.env.local`, which is what makes "nobody
hand-runs a production migration" true rather than agreed.

### Off Vercel, one variable names the environment: `APP_ENV`

**Set it. Nothing else can answer the question.** On Vercel the platform injects
`VERCEL_ENV` and the app reads it; nobody has to do anything. On Docker, Fly,
Railway, Render, ECS or a plain VPS there is no such variable, so the app falls
back to `NODE_ENV` — which every production server sets, and which therefore
tells it "this is a production artefact" and nothing more. A deployment that
says no more than that is treated as an **unnamed deployment**: cautious about
anything dangerous, lenient about anything missing.

| | named (`APP_ENV=staging` or `production`) | unnamed |
| --- | --- | --- |
| deferred credentials (`DATABASE_URL`, Clerk) | required, boot fails without them | still optional |
| `NEXT_PUBLIC_APP_URL` pointing at localhost | refused at boot | allowed |
| first administrator | whoever signs in with `BOOTSTRAP_ADMIN_EMAIL` verified, whenever no administrator exists — once the roles are installed (the deploy seeds them; §4) | same |
| live Stripe / Clerk keys | accepted on `production` only | refused |
| simulated checkout | `staging` + `ALLOW_SIMULATED_CHECKOUT=true`, never on `production` | unavailable |

So an unnamed deployment is safe but half-configured: it will boot with a
missing credential rather than telling you about it, and it cannot hold a live
key. `/setup` says so on the page when this is the situation you are in.

`APP_ENV` never overrides `VERCEL_ENV`. On a Vercel preview, `APP_ENV=production`
does nothing at all — the platform's answer wins, which is what keeps the
live-key binding non-negotiable there. Do NOT put `APP_ENV` in `.env.local`
either: that file is for your machine, and a value in it would follow a
`pnpm start` you ran to check the production build.

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

### `vercel.json` crons

The list is written by the generator from what you installed. With comms it
holds the queue drain, `/api/cron/comms`, once a day — the only schedule
Vercel's Hobby plan accepts. On Pro, tighten it (every 15 minutes, `*/15 * * * *`,
is a good resolution for appointment reminders), or point any external
scheduler at the URL with the secret. Either way set `CRON_SECRET` in the
Vercel project: the route refuses every call without it. Immediate messages
(the acknowledgement of a booking request, the confirmation when staff accept
it) are sent in the request that causes them and never wait for this.

With scheduling it also holds `/api/cron/scheduling`, once a day: it releases
booking requests nobody answered in time and tells the customer. A lapsed
request stops holding its time at its deadline either way, and is also
released whenever a customer books or staff open the calendar, so the cron
matters most in a quiet week. On Pro, run both every 15 minutes:

```json
"crons": [
  { "path": "/api/cron/comms", "schedule": "*/15 * * * *" },
  { "path": "/api/cron/scheduling", "schedule": "*/15 * * * *" }
]
```

**Appointment reminders on the daily schedule.** The comms cron runs at 14:00
UTC (7 AM Mountain Standard Time), and `src/server/scheduling-notify.ts` tells
the scheduling emails so (`REMINDER_RUNS`): each reminder is queued for the
last run at or before its time, so it arrives the day before the visit — at
least the lead time ahead, often a few hours more — while the reschedule and
cancel link in it still works. When you tighten the cron to every 15 minutes,
change `REMINDER_RUNS` to `{ everyMinutes: 15 }` in the same commit, and
reminders go out at the lead time exactly. The staff calendar shows a banner
when reminders are waiting past their time (the cron isn't running) or the
secret isn't set.

With the estimator it also holds `/api/cron/estimator`, once a day: quotes
past their date are marked expired (with comms, the customer and the office
are told), and photos a customer uploaded but never sent are deleted after two
days. The follow-up on an unanswered quote is a comms message, sent by
`/api/cron/comms`; `src/server/estimator-notify.ts` queues it for that cron's
daily run (`FOLLOW_UP_RUNS`) — change it to `{ everyMinutes: 15 }` when you
tighten the comms cron, as with reminders.

The same `CRON_SECRET` covers every route.

### Estimator: photos and photo reading

A customer's photo is kept with their estimate in the project's file storage
(`BLOB_READ_WRITE_TOKEN`, Vercel → Storage → Blob). Without it photos are not
kept, and the staff screens say so.

With `--ai`, the photo is read by Claude Haiku 4.5 (`ESTIMATOR_TAKEOFF_MODEL`
to change it; the model needs its price in `MODEL_RATES`, `src/server/ai.ts`).
The model only reports what it sees — how many steps, how tall they look —
and every price is worked out by the estimator's code. One small call per
photo, never two for the same photo, none when the customer has typed the
measurement; each call's tokens and cost are written to `ai_usage`. The owner
sets the daily budget and the readings per visitor in Estimate settings; past
either, customers are asked to count the steps themselves. `ANTHROPIC_API_KEY`
switches it on.

The business's name, tax rate, quote rules and who hears about new leads are
set by the owner in `/admin/estimator/settings`. Until the owner has saved the
name and tax rate there, `/estimate` says instant estimates aren't available
and no quote can be sent: a customer never gets an email from a business with
no name, at a tax rate nobody chose. `ESTIMATOR_TIME_ZONE` only
chooses the zone quotes are dated in the first time the estimator runs
(SCHEDULING_TIME_ZONE, then America/Denver, when unset). The price book starts
empty: the owner builds it, or loads the sample catalog, at
`/admin/estimator`. A new product, and every sample product, stays off
`/estimate` until the owner turns it on.

### Scheduling: Google Maps

`GOOGLE_MAPS_API_KEY` turns on real drive times and address lookup for
scheduling. Without it the app still schedules: drive times are straight-line
estimates, marked as estimates on the calendar and the crew's route, and
addresses are kept as typed.

In the Google Cloud console, on the project that holds the key:

1. Enable the **Geocoding API** and the **Distance Matrix API**.
2. Restrict the key to those two APIs (API restrictions), and to your server
   (an IP restriction, where your host has fixed outbound addresses). It is a
   server key and never reaches a browser.
3. Set it in the Vercel project for Production and Preview.

A key with either API switched off answers REQUEST_DENIED; the app logs
"google maps request failed" and carries on with what it has.

The business's time zone, name, services, crews and hours are set by the owner
in `/admin/schedule/settings`. `SCHEDULING_TIME_ZONE` only chooses the zone the
business starts in the first time scheduling runs (America/Denver when unset).
Online booking starts **off**: the booking page says it is closed until the
owner has checked those and switched on "Take bookings online", and the staff
calendar lists what is left to set up.

### Scheduling: crews on their phones

A crew member needs no developer. They sign in once at `/sign-in`; the owner
then picks them for their crew in Schedule settings → Crews ("Who opens this
crew's route"). Picking somebody who holds no staff role gives them the
**Crew member** role — `staff.schedule.route` and nothing else: their own
stops at `/admin/schedule/today`, Start, Complete and "Couldn't do it", no
calendar, no settings, no Messages. Un-picking them takes it away. Both are in
the audit log. Office staff keep their own role (`staff.schedule.view`,
`.manage`, `.settings`); picking the owner for a van never demotes them.

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

### Running the integration suites

`pnpm test` runs two projects. `unit` needs nothing. `integration` needs a
database, and without one each of its suites prints a line saying it has been
skipped and why — a skip you can read is the point, because the alternative is a
green tick over tests that never ran, and this project has been bitten by
exactly that.

Any Postgres will do; it does not have to be Neon, and it should not be your
staging branch. Every test rolls its transaction back, but the schema still has
to be there.

```
docker run -d --name pg -e POSTGRES_PASSWORD=app -e POSTGRES_USER=app \
  -e POSTGRES_DB=app -p 5432:5432 postgres:17
DATABASE_URL_UNPOOLED=postgres://app:app@localhost:5432/app pnpm db:migrate
```

The app's driver carries the wire protocol over a WebSocket — that is what lets
a serverless function hold an interactive transaction — so it cannot dial a
plain Postgres listener. `DATABASE_WS_PROXY` points it at a bridge; see
`src/db/index.ts`. With `ghcr.io/neondatabase/wsproxy` on port 5433:

```
DATABASE_URL=postgres://app:app@localhost:5432/app \
DATABASE_WS_PROXY=127.0.0.1:5433/v1 \
REQUIRE_DATABASE=1 pnpm test:integration
```

`REQUIRE_DATABASE=1` turns "no database" from a skip into a failure. Set it in
any pipeline whose job is to run these; leave it unset on a laptop.

## 4. What a release does

`.github/workflows/deploy.yml`, on a push to `staging` or `main`:

```
verify (typecheck + test)
   └─ migrate-staging          ← always, both branches; then db:seed:deploy
        ├─ deploy-staging      ← only on `staging`
        └─ migrate-production  ← only on `main`, needs migrate-staging; then db:seed:deploy
             └─ deploy-production
```

Each migrate job ends by seeding the permission catalog (`pnpm db:seed:deploy`),
so the roles and the first administrator exist before the new code is live.
Run by hand (Actions → Deploy → Run workflow), the same workflow runs only its
`admin-grant` job.

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
Preview scope (staging values) and the Production scope (production values).
Add `GITHUB_TOKEN` to both scopes — `.npmrc` interpolates it to install
`__SCOPE__/*` from GitHub Packages during the build (the same classic token
as `PACKAGES_READ_TOKEN` below).

**Vercel needs these in BOTH scopes, or the build refuses to start** — set them
before the first push to `main`, or that release stops halfway (the
migrations and the seed run, then `vercel build` fails on the environment
check):

<!-- adminigloo:deploy-required-env -->

Everything else in `.env.example` switches a feature on, or is optional: the
app starts without it and `/setup` says what each missing key turns off.

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
| `PACKAGES_READ_TOKEN`  | A **classic** personal access token with the `read:packages` scope, from a GitHub account that has been given read access to the `__SCOPE__` packages (your seller grants it). GitHub's fine-grained tokens can't read npm packages, and the automatic `secrets.GITHUB_TOKEN` is scoped to this repository and cannot read packages published from the scaffold repo |

Repository variable (optional):

| Variable         | Effect                                                                  |
| ---------------- | ----------------------------------------------------------------------- |
| `STAGING_DOMAIN` | A domain on the Vercel project. Every `staging` deploy is aliased to it, so reviewers get one stable URL instead of a new one per push |

`PACKAGES_READ_TOKEN` serves BOTH workflows: `ci.yml` installs with it too, so a
pull request can pass the check branch protection requires.

Repository (or environment) variable `BOOTSTRAP_ADMIN_EMAIL` — the address that
becomes the first administrator. Set it here for the deploy seed AND in Vercel
(both scopes) for the app; see "First run" below.

**Branch protection on `main`** — pull requests required, `ci.yml` required to
pass, linear history, no direct pushes.

### Clerk's Production instance

Production refuses test keys, and Clerk's live keys need a domain you own.

1. In Clerk, create the **Production** instance and give it your domain.
2. Attach the same domain to the Vercel project (Settings → Domains).
3. Add the DNS records Clerk lists for that domain, and wait for Clerk to show
   them as verified. Clerk sends its sign-in emails from this domain.
4. Put `pk_live_…` / `sk_live_…` in Vercel's **Production** scope only; the
   Development instance's `pk_test_…` / `sk_test_…` go in **Preview**.

### Clerk's webhook (one per instance)

The webhook keeps each person's row in step with Clerk, sets new people up if
their first page request hasn't, and — the part nothing else does — takes a
deleted account's access away. Without it, deleting someone in Clerk never
reaches this app.

| Instance | Endpoint URL | Events | Secret goes in |
| --- | --- | --- | --- |
| Development | `https://<STAGING_DOMAIN>/api/webhooks/clerk` | `user.created`, `user.updated`, `user.deleted` | Vercel **Preview** → `CLERK_WEBHOOK_SIGNING_SECRET` |
| Production | `https://<your domain>/api/webhooks/clerk` | the same three | Vercel **Production** → `CLERK_WEBHOOK_SIGNING_SECRET` |

The staging endpoint needs `STAGING_DOMAIN` (a per-deploy URL changes on every
push) and must not sit behind Vercel's login wall — see the next section.
Locally no webhook is needed: the first page request sets you up.

### `NEXT_PUBLIC_APP_URL` and Vercel's Deployment Protection

Invitation links and each company's public address are built from
`NEXT_PUBLIC_APP_URL`. Set it to your domain in **Production** and to
`https://<STAGING_DOMAIN>` in **Preview**, then redeploy (it is inlined at build
time). Unset on production it falls back to the project's production domain,
never a `*.vercel.app` deployment URL.

Vercel protects preview deployments with a login by default ("Standard
Protection"). An invitee opening a staging invitation link, and Clerk delivering
a staging webhook, would both meet that login. Add your staging domain as a
**Deployment Protection Exception** (Settings → Deployment Protection →
Deployment Protection Exceptions → Add Domain, `STAGING_DOMAIN`; available
on every plan): both then reach the app, and every other preview stays
protected.

A "Protection Bypass for Automation" in the webhook URL is NOT enough on its
own: it lets Clerk's webhook through, but people opening a staging invitation
link still land on Vercel's login page.

### Email (invitations by email)

Without `--email` (or until Resend is set up) every invitation is a link the
inviter copies — the team page says so and hands it over. In a project made
with `--email`, `EMAIL_FROM` is still needed for a deployment to start (it's
in the table above); `RESEND_API_KEY` is what can wait. To send them:

1. In Resend, add and verify your sending domain.
2. Set `RESEND_API_KEY` and `EMAIL_FROM` (an address on that domain) in both
   Vercel scopes.
3. Send a test invitation on staging and open it from the email.

A project generated without email gets it with
`pnpm dlx @adminigloo/create-app add email`.

### First run: roles, the first administrator, and getting back in

- **The deploy installs the roles.** Right after `pnpm db:migrate:deploy`, both
  migrate jobs run `pnpm db:seed:deploy` (`scripts/seed-deploy.ts`): the role
  templates, what each may do, and the owner-role backfill. Idempotent, and it
  never touches a role you customised. A permission a new feature adds reaches
  production's roles in the same release.
- **The first administrator** is `BOOTSTRAP_ADMIN_EMAIL` — set as a GitHub
  variable (for the deploy seed) and in Vercel (for the app). They become an
  administrator whenever NO administrator exists: at the deploy seed if they
  have already signed in, or the moment they sign in or open /admin. The
  address must be verified in Clerk.
- **Self-heal.** Signing in before the roles were installed no longer locks
  /admin: open it again after the next deploy (or `pnpm db:seed` locally).
  The bootstrap logic is `ensureBootstrapAdmin` in
  `__SCOPE__/permissions/server` (it was `src/server/bootstrap.ts`).
- **Locked out, and an administrator exists?** For production: GitHub →
  Actions → Deploy → **Run workflow**, with your email and `production` (it
  waits for the production environment's reviewer, like a migration). On your
  laptop, `pnpm admin:grant you@example.com` changes the database in
  `.env.local` — staging.
- **Adding more administrators** needs neither: an administrator gives anyone
  a staff role, including administrator, from **People** in /admin.

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
| `pnpm install` fails in Actions with 401 from `npm.pkg.github.com` | `PACKAGES_READ_TOKEN` | Missing, expired, fine-grained, or without `read:packages`. Make a new classic token. Both `ci.yml` and `deploy.yml` use it. |
| `pnpm install` fails with 404 from `npm.pkg.github.com` | which account the token belongs to | The token works, but that GitHub account has no access to the `__SCOPE__` packages yet. Ask your seller for access. |
| `vercel build` stops on the environment check after the migrations ran | the table in §5 | A variable from "Vercel needs these in BOTH scopes" is missing in that scope. Add it and run the deploy again. |
| `pnpm/action-setup` stops with "No pnpm version is specified" | `packageManager` in package.json | The generator writes it; put it back if it was removed. |
| /admin says "The roles aren't installed yet" | the deploy's `db:seed:deploy` step | Re-run the deploy, or `pnpm db:seed` locally. |
| /admin says "You do not have access" and you run the site | whether an administrator exists | Run the Admin grant workflow (production) or `pnpm admin:grant` (local/staging). |
| Someone deleted in Clerk can still sign in | the Clerk webhook for that instance | Set it up (§5); deletions reach the app only through it. |

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
