# Landscape and gaps

> **Status note, added after the fact.** This is a point-in-time survey and is left as one;
> the recommendations below have not been rewritten. Four of them have since shipped, so read
> the gap statements about them as history rather than as current state: the `catalog:`
> protocol (`pnpm-workspace.yaml`, two catalogs — build ranges and the wider peer ranges),
> `@clerk/break-check` in the package CI (`break-check.config.json`, the `api-surface` job),
> `adminigloo.json` written by the generator (`packages/create-app/src/manifest.ts`, with
> `SCAFFOLD.md` now generated from it), and the generator matrix CI
> (`.github/workflows/generator-matrix.yml`, six combinations covering six distinct overlay
> sets). The governing rules this document kept restating are now written down in
> `packages/create-app/README.md`.

A decision document for the owner of the adminIgloo scaffold. Three questions were asked:
is what we're doing normal, what are the good precedents, and what should be added — split
into always-on versus opt-out.

Everything below is grounded in three research passes: a survey of ~22 starter kits and
production OSS codebases, a baseline-capability sweep plus a read of the AI app builders,
and a file-level inventory of what this repo actually emits today.

**Two evidence notes up front, because they change how you should read the rest.**

- The brief says "roughly 17 packages plus a generator." The inventory found 15 directories
  under `packages/` — 14 runtime packages and `@adminigloo/create-app`. Minor, but the
  larger version of the same error runs through this whole document: *the package count
  overstates what the emitted app actually does.* At least six packages
  (`email`, `ai`, the invitation half of `tenancy`, the subscription half of `billing`,
  `stripe`'s billing portal, `observability`'s rate limiter) have **zero import sites** in
  any emitted file. They are primitives without consumers.
- Two of the most-cited free references are dead. `create-t3-app`'s last three commits are
  security bumps and it has never shipped a Next 16 release; `nextjs/saas-starter`'s last
  feature commit was 2025-06-18. Every listicle still ranks them. Don't benchmark against
  either. The live free equivalents are `create-better-t-stack` and `ixartz/SaaS-Boilerplate`.

---

## 1. How common is this

**The frame is commodity. The architecture is not.**

Next.js App Router + React + TypeScript + Tailwind + shadcn/ui + Postgres, with Stripe and
a hosted auth vendor, is the single most reproduced stack in software right now. Every AI
builder converges on it — v0, Lovable, Bolt, Base44, Replit, and the second tier — and
multiple analyses attribute that convergence to training-data gravity as much as to
deliberate choice. Choosing this stack is not a differentiator and should not be defended
as one.

Building a private scaffold for an agency is also completely normal. It's the standard
economic response to rebuilding the same infrastructure per client, and there's a whole
commercial tier selling exactly this shape: Makerkit ($349/$649), supastarter
($299/$799/$1,499 for the agency tier), TurboStarter (~$299–499), Achromatic ($180). All
one-time-with-lifetime-updates, all Turborepo monorepos, all rebuilt on Better Auth in
2026. The $1,499 unlimited-client-projects tier is the market rate this scaffold implicitly
competes with. So the answer to "is this a normal thing to be doing" is yes, emphatically,
and there is a priced market that proves it.

### Where this scaffold is ahead of the field

Five things are genuinely uncommon, and four of them are deliberate and correct.

**1. Base modules published as versioned private npm packages.** This is the unusual one.
Makerkit, supastarter, TurboStarter and every OSS product surveyed use *workspace* packages
inside one repo — `@kit/ui`, `@repo/logger` — that you clone and own. Nobody in the survey
distributes their base layer as installable dependencies across separate client repos.
Trigger.dev publishes packages, but it's a product with external consumers, not an agency
scaffold. This is the right call for an agency and it's the only mechanism by which a
security fix reaches twelve client apps in one afternoon rather than twelve. The cost, which
Trigger.dev's `packages/` (10 published) versus `internal-packages/` (27 private) split
makes explicit, is that **every published package is a permanent API commitment**, and 14 is
a lot of surface for a scaffold this young.

**2. Mechanically enforced additivity.** `planEmit` throws `OverlayCollisionError` if an
overlay path collides with a base-template path. Papermark's twelve-feature `ee/features/`
directory and `create-better-t-stack`'s `--addons` are the same architectural shape, but
neither has a machine check. This is a real, cheap, original piece of engineering, and it
means the additive rule is a property rather than an aspiration. Caveat in §3: the check
covers *collisions*, not *combinations*.

**3. Two independent permission layers, with a working admin UI, at scaffold time.** Cal.com
has one layer. Dub has four roles in one layer. Better Auth's organization plugin has one
layer with runtime-creatable roles. Achromatic has owner/admin/member. Nothing in the survey
ships two orthogonal layers — hierarchical internal staff roles *plus* per-tenant client
roles — with a checklist UI, sealed rows, per-person overrides and audit writes, on day
zero. That's a direct consequence of being an agency that remains a standing operator of
every app it ships, and it's the most defensible thing in the repo.

**4. Zero-credential boot as an enforced property.** The comparison here is instructive.
BoxyHQ computes one config object (`payments: Boolean(STRIPE_SECRET_KEY && ...)`) and
branches on it throughout the app — the exact design this scaffold forbade, just centralised
into one file. Makerkit uses null-object provider implementations. adminIgloo uses guards
(`isDbConfigured`, the proxy skipping `clerkMiddleware`), overlays, and a `/setup` page that
reads the *same* env schemas via `describeEnv`. The `/setup` page in particular is better
than anything in the survey: a live, credential-free report of configuration state that a
non-engineer can read. `@adminigloo/env` — `optionalUntilDeployed`, `modeBoundKeys`, the
pooled-vs-unpooled URL distinction, `KeyModeMismatchError`, the localhost guard — is ahead
of every kit surveyed, paid or free.

**5. The runtime-dependency versus copied-source split, stated as a rule with a reason.**
This is the consensus instinct; Neon's UI Registry README states it outright ("Nothing to
install as a package: component source lands in your project, and it's your code from that
point on"). Having written the rule down and applied it consistently puts this ahead of
most. What's missing is the other half, and it's the largest structural gap in the survey:
**only the dependency half has a distribution system.** Copied source is written once by the
generator, and the upgrade path is a hand-maintained "forked modules" markdown table.

### Where this scaffold is behind

**The day-zero Next.js baseline.** No `error.tsx`, no `global-error.tsx`, no
`not-found.tsx`, no `loading.tsx`, anywhere. No `metadataBase`, no `robots.ts`, no
`sitemap.ts`, no `generateMetadata` — including on `/products/[slug]`, the one page that
obviously needs one. No security headers. This is below the floor a competent developer
reaches on day one of any Next.js project, and it's conspicuous precisely *because* the
sophisticated parts of this repo are so much further along. An unhandled render error in a
generated client app currently falls through to Next's default screen.

**Operational plumbing.** Every real product surveyed ships some combination of: an audit
log with actor/target/IP, outbound webhooks with HMAC signing and auto-disable, hashed
scoped API keys, a background job queue, staff impersonation with a trail, and plan limits
as one typed record. No *starter kit* ships more than two. adminIgloo ships one — the audit
log, and it ships it well, end to end with real write sites and a filtered read UI. But
jobs, webhooks, API keys and impersonation are all absent, and `vercel.json` declares
`"crons": []` pointing at nothing.

**Release tooling for a 14-package published workspace.** No API-surface check against the
changesets bump (`@clerk/break-check` does exactly this, ships a GitHub Action, and takes an
afternoon). No `catalog:` protocol, so `react`/`next`/`zod`/`drizzle-orm` versions are
declared fourteen times. No matrix CI over generator answer combinations.

### The thing that worries me most

**Six packages have no consumers.** `@adminigloo/email` ships a sender and a delivery log
and no templates, and no emitted file imports it — choosing `--email` adds a dependency, an
env fragment and a schema re-export, and nothing sends mail. `@adminigloo/ai` has zero
import sites; `--ai` emits no route. `tenant_invitations` has a table, token crypto and a
lifecycle state machine, and nothing uses any of it. `createBillingPortalSession` has zero
callers. `checkRateLimit` has zero callers, and `observabilityServer()` — which declares
`SENTRY_DSN` and the Upstash vars — is never spread into the generated env, so those
variables exist in no client project's contract. `error_log` has a schema, a fingerprinter,
a tRPC procedure and an admin page, and the only thing that ever writes a row is the demo
seed script.

That's not a gap list, it's a pattern: **primitives are being built ahead of their
consumers, and an unconsumed primitive has an unvalidated API.** You do not know whether
`createEmailSender`'s signature is right, because nothing has tried to send an invitation
with it. For a scaffold that publishes to npm and treats every export as a commitment, this
is the expensive kind of debt. The good news is it makes the next few weeks unusually
cheap — most of §3's top band is *wiring*, not design.

### Is the Lovable comparison apt?

Partly, and the part that's wrong matters.

**Apt:** both compress time-to-running-app, and both bet that a large fraction of every app
is the same. Base44 made the identical bet with unusual clarity — every app needs a tenant
model, CRUD, an admin panel and a permission layer, so generate all four.

**Not apt in three ways.**

*Wrong builder.* The close analogue isn't Lovable, it's **v0**. Lovable emits React+Vite SPA
(TanStack Start with SSR only for apps created after 2026-05-13) on Supabase or its own
managed Supabase, with no separate server layer — architecturally quite far from here. v0
emits Next.js App Router with logic in Server Actions and Route Handlers, treats auth and
database as *pluggable marketplace integrations rather than baked-in vendors*, and since
February 2026 makes the connected Git repo the canonical artifact rather than the vendor's
database. That's the same philosophy: pick the frame, leave the vendors additive, let the
repo be the truth.

*Opposite resolution of the ownership question.* Base44 owns the backend and the admin panel
and you cannot restyle or eject them; it auto-derives the admin from the schema. That's the
mirror image of this scaffold's copied-source rule, and Firebase Studio is the cautionary
tail: signups disabled 2026-06-22, product sunsets 2027-03-22, and the generated project's
value was coupled to a hosted environment being withdrawn.

*The differentiator isn't the frame.* Here is the load-bearing finding from the builder
sweep: **not one AI builder ships, by default, any of** metadata/sitemap/robots/OG
discipline, error tracking, rate limiting, background jobs, transactional email with domain
authentication, GDPR export/deletion, audit logging, tests, i18n, or accessibility checks.
Lovable is the only partial exception (a pre-publish security scan, built-in analytics, an
SEO review workflow) and it added those *after* enough published apps shipped with leaked
keys and missing RLS to become a reputational problem.

So "probably pretty similar to how Lovable is doing it" is true about the frame and false
about the value. The frame is commodity and the builders got there first and cheaper. What
they cannot do is firm-owned tenancy, two permission layers, and an architecture where
options are additive packages rather than regenerated code. **The strategic risk runs the
other way:** the builders are converging up into the operational layer from below. The
durable moat is the tenant/permission model and the overlay architecture — not the starter
template, and not the fact that it saves a week of setup.

---

## 2. What the good precedents do that we do not

Concrete and attributed. Ordered roughly by how much it matters here.

**Private, authenticated shadcn registry — the distribution mechanism for copied source.**
Neon ships an official UI Registry (`neondatabase/ui`) alongside a package monorepo and is
explicit about which distribution model applies to which layer. Since shadcn CLI 3.0 the
registry format supports namespaces, per-registry `Authorization: Bearer ${ENV_VAR}` headers
configured in `components.json`, `registryDependencies` between items, and item types beyond
components — `registry:page`, `registry:file`, `registry:lib`, `registry:theme`. A private
`@adminigloo` registry, authenticated with the *same GitHub Packages token already in
`.npmrc`*, would give the admin shell a versioned, re-runnable `shadcn add @adminigloo/admin-shell`
path where a client six months behind resolves the diff in git instead of in a markdown
ledger. It does not violate the copied-source rule — the code still lands in the client's
repo and is theirs. It may be able to subsume the generator's copy step for overlays entirely.

**Trigger.dev's `REQUIRE_PLUGINS=1` — the missing half of zero-credential boot.** Their
`@trigger.dev/plugins` is a *types-only contract package*; `@trigger.dev/rbac` is a
`LazyController` that dynamically imports the real implementation and falls back to a
**named** implementation with deliberate semantics (`permissiveAbility` vs `denyAbility`)
when the import fails. Then `REQUIRE_PLUGINS=1` turns a missing implementation into a boot
failure in non-dev, with `require-plugins.test.ts` asserting all four branches of the flag
including that only the literal string `"1"` counts. This is the exact hole in adminIgloo's
rules: "boots with nothing configured" and "is correctly configured" are currently
indistinguishable at runtime, so a production deploy missing `STRIPE_WEBHOOK_SECRET` looks
identical to a healthy dev machine.

**Permissions as `(resource, action)` rows rather than role enums.** Cal.com shipped
`Role` + `RolePermission(roleId, resource, action)` with `RoleType = SYSTEM | CUSTOM` scoped
by `teamId`, and enabled it globally on 2026-01-29 after eight months behind a flag. Better
Auth exposes the same via `createAccessControl({ project: ['create','update',...] })` with
runtime-creatable `organizationRole` rows and `maximumRolesPerOrganization` as a
*plan-derived function*. Dub ships a 26-entry `PERMISSION_ACTIONS` tuple plus a
human-readable resource list that drives its scope-picker UI. This maps almost exactly onto
this scaffold's stated model — SYSTEM roles are the templates, CUSTOM rows are the per-tenant
overrides, the checklist screen is a join. Two specifics worth stealing regardless of any
schema change: Better Auth's `hasPermission` (server, authoritative) vs `checkRolePermission`
(client, synchronous, excludes dynamic roles) is the right two-function API for greying out
buttons without trusting the client; and Cal.com's **nullable-FK-beside-the-enum** migration
is the documented way to add per-tenant custom roles to a client already in production.

**Cal.com's `tasker` — a background job queue with no vendor and no credentials.** Postgres
table, `tasker.create('sendWebhook', payload)`, a cron route draining 100 tasks/minute,
`succeededAt`, `attempts` with `maxAttempts` default 3, a cleanup cron, and a
`tasker-factory.ts` so `InternalTasker` swaps for `TriggerDevTasker` later. This is the only
job design in the survey that satisfies the zero-credentials rule perfectly, and adminIgloo
has no job story at all.

**OpenStatus's `PlanLimits` and Dub's `plan-capabilities.ts`.** Dub has one pure function
`getPlanCapabilities(plan)` returning ~19 booleans, imported everywhere, with zero branches
elsewhere — a pattern for plan gating that doesn't violate the no-conditionals rule.
OpenStatus goes further: `allPlans: Record<WorkspacePlan, PlanConfig>` in the *db package*,
mixing booleans, numeric quotas, enum-restricted options (`periodicity: ['10m','30m','1h']`),
multi-currency `IntervalPrice`, and addons — so pricing page, enforcement and Stripe seed
data all read one object. Client pricing tiers are almost never pure booleans; multi-currency
and addons are the details that get retrofitted painfully.

**Dub's webhook reliability design.** `consecutiveFailures` counter on the row, owner
notification at thresholds, auto-disable at a threshold with `disabledAt`, a
`WebhookDisabled` email, and a denormalised `webhookEnabled` flag on the workspace so the hot
path skips the lookup. HMAC-SHA256 over the body via WebCrypto (edge-compatible) with sample
fixtures. The auto-disable is the part everyone forgets until a dead client endpoint is
eating the queue.

**Achromatic's staff-side admin.** Ban, **impersonation**, **manual billing resync**, credit
adjustment, app-configuration UI. Two of those are direct gaps. Impersonation is the most
requested staff feature in client work — and `Principal` here already carries
`isImpersonating` with nothing that sets it. Manual billing resync (a staff button that
re-pulls Stripe state into your own tables) matters *more* here than for Achromatic,
precisely because the firm owns the billing tables and a missed webhook leaves them
authoritative and wrong.

**Vercel saas-starter's `validatedAction` wrapper.** A higher-order function taking a Zod
schema and an action; every Server Action is declared through it, so authorization and
validation are structurally impossible to forget. Partially covered here —
`createStreamRoute` already authorizes before the stream opens, which is the same idea — but
`/api/webhooks/*` and any future plain route handler have no equivalent single door.

**`vercel/platforms`' `extractSubdomain`.** ~40 lines, directly liftable into
`@adminigloo/tenancy`, handling the two cases everyone gets wrong: `*.localhost` in dev with
no DNS, and `tenant---branch-name.vercel.app` preview hostnames. It also confirms Next 16's
`proxy.ts` convention this scaffold already uses, so the scaffold isn't out on a limb there.

**Papermark's `ee/limits/` four-entrypoint module.** `constants.ts` + `server.ts` (server
check) + `handler.ts` (API) + `swr-handler.ts` (client hook) — one limit, authored once,
consumed identically at three call sites. adminIgloo has the same three-consumer problem for
both permission layers and for plan gates, and exporting a predicate and hoping is a weaker
answer.

**OpenStatus's test density.** tRPC routers with co-located tests (`monitor.ts` +
`monitor.test.ts`) *plus* `trpc.test.ts` and `trpc-errors.test.ts` testing the procedure
middleware itself. Given that both permission layers are enforced in procedures here, the
middleware test is the one that proves denial actually happens — and it's the test most
scaffolds skip. The bones exist (`src/server/__tests__`, `src/permissions/__tests__`);
OpenStatus shows the density to aim for.

**Midday's `catalog:` protocol and one-Hono-app API surface.** `catalog:` in
`pnpm-workspace.yaml` pins shared dep versions once. Separately, `apps/api` serves tRPC
(`@hono/trpc-server`), OpenAPI (`@hono/zod-openapi`) and MCP (`@hono/mcp`) from one process —
the strongest argument for a documented public-API story that is strictly *additive* to the
current tRPC rule rather than a replacement for it.

**Turborepo's `check-examples.ts`.** Every example is installed and built on every turbo
release. The generator here has a combinatorial answer matrix (org type × business model ×
admin shell × AI × email × personal-workspace-only) and the failure mode of additive overlays
is precisely the combination nobody generated.

**`@clerk/break-check`.** API Extractor over each package's public `.d.ts`, diffed against a
baseline, classified breaking/non-breaking/additive, compared to the actual changesets bump,
fails CI on an insufficient bump, posts a table into the PR. On npm, ships an Action.

**Neon's branch actions.** `create-branch-action` / `delete-branch-action` per PR, and
`schema-diff-action` posting the schema diff as a PR comment. The second is the specific
guardrail for a scaffold where `@adminigloo/db` owns base tables and client apps add their
own — it makes an accidental base-table alteration visible at review time.

**Documenso's `packages/auth` client/server entrypoint split.** Makes `server-only`
violations a build error rather than a runtime surprise. Worth copying literally for
`@adminigloo/permissions`, where a leaked server helper is a security bug rather than an
inconvenience.

### Where the evidence is thin or conflicting

- **Better Auth vs Clerk.** The research makes a genuinely strong case: the organization /
  member / invitation / team / organizationRole tables live in *your* Postgres, joinable and
  migratable, which satisfies "the firm owns the tenant table" more completely than Clerk
  does — and every 2026 commercial kit rebuilt on it. Meanwhile Clerk Billing takes 0.7% per
  transaction and custom permissions only surface in `has()` when the permission's Feature is
  in the org's active Clerk plan. But the Clerk-side claims come from docs and search, not
  from a reproduction, and the migration cost is a rewrite of `@adminigloo/auth` plus every
  existing client's identity data. See §3 for what to actually do.
- **"tRPC 11 has not shipped a minor since 11.18.0 in June 2026."** That's about two months.
  It is not evidence of stagnation and should not be cited as one.
- **Documenso leaving Next.js for React Router 7.** One project, one data point, product-shaped
  reasons. Hold it lightly.
- **Cal.com went closed source on 2026-04-15** (repo renamed `calcom/cal.diy`, AGPL→MIT, team
  scheduling and routing moved to a closed edition). The PBAC tables and `tasker` are still in
  the open code but treat it as a Q1-2026 snapshot, not a live reference.
- **Licences.** Dub and Papermark are source-available with custom terms; Documenso and
  Papermark both carve out commercially-licensed directories; `vercel/platforms` has no
  licence file at all. Read all of these for architecture. Do not paste code into client repos.

---

## 3. The gap list

Ordered by value-per-hour within each band. "Cost" assumes one experienced developer who
knows this codebase, and reflects that much of the top band is *wiring existing primitives*
rather than designing anything.

### SHIP NEXT

| Capability | Why it matters here | Cost | Always-on / opt-out | Home |
|---|---|---|---|---|
| Spread `observabilityServer()` into the generated env | `SENTRY_DSN` and the Upstash vars are declared in a package and reach no client project's contract. `/setup` can't report on them; the rate limiter can't be configured. A one-line omission with three downstream consequences. | 1h | Always-on | `create-app/emit.ts` |
| Error capture producer | `error_log`, `errorFingerprint`, `admin.recentErrors` and `/admin/errors` all exist; the only writer is the demo seed. Every client ships with a permanently empty error viewer. Needs a reporter module, an `onError` hook on the tRPC route handler, and a `global-error.tsx` that reports. | 0.5d | Always-on | `@adminigloo/observability` + template |
| `error.tsx` / `global-error.tsx` / `not-found.tsx` / `loading.tsx` | Below the day-one Next.js floor. Today an unhandled render error gives a client's user "Application error: a client-side exception has occurred" with no way back. `global-error` is the only thing that catches a root-layout throw. | 1d | Always-on | template + each overlay |
| Environment-gated `noindex` + `robots.ts` | Neon-branch staging and Vercel preview URLs get crawled and can outrank the client's production site for their own brand terms. Cleanup is Search Console removals plus weeks of waiting. Sharpest edge in the whole SEO list and nearly free. | 2h | Always-on | template |
| Security headers block | HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `frame-ancestors`. Referrer-Policy in particular leaks tenant slugs in paths to every third-party asset. First thing on every security questionnaire. Not CSP — see §4. | 2h | Always-on | template `next.config.ts` |
| Cross-tenant isolation test suite | The catastrophic multi-tenant bug is one forgotten `where tenant_id`. The integration harness already exists (`describeIntegration`, skips without `DATABASE_URL`). Seed two tenants, assert every listed procedure returns zero rows for the wrong tenant. Much cheaper than RLS and catches the same class. | 1d | Always-on | template `src/server/__tests__` |
| `catalog:` protocol in `pnpm-workspace.yaml` | 14 packages each declare `react`/`next`/`zod`/`drizzle-orm` independently. A Next bump is currently 14 edits. | 1h | Always-on (repo) | root |
| `@clerk/break-check` in CI | 14 published packages, changesets, and no check that a `patch` didn't remove an exported type. Ships an Action; posts a table into the PR. Cheapest structural win in the survey. | 0.5d | Always-on (CI) | `.github/` |
| Mobile navigation for the admin shell | `admin/layout.tsx` is `flex min-h-dvh` with a `w-60 shrink-0` sidebar and **not one responsive breakpoint**. The admin panel is unusable below ~640px — and it is the thing you demo to clients. | 0.5d | Always-on | `overlays/admin-minimal` |
| SEO metadata floor | `metadataBase`, title template, description, `openGraph`/`twitter` defaults, plus `generateMetadata` on `/products/[slug]`. Without `metadataBase` every relative OG URL resolves against localhost in production and shared links render as a grey box. | 0.5d | Always-on | template + stripe overlay |
| `/api/health` that touches the DB | Uptime monitors currently have nothing real to hit. Make it Midday's `packages/health` shape: report *which integrations are configured*, turning "features light up as keys arrive" from an invisible property into something a client's ops person can see. Pairs with `/setup`. | 2h | Always-on | template + `@adminigloo/env` |
| Rate limiting call sites | `checkRateLimit` + `createMemoryRateLimitStore` exist with zero callers. Wire into the tRPC procedure ladder, both inbound webhook routes, and `createStreamRoute`. An unthrottled AI route is the one omission that produces a same-day invoice. | 1d | Always-on | `@adminigloo/trpc` + `observability` |
| `ADMINIGLOO_REQUIRE` boot assertion | Trigger.dev's `REQUIRE_PLUGINS=1`. Right now "opted out" and "misconfigured in production" are the same runtime state. This is what makes every opt-out in this document safe. Test all four branches of the flag. | 0.5d | Always-on | `@adminigloo/env` |
| `adminigloo.json` written by the generator | The machine-readable answer to "what is enabled here?" — currently recoverable only by reading `package.json` and the directory tree. Wasp's `main.wasp` is the argument. Prerequisite for the matrix CI, a `doctor` command, and any upgrade tooling. | 0.5d | Always-on | `create-app` |
| Generator matrix CI | The additive-overlay guarantee is the load-bearing rule of this design and it is currently **unverified across combinations** — `OverlayCollisionError` catches path collisions, not a combination that fails to typecheck. Nightly: generate ~6 representative answer sets, `pnpm install && build && typecheck`. Turborepo's `check-examples.ts`. | 1d | Always-on (CI) | `create-app` CI |
| Invitations end to end | `tenant_invitations` + token crypto + `invitationState` exist and nothing uses them. **A multi-tenant scaffold with no way to add a second person to a tenant is missing the loop the entire tenancy layer exists for.** Forces `@adminigloo/email` to acquire its first consumer. Adopt Better Auth's finding: opaque UUID invitation ids skip email verification, predictable ones require it. | 3d | Always-on where tenancy is | `tenancy` + `email` + template router |
| Per-project `AGENTS.md` emitted by the generator | Every paid kit ships one; Papermark checks a `skills-lock.json` into the repo; Clerk and Neon both publish agent-skills repos. The generator already knows the installed packages and overlays, so it can write an accurate one — which is more than most hand-maintained ones manage. | 0.5d | Always-on | `create-app` |
| Governing rules written into the generator README | create-t3-app's only durable contribution is its axioms doc. The five rules in the brief are that document and currently live in tribal memory. Add one explicit prohibition: **never read Clerk's `has()`, never configure a Clerk Plan, never enable Clerk Billing** — because the plan-gates-permission-visibility behaviour would silently start denying permissions the firm's own tables grant. | 2h | Always-on | repo README |

### WORTH DOING

| Capability | Why it matters here | Cost | Always-on / opt-out | Home |
|---|---|---|---|---|
| Neon branch-per-PR + `schema-diff-action` | Branching is already in the stack for staging/prod; per-PR is the stronger version and costs nothing on Neon's model. The schema-diff PR comment is the specific guardrail for a scaffold where `@adminigloo/db` owns base tables and clients add their own. | 0.5d | Always-on (emitted workflow) | `create-app` templates |
| Postgres-backed job queue | Cal.com's `tasker`: table + Vercel cron + `attempts`/`maxAttempts` + a factory seam for a later Trigger.dev swap. No vendor, no credentials — the only job design that satisfies the zero-credential rule. Everything else on this list (email retries, exports, purges, outbound webhooks, GDPR erasure) depends on it. `vercel.json` already has an empty `crons: []` waiting. | 3d | Always-on | **new** `@adminigloo/jobs` |
| Staff impersonation | `Principal.isImpersonating` exists and nothing sets it. Needs a session distinct from the real one (never a token swap), a persistent banner, an expiry, a required reason string, audit events on start and stop. Most-requested staff feature in agency work; a hidden backdoor is both a breach vector and an audit finding. | 2d | Opt-out (`admin-full`) | `auth` + `admin-full` overlay |
| Transactional email templates | React Email in a shared package with a preview route. `@adminigloo/email` currently sends whatever HTML you hand it and ships no templates. Falls out of the invitations work; the marginal cost after that is small. | 1.5d | Opt-out | `@adminigloo/email` |
| Subscription management UI | `@adminigloo/billing` has plans/subscriptions/entitlements/proration/status-mapping, and `createBillingPortalSession` has **zero callers**. `--model subscription` today changes the package set and variant intervals and emits no subscription screen at all. | 3d | Overlay | **new** `overlays/subscription` |
| Typed `PlanLimits` record | OpenStatus's shape, not Dub's booleans. Numeric quotas, enum options, multi-currency, addons, in the db layer so pricing page / enforcement / Stripe seed can't drift. Retrofitting multi-currency is the painful part. | 1.5d | Always-on where billing is | `catalog` + `billing` |
| Tenant member list + role management | `tenant_members` exists; nothing lists it. `/admin/tenants` has no drill-in and the generated `members.list` returns the caller's own permissions, not the roster. The client-side permission layer has no management surface. | 2d | Opt-out | `admin-minimal` overlay |
| Manual billing resync | A staff button that re-pulls Stripe state into your own tables. Matters *more* here than for Achromatic because the firm owns the billing tables, so a missed webhook leaves them authoritative and wrong with nothing to reconcile against. | 1d | Opt-out (`admin-full`) | `stripe` + `admin-full` |
| CSP with per-request nonces | The difference between an XSS being a bug and a session-token exfiltration. Also the single most likely thing to break a client's marketing tag post-launch, so ship report-only with a `report-uri` first. Mechanism in §4. | 2d | Always-on, tunable | `next.config.ts` + `proxy.ts` |
| Private `@adminigloo` shadcn registry | The largest structural idea in the survey. Gives copied source a versioned, re-runnable pull path authenticated by the token already in `.npmrc`. **Do this after `adminigloo.json` exists** so the registry has a manifest to reason about. Needs a hosting decision. | 4d | Mechanism | new infrastructure |
| Playwright E2E on 3–4 flows | `packages/testing/src/playwright.ts` is types-and-data-only, nothing imports it, and no generated project has a config, an `e2e/` dir, a devDependency or a CI step. A stranded asset. Keep the suite deliberately small: sign-up, sign-in, invite-a-teammate, checkout. | 2d | Opt-out | `testing` + template |
| Feature flags primitive | Not for install-time optionality — for "turn this on for one tenant while we test it", which clients ask for constantly. Without it, client-specific behaviour becomes forked code or hardcoded tenant-ID checks, which is exactly the branching the rules forbid. Rules in §4. | 2d | Always-on | **new** `@adminigloo/flags` |
| Structured logging wired everywhere | `createLogger` is genuinely good (pino, `REDACT_PATHS` tuned to this scaffold's real secrets) and is wired into **one** emitted file. A project generated with `--model none` creates no logger at all. Thread a request id through the tRPC context. | 1d | Always-on | `observability` + `trpc` |
| GDPR export/delete registry | Declare per-table which columns are personal data and what deletion does (delete / anonymise / retain for legal basis). Costs almost nothing while the schema is young; teams retrofitting this burn 4–8 weeks of senior time. Only identity-sync soft-delete exists today. | 2d | Always-on (declaration); opt-out (UI) | `db` + `create-app` |
| Legal routes with a generated subprocessor list | Stripe requires privacy + terms before activating an account. The generator knows the installed packages, so it can emit an *accurate* subprocessor list — Clerk, Neon, Stripe, Vercel, Resend, Sentry — which is the part clients' generic templates always get wrong. | 1d | Opt-out | `create-app` |
| Outbound webhooks | Dub's design in full: HMAC-SHA256, `consecutiveFailures`, notify thresholds, auto-disable with `disabledAt`, a denormalised `webhookEnabled` flag on the tenant, customer-visible delivery log with replay. Depends on the job queue. | 4d | Overlay | **new** `@adminigloo/webhooks` |
| Customer-facing API keys | Hashed at rest with a display prefix (`ak_live_`/`ak_test_` — unprefixed keys defeat secret scanners), scopes resolving against `@adminigloo/permissions` and never against Clerk, `lastUsedAt`, two active keys for rotation, per-key rate limit. Better Auth's api-key plugin is a complete design to copy. | 3d | Overlay | **new** `@adminigloo/api-keys` |
| Public REST/OpenAPI overlay | A Hono app with `@hono/zod-openapi` over the same Drizzle repositories. Strictly additive to "tRPC for CRUD, route handlers for AI". The moment a client asks for a documented API for their mobile team or a partner, you are otherwise hand-writing it. | 4d | Overlay | **new** `@adminigloo/api` |
| Toasts + skeletons in the UI kit | The kit exports nine things and neither is a skeleton; mutation feedback in `ProductForm`/`RoleEditor` is inline only. Cheap, and every emitted page is currently `force-dynamic` with nothing shown while it resolves. | 0.5d | Always-on | template UI kit |
| `Intl` formatting helpers | Distinct from i18n and more damaging: hardcoded `toLocaleDateString()` shows a Sydney user yesterday's date, and `1,000.00` reads as a hundred thousand to a German customer. Amounts are already integer minor units (`amountMinor`), so half the work is done. | 0.5d | Always-on | template `src/lib` |
| Dependency install policy | `--frozen-lockfile`, `minimumReleaseAge` of 7+ days, `trustPolicy: 'no-downgrade'`, `npm audit signatures`, Renovate batching weekly, and publish `@adminigloo/*` with provenance. Shai-Hulud/CHAINDROP are self-propagating npm worms; a floating CI install picks up a malicious version within minutes of publication. | 0.5d | Always-on | root + emitted CI |
| `packages/` vs `internal-packages/` review | 14 published packages is 14 permanent API commitments. Some are almost certainly implementation detail that should be `workspace:*`-only. Trigger.dev's 10-published / 27-private split is the model. Do this *before* clients depend on the current surface. | 1d | Repo decision | root |
| `client/`+`server/` entrypoint split for `permissions` | Documenso's pattern. A leaked server helper in `@adminigloo/permissions` is a security bug; this makes it a build error. | 0.5d | Always-on | `@adminigloo/permissions` |
| Backup restore drill | Everyone has backups; almost nobody has restored one. Enable Neon PITR, execute one restore into a scratch branch, write the measured RTO into the runbook. An untested backup is a belief, not a control. | 0.5d | Always-on (process) | runbook |
| Runbook + launch checklist emitted per project | Highest-leverage item on the list *for an agency specifically*. Six months after handover, the person who set up DNS, DMARC, the Stripe webhook and the Clerk production instance is on another project. The generator knows which of those apply to each project. | 1d | Always-on | `create-app` |

### DELIBERATELY SKIP

These are refusals, with reasons. Several are things other kits ship.

| Capability | Why to refuse it here |
|---|---|
| **Migrating Clerk → Better Auth** | The research case is real and I'd take it seriously on a greenfield decision. But the rule the firm actually cares about — *the firm owns the tenant/org table* — is already satisfied by `@adminigloo/tenancy`, which owns tenants, members and invitations in its own Drizzle schema. Better Auth would replace Clerk's identity role, not fix an ownership gap. The cost is a rewrite of `@adminigloo/auth` plus every deployed client's identity data. **Do instead:** write the prohibition down (SHIP NEXT), and keep `@adminigloo/auth`'s surface deliberately small — a users mirror, a webhook verifier, a `Principal` — so a future swap is one package rewrite rather than an app rewrite. Revisit when Clerk's pricing or the plan-gating behaviour actually bites a client. |
| **Multi-provider billing abstraction** | Makerkit spans three providers, supastarter five, and it's tempting. But the firm's rule binds Stripe test mode to staging and live to prod *by environment*, and an abstraction over five providers with one implementation is speculative generality that makes the Stripe path worse. EU merchant-of-record demand is real but it's a per-client conversation. Add the second provider when a second provider is sold. |
| **Postgres RLS as a second enforcement layer** | Makerkit does it, `pg_session_jwt` makes it possible on Neon, and the argument (a missed `where` becomes a no-op instead of a leak) is genuinely good. But it's a permanent complexity tax on every migration, seed script and test, and it interacts badly with drizzle-kit workflows. The cross-tenant isolation test suite in SHIP NEXT catches the same bug class for a fraction of the cost. Revisit if a near-miss happens or a client's security review demands it. |
| **Session replay** | Records real user sessions, so it drags in consent, PII masking and a data-processing disclosure the firm would then owe every client. Meaningful client bundle cost. Privacy-conscious and EU-heavy clients refuse it outright. Genuinely contested in the field, not a consensus omission. Offer it as a per-client add-on, never a default. |
| **Command palette** | Invisible to most users, and every command must be registered *and* permission-filtered against both layers or it surfaces actions that then 403 — which in a two-layer permission model is real, ongoing work. Justified in a dense internal tool with 100 screens; not in a 20-screen client app. |
| **Visual regression on emitted apps** | The admin panel is copied source that every client restyles *by definition*. Baselines would be per-client and worthless at the scaffold level. VRT on the base UI package is defensible in principle, but the kit is nine components and the notorious CI-noise cost outweighs it at this size. |
| **Full i18n in the base** | A message-key indirection layer on a single-locale app slows every UI change and the catalogues rot. `next-intl` is the clear App Router default if it's ever needed, as an additive overlay. What the base *must* enforce is only the irreversible part: no string concatenation for sentences, logical CSS properties, and the `Intl` helpers listed above. Don't confuse those with i18n. |
| **Cookie consent banner as a default** | Contested only because the answer depends on a decision made elsewhere. Ship cookieless analytics and no Google tags and **no banner is legally required at all**. A banner that sets analytics cookies on load and records the choice afterwards is non-compliant and provides zero protection — which is what most default banners do. Make the no-banner path the default; consent becomes an overlay when a client brings GA4 or ad pixels. |
| **Waitlist / pre-launch mode** | Introduces a second signup path that must be kept in sync with the real one forever, duplicates a marketing-site concern, and most client projects never use it. A cheap-looking overlay with a permanent maintenance tail. |
| **SOC 2 tooling (Vanta/Drata) in the scaffold** | Premature for most clients, and the gap in a real audit is never the controls — it's the evidence. Ship the *substrate* (audit log, enforced review, CI-gated deploys, encrypted secrets, log retention) so a compliance product can be pointed at an existing system later, and refuse to ship the compliance product itself. |
| **Audit logs to a columnar store (Tinybird)** | Dub's reasoning is right — audit rows are append-only, write-heavy, queried by time range, retained for years, and on Neon they ride along in every branch. But taking a Tinybird dependency contradicts the zero-credential rule and adds a vendor to every client. **Take the reasoning, refuse the dependency:** decide the partition-and-retention story for `audit_log` now (roughly 12 months auth events, 24 months role changes, 36 months impersonation and MFA resets) and add a purge job when the job queue lands. Revisit the columnar store when a client's volume actually demands it. |
| **Base44-style admin auto-derived from the schema** | Directly contradicts the copied-source rule, and the rule is right: the automation buys a panel nobody can restyle, which is the one thing every client wants to do. |
| **Moving off Next.js** | Documenso did it and Midday moved its backend to Hono, but that's two products with product-shaped reasons and the survey shows no trend. The additive answer for the API surface (a Hono overlay, WORTH DOING) captures the actual benefit without the migration. |

---

## 4. How opt-out should work here

The current rule — additive packages and overlay directories, never conditional branches — is
correct and mechanically enforced for the cases it covers. It does not cover everything, and
pretending otherwise is how the rule quietly erodes. There are three distinct classes, and
they need three different mechanisms.

### First, state the rule that's already implicitly true

`overlayDirsFor` is a branch. `packagesFor` is a branch. `renderHomePage` branches on
`businessModel`. That's fine, and it's the actual principle:

> **Conditionals are allowed in the generator. They are forbidden in the artifact.**

No emitted file asks whether a feature was installed; `emit.ts` asks constantly. Writing this
down does three things: it makes the rule checkable (grep the emitted output, not the
generator), it legitimises the mechanisms below, and it names where the complexity is allowed
to live so it doesn't leak into client repos.

### Class A — cleanly additive (already solved)

Storefront, admin shells, catalog admin, subscription UI, webhooks, API keys, the public API
overlay. Package + overlay directory, `OverlayCollisionError` proves non-collision. The only
thing missing is the **matrix CI**, because collision-freedom is not combination-correctness,
and the failure mode of additive overlays is precisely the combination nobody generated.

### Class B — always-on code with a real no-op implementation

Analytics, logging, email, error reporting, feature flags, job dispatch. These have call sites
scattered through *base* code, so an overlay cannot own them. The answer is Makerkit's
null-object pattern done properly — which this scaffold already does correctly in exactly one
place: `createEmailSender` with no API key returns outcome `'skipped'`. That's a real result,
not a throw and not an early return that callers must remember to check.

Generalise it into a stated pattern with three parts:

1. **The interface and the no-op live in the base package and are always installed.**
   `@adminigloo/analytics` exports `defineEvents()` (mirroring `defineAuditedActions`, which
   already exists and works well) and `track()`. With no transport registered, `track()`
   writes to the logger and returns. It is a real implementation with documented semantics —
   Trigger.dev's point that `permissiveAbility` versus `denyAbility` are *deliberate choices,
   not accidents*, applies directly.
2. **The real implementation is an additive package that registers a transport.**
   `@adminigloo/analytics-posthog` exports a transport. The generator emits exactly one file,
   `src/analytics.ts`, whose contents differ between projects by an import and a registration
   call. That single file is the **composition root**. Every other call site in the app is
   byte-identical whether or not PostHog is installed.
3. **`ADMINIGLOO_REQUIRE` makes the no-op detectable.** Today, opted-out and
   misconfigured-in-production are the same runtime state. A boot assertion evaluated when
   `isDeployed()` — `ADMINIGLOO_REQUIRE=stripe,email,analytics` fails the boot if a listed
   capability resolves to its no-op — converts a silent degradation into a deploy failure.
   Follow Trigger.dev exactly on the pedantry: only the literal expected value counts, and
   there is a test asserting every branch of the flag.

`@adminigloo/env` is already the right home for this and already knows the shape
(`groupComplete`, `OBSERVABILITY_ENV_GROUPS`).

### Class C — single files the generator already composes

CSP, security headers, maintenance mode, edge rate limiting, flag middleware. These cannot be
overlays because they live in `next.config.ts` and `proxy.ts` — one file each, already
rendered token-by-token by `emit.ts`, and `proxy.ts` already contains a
credential-conditional `clerkMiddleware` skip.

So make those two files **explicit composition roots**:

- `next.config.ts` gets `headers()` returning `[...securityHeaders(), ...cspHeaders(nonce)]`,
  where each contributor is a function exported by an installed package. The generator decides
  which contributors appear in the array. The emitted file contains no `if`.
- `proxy.ts` becomes a composed pipeline: an ordered array of stages (`maintenanceStage`,
  `authStage`, `tenantResolutionStage`, `nonceStage`), each a package export, assembled by the
  generator. Today `proxy.ts` hand-rolls the Clerk skip; under the composed model that skip is
  *a stage that is absent*, which is strictly cleaner and removes the one runtime conditional
  currently in the emitted middleware.

Two consequences worth accepting explicitly. CSP nonce generation must be always-on and
unconditional (a nonce with no CSP header costs nothing; a CSP with no nonce breaks the app),
so ship report-only with a `report-uri` first and let per-client tuning happen in the emitted
config. And `vercel/platforms`' `extractSubdomain` is the natural `tenantResolutionStage` if
per-tenant subdomains ever land — including the `tenant---branch.vercel.app` case nobody
handles until the first preview deploy breaks.

### Feature flags need their own rule, or they become the backdoor

A flag and an install-time option look similar and are not. If flags can gate whether a
feature exists, every future `if (featureInstalled)` gets laundered as `if (flags.thing)` and
the no-conditional-branches rule is dead within a year. Write the boundary down:

> **A flag may gate a behaviour inside an installed feature. A flag may never gate whether a
> feature is installed.** Install-time optionality is answered by the generator and recorded
> in `adminigloo.json`. Runtime optionality is answered by a flag and recorded in the flags
> table.

Corollaries: flags are tenant-scoped by default, because "turn this on for one tenant while we
test it" is the actual client request; the resolver sits behind a vendor-neutral interface
(Class B); and flag evaluation is always-on, because the flag table is base infrastructure
even in a project with no flags defined.

### And make "what's on here" machine-readable

`adminigloo.json` — written by the generator, listing answers, installed packages, applied
overlays, registered transports and required capabilities — is the small piece that makes all
three classes verifiable. The matrix CI reads it to know what to assert. A future `doctor`
command reads it to diff intent against reality. The shadcn registry, when it lands, reads it
to know which blocks a project is entitled to pull. Wasp expresses its whole app as
`main.wasp`; this scaffold's honest equivalent is a manifest the generator writes and nobody
is asked to maintain by hand.

---

## 5. Recommended next three

### 1. Close the observability loop (~3 days)

Error capture producer, `error.tsx`/`global-error.tsx`/`not-found.tsx`/`loading.tsx`,
`observabilityServer()` spread into the generated env, `checkRateLimit` wired into the
procedure ladder and both webhook routes, `createLogger` threaded through the tRPC context
with a request id.

**Why this first.** Every piece already exists in the repo. This is wiring, not design, so the
value-per-hour is unmatched by anything else on the list. It is also the only band where the
scaffold is *worse than it looks*: `/admin/errors` renders unresolved-first with occurrence
counts and will be permanently empty in every client app, because the only thing that has ever
written to `error_log` is the demo seed. Shipping a client a beautiful error viewer that never
shows an error is the kind of thing that erodes trust in the whole scaffold, including the
parts that are genuinely excellent. The Next.js boundaries go in the same pass because
`global-error.tsx` is where the reporter has to be installed anyway, and because their absence
is currently below the floor a client's next developer will judge you against.

### 2. Invitations end to end, which forces email to acquire a consumer (~3 days)

The tenancy router, an `/invite/[token]` accept route, the first React Email template, and
audit writes on send / accept / revoke.

**Why this over the other functional gaps.** A multi-tenant scaffold that cannot add a second
person to a tenant is missing the loop the entire tenancy layer exists for — and the pieces are
all sitting there unused: the table, `generateInvitationToken` / `hashInvitationToken` /
`verifyInvitationToken`, and `invitationState`. One feature validates three stranded packages
at once (`tenancy`'s crypto, `email`'s sender and delivery log, `observability`'s audit), and
validating an unconsumed API before it hardens is worth more than the feature itself, because
these are published packages and every export is a permanent commitment. It also forces the
Better Auth security finding into the open while it is still free to act on: opaque UUID
invitation ids skip email verification, predictable ids require it, and which one this scaffold
has is a decision the crypto helpers currently make implicitly.

### 3. `adminigloo.json` plus the generator matrix CI, with `break-check` alongside (~2 days)

The manifest, a nightly job generating ~6 representative answer combinations through
`pnpm install && build && typecheck`, and `@clerk/break-check` in the package CI.

**Why this over the shadcn registry**, which is the bigger idea. The registry is a four-day
build with a hosting decision attached, and it should be done *second* — after
`adminigloo.json` exists, so the registry has a manifest to reason about when deciding what a
project is entitled to pull. The matrix CI, meanwhile, is the test that the load-bearing rule
of this entire architecture actually holds. Additivity is currently an assertion:
`OverlayCollisionError` proves no two overlays write the same path, which is not the same as
proving that `--model subscription --admin full --ai --personal-workspace-only` typechecks and
builds. The failure mode of additive overlays is exactly the combination nobody generated, and
that failure will surface on a client project at the worst possible moment. `break-check` rides
along because it is an afternoon, it is the same category of guarantee — mechanical enforcement
of a rule currently maintained by hand — and 14 published packages with changesets and no
API-surface check is a slow leak.

### What is deliberately not in the three

**The private shadcn registry** is the single largest structural idea in the research and it
should be fourth, not fifth — but sequencing it after the manifest is worth two days of delay.
**The job queue** is needed and nothing currently blocks on it; it becomes urgent the moment
outbound webhooks, GDPR erasure or email retries are on the roadmap, and it should be the next
new package after the registry. **SEO and security headers** did not take a slot despite
excellent value-per-hour, because each is a two-hour task that can ride along with any of the
above rather than consuming one. **Better Auth** is not here at all: the right action is the
written prohibition inside item 3's README work, not a migration.
