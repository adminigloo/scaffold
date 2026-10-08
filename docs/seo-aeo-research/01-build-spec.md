**Build spec: internal audience exclusion and the SEO, AEO and analytics suite in AdminIgloo, installed into Riddler Go**

Everything here was read-only. I re-checked every code citation I rely on; anything I could not check is marked INFERRED.

## The answer

1. **What you asked me to find.** Your Road Rally work is pushed and deployed. As of 2026-10-06 it is on `origin/master` at 5e5fb1f0 and `origin/staging` at a7a79cc3; the deploy runs come from the inventory's `gh run list`, which I did not re-check.
   - It adds four reports: Registrations by Event/Day, an Accounts→Registrations funnel, Sign-ups by Source, and a per-event report.
   - It adds Tracking 1.3.0: first and last touch, the verify link that returns to the wizard, and pixel fixes.
   - It adds one internal-accounts rule with an "Include internal" toggle that defaults to off.
   - It reads PlanetScale MySQL, not DynamoDB.
   - Riddler Go has none of the exclusion and none of the attribution. AdminIgloo has none of it either.
2. **Rachel's requirement, and the main decision.** Build a new, small package, **`@adminigloo/audience`**, rather than putting the exclusion inside `@adminigloo/analytics`.
   - Riddler Go keeps its own cookie-based analytics tables, as the prior plan says. Road Rally is MySQL with a SolidJS admin. So the rule that decides who counts can't live in analytics' Postgres tables.
   - `audience` holds three things: the rule model (pure TypeScript), a small "marks" store, and display-only components.
   - **Excluding someone is a read-time anti-join against marks; it never rewrites analytics rows.** Adding a person or a rule cleans their history right away. Removing it restores the numbers. Every report shows "Excluded: N (staff X, test Y, automation Z)".
   - Analytics 0.2 and the digest use it, and so does any other package that counts people.
3. **Riddler Go needs no change to its existing tables.** Marks on the `rg_visitor` id (a 2-year cookie), on users, on orgs and on orders cover staff browsing, staff orgs and test orders. That avoids adding `orders.is_test` or `organizations.is_internal`.
   - The only migration is three new `aig_audience_*` tables. It is additive and lands after the 2026-10-09 trial.
4. **What to build first (section 5).** `@adminigloo/audience` 0.1, then the AdminIgloo site wired end to end, then Riddler Go staging. It is size M, and Rachel sees "staff and named people excluded, history cleaned, N excluded shown".

## 1. What you asked me to find

**Commits.** Each change was committed twice, once per branch:

| Change | staging | master | Date |
|---|---|---|---|
| Sessions reports | 4de6d8e2 | be48fb38 | 2026-10-02 |
| Tracking 1.3.0 | 756e03a8 | 3b9d50df | 2026-10-02 |
| Tracking changes dated as live in production on 2026-10-05 | 34b61d3b | 0a199680 | 2026-10-05 |
| Stage info box; one internal rule | cb6462c1 | 1dfab22c | 2026-10-06 |
| Staff out of roster and session cards (the direct fix for "snowcat92") | a7a79cc3 | 5e5fb1f0 | 2026-10-06 |

- The analytics-only admin role is 2cbc77d6 (2026-07-22), on both branches. 5dfdd7d4 later narrowed it to `/sessions`.
- Your local `master` is 28 commits behind origin.

**Reports.** The routes are in `backend-api/src/api/admin/sessions.ts`; the pure logic is in `_registrationReport.ts`, `_signupSources.ts` and `_sessionsUtils.ts`.
- **Registrations by Event and by Day.** Days are America/Denver, DST-safe, half-open ranges.
- **Accounts funnel.** Groups a, b, c-owner, c-member and d, with a cutoff detected from the migration-0080 burst.
- **Sign-ups by Source.** Uses the D10 classifier (paid if a click id or paid medium, `fbclid` alone counts as social), a window capped at 31 days, and a 413 response above 20,000 sessions.
- **Analyst privacy.** Salted email masks, IDs replaced by -1, coupon masks, and no revenue.

**Tracking 1.3.0.**
- `rrr-first-touch` and `rrr-last-touch` are kept for 90 days in the browser, but the server only counts touches from the 7 days before sign-up.
- Click ids are stored as presence only. URLs are scrubbed in the browser and again at ingest, with a parity test.
- The verify link goes back to the wizard, except for private events.
- Pixels now send the real charged price.

**The internal rule (verified).**
- `isInternalOwner` (`_registrationReport.ts:94-98`): account type is not `user`, or the email contains "riddlerroadrally".
- `exclusionOf` (`:225-232`): demo, then in-house, then internal owner.
- `isInternalSession` (`_sessionsUtils.ts:779-793`): the tab's email belongs to an internal account, or is `guest`.
- It is applied when reports are read, so it is retroactive. Nothing is deleted.

**Where Road Rally still leaks:**
- signed-out or incognito staff tabs that never log an email;
- no named list of people, so excluding someone means changing their role;
- unverified sign-ups are checked only by the email substring;
- Meta, Google Ads and Floodlight fire for staff, including on `/admin`;
- bots are reported but never excluded;
- the analytics role is trusted from a 2-year login token.

**What Riddler Go lacks** (`C:\Users\dalli\riddler-go`):
- **Any internal exclusion.**
  - The only drops are `webdriver` and localhost, and they happen in the browser (`lib/tracking/beacon.ts:43-47`).
  - `app/api/beacon/route.ts:51-147` has no check of who is visiting.
  - `analytics_sessions` has no user id or internal flag (`db/schema/analytics.ts:12-41`).
  - `recordServerEvent` (`lib/tracking/server-events.ts:62-85`) writes funnel events for staff too.
- **The rest:** excluded counts, the toggle, first/last-touch attribution, a database-backed account→org→published→paid funnel, and sign-up sources.
- **What it already has:** an analytics role (`auth.ts:48`), annotations, an AI report, the digest, and the Play Along predicate plus guard test (`lib/participants/counted.ts`, `lib/__tests__/host-play-exclusion.test.ts`). That is the pattern to copy.

**What AdminIgloo lacks.** Everything above.
- `@adminigloo/analytics` 0.1.0 has no internal filter. `sessionWindow` at `reports.ts:57-59` is the single place to add one.
- Its visitor key is cookieless and changes daily, so a rule about a person can reach back only about 48 hours unless the app turns on pseudonymous mode.

**Corrections to the inventories:**
- `event_published` is at `lib/events/actions.ts:288`, not :276.
- Riddler Go already pins `@adminigloo/feedback` 0.9.1 (`package.json:39`). ADR-0014's handoff blocker therefore exists today.

## 2. Spec for excluding the internal audience (`@adminigloo/audience` 0.1)

### Rules model

These are stored rules. Each row has: id, tenant_id, kind, value, reason_label, note, created_by, created_at, disabled_at, applies_from.

| Kind | Matches | Reaches back in time? |
|---|---|---|
| `user` | a named user id (Rachel's "list of people") | yes, through the visitor-to-user link (below) |
| `email` | an exact address, trimmed and lower-cased, with optional Gmail dot/plus folding | yes, through the link |
| `email_domain` | e.g. `riddlergo.com` | yes |
| `email_pattern` | a substring or glob, e.g. `+clerk_test`, `riddlerroadrally` | yes |
| `org` | an org id (staff workspace or demo org) | yes |
| `event` | a test event | yes |
| `order` | a test order | yes |
| `visitor` | a device ("mark this browser", or `?internal=<signed token>`) | yes for that device |
| `network` | a CIDR range | **new visits only; IPs are never stored** |
| `host` | a host allow-list; anything else is non-production | new visits only |
| `user_agent` | automation (HeadlessChrome, Playwright, Lighthouse, UptimeRobot, Checkly, and similar) | new visits only |

- The code-level rule is `isInternal(user) => reason | false`, supplied by the app. Its results are shown in the UI as read-only.
- Bots are a separate `bot` reason. They are never mixed into "internal".

### Defaults that work with no configuration

- **The app's callback.** For Riddler Go: `platformRole ∈ {super, staff, analytics}`.
- **Built-in patterns:** `+clerk_test@`, the reserved domains (`example.com`, `example.org`, `example.net`, `*.test`, `*.invalid`, `*.localhost`), and `+test@`.
- **Hosts:** `localhost`, `127.0.0.1`, `::1`, `*.vercel.app`, and `VERCEL_ENV !== "production"`. This fails open, as trailcards' `isNonProductionDeployment` does.
- **Automation:** the `webdriver` flag in the browser plus the user-agent list on the server, and a secret header `x-aig-audience: test` for smoke runs against production.

### Order of reasons

When several reasons apply, the first one wins, so the per-reason counts add up to the total excluded (this follows Road Rally's `exclusionOf`):

bot > automation > non-production > role (callback) > named user > email > domain > pattern > org > event/order > device > network > manual

### What is stored (default Drizzle store, configurable prefix, default `aig_audience_`)

- **`…rules`**: as above.
- **`…marks`**: tenant_id, subject_kind (`visitor`, `user`, `org`, `event`, `order` or `session`), subject_id, reason, rule_id (null when set by hand or at intake), source (`ingest`, `rule`, `manual` or `backfill`), marked_by, marked_at, cleared_at.
  - There is a partial unique key on (tenant, kind, id, coalesce(rule_id, reason)) where cleared_at is null.
- **`…links`**: visitor_id, user_key = HMAC(`AUDIENCE_SECRET`, userId), first_seen, last_seen.
  - Rows are written only for signed-in beacons.
  - The mode is `link: "internal-only" | "pseudonymous"`. Pseudonymous (recommended for Riddler Go) is what lets a person added later reach their anonymous past.
- **`…runs`**: id, rule_id, action (`apply`, `remove`, `backfill` or `manual`), subjects_changed, sessions_affected, from, to, by, at.

The store is defined as an `AudienceStore` interface. The default Drizzle Postgres store comes from `defineAudienceTables({prefix})`. A MySQL store for Road Rally comes later.

### Intake

`audience.observe({visitorId, user?, host, userAgent, ip?, headers})` returns a reason or null. If there is a reason, it writes a visitor mark (`source: ingest`). It is idempotent, and active rules are cached for 60 seconds.

- **Riddler Go** calls it from the beacon route after `resolveOrCreateAnalyticsSession`. Clerk's `auth()` works there because `proxy.ts:63-70` matches `/api`.
- **Server events.** `audience.classifyActor({userId, orgId})` runs in `recordServerEvent`. An internal actor's event is still written, but its visitor is marked.
- **What is dropped rather than tagged:** malformed requests, non-production traffic writing into the production database, and privacy opt-outs (Global Privacy Control or Do Not Track).
- **IP addresses** are checked against CIDR rules in memory, then thrown away.

### Reports

The core is pure and needs no database.
- `countedVisitorSql(col, opts)` and `countedSubjectSql(kind, col)` return a `NOT EXISTS (… marks m WHERE m.subject_kind=… AND m.subject_id=col AND m.cleared_at IS NULL)` fragment. It works inside raw SQL with a `s` alias, which is how Riddler Go's `inWindow()` is written.
- `excludedBreakdown(window)` returns `{total, byReason}`.
- `includeInternal` defaults to false. It is a URL parameter, never remembered between visits (the Road Rally a7a79cc3 lesson). A banner shows while it is on.
- **Must never be filtered:** AI spend and usage, capacity, audit and security logs, error monitoring, rate limits.

### Cleaning numbers already polluted

| Action | What happens |
|---|---|
| `preview(rule)` | A dry-run count of the visitors, sessions, orgs and orders it would mark, over 30 days, 90 days and all time, with before/after KPIs. |
| `apply(ruleId)` | Resolves users through `listUsers` (supplied by the app), then their visitors through `…links`, and writes marks in batches. It is idempotent. It writes a run row and an annotation through the app's adapter: "Internal rule added: N sessions excluded back to <date>". |
| `remove(ruleId)` | Sets `cleared_at` on that rule's marks, then re-applies the rules still active. Marks made at intake or by hand are untouched. Nothing is ever hard-deleted. |
| `backfill(adapter)` | Each app supplies the joins (Riddler Go's are in section 4). |

- Every card, the digest and the AI report show the exclusion line.
- One panel lists the numbers that cannot be cleaned: Google Search Console, AEO engines, the Stripe and Clerk dashboards, digests already sent, and Meta/Google pixels.

### Admin UI

Entry `@adminigloo/audience/ui`. The components fetch nothing. They take plain data, plus callbacks that a Riddler Go page can fill with server actions.

| Component | What it does |
|---|---|
| `IncludeInternalToggle({value, href})` | The per-report toggle. |
| `ExcludedNote({excluded})` | The "Excluded: N (…)" line on cards. |
| `AudienceRulesPanel({rules, runs, canEdit, maskEmails, onPreview, onAdd, onRemove})` | Rules list, add form with preview count, run history. |
| `MarkThisBrowserButton({onMark})` | Marks the current device. |
| `UnfilteredSourcesNote` | Labels the outside sources as unfiltered. |

- Styling uses CSS variables only, with 44px tap targets and AA contrast. This matters because ADR-0014 notes feedback's stock styles failed Riddler Go's rules.
- **Permissions:** super and staff can edit. The analytics role can view and toggle but not edit, and sees emails masked as `j***@gmail.com`.

### Privacy

- No IPs are stored anywhere.
- Links store an HMAC of the user id, never the id itself.
- Rule emails are normalized, and masked for analysts.
- The device mark reuses the first-party cookie the app already sets. That it is exempt from consent is INFERRED; check with legal.
- The README states exactly what each link mode stores.
- Riddler Go's privacy page probably needs one sentence about linking signed-in visitors (INFERRED).

### Guard test

`@adminigloo/audience/testing` exports `assertCountedReads({roots, tables, predicates, exempt})`. It generalizes `host-play-exclusion.test.ts`: the build fails when a file reads the analytics tables without the predicate, unless an exemption gives a reason.

### Road Rally later (INFERRED)

- The pure core and a MySQL `AudienceStore` would replace `isInternalOwner`/`isInternalSession` with `classifyActor` plus a named list. That fixes the personal-Gmail staff and unverified sign-up leaks.
- The device mark would go in localStorage, set when staff sign in and sent on the beacon. That fixes anonymous staff tabs.
- `shouldSuppressPixels()` would guard Meta, Google Ads, Floodlight and GA4, or tag GA4 traffic as internal.
- The user-agent bot list would be enforced, not just reported.
- The UI components don't apply, because Road Rally's admin is SolidJS.
- The 2-year-token problem with the analytics role is a separate fix.

## 3. AdminIgloo package build plan

Sizes: S is about 1 to 2 days, M about 3 to 5 days, L more than a week.

| # | Package | Size | Scope | API | Tests |
|---|---|---|---|---|---|
| 1 | **audience 0.1** (new) | M | Section 2 | `createAudience({store, isInternal, listUsers, link, rules})`, `defineAudienceTables`, `./ui`, `./testing` | Unit: each rule kind, precedence, normalization. PGlite (as booking uses): apply/remove round trip, intake marks, counts adding up. Scaffold e2e: the components, with axe and tap-target checks. |
| 2 | **analytics 0.2** | L | `defineAnalyticsTables({prefix})` and `createAnalytics({db, tables, audience, limits, license})` with the caches inside each instance; session columns `internal_reason`, `actor_key`, `classifier_version`; cookieless mode uses session tags plus a 48-hour `markVisitorInternal`, and pseudonymous mode uses `actor_key`; `counted()` in `sessionWindow` plus joins in top pages, clicks, event visits and vitals; the SEO-audit bot excluded by default; `aiEngineOf` and `getAiAssistantTraffic`; `reclassifySources`; configurable `limits`; README and CHANGELOG. | `createAnalytics(...)`. The default prefix reproduces 0025's names exactly. | Snapshot that the default prefix matches 0025's names; every report excludes internal by default; the public snapshot always excludes; two table sets don't share caches; the guard test. |
| 3 | **analytics 0.3** | L | The generic reports derived from Road Rally: `./attribution` (first/last-touch capture in the browser, server re-validation, a 7-day window, UTMs carried through redirects, a URL scrubber with a parity test); `./funnel` (the app supplies `FunnelSource` stage queries; the package provides business-time-zone day buckets, backfill-cutoff detection, conversion medians, a sign-up-sources table and the source classifier including AI); `./privacy` (salted masks, free-text scrub). | as listed | Pure: day buckets, cutoff detection, classifier, scrubber parity. PGlite: funnel through a fake adapter. |
| 4 | **seo 0.1** (new, no tables) | M | Metadata builder (canonical is the page itself, no doubled brand, share image always merged); JSON-LD `@graph` with `@id` and `<` escaped; robots builder fed from `analytics/crawlers`; sitemap with real `lastmod`, images and splitting; llms.txt and llms-full.txt from a content registry; IndexNow; `isIndexable(env)`. | builders | Unit and snapshot tests per builder; an escaping test. |
| 5 | **seo-reports 0.2** | M | Rewrite `robotsBlocks` (wrong user-agent group handling); new checks (canonical, `X-Robots-Tag`, llms-full.txt, duplicate titles, orphan pages, broken links); parallel fetching; failure history; tenant column; an `AuditStore` adapter. | `createAudit({store})` | Robots fixtures, including the GPTBot/ClaudeBot group case. |
| 6 | **search-console 0.1** (new) | S/M | Signs its own login (no Google library), nightly import, impressions-weighted reports, `GscStore` adapter. | `createSearchConsole({store, credentials})` | Fake token server; date-math tests. |
| 7 | **aeo 0.2** | L | Rebuilt from Riddler Go's `lib/aeo` (**blocked on the IP question**); otherwise a clean-room build from Traildek's ideas plus the fixes in 00 §3. Store-first (`AeoStore`). | `createAeo({store, engines, budget})` | RG's `lib/aeo/__tests__` become package tests. |
| 8 | **digest 0.1** | M | Anomaly engine (`computeAnomalies`), weekly composition, the excluded line, the unfiltered-sources note. | `composeDigest(inputs)`, pure | Pure tests. |

- **How each package stores data.** analytics uses the prefix, because rewriting 20+ report queries per app isn't worth it. aeo, seo-reports and search-console use adapters, because Riddler Go's history lives in its own tables. audience ships both: a default store and the interface.
- **Every package:** exact pins, `files: ["dist","README.md","CHANGELOG.md"]`, license gating with `verifyLicense`, publishing with `pnpm publish`, and a vendorable tarball built alongside each release.
- **Release order:** audience 0.1, analytics 0.2, seo 0.1, seo-reports 0.2, search-console 0.1, analytics 0.3, digest 0.1. aeo 0.2 waits on the IP decision.

## 4. Riddler Go install plan

**Before the 2026-10-09 trial: nothing goes in.** The prior plan's one task is still open: set `CRON_SECRET` in production. That is a settings change, not code.

| Package | What is installed and wired | Adapters / migrations | Env vars | Crons | Acceptance |
|---|---|---|---|---|---|
| **audience 0.1** | `lib/analytics/audience.ts`: `isInternal` from `platformRole`, `listUsers` from `users`, link mode pseudonymous. `audience.observe` goes in the beacon route and `recordServerEvent`. `inWindow()` in `lib/analytics/queries.ts:215-217` gets `AND counted` unless `includeInternal`. Web Vitals (`:650-690`) get a join through the session. Admin home counts (`app/admin/page.tsx:14-74`) exclude marked orgs. Digest (`lib/analytics/digest-send.ts`) and AI report get the excluded line. New page `/admin/analytics/audience` uses server actions with the `ui` components. Annotations go through an adapter over `analytics_annotations` (`kind: "note"`). | **One additive migration:** `aig_audience_rules`, `aig_audience_marks`, `aig_audience_links`, `aig_audience_runs`. Existing tables are not altered. | `AUDIENCE_SECRET` (32+ characters) | maintenance can run inside the existing `analytics-digest` job, or as a daily `audience-maintain` job | A ported copy of the guard test over `analytics_sessions`, `page_views` and `session_events`. Vitest: a `+clerk_test` user and a staff user browsing are excluded, a customer is counted, removing a rule restores the counts. E2E: the axe and tap-target spec for the page. Dry-run backfill counts reviewed with Rachel before apply. |
| analytics 0.2 | **Only the crawler half**, using `prefix: "aig_analytics_"`, so `aig_analytics_crawler_hits`. Riddler Go keeps its own visitor analytics. | one additive table | none new | the existing ones | crawler e2e |
| seo 0.1 | Swap out `components/seo/schemas.ts`, `JsonLd.tsx`, the robots builder and `llms-content`. | none | `INDEXNOW_KEY` | none | existing `schemas.test.ts` plus snapshots |
| seo-reports 0.2 | An adapter over `audit_findings`. | none | none | `site-audit` | audit e2e |
| search-console | An adapter over `gsc_daily`. | none | 3 `GSC_*` variables (on the client's account) | `gsc-pull` | import vitest |
| aeo 0.2 | An adapter over `aeo_queries` and `ai_citation_log`, **only if the IP question allows it**. | none | engine keys (client-owned) | `aeo-citations` | `e2e/admin/aeo-citations` |

**Backfill for Riddler Go** (one-off, idempotent, dry-run first):
- **Internal users:** platform roles, plus the rules, plus the patterns (which catch the nine `+clerk_test` users).
- **Visitors with these server events:**
  - `checkout_completed`: `properties->>'orderId'` maps to `orders.purchased_by` or `orders.organization_id`.
  - `event_published` and `sketch_claimed`: `properties->>'eventId'` maps to `events.created_by` or `events.organization_id`.
  - When either is internal, mark that visitor. Because the cookie lasts 2 years, all of that visitor's sessions are then excluded.
- **Internal orgs** are suggested in the UI ("every member is internal") and confirmed by hand. They are never auto-marked, because staff help inside customer orgs.
- **Limit, stated on screen:** staff browsing before the links table existed, by staff who never published, claimed or bought, can't be found.

**Play Along:** unchanged. `/play` is never beaconed, and `counted.ts` stays.

**ADR-0014.** Each package adds a registry dependency to the handoff blocker.
- Pin exactly, and keep the vendored tarballs current.
- Amend ADR-0014, or write ADR-0015, to list `@adminigloo/audience` and `@adminigloo/license` before the merge.

**IP question.** audience, seo, seo-reports, search-console and analytics are clean-room AdminIgloo code or Traildek-derived (your own), so they are safe. aeo 0.2 rebuilt from Riddler Go's `lib/aeo` needs the contract checked or Rachel's written OK first. Until then, build aeo 0.2 clean-room.

## 5. First slice to build now (in `C:\Users\dalli\scaffold`)

1. **`packages/audience`**
   - Pure core: rules, `classifyActor`, precedence, email normalization, defaults, CIDR (reuse `analytics/src/verify.ts`).
   - Drizzle store with a prefix, and the four tables.
   - `observe`, `preview`, `apply`, `remove`, `backfill(adapter)`, `excludedBreakdown`, `countedVisitorSql` and `countedSubjectSql`.
   - `./ui`: the toggle, `ExcludedNote` and `AudienceRulesPanel`.
   - `./testing`: `assertCountedReads`.
   - Tests: unit, PGlite, and a scaffold e2e spec for the components.
2. **Wire the AdminIgloo site** (`C:\Users\dalli\adminIgloo`)
   - Change `SiteAnalytics.tsx` from `disabled={staff}` to marking the visit. In cookieless mode, map this to the analytics 0.2 `internal` tag. For this slice, use the audience `session`/`visitor` marks keyed by visitor_key.
   - Add the audience panel to `/admin/analytics`.
   - Add the additive migration. You run `db:migrate` yourself.
3. **Acceptance for Rachel's requirement:**
   - A staff member browsing signed in, signed out on the same device, and as a `+clerk_test` user is excluded.
   - Adding a named email excludes that person's history at once, and shows "Excluded: N (named person N)" plus an annotation.
   - Removing the rule restores the numbers exactly.
   - The analytics role sees masked emails and cannot edit rules.
4. **Then, after the trial:** Riddler Go staging gets the dry-run backfill and the counts review with Rachel, then production.

**Files cited:**
- `C:\Users\dalli\scaffold\docs\seo-aeo-research\00-answer-and-plan.md`
- `C:\Users\dalli\scaffold\packages\analytics\src\reports.ts`
- `C:\Users\dalli\scaffold\packages\analytics\src\ingest.ts`
- `C:\Users\dalli\scaffold\packages\analytics\src\client.tsx`
- `C:\Users\dalli\riddler-go\lib\analytics\queries.ts`
- `C:\Users\dalli\riddler-go\app\api\beacon\route.ts`
- `C:\Users\dalli\riddler-go\lib\tracking\server-events.ts`
- `C:\Users\dalli\riddler-go\lib\participants\counted.ts`
- `C:\Users\dalli\riddler-go\lib\__tests__\host-play-exclusion.test.ts`
- `C:\Users\dalli\riddler-go\docs\adr\0014-riddler-go-may-depend-on-adminigloo-packages.md`
- `C:\Users\dalli\riddler\MonoRepo\packages\backend-api\src\api\admin\_registrationReport.ts`
- `C:\Users\dalli\riddler\MonoRepo\packages\backend-api\src\api\admin\_sessionsUtils.ts`
- `C:\Users\dalli\trailcards\src\server\utils\reportableOrders.ts`