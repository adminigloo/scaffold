# What They Ship, What We Ship, What To Take

An answer to: *"other companies do stuff like I'm trying to build here — I wouldn't mind
seeing what they're offering and then mimicking it so that it makes it really easy for me."*

Three audits back this document: a commercial-kit teardown (Makerkit, supastarter,
Achromatic, TurboStarter, ShipFast, Shipixen, Bullet Train, Open SaaS, Divjoy), a
docs/distribution/first-hour/agent-era survey, and a measured inventory of our own generated
output. Everything below is grounded in those. Where the evidence is thin or the audits are
silent, it says so rather than guessing.

The operative constraint is the second half of the owner's sentence. This is about the
owner's experience of consuming their own scaffold on the next client project — not feature
count. The copy list in §4 is therefore split into things that add **features** and things
that make existing features **easy to use**, and the ordering favours the second.

---

## 1. Feature-by-feature

**Legend.** `✅` shipped · `◐` partial · `✗` absent · `—` not found in the audits (the vendor
does not advertise it and no source was read that would confirm either way — treat as
unknown, not as absent).

Columns are the three closest commercial comparables plus Bullet Train, which is not a
Next.js kit but is the only product in any ecosystem running our architecture (versioned
packages, not cloned source) and is therefore the more honest benchmark for tables 1B and 1C.

Our column is marked harshly on purpose. A generous mark here is a gap that never gets
filled.

### 1A. Product surface — what a client sees

| Capability | Makerkit $349 | supastarter $299–1,499 | Achromatic $180 | Bullet Train (free) | **Ours (create-app 0.11.0)** |
|---|---|---|---|---|---|
| Email/password + OAuth | ✅ | ✅ | ✅ | ✅ | ✅ Clerk 7 |
| Magic link | ✅ | ✅ | ✗ | — | ◐ Clerk supports it; we ship no UI, no docs, no flag |
| MFA / passkeys | ✅ MFA + passkeys | ✅ 2FA + passkeys | ◐ TOTP only | — | ◐ same — a Clerk dashboard toggle we have never exercised or documented |
| Multi-tenancy / orgs | ✅ | ✅ | ✅ | ✅ | ✅ tenants, members, role templates, invitations; personal workspaces minted for every user so B2C and B2B share one query path |
| Organisation switcher UI | ✅ | ✅ | ✅ | ✅ | ✗ — and `--tenant none` vs `--tenant Organization` currently emit **byte-identical projects** |
| RBAC / permissions | ✅ roles | ✅ roles & permissions | ◐ membership roles | ✅ `bullet_train-roles` | ✅ two-layer (catalog in code, assignments in DB), staff + tenant scopes, CI scope audit |
| Super admin panel | ✅ | ✅ | ✅ | — | ◐ 12 admin pages, but `/admin/support` is a 30-line `EmptyState` reading no data, and the `--admin full` prompt promises a health page and a data explorer that **do not exist** |
| Impersonation | ✅ | ✅ | — | — | ✗ worse than absent: `staff.tenants.impersonate` is in the catalog and shows in the admin checklist, `actorImpersonatedBy` is a rendered `audit_log` column, and nothing enforces or writes either |
| Subscription billing | ✅ | ✅ | ✅ | ✅ Stripe gem | ✅ plan catalog, proration, entitlements, subscription mirror |
| One-time payments | ◐ | ✅ | ✅ | — | ✅ cart in integer minor units, orders keyed on the PaymentIntent so idempotency is a DB constraint not a convention |
| Product catalog / storefront | ✗ | ✗ | ✗ | ✗ | ✅ products, variants, grants, Stripe sync planner that knows prices are immutable |
| Usage credits / AI metering | ✗ | ◐ usage-based billing | ✅ sell credit packs, track balances, paywall | ✗ | ◐ `ai_usage` records cost in integer micros; nothing sells a pack, holds a balance, or refuses at zero |
| Payment providers | Stripe / Polar / Paddle | 5 providers | Stripe | Stripe | ◐ Stripe only |
| Customer billing portal | ✅ | ✅ | ✅ | — | ✅ `/account/billing` |
| Transactional email | ✅ React.Email | ✅ | ✅ Resend + React Email | — | ✅ Resend + React Email **plus** a delivery log that records `skipped` instead of throwing when there is no API key |
| Email template preview | — | — | — | — | ✅ `/setup/email` renders in a sandboxed iframe with fixtures — no DB, no session, no query params |
| Marketing pages | ✅ | ✅ | ✅ | ✅ | ✅ home + pricing, 5 sections |
| Marketing block library | ◐ 13 doc pages organised by purpose | — | ◐ "50+ typed components" | ✅ gem-shipped fields/themes | ◐ 5 sections; Shipixen advertises 37+ blocks / 300+ examples / 63 themes |
| UI primitives | shadcn/ui | shadcn/ui | "50+ typed" | gems | ◐ **8** (Badge, Button, Card, EmptyState, Field, Notice, PageHeader, Table). No dialog, tabs, combobox, date picker, toast |
| Blog / MDX CMS | ✅ | ✅ | ✅ | — | ✗ |
| Legal pages | ✅ | ✅ | ✅ | — | ✅ and the subprocessor list is **derived from the packages actually installed** |
| SEO (robots / sitemap) | ✅ | ✅ | ✅ | — | ✅ emitted in *every* configuration including `--no-marketing`; robots refuses indexing outside production |
| Dark mode | ✅ | ✅ | ✅ | ✅ themes as gems | ✅ 26 CSS custom properties |
| i18n | ✅ | ✅ | — | — | ✗ |
| File storage / uploads | ✅ | ✅ | ✅ S3 presigned | — | ✗ |
| Background jobs / cron | — | ✅ | ✅ four runtimes documented | — | ✗ |
| AI chat | — | ✅ adapters | ✅ streaming, Vercel AI SDK | — | ◐ `/api/ai/chat` streams, meters through cancellation, records cost — and has **zero callers**. No chat component; no page mounts the router |
| Analytics | ✅ | ✅ | ✅ | — | ✗ |
| Monitoring / error tracking | ✅ | ✅ | ✅ | — | ✅ pino with this scaffold's real secrets redacted, error fingerprints stable across redeploy, `error_log` + optional Sentry, `/api/error-report` so client-boundary errors are not lost |
| Audit log | — | — | — | — | ✅ `defineAuditedActions` is the only way to name an action, with a `sensitive` flag and a sensitive-only admin filter |
| Rate limiting | — | — | — | — | ✅ Upstash when configured, in-process when not, and the limiter **says which** rather than pretending they are equivalent |
| Feature flags | — (TurboStarter ✅) | — | — | — | ✗ |
| Notifications | — | ✅ | — | — | ✗ |
| Search | — | — | — | — | ✗ |
| Data export / GDPR deletion | — | — | — | — | ✗ |
| Seed / demo data | — | — | — | — | ✅ `db:seed` + `db:seed:demo`, and a no-Stripe purchase runs the **same** `fulfilPurchase` a real payment does, refusing the moment Stripe is configured |
| Unit tests | ✅ | ✅ 2026 addition | — | ✅ | ✅ 251 tests in a maximal project; 197 pass with zero credentials, 54 skip **loudly** |
| E2E tests | ✅ Playwright | ✅ | — | ✅ | ✗ `@adminigloo/testing/playwright` is a built, tested subpath with no `playwright.config.ts`, no `e2e/`, no devDependency and no CI step anywhere |
| Boots with zero credentials | — | — | — | — | ✅ **measured**: 27 static routes, 16× 200, 11× 307, none failed, identical under `next start` and `next dev` |
| Fail-fast env validation | — | — | — | — | ✅ and it binds provider key modes to `APP_ENV`, so a live Stripe key outside production throws at boot with no override |

Two honesty notes. First, the `—` cells for audit log, rate limiting, seed data and
zero-credential boot are not wins by default: vendors were audited from their marketing and
docs, not run, so the absence of a bullet is weak evidence. What *is* reasonable evidence is
that none of the four made these headline claims, and Makerkit markets 1,240 doc pages — if
they had a zero-credential first run they would sell it. Second, component counts are the
thinnest comparison here: only Achromatic ("50+ typed") and Shipixen ("37+ blocks") publish
a number at all, so "8 vs 50" is a real gap but not a like-for-like measurement.

### 1B. How you consume it — distribution and upgrade

This is the table that matters, and the one where the architecture does something nobody in
the Next.js market does — and where the follow-through is missing.

| Capability | Makerkit | supastarter | Achromatic | Bullet Train | **Ours** |
|---|---|---|---|---|---|
| Distribution model | clone + git merge | clone + git rebase | clone + git merge | **versioned gems** | **versioned npm packages** |
| Logic fix reaches an existing project | ✗ hand-merge | ✗ hand-rebase | ✗ hand-merge | ✅ `bundle update` | ◐ `pnpm update` — **patches only**. All 15 packages are 0.x, so a caret is `>=0.x.0 <0.(x+1).0` and every minor needs a hand edit of `package.json` |
| Documented upgrade ritual | ✅ | ✅ + candid drift warning | ✅ **best in category**: fetch → `git log HEAD..upstream` → `git diff --stat` → scrutinise auth/migrations/billing/env → merge on a branch | ✅ | ✗ nothing. No merge doc, no vendor-branch convention, no guidance |
| Copied-source re-pull | ◐ plugins CLI + shadcn registry + codemods | ✗ | ✗ | ✅ per-file `--eject` on demand | ✗ ~100 files across 10 overlays — the whole admin panel, checkout, storefront, account area, marketing site, legal pages — receive nothing after generation |
| Find where a file came from | ✗ | ✗ | ✗ | ✅ `bin/resolve <class\|partial\|translation-key> --open` | ✗ |
| Patch the framework from a client project | ✗ | ✗ | ✗ | ✅ `bin/hack` clones core into `local/` for in-place editing and upstreaming | ✗ |
| Additive optional features | ✅ `@makerkit/cli plugins add` — shadcn registry + **codemods**, post-hoc | ✗ | ✗ | ✅ add a gem | ◐ strictly additive and machine-enforced (`OverlayCollisionError`, `assertCapabilitiesAreProvable`) — but **only at generation time**. No way to add a feature to a month-old project |
| Generator CLI | ◐ clone | ◐ clone | ◐ clone | ✅ super_scaffolding | ✅ 192 files in 0.26 s, 6 well-written prompts, flags used verbatim, non-TTY implies `--yes` |
| `doctor` / health command | ✗ | ✗ | ✗ | — | ✗ |
| `upgrade` command | ✗ | ✗ | ✗ | ✗ (`bundle update` suffices) | ✗ |
| Codemods | ✗ | ✗ | ✗ | — | ✗ |
| Dependency automation (Renovate / Dependabot) | ✗ | ✗ | ✗ | — | ✗ not in the scaffold repo and not in either emitted workflow |
| Machine-readable project manifest | ✗ | ✗ | ✗ | ✗ | ✅ `adminigloo.json` — full answers, package ranges, overlays, 25 capability keys, required-vs-optional env split, 100% derived so it is rebuildable and byte-diffable |
| Anti-overclaiming enforcement | ✗ | ✗ | ✗ | ✗ | ✅ `CAPABILITY_EVIDENCE` pairs every key with a named emitted file; `assertCapabilitiesAreProvable` runs inside `planEmit` on **every generation**; four keys it genuinely cannot distinguish are quarantined in `UNDISTINGUISHED_CAPABILITIES` with written reasons and a test keeping the list honest |
| Public-type-surface regression check | ✗ | ✗ | ✗ | — | ✅ `@clerk/break-check` posts a gains/losses table across all 14 packages on every PR |
| Changelog discipline | ✅ | ✅ | ✅ | ✅ | ✅ changesets, CI fails a PR touching a package without one, 3,080 lines of real release notes |

### 1C. Documentation and agent enablement

| Capability | Makerkit | supastarter | Achromatic | ShipFast | **Ours** |
|---|---|---|---|---|---|
| Docs site | ✅ ~1,240 pages | ✅ 103 (Next) of 547 | ✅ 226 across two ORM copies | ✅ ~50 | ✗ none |
| Engineered first-hour path | ✅ 10 sequenced pages + functional walkthrough + conventions | ◐ one setup page | ✅ | ✅ **best design** — tutorials ordered by what you do on day one, not by module taxonomy | ◐ `/setup` is genuinely best-in-class; the printed next-steps **break the app** (§3) |
| Recipes / task guides | ✅ 5 | ◐ 2 | — | ✅ tutorials are the recipes | ✗ |
| Troubleshooting section | ✅ | ◐ 1 page | ✅ 5 pages | ✗ | ◐ one section inside `DEPLOYMENT.md` |
| Per-module reference | ✅ | ✅ | ✅ | ✅ | ✗ **14 of 15 packages have no README**; the only way to learn what `@adminigloo/permissions` or `@adminigloo/trpc` exports is `dist/index.d.ts` |
| Migration / upgrade guides | ✅ v2-migration + updating-codebase | ◐ one update page | ✅ | ✗ | ◐ 3,080 lines of changelog, which is *what changed*, never *what to run* |
| README in a generated project | ✅ | ✅ | ✅ | ✅ | ✗ **none is emitted**; `README.md` appears in the codebase only in the `HARMLESS` allowlist of files permitted to pre-exist |
| `AGENTS.md` / editor rules | ✅ Claude Code, Cursor, Codex | ✅ AGENTS.md spec | ✅ "coding-agent context" | ✗ | ✗ zero hits repo-wide |
| Agent Skills | — | ✅ **21**, on the open spec, across setup / building / auth+payments / data / quality | ✅ blogged | ✗ | ✗ |
| MCP server | ✅ | — | ✅ | ✗ | ✗ |
| `llms.txt` + `.md` page variants | — | — | — | ✗ | ✗ |
| Live logged-in demo | ✅ per stack | ✅ real seeded app | ✗ static fake "Acme" page, no reachable dashboard | ✗ leaderboard instead | ✗ deliberate (§5) |
| Figma UI kit | ✅ only one in the market | ✗ | ✗ | ✗ | ✗ |
| Source-as-documentation | — | — | — | — | ✅ 30% of a generated project's 34,085 lines are comments; 65 files open with a block comment naming the *specific bug* the code prevents; package source is 42% comments |

---

## 2. Where we are ahead

Attributed, specific, and limited to what an audit actually measured.

**We are the only Next.js product in the market shipping logic as versioned packages.** The
distribution audit ran an explicit negative search and confirmed it: no commercial Next.js
kit uses versioned package distribution; the "npm init saas-boilerplate" style CLIs all
clone. The only precedents anywhere are Bullet Train (Ruby, ~17 gems) and Wasp (a compiled
framework under a cloned template). supastarter states the problem we avoid in their own
docs, verbatim: *"with every change you make to your application, it will become harder to
update your code base, because you are essentially rebasing your code on top of the latest
supastarter code with Git."* They charge $1,499 for an agency licence and say that on the
update page.

**Zero-credential boot, measured rather than claimed.** 27 static routes, 16 rendering 200
and 11 correctly redirecting to sign-in, identical under `next start` and `next dev`, with
nothing configured. `pnpm test` gives 197 passes in 5.8 s. `pnpm dev` is ready in 574 ms. No
competitor advertises anything comparable, and the pattern audit identifies "the first run
must not block on a credential, ever" as the principle behind Clerk's keyless mode and
Convex's auto-provisioned local deployment — we already have the whole-application version
of it.

**`APP_ENV` binding is a security property nobody else has.** Provider key modes are bound to
a host-derived environment, so a live Stripe or Clerk key outside production throws at boot
with no override, and a deployment pointing at localhost refuses to build. Achromatic's
equivalent is a docs page telling you to scrutinise env changes when you merge.

**Capability provability is the strictest anti-overclaiming machinery in the audit, by a
distance.** `CAPABILITY_EVIDENCE` requires a named emitted file for each of 25 keys;
`assertCapabilitiesAreProvable` runs inside `planEmit` on every generation rather than only
under test; it reads the *output* rather than the answers so it cannot become a tautology;
and the four keys whose evidence genuinely cannot distinguish a sibling are quarantined in
writing, with a test that keeps the list from rotting. Every vendor in the audit ships a
marketing bullet list. We ship a build that fails when a bullet is not backed by a file.

**Degrade-instead-of-throw is a consistent, deliberate design.** `db` ships an `unconfigured`
stand-in so every query path type-checks with no `DATABASE_URL`. `email` records a send as
`skipped` in `email_events` rather than throwing, so mail-sending features work end-to-end
before anyone finds a credential. Tests skip *loudly*, printing that a suite is skipped and
that `REQUIRE_DATABASE=1` turns it into a failure. The rate limiter reports whether it is
counting in Upstash or in-process instead of pretending they are equivalent. Same instinct as
the capability evidence: never let the system claim more than it is doing.

**Robots refusing to index outside production, on stated reasoning** — a crawled preview
outranking the client's real site is a harm, and a harm must not be opt-in. That is an
agency-specific concern no founder-oriented kit has reason to think about, and it matters on
every client project.

**One-time commerce and a product catalog.** Nobody else in the audit ships a storefront —
they are all SaaS-subscription kits. Cart maths in integer minor units, orders keyed on the
PaymentIntent so idempotency lives in the database, discounts as Stripe coupons rather than
negative line items, and a sync planner that knows Stripe prices are immutable. That is
domain knowledge, not scaffolding.

**Two-layer permissions with a CI scope audit.** Catalog in code, assignments in the
database, one resolver for staff and tenant scopes on both server and client, every tRPC
procedure declaring its scope, and `assertPermissionScopes` failing the router that forgets.
Makerkit and supastarter ship "roles & permissions" as a bullet; this is enforced at build.

**`/setup`.** Derived from the same Zod schemas boot validation uses, so it cannot drift; 14
variables each with what it unlocks and where to get it down to the dashboard menu path;
distinguishes `missingWhenDeployed` from `ok`; warns when nothing on the host names the
environment and lists all four consequences; never prints a value. The first-hour audit's
ideal — "a guided setup surface inside the running app, not in the README", self-verifying
rather than a static checklist, the thing Medusa is cited for — is a surface we already
built, and it is better than any equivalent in the commercial kits.

**Three of our absences look deliberate rather than accidental**, and should be defended as
such. No live demo: this is an internal tool for one firm, not a product with a purchase
funnel, and the audit also found demos to be the weakest differentiator (Achromatic's is a
fake marketing page). No multi-provider billing: five providers means five webhook ledgers,
and one firm serving one client base does not need Paddle. No i18n in the base: adding it to
the base template rather than as an additive package would violate the additivity invariant
the whole architecture rests on.

---

## 3. Where we are behind, and what it costs on the next client project

Not abstractly — what the absence does to the owner, in hours or in risk.

**Minor releases never reach an existing project. This is the one with a security
consequence.** All 15 packages are 0.x, so caret ranges carry patches and not minors.
`versions.ts` knows this precisely — 46 lines of comment — and `versions.test.ts` enforces
that the emitted range admits the version the commit will publish. But that guard protects
only *newly generated* projects. `@adminigloo/env` 0.3.0 fixed a bug where a self-hosted
production server read as a laptop, which means it minted free licence keys. A client project
generated on `^0.2.x` still has that bug, `pnpm update` will never fix it, and no channel
exists that would tell anyone. **Cost: not hours — an unbounded liability sitting in every
project generated before that release, with no inventory of which ones.**

**No agent support of any kind, on a project the owner builds with an agent.** No `AGENTS.md`,
`CLAUDE.md`, `llms.txt`, skill, MCP server or editor rules file — searched, zero hits
repo-wide, the only match a prose mention inside a gap document. The cost compounds three
ways. First, on every new client project the agent rediscovers conventions from scratch,
which is exactly the rationale supastarter gives for their 21 skills: they "guide agents
through project conventions rather than requiring agents to rediscover them with each
prompt." Second, an agent with 2025-era priors about Next 16 / Clerk 7 / tRPC 11 /
Tailwind v4 writes plausible, wrong code — Clerk's stated reason for shipping skills through
their CLI is agents writing `<SignedIn>` when v7 replaced it. Third, and worst here
specifically, an agent that has not been told the invariants will cheerfully add a conditional
branch instead of an overlay, read Clerk `has()`, or skip a changeset — violating the exact
rules that make this scaffold unusual. **Cost: a recurring tax on every session, plus a class
of bug that only surfaces as architectural drift.**

**No re-pull path for ~100 copied-source files.** Ten overlays: the whole admin panel,
checkout, storefront, account area, marketing site, legal pages. The mitigation is honest and
real — only *presentation* lives in overlays, so routers, permission checks and audit calls
stay in packages and a security fix still reaches everyone. But a UI fix means a human
diffing their `/admin/products/page.tsx` against overlay source at the recorded generator
version, by hand. **Cost scales linearly with client count: with four live projects every
admin-panel improvement is four manual diffs — or, realistically, it is never propagated and
each client silently keeps the old bug.** Note the ranking: Makerkit, supastarter and
Achromatic all have *worse* mechanisms than ours for logic, and a *documented ritual* we lack
for source. On copied source specifically we are behind three paid kits.

**`adminigloo.json` has no readers.** The manifest, the 25-key vocabulary and the evidence
machinery are built, enforced and excellent — and the `doctor` command, the drift check and
the component registry they were designed to serve do not exist. Rebuild-and-byte-compare,
the entire reason the manifest is purely derived, is unimplemented. **Cost: the expensive
half is paid and none of the value has been collected.** This is also the clearest instance of
the pattern that should govern the copy list — primitives built ahead of their consumers.
`@adminigloo/testing/playwright` (built, tested, no config, no `e2e/`, no CI step) and
`/api/ai/chat` (streams, meters, records cost, zero callers) are the same shape.

**The generator's printed step 2 breaks the app.** `cp .env.example .env.local` overwrites the
annotated, already-working `.env.local` the generator just wrote — measured result: `Invalid
environment variables: NEXT_PUBLIC_APP_URL — expected string, received undefined`, then
`Failed to load next.config.ts`, then a dev server that serves nothing. The line under it —
"The app will not boot until these are set", over 12 variables — is false, and contradicts
the single best property of the whole system. **Cost to the owner: low, they know. Cost to a
client's developer, a contractor, or an agent following instructions literally: the entire
first hour, spent debugging a break the tool caused.** It is a one-line fix in `nextSteps()`.

**No README, no `git init`, undocumented registry auth.** A person lands in an untracked
directory of 192 files with no front door and nothing pointing back at the scaffold repo, its
six rules, or its changelogs. Before that, `pnpm dlx @adminigloo/create-app` needs a global
`.npmrc` and a `read:packages` token that neither the README nor `--help` mentions, so the
first experience is a bare 401. **Cost: ~30 minutes per new person, every time — and it is
the first impression a client's own developer forms of the firm's tooling.**

**14 of 15 packages have no README.** To recall what `@adminigloo/billing` exports you read
`dist/index.d.ts`. **Cost: small friction per lookup, many lookups per project — and it is
also why an agent cannot help, because there is nothing at package level for it to read.**
The 3,080 lines of changelog are genuinely good and are not a substitute for an API surface
page.

**Eight UI primitives.** Consistent, token-driven, dark-mode-aware from 26 CSS custom
properties — and the first client who asks for a date picker, dialog, combobox, tabs or toast
puts the owner in bespoke-component work. **Cost: a few hours the first time and, because
there is no shared component channel, a few hours again on the next project.**

**No E2E tests.** Four flows would cover the risk — sign-up, sign-in, invite a teammate,
checkout — and checkout is precisely the flow that fails silently and expensively. The
Playwright helpers already exist and are stranded.

**Blank rows a client will notice:** file uploads, background jobs, i18n, product analytics,
search, feature flags, org switcher UI, CSV export, GDPR deletion. Each is a defensible scope
decision individually. Collectively they are what makes a feature-comparison conversation with
a client awkward, and each is a bespoke build the first time it is asked for.

**Two manifest claims that are currently too generous**, which matter because this project's
own standard is strict: `admin.support-tools` is proven by a file that is a pure `EmptyState`
reading no data, and `--admin full`'s prompt hint promises a health page and a data explorer
that exist nowhere. Both are small, and both undercut the credibility of the evidence
mechanism that is otherwise the best thing here.

---

## 4. The copy list

Ordered by value to the owner per hour of work. Each item is tagged **[EASE]** — makes
existing capability easy to reach — or **[FEATURE]** — adds new capability. The owner asked
for the first, and this project's history (a manifest with no readers, a Playwright export
with no config, an AI endpoint with no caller, a permission with no enforcement) argues
strongly for finishing consumers before building more primitives.

---

### 1. Fix the first hour · **[EASE]** · ~1 hour · one-off

**What.** Three edits: delete the `cp .env.example .env.local` line and the "will not boot
until these are set" paragraph from `nextSteps()`; emit a `README.md`; run `git init` with an
initial commit.

**Who does it best, what to take.** ShipFast — thinnest docs in the audit, highest sales —
leads with "Ship in 5 minutes" and orders its tutorials by what a person does on day one
rather than by module taxonomy. Take that ordering for the README: what you have; run
`pnpm dev` (it works with nothing configured); open `/setup`; then the Neon path when you want
data. Everything the README needs to say already exists in `/setup`, `/setup/start` and the
source comments — it is simply not assembled at the path a person opens first.

**Why here.** The only item on the list where current behaviour is actively destructive and
measured to be so. The cost/benefit is not close.

---

### 2. Make minors flow, and notify · **[EASE]** · half a day · one-off + trivial standing

**What.** Two halves. (a) Settle the 0.x question: publish 1.0.0 across all 15 packages so
carets carry minors, or widen the emitted ranges. (b) Publish a shared Renovate preset repo
and emit a one-line `renovate.json` into every generated project.

**Who does it best, what to take.** Doist's shared Renovate config is the reference shape:
every consuming repo carries `{"extends": ["github>adminigloo/renovate-config"]}` and nothing
else, so upgrade policy for the entire fleet is one file. Take the grouping and automerge
policy specifically — all `@adminigloo/*` in a single PR per scaffold release, patch and minor
automerged, majors held for review. Renovate's own docs recommend keeping the preset repo
public.

**Why here.** This *is* the depend-and-upgrade promise. Today it is half-connected: the
packaging is right, minors do not flow through 0.x carets, and no notification channel exists
at all. It is the only item with a live security consequence (`env` 0.3.0), and the cheapest
item with a large effect. Half a day converts an architectural bet into a working mechanism —
after which a fix genuinely does open a PR in every client repo the day it publishes.

---

### 3. `AGENTS.md`, generated per project from the manifest · **[EASE]** · half a day · small standing

**What.** A root `AGENTS.md` in the scaffold repo stating the invariants (additive packages
only, never conditional branches; copied source vs runtime dependency; changesets required;
never read Clerk `has()`; never enable Clerk Billing), one per package describing what that
package owns, and a generated per-project `AGENTS.md` written from `adminigloo.json` — which
answers were given, which packages at which ranges, which overlays applied, which capabilities
are claimed, which env vars are required.

**Who does it best, what to take.** AGENTS.md is now stewarded by the Agentic AI Foundation
and read by ~30 tools. The pattern worth copying is **nesting**: OpenAI's Codex repo carries
88 of them down its tree, nearest file to the edited code wins. For a 15-package monorepo that
maps exactly.

**Why here.** The corpus is already written and unusually good — 30% comment density, 65 files
opening with a block comment naming the specific bug prevented, and `create-app/README.md`'s
six architectural rules each paired with the failure that earned it. It is simply not addressed
to a machine or placed where one looks. The per-project variant is nearly free because
`adminigloo.json` is 100% derived: it is a template over a JSON file that already exists. This
also gives the manifest its first reader.

---

### 4. Per-package READMEs, generated from the type surface · **[EASE]** · ~1 day · small standing

**What.** One page per package answering install → configure → verify → common failures. 14 are
missing.

**Who does it best, what to take.** Better Auth (a page per plugin and provider), Drizzle (a
page per driver), Clerk (a page per SDK). The structural rule from the docs audit: complete and
self-contained, no cross-page prerequisites — which matches an additive package architecture
exactly, because an agent asked to add one feature then reads exactly one page. The generation
rule from Stripe and shadcn: reference is generated from a machine-readable source of truth,
never hand-written, because hand-written reference drifts within one release. The sources
already exist — `package.json` exports, the Zod env fragments, the Drizzle schemas, the
permission catalog fragments — and `@clerk/break-check` already computes the public type
surface on every PR.

**Why here.** It serves the owner and the agent from one artifact, and it is the cheapest
possible fix for "I have to read `dist/index.d.ts` to remember what this exports."

---

### 5. `@adminigloo/cli`: `info --json`, `doctor`, `drift` · **[EASE]** · 2–3 days · standing

**What.** Three commands reading `adminigloo.json`. `info --json` emits package versions,
enabled feature packages, overlays present, capability keys, env status. `doctor` validates env
wiring, migration state, registry auth and package-version currency, every failing check
printing a description, a remedy and a docs link. `drift` rebuilds the manifest from the
recorded answers and byte-compares against disk — the thing the manifest was purpose-built to
allow and which nothing does.

**Who does it best, what to take.** `clerk doctor [--spotlight] [--fix]` — `--spotlight` shows
only failures, `--fix` proposes a diff before applying. `expo-doctor` and `flutter doctor` for
the check-list format. `shadcn info --json` for machine-readable project state. Storybook's
`automigrate` for the best version of the pattern: it explains what is out of date, offers to
fix it, and links a docs page per finding. And the rule worth adopting wholesale from the
agent-era audit: **every command gets a non-interactive path, a `--json` output and a
`--dry-run`.**

**Why here.** This is substrate. The upgrade command, the codemod runner, the registry re-pull
and the agent skill all need to ask "what is this project" and "what is wrong with it";
building `info` and `doctor` now answers that once instead of three times. It also finally
makes `adminigloo.json` load-bearing rather than ornamental.

---

### 6. An agent skill, shipped through a private Claude Code plugin marketplace · **[EASE]** · 1–2 days · standing

**What.** One skill in the scaffold repo — `SKILL.md` under 500 lines, reference files per
feature package, released from the same repo and the same changeset as the packages —
distributed via a `.claude-plugin/marketplace.json` in a private repo, alongside slash commands
(`/add-feature-package`, `/upgrade-scaffold`) and an MCP config.

**Who does it best, what to take.** shadcn's own skill at `skills/shadcn/` is the best available
template: `SKILL.md` plus `cli.md`, `customization.md`, `registry.md`, plus `agents/`, `rules/`
and — the part nobody copies — `evals/`. Its description is written as a trigger list, its body
is mostly hard rules rather than prose, and it constrains `allowed-tools`. supastarter's
21-skill taxonomy is the right decomposition (setup, building features, auth & payments, data &
integrations, quality & shipping). Clerk's rationale is the argument for shipping it from the
same release as the code: an agent's stale priors are exactly where it produces plausible,
wrong output, so **the skill should state what changed, not just what is true.** Claude Code
plugin marketplaces work from a private git repo with no special setup because they reuse
ordinary git auth.

**Why here.** Given the owner builds with an agent, this is plausibly the single highest-leverage
item on the list; it is ranked sixth only because items 1–5 are cheaper or are its prerequisites
(the skill should be able to say "run `adminigloo doctor`" and "read `AGENTS.md`"). Copy the
`evals/` directory too — a skill that is not tested regresses exactly as silently as untested
code.

---

### 7. A private shadcn registry for the overlays, plus a vendor branch · **[EASE]** · 3–5 days · standing

**What.** The re-pull path for ~100 copied-source files, in two lanes.

*Lane one, the registry.* A `registry/` directory in the scaffold monorepo, `shadcn build` in
CI, generated JSON committed, and every client project installing copied source with
`shadcn add adminigloo/scaffold/admin-shell#v0.12.0`. The GitHub-address form is the right
choice: it authenticates with the same GitHub PAT class already used for GitHub Packages, so
there is no second registry to host, no `components.json` entry and no extra secret in any
client repo. `registry:page` items with `target` ship actual routes; `envVars` appends keys to
`.env.local` without overwriting; `docs` prints a post-install message. **The `#ref` pinning is
the load-bearing part** — it records which scaffold version a project's copied source came from,
which is the precondition for ever upgrading it. On upgrade, `shadcn add <item> --diff` gives a
three-way diff (local file / version originally added / latest upstream): unmodified files
overwrite, modified files become a reviewable PR.

*Lane two, the vendor branch,* which costs nothing and covers arbitrary edits: commit pristine
generator output as the first commit on a `scaffold/vendor` branch at generation time;
regenerate that branch at the new version on upgrade and `git merge scaffold/vendor` into main.
Git's own three-way merge then does what copier's `copier update` does, and it composes with
`#ref` because the ref tells you which version to regenerate from.

**Who does it best, what to take.** Makerkit's plugin system is the closest thing in the Next.js
market — shadcn registry plus their own CLI plus **codemods**, so integration has no manual
wiring steps — and the distribution audit calls it the single most copyable mechanism found.
Bullet Train's `--eject` is the better idea underneath it: ship as dependency by default,
convert to copied source per file, on demand, at the moment you actually need to diverge.
Achromatic's merge-review discipline is what to write into the accompanying doc —
`git log --oneline --decorate HEAD..upstream/main`, `git diff --stat`, scrutinise anything
touching auth, migrations, billing, env or deployment, and above all *"do not regenerate or
delete migration history just to make a merge clean."*

**Why here.** It is the largest remaining hole in the architecture and the manifest was
explicitly designed to serve it. It is seventh rather than second because it is the first
genuinely expensive item, it wants `info`/`doctor` underneath it, and its value scales with
client count — it earns its place the moment there are three or four live projects and is
speculative before that.

**Consider also, cheaply:** for the *marketing* overlay specifically, Expo's prebuild model beats
any merge strategy. If copy, nav and section ordering came from a `marketing.config.ts` the
client edits, the page files stay regenerable forever and never need a merge at all. The admin
panel is genuinely meant to be restyled and belongs in the registry lane. Drawing that line per
surface, rather than treating all copied source alike, is the actual design decision.

---

### 8. A docs site — Diátaxis, error-code pages, `llms.txt` · **[EASE]** · 1–2 weeks · permanent standing commitment

**What.** The thing every vendor in the audit actually sells. Four literal top-level sections
with a rule that a page may only be one of them: Tutorial (build your first client project),
How-to (add Stripe to an existing project), Reference (generated, per package), Explanation (why
additive packages instead of conditional branches). Plus a get-started *matrix* rather than a
linear quickstart, with the column nobody writes and the owner will use most: *existing project
generated by an older create-app*. Plus a Gotchas page — append-only, cheap, with obvious entries
already ("copied admin source is not upgraded by npm", "overlay directories win over package
defaults", "GitHub Packages publishes private by default", "npm ignores parent `.npmrc`").

**The highest-leverage sub-item, worth doing even without the rest:** one docs page per literal
error string at a stable URL, with the URL embedded in the thrown message. Next.js does this
(`nextjs.org/docs/messages/<slug>`), Prisma codes every error, React ships a decoder. Every error
this scaffold throws should get a code, a page and a link in the message: env validation
failures, migration drift, Clerk key mismatch, `OverlayCollisionError`, and the registry 401 that
is currently the very first thing a new user hits, bare. This converts "search five times" into
"click the link in the terminal."

**Also take:** every page served as raw Markdown at the same URL plus `.md`, indexed from an
`llms.txt` where each link carries a one-sentence description — that makes it a routing table
rather than a sitemap, and serves the human and the agent from one artifact. Trigger.dev and
Clerk are the references; Mintlify's experience is the warning against a single flat index for a
15-package site.

**Why here, and the honest caveat.** Documentation is what these companies actually sell — strip
the source and it is the largest surviving asset by an order of magnitude. But Makerkit's 1,240
pages are affordable to them because docs volume *is* their marketing, and they pay a 9×
duplication tax we do not have to pay. For a one-firm internal scaffold the right target is
Achromatic-shaped, not Makerkit-shaped, and it is a permanent commitment rather than a project.
Start with the error-code pages and the Gotchas list, which are append-only and immediately
useful, and let the reference half be generated (item 4).

---

### 9. Recipes and a troubleshooting section · **[EASE]** · ~1 hour each, ongoing · standing

**What.** Short pages titled by the task, with no narrative: "add an admin-only route", "add a
Stripe metered price", "recover a migration that failed mid-deploy", "add a new permission key".
Title them as the search query.

**Who does it best.** TurboStarter leads the audit with 13 recipes; Makerkit has five substantial
ones; supastarter's two are a visible weakness in an otherwise strong doc set. Dedicated
troubleshooting sections exist in Makerkit, Achromatic (5 pages) and TurboStarter (4).

**Why here.** The docs audit's observation is the reason: these are the pages nobody writes until
a customer forces them to, which is exactly why buyers value them — and here the "customer" is
the owner six months later. They are append-only, so they cost an hour each and never need a
redesign. `DEPLOYMENT.md` already contains most of the first troubleshooting page.

---

### 10. Unstrand Playwright — four E2E flows · **[FEATURE / quality]** · 1–2 days · small standing

**What.** `playwright.config.ts`, an `e2e/` directory, the devDependency, a CI step, and four
specs: sign-up, sign-in, invite a teammate, checkout. `@adminigloo/testing/playwright` already
exists, is built and is tested, and nothing imports it.

**Why here.** Cheap because the helpers exist, and it covers checkout — the flow most likely to
break silently and most expensive when it does. It also removes one of the three
primitives-without-consumers, which matters for the credibility of the evidence mechanism.

---

### 11. Grow the UI primitives to ~25, through the registry · **[FEATURE]** · 2–3 days · standing

**What.** Dialog, sheet, tabs, combobox, date picker, toast, dropdown menu, tooltip, pagination,
skeleton — the set a client asks for first.

**Who does it best, what to take.** shadcn, obviously — but take the *distribution* decision
consciously. The presets mechanism (an entire design-system config encoded into one shareable
code, applied with `shadcn init --preset`) is the cleanest way to encode the house style so a
client restyle starts from our defaults rather than shadcn's, and `shadcn apply --only theme` is
a real upgrade path for the styling half of copied source even after a client has edited
component internals, because CSS variables are far safer to overwrite than TSX.

**Why not higher.** It is the first thing a client notices, and it is still a feature rather than
an ease-of-use item — and its distribution depends on item 7. Doing it before the registry exists
means eight more files that can never be upgraded.

---

### 12. Fill the blank rows, one additive package at a time · **[FEATURE]** · 3–5 days each · standing per package

In the order a client is most likely to ask: file storage (S3 presigned, as Achromatic and Open
SaaS ship it); background jobs (Achromatic documents four runtimes — pick one); an organisation
switcher UI, which also makes `--tenant` a real answer instead of a byte-identical one; usage
credits (Achromatic's is the only first-class version in the audit and increasingly what clients
ask for, and `ai_usage` in micros is already half of it); a caller for `/api/ai/chat`; and an
actual implementation of the impersonation permission that is currently declared and unenforced.
Then i18n, analytics, search, feature flags, CSV export and GDPR deletion as demand appears.

**Why last.** Every one is a legitimate gap and none is what the owner asked for. A feature-list
comparison shows them as blank rows; a next-client-project retrospective shows items 1–7 as the
thing that cost time.

---

## 5. What not to copy

**The multi-stack matrix.** Makerkit sells Supabase, Drizzle and Prisma as three separate $349
purchases and maintains nine product lines with ~180 duplicated doc pages each; Achromatic
maintains two near-identical 113-page doc copies. That duplication is the exact cost a
package-based architecture avoids, and the only reason they can monetise it. Copying it imports
their tax for none of their revenue.

**Git-remote merge as the upgrade mechanism.** Achromatic's ritual is genuinely the best-written
thing in the audit and should be read — but adopt it *only* as documentation for the vendor-branch
lane in item 7, never as the primary mechanism. Making it primary concedes the one thing that
makes this scaffold unusual, and supastarter has already told us where it leads.

**shadcn `--overwrite` as an upgrade path.** Nothing in this ecosystem auto-merges, shadcn warns
about the flag itself, and it has open bugs where it fails to suppress the prompt. The realistic
2026 state of the art is `--diff` per file, agent applies upstream changes preserving local
edits, human reviews a PR. Anything that silently rewrites a client's restyled admin page is
worse than doing nothing.

**Five payment providers.** supastarter's breadth is a marketing asset for a product sold to
strangers. Here it means five webhook ledgers, five idempotency stories and five sets of edge
cases against a two-phase event ledger that currently works. Add a second provider when a
client's contract requires it, not before.

**A GUI configurator.** Shipixen's desktop app and Divjoy's generator are the same idea, and
Divjoy is the cautionary tale in the audit: frozen stack, 2024 copyright, 17,323 stranded
codebases, and no mechanism or commercial reason to reach any of them. Our generator is already
answer-driven, reproducible from a single command, and runs in 0.26 s. A GUI would add a
maintenance surface and remove reproducibility.

**A Figma UI kit.** Only Makerkit ships one, and it makes sense as a differentiator for a product
with a purchase funnel. Our restyle path is 26 CSS custom properties; a Figma file would be a
second source of truth that drifts.

**Mobile and browser-extension targets.** TurboStarter's Expo + WXT breadth is real and genuinely
uncontested — and it is an enormous surface for a firm building Next.js apps. Nothing in the
owner's question points at it.

**Discount theatre, Discord, leaderboards, showcases, comparison posts, consulting-call tiers.**
Pre-sale mechanisms for products sold to strangers. The pricing data is still worth keeping for
one reason: the entire commercial category prices the right to build unlimited client products at
under $1,500 one-time, so this scaffold has to beat $1,500 in saved hours exactly once to be
worth having — which it almost certainly already has.

**A demo site.** The audit's own verdict is that demos are the weakest differentiator, with
Achromatic's being a static fictional marketing page with fabricated stats and no reachable
dashboard. There is no buyer here. If one ever appears, the requirement is a seeded, logged-in
application — and `db:seed:demo` already does the hard half.

**i18n, analytics or storage in the base template.** Each is worth having (item 12) and each must
arrive as an additive package or overlay. Putting any of them in the base breaks the additivity
invariant that `OverlayCollisionError` and `assertCapabilitiesAreProvable` exist to enforce, and
that invariant is worth more than any of the three features.

---

## 6. The recommended next three

**One — make minors flow and wire up Renovate.** (Item 2, half a day.) The central claim of this
architecture is that a fix reaches every client project ever generated. Today that is half true:
packaging is right, minors do not flow through 0.x carets, and there is no notification channel at
all — no `renovate.json`, no `dependabot.yml`, not in the scaffold repo and not in either emitted
workflow. `@adminigloo/env` 0.3.0 fixed a bug that gives products away free on a self-hosted
production server, and a project on `^0.2.x` will never learn that. This is the only item where
inaction has a security consequence, it is the cheapest item with a large effect, and until it is
done every other investment sits on top of a promise the system does not keep.

**Two — agent enablement generated from the manifest: `AGENTS.md` (root, per package, per
project) plus one skill in a private Claude Code plugin marketplace.** (Items 3 and 6, about two
days together.) This is the most literal available answer to "makes it really easy for me,"
because the owner's actual interface to this scaffold is an agent. It is now a headline bullet on
every serious kit — supastarter's 21 skills, Makerkit's MCP server and per-tool rules as *install
steps*, Achromatic's "coding-agent context" — and we have exactly zero. It is unusually cheap here
because the corpus is already written: 30% comment density, 65 files opening with the specific bug
they prevent, six numbered architectural rules each paired with its failure. The per-project half
is nearly free because `adminigloo.json` is 100% derived. Do the root and per-package `AGENTS.md`
first; the skill second, from the same release as the packages, so its content is version-matched
— which is the whole point, since an agent's stale priors about Next 16, Clerk 7, tRPC 11 and
Tailwind v4 are precisely where it will write plausible, wrong code.

**Three — repair the first hour and give the manifest its first real reader: fix `nextSteps()`,
emit a README, `git init`, then build `@adminigloo/cli info --json` and `doctor`.** (Items 1 and
5, about three days.) The first part is an hour and stops the tool from breaking the app it just
generated, which is currently measured and true. The second part is substrate: `doctor` is the
pattern every good CLI in the audit converged on (`clerk doctor --fix`, `expo-doctor`, Storybook's
`automigrate` explaining what is out of date and linking a docs page per finding), and
`info --json` is what makes the upgrade command, the drift check, the registry re-pull and the
agent skill cheap to write later instead of each inventing its own answer to "what is this
project."

**Deliberately not in the top three:** the shadcn registry, the docs site, and more UI primitives.
All three are on the list and all three are real. But each is expensive, each wants
`doctor`/`info` underneath it, and — most importantly — this project has a documented habit of
building primitives ahead of their consumers: a manifest with no readers, a Playwright export with
no config, an AI endpoint with no callers, a `staff.tenants.impersonate` permission with no
enforcement. Every one of the recommended three creates a consumer for something already built
that is currently paying no return. That is the pattern to repeat before adding anything else.
