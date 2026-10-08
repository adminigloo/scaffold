ANALYTICS 0.2 DESIGN: EXCLUSIONS, ADAPTERS, AI SOURCE (read-only review of `C:\Users\dalli\scaffold\packages\analytics` and the testbed `C:\Users\dalli\adminIgloo`)

**Headline.** No report in `@adminigloo/analytics` 0.1.0 has an internal or staff filter. The testbed's only staff lever drops staff visits in the browser. That leaves no audit trail, no "include internal" view and no way to clean up visits already counted. In 0.1 every report reads the raw rows directly; there are no rollup tables. So cleaning up polluted numbers comes down to setting a tag on `analytics_sessions` and refreshing one cache. The real limit is the cookieless model: a rule about a person can only reach back about 48 hours unless the app opts into storing a pseudonymous actor key.

## 1. Inventory

**Tables** (`src/schema.ts`). All are tenant-scoped with a plain-text `tenant_id`.

- **`analytics_sessions`** (19-67). Columns: id (uuidv7 text), tenant_id, visitor_key, last_doc_id, started_at, last_seen_at, landing_path, referrer_host, utm_source, utm_medium, utm_campaign, utm_content, utm_term, click_id_kind, source_bucket, country, device, browser, os, page_view_count, event_count, duration_ms, is_engaged, converted.
  - Indexes: tenant+started, tenant+visitor+last_seen, tenant+doc, tenant+source+started, started.
- **`analytics_page_views`** (69-90). Columns: id (bigserial), session_id (FK, cascade), tenant_id, path, content_type, content_key, sequence, occurred_at.
- **`analytics_events`** (92-118). Columns: id, session_id (FK, cascade), tenant_id, name, path, label, value, metric_id, occurred_at.
- **`analytics_crawler_hits`** (127-148). Columns: id, tenant_id, bot_name, bot_kind, operator, path, country, verified, bucket_start, hits, last_at.
  - Unique key: (tenant, bot, path, bucket, verified).
- **`analytics_salts`** (155-159): day (PK), salt, created_at.
- **`analytics_rate`** (166-176): tenant_id, net_key, window_start (all three form the PK), sessions, hits.
- **`analytics_sites`** (179-182): tenant_id (PK), tracking_since.
- **`analytics_annotations`** (188-202): id, tenant_id, day, label, kind, created_by, created_at.

**Functions that touch the database.**

In `ingest.ts`:
- `saltFor` (63), `resolveVisitorKeys` (94), `createAnalyticsHandler().handle` (229-303)
- `takeHit` (314), `ensureSite` (329), `liveSession` (336)
- `recordPageView` (359-443): advisory lock, session budget, session insert at 394-415, session update at 421-431, page-view insert at 433
- `recordEvent` (445-497), `addDuration` (500-512), `recordConversion` (524-552)
- `recordCrawlerHit` (572-597), `runAnalyticsMaintenance` (615-650): purges salts and rate rows, enforces retention in batches

In `reports.ts`:
- `getTrackingSince` (81), `totals` and `getOverview` (116-157), `getDailyTrend` (173-211)
- `getSources` (225), `getReferrers` (255), `getCampaigns` (275), `getBreakdown` (302), `getEngagementBySource` (324), `getActivity` (360)
- `getTopPages` (387-404), `getLandingPages` (414), `getTopClicks` (441-450), `getEventVisits` (457-475)
- `getWebVitals` (491-516, raw SQL), `getCrawlers` (546-607), `getRecentAiReads` (623-657), `getAiCoverage` (660-681)
- `getPipelineHealth` (697-717), the annotation functions (730-750), `getPublicSnapshot` (796-835)

**Two module-level caches**, `saltCache` (ingest.ts:56) and `knownSites` (326). Because they are global, two table sets in one process would share them. This is also why the testbed's integration test needs a fresh tenant for every test.

**How the testbed uses it.**
- **Schema:** spread into the app schema at `src/db/schema.ts:51,75`. The tables were created by `drizzle/0025_sad_prism.sql` under the default names, including the foreign-key names, for example `analytics_page_views_session_id_analytics_sessions_id_fk`.
- **Beacon endpoint:** `app/api/analytics/route.ts` calls `siteAnalyticsHandler()`, defined at `src/server/site-analytics.ts:67-80`.
- **Server-side conversions:** `recordSiteConversion` (site-analytics.ts:88-103) passes request headers only. It does no staff check.
- **Beacon:** `src/components/SiteAnalytics.tsx:24` mounts `<AnalyticsBeacon disabled={staff}>`. The `staff` value comes from `viewerIsStaff()` (site-analytics.ts:111-122), called in `app/(site)/layout.tsx:51,81`.
- **Crawler log:** `proxy.ts` logs crawlers through `src/server/crawler-log.ts`. clerkMiddleware covers `/(api|trpc)(.*)` (proxy.ts:146-155), so Clerk's `auth()` works inside `/api/analytics`.
- **Admin page:** `app/admin/analytics/page.tsx` is fed by the tRPC procedure `analytics.report` (`src/server/routers/analytics.ts:42-97`). `refreshPublic` (115-120) already exists "after a data fix".
- **Cron:** `app/api/cron/analytics/route.ts:42`, scheduled at `15 8 * * *` in `vercel.json`.
- **Environments:** kept apart by tenant (`src/analytics-config.ts:20`): `site` in production, `site:<env>` elsewhere.
- **Homepage:** the public window is cached for 20 seconds (site-analytics.ts:151-154).
- **Tests:** the only database tests are in the testbed, `src/server/__tests__/analytics.integration.test.ts` (6 tests). It imports the tables from `@adminigloo/analytics/schema` directly.

## 2. Who is identifiable at ingest

| Signal | What the handler has | Where |
|---|---|---|
| Payload | `d` (a per-document random id, held in memory only), `p` path, `ms`, and on the first view `r` (referrer host) and `q` (query string); events add `n`, `l`, `v`, `i` | ingest.ts:171-195 |
| Request | User-Agent (used for the crawler check, the HMAC and device parsing; never stored), IP through the `clientIp()` hook (HMAC only), country through `resolveCountry`, Origin/Referer (same-site check, 208-213), Sec-GPC/DNT | |
| App cookies | The beacon is same-origin. `sendBeacon` sends cookies, and the `fetch` fallback uses `credentials:"same-origin"` (client.tsx:110). So the Clerk session reaches the handler, but the handler never reads it: there is no identify hook. | |
| Anonymous id | None by design. The visitor key is HMAC(daily salt, IP ‖ UA ‖ tenant). It can be linked only to today's or yesterday's sessions until that salt is deleted, roughly 48 hours. | |
| Host | `req.url` and Origin are known, so preview and local traffic can be identified. The testbed separates them by tenant; trailcards 828485e instead refuses to record anything outside production. | |

**Where to tag:** in `handle()` after parsing (ingest.ts:254), work out the visit's audience tag once, then pass it into:
- the session insert at 394-415;
- the updates at 421-431, 476-486 and 504-511, using `coalesce` so that a staff member who signs in partway through a visit flags the whole session;
- `recordConversion` (524).

## 3. What gets filtered today

- **Bots** are dropped at ingest (ingest.ts:242), so reports never need a bot filter (reports.ts:16-21).
- **The browser skips** Global Privacy Control, Do Not Track, `navigator.webdriver` (test automation), the local opt-out and `disabled` (client.tsx:117-124). The `?analytics=off` link (146-155) is a per-device drop.
- **Throttles:** 600 requests per network per hour, 30 new sessions per network per hour, 500 page views per session (ingest.ts:39-45).
- **Report-level filters:**
  - `getTopClicks` excludes web vitals (445).
  - `getPublicSnapshot` limits pages to the public paths in SQL and withholds vitals below 50 samples.
  - The AI-kind filters apply to crawler data only.
- **No internal/staff filter exists anywhere in the package.**
- **The site's own SEO audit pollutes the crawler reports.** The seo-reports user agent `adminigloo-seo-reports/0.1` (`seo-reports/src/index.ts:317`) is classified as the crawler "AdminIgloo audit" (crawlers.ts:346). The daily cron (route.ts:246) crawls 25 pages a day. Those hits inflate the bot list, the top paths and the `seo-tool` count, though not the AI counts.

## 4. Exclusion design

### Schema

Add to `analytics_sessions` (no change to page views or events; they inherit through a join to the session):
- `internal_source text NULL`: null means counted. Values: `ingest`, `rule`, `manual`.
- `internal_reason text NULL`: for example `role:admin`, `email-domain`, `network`, `device`, `env`, `rule:<id>`, `manual:<userId>`.
- `actor_key text NULL`, `actor_role text NULL`, `actor_domain text NULL`: written only when `identity:"pseudonymous"`. `actor_key` is HMAC(`actorSecret` from env, userId).
- `classifier_version smallint`: for the source reclassification in section 6.
- A partial index on (tenant_id, started_at) WHERE internal_source IS NULL, and an index on (tenant_id, actor_key).

New table `analytics_exclusion_rules`:
- Columns: id, tenant_id, kind, value, value_to, note, created_by, created_at, disabled_at.
- Kinds: `user`, `email`, `email_domain`, `role`, `network` (CIDR), `device_link`, `landing_path`, `path_prefix`, `referrer_host`, `utm_source`, `utm_campaign`, `time_window`, `session`, `bot`.

New table `analytics_exclusion_runs` for the audit trail:
- Columns: id, tenant_id, rule_id, action (`apply`/`remove`/`recompute`/`manual`), sessions_changed, from, to, by, at.
- Each run also writes an annotation of kind `data`, so the trend chart explains why a line dropped.

No crawler-table column is needed. Bot exclusion is applied at query time (`notInArray(bot_name, …)`), which makes it fully retroactive. "AdminIgloo audit" is excluded by default.

### Ingest

New option `AnalyticsHandlerOptions.audience`:
- `identify(req)` returns `{userId, email, roles}` or null. It is called on page-view beacons only and cached per document id for 30 minutes.
- `isInternal(actor)` returns a reason string or false. This is the code-level rule, the same shape as Road Rally's `isInternalOwner`: any non-customer account type, or a company email domain.
- `internalNetworks`: CIDR ranges, checked in memory with `parseCidr`/`ipInRange` from verify.ts and never stored.
- `identity: "none" | "pseudonymous"` (default `"none"`), `actorSecret`, and `listInternalUserIds()` for the daily job.

Active rules are cached per instance with a 60-second TTL.

**Client changes:**
- A new `internal` prop on `AnalyticsBeacon` sends `x:1` on every beacon. This tags the visit instead of dropping it.
- `markDeviceInternal()` plus a `?analytics=internal` link, modelled on the existing opt-out, for the client team's phones when signed out.
- Add `x` to the payload schema at ingest.ts:179-195. The server treats `x` only as a downgrade: forging it can only hide a visit.

**New `markVisitorInternal({ip, userAgent, reason})`:** flags sessions under today's and yesterday's visitor keys. Call it on staff sign-in, or from a "these are my visits" button in the admin.

### Reports

- Add `ReportQuery.includeInternal?` (default false) and one helper, `counted(t, q)`.
- Put it inside `sessionWindow` (reports.ts:57-59). That one change covers `getOverview`/`totals`, the session half of `getDailyTrend`, `getSources`, `getReferrers`, `getCampaigns`, `getBreakdown`, `getEngagementBySource`, `getActivity` and `getLandingPages`.
- Add an inner join to sessions plus `counted` in `getTopPages` (387-404), `getTopClicks` (441-450) and `getEventVisits` (457-475). In `getWebVitals`, add it to the `loads` subquery (492-501).
- `crawlerWindow` (61-63) gains the excluded-bot list. That covers `getCrawlers`, `getRecentAiReads`, `getAiCoverage` and the crawler half of the trend.
- `getPublicSnapshot` always excludes internal visits, whatever the caller passes.
- `getPipelineHealth` stays unfiltered: it checks liveness.
- `getOverview` also returns `excluded: {visits, byReason}`, like Road Rally 1dfab22c's `totals.excluded`, so the dashboard can say "312 internal visits left out".

### Recompute and maintenance

- `previewExclusionRule(rule)`: a dry-run count.
- `applyExclusionRule(id)`: batched UPDATE in the same pattern as the retention loop (633-648): `set internal_source='rule', internal_reason='rule:<id>' where internal_source is null and <predicate on stored columns>`. It returns the count and the affected days, and writes a run row and an annotation.
- `removeExclusionRule(id)`: clears rows `where internal_reason='rule:<id>'`, then re-applies the remaining active rules to those rows. Tags set at ingest or by hand are never touched.
- `runAnalyticsMaintenance` adds three steps:
  1. Re-apply the active rules to sessions started since the last run (idempotent safety net).
  2. With `listInternalUserIds` and the pseudonymous mode: flag sessions whose `actor_key` matches the app's current list of internal users. This is the same "who is internal now" logic Road Rally uses.
  3. Reclassify sources when the classifier version changes.
- There are no rollups to rebuild in 0.1. The only cache is the testbed's 20-second public snapshot; bust it after any apply or remove (the `refreshPublic` path).
- If a later release adds daily rollups, re-roll the affected days that `apply` and `remove` return.

### What cleanup can and cannot reach in cookieless mode

| Rule kinds | Retroactive reach |
|---|---|
| landing/path prefix, referrer host, UTM, time window, session id, country/device/browser, bot | Full: these columns are stored for the 13-month retention |
| user, email, domain, role | Full only with `identity:"pseudonymous"`. Otherwise new visits only, plus about 48 hours through `markVisitorInternal` |
| network (CIDR) | New visits only: the IP is never stored |
| device link | New visits only, plus about 48 hours |

**For Riddler Go, recommend `identity:"pseudonymous"`.** Hosts and the client's staff sign in, and its existing analytics already keeps a 2-year cookie, so this is no step down in privacy. The README must spell out what is stored in each mode.

### Guard test

Port Riddler Go 3411fe4's "source guard": a test that fails if any `.from(t.sessions | t.pageViews | t.events)` in reports.ts lacks `counted(`.

## 5. Table prefixes and adapters, without breaking the testbed

- **`defineAnalyticsTables({ prefix = "analytics_" })`** builds every table, index and foreign-key name from the prefix.
  - The default instance is exported under the current names (`analyticsSessions` and the rest). The testbed's `schema.ts:51,75` and the integration test's imports keep working.
  - drizzle-kit sees identical DDL for the 8 existing tables. The only change is additive: the new columns and the two new tables.
- **`createAnalytics({ db, tables?, tenantId, timeZone, audience, license, limits })`** returns a bound API: handler, recordConversion, recordCrawlerHit, maintenance, reports and exclusions.
  - The two caches move inside each instance.
  - Internal functions take `t: AnalyticsTables`.
  - The 0.1 free functions stay as deprecated wrappers over the default tables, to be removed at 1.0.
- **Riddler Go:** `prefix: "aig_analytics_"`.
  - Of its 65 tables, only `analytics_sessions` and `analytics_annotations` clash, and it has no `aig_` tables (verified).
  - Its 4 `analytics_sessions_*` index names would also collide without the prefix.
  - The prefix means an additive migration only, and its legacy tables keep running alongside for a comparison period.
- **Column mapping comes free with Drizzle.** The queries use table objects by their JS keys, so an app can pass its own `pgTable` with the same keys and different SQL names, for example `visitorKey: text("visitor_id")`. Type `AnalyticsTables` structurally to allow this. It is not recommended for Riddler Go's legacy table, which lacks about 15 required columns.
- **Don't build a method-by-method store interface for analytics.** It would mean reimplementing 20+ report queries in each app. Keep that design for aeo, Search Console and the audit, where Riddler Go's existing history matters.

## 6. AI traffic source

- **Already there:** the `aiAssistant` source (sources.ts:18-27, 202, 210). `utm_source=chatgpt.com` is already handled (sources.ts:69), so the prior plan's item for it is done in analytics.
- **Add `aiEngineOf({referrerHost, utmSource})`:** chatgpt, perplexity, claude, gemini, copilot, meta, grok, deepseek, mistral or other.
- **Add `getAiAssistantTraffic(query)`:** per engine, show visits, engaged rate, conversions and landing pages, each paired with the `ai-assistant` crawler fetches for the same path. For example: "ChatGPT-User fetched /pricing 14×, and 6 visits came from ChatGPT".
- **Candidate hosts (INFERRED; check each one live before shipping):**
  - Web: copilot.cloud.microsoft, m365.cloud.microsoft, notebooklm.google.com, aistudio.google.com, duck.ai, chat.qwen.ai, kimi.com, pi.ai
  - Android packages: com.anthropic.claude, ai.perplexity.app.android, com.google.android.apps.bard, com.microsoft.copilot
  - UTM sources: perplexity.ai, claude.ai
- **Document the limit:** Google AI Overviews and AI Mode arrive as google.com and stay "organic"; the referrer can't separate them.
- **`reclassifySources({since})` is fully retroactive,** because referrer_host, utm_source, utm_medium and click_id_kind are stored (schema.ts:37-46). It is guarded by `classifier_version`.

## 7. aeo 0.1.1 and seo-reports 0.1.0

Neither has any audience concept: there are no people in an AEO check or an SEO audit. aeo is tenant-scoped; seo-reports has no tenant column. The only cross-package effect is the audit crawler polluting the analytics crawler reports (section 3), fixed by excluding that bot by default.

## 8. Change list for analytics 0.2.0

1. **schema.ts:** `defineAnalyticsTables({prefix})` with the default instance exported under today's names. New session columns: `internal_source`, `internal_reason`, `actor_key`, `actor_role`, `actor_domain`, `classifier_version`, plus the partial index. New tables `exclusion_rules` and `exclusion_runs`.
2. **`createAnalytics()` bound API:** caches moved into the instance; deprecated 0.1 wrappers kept.
3. **Ingest:** the `audience` option; `x:1` device flag; `markVisitorInternal`; actor columns in pseudonymous mode; `coalesce` upgrade of the session on staff sign-in; `recordConversion` accepts headers or an actor.
4. **New `./exclusions` entry (pure):** the rule matcher and the CIDR helper, so Riddler Go's own report queries can reuse the same rule.
5. **Exclusion API:** list, add, preview, apply, remove, recompute.
6. **Maintenance:** re-apply rules, the internal-user roster check, source reclassification.
7. **Reports:** `includeInternal`; `counted()` in `sessionWindow` plus the joins in the 4 page/event reports; the crawler bot exclusion; the public snapshot always excludes; `excluded` counts in `getOverview`.
8. **Client:** `internal` prop, `markDeviceInternal()`, `?analytics=internal`.
9. **Dashboard (plain-data components):** `IncludeInternalToggle`, an `ExcludedNote` on the KPI cards, and an `ExclusionRulesPanel` (rules list, add form with preview count, run history).
10. **AI source:** `aiEngineOf`, the new hosts, `getAiAssistantTraffic`, `reclassifySources`.
11. **Configurable `limits`:** at 30 new sessions per network per hour (ingest.ts:41), a Riddler Go live event on venue Wi-Fi would be undercounted (INFERRED: only if the beacon is mounted on player pages).
12. **License gate:** `options.license` plus `verifyLicense({feature:"analytics"})`, as in `booking/src/handlers.ts:460-463`.
13. **README.md:** install; wiring the handler, beacon, crawler log and cron; what is stored and never stored in each identity mode; a guide to exclusions and how far each rule kind reaches back; prefixes; the reports API; privacy-page text.
14. **CHANGELOG.md** covering 0.1.0 and 0.2.0, with `files: ["dist","README.md","CHANGELOG.md"]` (feedback/package.json:32-35 is the model).
15. **Package-level tests:**
    - Integration (PGlite or a test database): tagging at ingest; upgrade on sign-in mid-visit; the device flag; networks; rule apply then remove restoring counts; ingest tags surviving a recompute; a table-driven check that every report excludes internal by default and includes it with the flag; the public snapshot always excluding; a prefixed table set end to end; two table sets not sharing caches.
    - Pure: each rule kind; `aiEngineOf`; a snapshot showing the default prefix reproduces the 0025 names exactly.
    - The guard test from section 4.
16. **Publish:** with `pnpm publish` (`workspace:^` on `@adminigloo/db`). Move the testbed from `vendor/adminigloo-analytics-0.1.0.tgz` to `^0.2.0`.

**Testbed adoption path:**
1. Generate the additive migration (0028); you run `db:migrate` yourself, as before.
2. Add `audience.identify` to `site-analytics.ts`, reusing the `viewerIsStaff` logic (111-122).
3. Change `SiteAnalytics.tsx:24` from `disabled={staff}` to `internal={staff}`.
4. Add `includeInternal` and the exclusion procedures to `routers/analytics.ts`, and the panel to `/admin/analytics`.
5. Bust the public-snapshot cache after any rule change.
6. The cron's call at `route.ts:42` keeps its signature.

**Patterns borrowed:**
- Road Rally 1dfab22c: one shared internal rule, an "Include internal" toggle, and excluded counts by reason.
- trailcards 828485e: a flag set at write time plus one reportable-row predicate used by every report.
- Riddler Go 3411fe4: a shared counted-rows module plus a source-guard test.