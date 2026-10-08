**Trailcards AEO and analytics: full inventory for the Riddler Go / AdminIgloo port**

Everything below was read-only. Line references point at the trailcards repo (`C:\Users\dalli\trailcards`, branch `main`, HEAD `b68eb90`) unless another repo is named. Anything marked INFERRED was not confirmed in code.

## 0. What to know first

1. **The retired-model claim from the gap analysis is out of date.** Commit `0250de8` ("fix(aeo): replace retired engine models, make model IDs configurable") is already on `main`.
   - Current defaults are at `src/server/services/aeoEngines.ts:84-89`: chatgpt `gpt-4o`, perplexity `sonar`, gemini `gemini-3.7-flash`, claude `claude-sonnet-4-6`.
   - The comments at :74-78 record that `llama-3.1-sonar-*` was retired 2025-02-22 and `gemini-2.0-flash*` shut down 2026-06-01.
   - Still unverified:
     - Whether `gemini-3.7-flash` really exists. The code says it went GA on 2026-08-13, which is after my knowledge cutoff.
     - Whether a stale override sits in the production `aeo_engine_models` site_settings row. The database was not read.
2. **The founder's belief that Riddler Go has no SEO/AEO is wrong.** I only checked this at the file level because Riddler Go was outside my piece.
   - `C:\Users\dalli\riddler-go` already has a port of this stack:
     - Tables: `db/schema/aeo.ts` (`aeo_queries`, `ai_citation_log`, `platform_settings`), `db/schema/gsc.ts` (`gsc_daily`), `db/schema/annotations.ts` (`analytics_annotations`), `db/schema/analytics.ts` (`analytics_sessions`, `page_views`, `session_events`, `ai_crawler_hits`).
     - Code: `lib/aeo/runner.ts` (its header says "Section 22 Phase 22.d, ported from trailcards' aeoCitationRunner.ts"), `lib/gsc/ingest.ts`, `lib/tracking/ai-crawler-capture.ts`.
     - Crons in `vercel.json`: aeo-citations Sat 14:00, gsc-pull daily 06:00, analytics-digest Mon 13:00, site-audit Mon 07:00.
     - Tests: e2e specs under `e2e/admin/` (aeo-citations, crawler-capture, analytics-dashboard).
   - The SEO/AEO work for Riddler Go is a consolidation and migration job, not a new build.
3. **Table-name collisions, verified:**
   - Trailcards `aeo_queries` collides with `@adminigloo/aeo` `aeo_queries` (`scaffold/packages/aeo/src/schema.ts:10`) and Riddler Go `aeo_queries`.
   - Trailcards `ai_citation_log` matches Riddler Go `ai_citation_log`.
   - Trailcards `page_views` / `session_events` match Riddler Go.
   - Trailcards' analytics table is literally named `sessions`, and Riddler Go already uses `sessions` for game sessions (`riddler-go/db/schema/sessions.ts:25`). Trailcards' analytics schema can never be copied into Riddler Go under its own names.
4. **Trailcards' AI-crawler panel can never show any crawler visits.**
   - Bots are only detected inside `/api/analytics/event` (`src/app/api/analytics/event/route.ts:69-103`), which only the client JS beacon calls.
   - The beacon refuses to send without localStorage consent (`src/lib/analytics/beacon.ts:181-182`, `:207-208`).
   - Crawlers don't run JS and have no consent, so the "bots bypass consent" branch (route.ts:280-286) is effectively never reached.
   - There is no server-side capture: `src/middleware.ts` (32 lines) has no bot or analytics code.
   - `@adminigloo/analytics` already fixed this server-side (`scaffold/packages/analytics/src/crawlers.ts` and `verify.ts`, which checks crawlers against their operators' published IP ranges). Trailcards' `sessions.bot_verified` is never written (grep finds only reads at `routers/analytics.ts:790-800`).

## 1. File map (AEO + analytics)

- **Plans:**
  - `ANALYTICS-AEO-V2-PLAN.md` (98 lines; Phase 2 all DONE 2026-08-26; line 4 says it is kept in sync with riddler-go plan 22.f–22.h).
  - `SITE-REWORK-PLAN.md` §7.0–7.3 (lines 841–1140) has the original vision.
  - `docs/ADMIN-REORG-PLAN.md`.
- **AEO services:**
  - `src/server/services/aeoEngines.ts` (586 lines), `aeoCitationRunner.ts` (256), `aeoCompetitors.ts` (185), `aeoModelSettings.ts` (57).
  - Tests: `aeoCitationRunner.test.ts` (6), `aeoCompetitors.test.ts` (10).
- **AEO router, schema, seed, cron:**
  - `src/server/api/routers/aeo.ts` (597), `src/server/db/schema/aeo.ts` (90), `src/server/db/seeds/aeo-queries.ts` (125), `src/app/api/cron/aeo-citations/route.ts` (53).
- **Analytics:**
  - Schema: `src/server/db/schema/analytics.ts` (136), `gsc.ts` (61), `change-log.ts`, `ai-usage.ts` (33), `investor-reports.ts`.
  - Routers: `analytics.ts` (1289), `gsc.ts` (169), `changeLog.ts`, `investorReports.ts`.
  - Ingest: `src/app/api/analytics/event/route.ts` (324).
  - Client: `src/lib/analytics/beacon.ts`, `src/app/(shop)/components/AnalyticsBeacon.tsx`, `WebVitalsReporter.tsx`, `CookieConsent.tsx`.
  - Utils: `src/server/utils/classifySource.ts` (44 tests), `sessionEngagement.ts`, `deployment.ts`, `mapConcurrent.ts`, `reportableOrders.ts`.
  - Services: `orderAttribution.ts`, `contentAttributionRollup.ts` (15 tests), `gscIngest.ts` (16), `analyticsDigest.ts` (981 lines, 24 tests), `sitemapAudit.ts` (441, 14), `investorReport.ts` (plus template and types), `consent.ts`, `settings.ts`.
  - Libraries: `src/lib/analytics/aiReport.ts` (577, 9 tests), `trend.ts` (6), `webVitals.ts` (12).
- **Crons:** `src/app/api/cron/{aeo-citations, analytics-rollup, gsc-pull, analytics-digest, sitemap-audit}` (plus `refresh-conditions`, which is Traildek-specific trail conditions).
- **Admin UI** (`src/app/admin/analytics/`, 28 files, 5,197 lines):
  - Pages: `page.tsx`, `layout.tsx` (reports-access gate), `error.tsx`, `citation-queries/`, `annotations/`, `ad-spend/`, `reports/`, `report-preview/[reportId]/`.
  - `components/`: `AnalyticsDashboard.tsx` (1224), `AICitationCard.tsx` (407), `ShareOfVoice.tsx` (210), `EngineHealth.tsx`, `AeoEmptyState.tsx`, `SearchPerformance.tsx` (309), `CoreWebVitals.tsx`, `SitemapHealth.tsx`, `TrendWithAnnotations.tsx`, `AiReportButton.tsx`, `DataTable.tsx` (sortable, CSV/TSV export), `KpiCard.tsx`, `PrettyPercent.tsx`, `SourceBucketLabel.tsx`.
- **AEO-adjacent SEO surfaces** (the SEO-side reviewer covers these):
  - `src/app/robots.ts`: explicit allow rules for GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-Web, Google-Extended, PerplexityBot, CCBot, Applebot-Extended and Bytespider (:28-39).
  - `src/app/llms.txt/route.ts`, `src/app/llms-full.txt/route.ts`.

## 2. AEO: capability by capability

### A. Query set
- **Table:** `aeo_queries` (`schema/aeo.ts:26-46`).
  - Columns: id (cuid2), query, category enum `brand|niche|product`, is_active, notes, created_at, created_by.
  - Indexes on active and category.
- **Seed** (`seeds/aeo-queries.ts:22-103`): 15 hard-coded Traildek queries (5 brand, 5 niche, 5 product, each with a "why" note).
  - `seedAeoQueriesIfEmpty()` (:109) seeds lazily; it is called from the runner (:99) and from `listQueries`.
- **CRUD** (aeo router): `listQueries`, `addQuery` (:44, query 2–500 chars), `updateQuery`, `deleteQuery`.
  - Deleting a query cascades away all of its citation history (FK onDelete cascade at schema :60). The UI warns about this.

### B. Engines
All four live in `aeoEngines.ts`. Every call goes through `runQuery` (:535), which never throws: errors come back as `errorMessage`. Each call has a 30s `withTimeout` (:114) and one retry after 750ms, skipped for auth/4xx-looking errors (:124-143).

| Engine | How it's called | Sources / extras captured |
|---|---|---|
| ChatGPT | Raw fetch to the OpenAI Responses API with the `web_search` tool (:229-307). | `output_text` plus annotation URLs. Metadata keeps only `citationCount`; the URL list is not kept (:305). |
| Perplexity | Raw fetch to `/chat/completions`, temperature 0.2, system prompt "Cite sources with inline URLs" (:313-377). | Top-level `citations[]`. |
| Gemini | REST `generateContent?key=` with the `googleSearch` grounding tool (:383-459). Key is `GOOGLE_GENERATIVE_AI_API_KEY`, falling back to `GEMINI_API_KEY`. | `groundingChunks[].web.uri` (first 10) and `webSearchQueries`. |
| Claude | `@ai-sdk/anthropic` `tools.webSearch_20250305({maxUses:4})` via `generateText` (:465-522). | `result.sources` (first 10). |

- **Claude tool check:** `webSearch_20250305` does exist in installed `@ai-sdk/anthropic` 3.0.67 (verified in `node_modules`).
  - If the tool is missing, the code silently answers without search (:495-497).
- **Model override:** the `site_settings` row `aeo_engine_models` (`aeoModelSettings.ts:28-57`) can override any engine's model without a redeploy. A broken row falls back to the defaults.
- **Pricing table** (:92-105, "verified 2026-08-26", USD per million tokens):
  - gpt-4o $2.50 / $10
  - sonar $1 / $1 plus $0.005 per request
  - gemini-3.7-flash $0.75 / $3.75 (introductory through 2026-12-31)
  - claude-sonnet-4-6 $3 / $15
  - The table is keyed by engine and assumes the default model, so costs drift if a model is overridden (note at :25-26).
- **Engine configured check:** `isEngineConfigured` (:566).

### C. Citation detection
- `detectCitation` (:152-191) is a case-insensitive substring scan against the hard-coded `BRAND_PATTERNS` (:62-69: traildek, trail dek, trail-dek, traildek.com, …).
  - The snippet is 80 characters before and 160 after the first hit.
  - The URL is any traildek URL in the answer, otherwise the URL nearest the hit.
  - The `brandSlug` parameter is ignored (`void brandSlug`, :156).
- **Runner URL choice** (`aeoCitationRunner.ts:172-177`): it prefers a structured URL matching `/traildek/`, otherwise **the engine's first source URL**. That fallback applies whether or not the brand was cited.

### D. Sentiment
- `classifySentiment` (:198-223) calls `claude-haiku-4-5-20251001` with temperature 0 and a 15s timeout.
- It returns one word (favorable, neutral or negative). The prompt hard-codes "Traildek".
- It runs only when the brand was cited (runner :166) and falls back to neutral on any failure.

### E. Competitor share of voice
- **Config:** `site_settings` row `aeo_competitor_brands` holding `[{name, patterns[]}]`.
  - Parsed by `parseCompetitorBrands` (`aeoCompetitors.ts:55`); an invalid row falls back to the defaults.
  - Defaults are a placeholder: AllTrails, Gaia GPS, Hiking Project (:38-42).
- **Detection:** `detectCompetitorMentions` (:84) does a substring scan with no extra engine calls.
  - Results are stored in `ai_citation_log.metadata.competitorsCited` (runner, line marked "Phase 2.4").
- **Math:** `buildShareOfVoice` (:132).
  - Per category plus an overall row: our rate = brand-cited calls / non-error calls; competitor rate = mentions / non-error calls.
  - Every configured competitor is zero-filled.
  - Router `getShareOfVoice` (aeo.ts:439) does the SQL with `jsonb_array_elements_text`, guarded by `jsonb_typeof`.
- **Backfill:** `backfillCompetitorMentions` (aeo.ts:531, adminProcedure) pages through 500 rows at a time by id and updates 25 at a time. It is idempotent.
- **UI:** `ShareOfVoice.tsx` shows the table, flags when placeholder defaults are in effect, and has a confirm dialog for the backfill.
  - There is no per-engine split (deferred in the plan, line 68).

### F. Runner and scheduling
- `runCitationCheck` (`aeoCitationRunner.ts:91`) is shared by the cron and the "Run now" button.
- Steps:
  1. Seed if empty.
  2. Resolve models and competitors once per run.
  3. Skip engines without an API key (:117).
  4. Order queries per engine with never-answered or oldest-answered first, using `orderByLastChecked` (:76). Error rows don't count as answered.
  5. Run engines in parallel, 3 calls at a time per engine (`CALLS_PER_ENGINE`, :49, via `mapConcurrent`).
- **Deadline guard:** no call starts within 80s of the deadline (`CALL_HEADROOM_MS`, :56). Skipped queries are reported once per engine (:247).
- **Triggers:**
  - Cron: Saturday 14:00 UTC (`vercel.json`), `maxDuration` 300 with a 280s budget (`cron/aeo-citations/route.ts:22,45`), CRON_SECRET bearer auth (503 if the secret is unset, 401 if wrong).
  - Manual: tRPC `runCitationCheck` (aeo.ts:208) with a 5-minute budget. The tRPC route sets no `maxDuration`, so it runs on the platform default. INFERRED that the default is 300s on Fluid compute.
- **Sampling:** one sample per query, per engine, per week. There is no repeated sampling, no location or persona variation, and no deterministic seed.

### G. Cost controls and metering
- Each row stores `cost_usd`, which is token-based (plus Perplexity's per-request fee).
- **Not counted:**
  - The Haiku sentiment call.
  - Claude web-search fees, OpenAI web_search tool fees and Gemini grounding fees beyond the free tier. INFERRED that these vendor fees exist; they are not in the code.
  - Real cost therefore runs higher than recorded.
- **The monthly budget is never enforced.**
  - `aeo_monthly_budget_usd` (default $30, aeo.ts:27-28) has `getMonthlyBudget` / `setMonthlyBudget`.
  - The runner never reads it, and the UI never calls it. Grep finds only the router and one comment.
  - The UI's cost estimate is a hard-coded $1.50 per 60 calls (`CitationQueriesClient.tsx`, `ESTIMATED_COST_PER_RUN_USD`).
- AEO calls are not written to `ai_usage_log`.
- Timeouts use `Promise.race` without an AbortController, so a timed-out request keeps running and is still billed. A retry can double the cost (INFERRED).

### H. Engine health
- `getEngineStatus` (aeo.ts:144) returns, per engine: configured, model, and the last run (bucketed by hour) with calls, errors, error rate and `allFailed`.
- `EngineHealth.tsx` shows a red alert banner when a configured engine failed 100% of its last run, plus a per-engine strip. It is mounted on the dashboard and the citation page.

### I. Read APIs
- `getRecentRuns` (:216): grouped by hour; calls, citations, errors, cost, unique queries.
- `getCitationHeatmap` (:251): query × ISO-week grid counting distinct citing engines, with a snippet. **It does not filter `isActive` (:257-265), so inactive queries dilute "cited this week".**
- `getCitationStats` (:350): totals, rate, per engine, per sentiment, top 10 cited URLs (90-day default).
- `getCompetitorBrands`, `getShareOfVoice`.

### J. UI
- **`/admin/analytics/citation-queries`** (`CitationQueriesClient.tsx`, 608 lines) has three tabs:
  - Queries: add/edit/toggle/delete.
  - Run now: pre-flight (active queries, configured engines with a model tooltip, estimated cost), confirm dialog, last-run stats and error list.
  - History.
  - A stale banner still says "Vercel Pro upgrade pending".
- **Dashboard "AEO Intelligence" section:**
  - `AICitationCard`: 12-week heatmap (red 0 / yellow 1–2 / green 3–4 engines), this-week rate, per-engine bars, sentiment breakdown, top URLs.
  - `ShareOfVoice`.
- **Not built:** the planned drill-down to per-engine timelines and raw answers (SITE-REWORK §7.2.4). `rawAnswer` is stored but no UI or API ever returns it.
- **`AeoEmptyState.tsx`:** editorial "levers" card (structured content, JSON-LD, allow AI crawlers, authoritative answers, track citations). It appears when no AI-assistant referrers are found.

## 3. First-party analytics stack

### A. Ingest
- `POST /api/analytics/event` (route.ts):
  - Zod payload (:38-54).
  - Returns 204 for dev and preview deployments via `isNonProductionDeployment` (:264; `deployment.ts:11-16`).
  - Returns a silent 204 for malformed payloads or no consent.
  - Writes directly to the database. The Upstash queue was removed because no consumer ever drained it (header :19-24).
- **Sessions:** a session is the same anonId within a 30-minute inactivity window (:109, `getOrCreateSession` :132). The window is actually checked against `startedAt`, not last activity (INFERRED bug: long sessions split every 30 minutes).
- Country comes from `x-vercel-ip-country`.

### B. Client
- `beacon.ts`:
  - Prefers `sendBeacon`, falls back to `fetch` with `keepalive`.
  - Consent is read from the localStorage key `tdk_consent`.
  - A 1-year `tdk_anon_id` cookie is set only after consent.
  - UTMs come from the current URL only.
- `AnalyticsBeacon.tsx` tracks pageviews on route change and extracts deck/collection/trail/product slugs with regexes (:28-35).
- `WebVitalsReporter.tsx` sends LCP, CLS and INP (`web-vitals@6`) as `web_vital` events.
- Admin and auth routes are not tracked.

### C. Source classification
- `classifySource.ts:144` assigns one of 7 buckets: qr, paid, aiAssistant, organic, social, referral, direct. It runs once per session at start (first touch).
- **AI hosts** (:36-45): chatgpt.com, chat.openai.com, perplexity.ai, claude.ai, gemini.google.com, copilot.microsoft.com.
  - `"bing.com/copilot"` (:44) and `"brave.com/search"` (:71) are paths and can never match a hostname.
- **AI UTM sources** (:47-57): chatgpt, openai, perplexity, claude, …
  - INFERRED bug: `utm_source=chatgpt.com`, which ChatGPT appends to outbound links, is not in the set. Without a referrer those visits classify as **direct**.
- Exact-host matching misses google.co.uk, l.facebook.com variants and similar. `@adminigloo/analytics/src/sources.ts` says it fixed these.

### D. Engagement
- `isEngagedSession` (`sessionEngagement.ts`): GA4 rule (≥10s, or ≥2 pageviews, or a cart/checkout event).
- Its comment says "we test it", but no test file references it.

### E. Order attribution
- `resolveOrderAttribution` (`orderAttribution.ts:33`) finds the first-touch and last-touch session by anonId or userId and writes four columns on `orders`.
- `anonId` reaches it through Stripe metadata (commit `ebba92f`).
- **Bug:** `sessions.user_id` is never written (the only insert is route.ts:152, and neither update sets it). So userId attribution never matches, and `getMostEngagedUsers` always returns nothing.

### F. Content attribution rollup
- `contentAttributionRollup.ts` plus cron `analytics-rollup` (daily 00:10 UTC, `?date=` backfill).
- Writes `content_attribution_daily`: sessions landed, sessions that viewed the path in the chain, first-touch orders and revenue, and linear-attributed revenue across the anonId session chain. Delete-then-insert per day.
- `getRevenueAttributionByContent` merges rolled-up days with live data for the uncovered trailing day.

### G. Dashboard procedures
All in `routers/analytics.ts`, all `reportsProcedure`:
- **KPIs and trends:**
  - `getHeroKpis`: sessions, engaged, orders, revenue, AOV and QR scans, each with prior-period delta, year-over-year and a small-sample flag (<30).
  - `getDailyTrends`.
- **Unit economics:**
  - `getUnitEconomics`: CAC from manually entered ad spend, LTV (labelled 90d but actually average per customer in range), margin from `products.costPrice`, payback days.
- **Acquisition:**
  - `getTrafficSources`.
  - `getTopReferrers`: AI-assistant flag. The AI referral card only sees referrers in the overall top 20 that have a non-null referrer.
  - `getAIBotCrawlerHits` (:793): fetch-on-citation vs index-building tiers.
  - `getQrTraffic`: by `utm_content`; no `isBot` filter.
- **Content:** `getTopDecks`, `getTopCollections`, `getTopTrails` (all Traildek slugs).
- **Engagement:** `getEngagementBySource`, `getHourlyActivity`, `getDayOfWeekActivity`.
- **Audience:** `getMostActiveUsers` (from `users.orderCount`), `getMostEngagedUsers` (always empty, see 3E).
- **Raw data, health, settings:**
  - `getAdvancedRawTables`: paths, referrers, countries.
  - `getWebVitals` (:1037).
  - `getSitemapAudit` (:1112).
  - `getAdSpend`; `setAdSpend` (superAdmin).
  - `getCurrentSession` is a **public** procedure keyed by anonId.
- Range presets are 7d, 30d, 90d and custom, built in browser-local time while the server buckets by UTC (INFERRED off-by-day risk).
- A "business context" textarea is persisted in localStorage.

### H. Core Web Vitals
- `getWebVitals` computes p75 with `PERCENTILE_CONT(0.75)` over `session_events` metadata, plus a daily trend and an optional per-path split.
- Thresholds live in `src/lib/analytics/webVitals.ts`. The UI is `CoreWebVitals.tsx`.
- Data only comes from visitors who gave consent.

### I. Google Search Console
- `gscIngest.ts` signs a service-account RS256 JWT with `node:crypto`, so there are zero new dependencies (:112-133).
- Calls `searchAnalytics.query`:
  - dimensions `[page, query]`, `type: "web"`, `dataState: "all"` (:243).
  - 25k rows per page, up to 8 pages (:35).
- Cron `gsc-pull` (daily 06:00 UTC, `maxDuration` 120) pulls yesterday. `?date=` backfills.
  - Returns 200 with `configured: false` when the env vars are unset.
  - Finalized-data re-pulls are manual only.
- **Router** (`routers/gsc.ts`): `getStatus`, `getTotalsTrend`, `getTopQueries`, `getTopPages`. CTR and position are impressions-weighted (:40-41).
- **UI:** `SearchPerformance.tsx`.
- **INFERRED limitation:** including the query dimension drops anonymized queries, so totals undercount compared with the GSC UI.
- **Missing:** device, country and search-appearance dimensions; the URL Inspection and Sitemaps APIs; Bing Webmaster.

### J. Sitemap audit
- `sitemapAudit.ts` plus cron (Monday 07:00 UTC, `maxDuration` 300).
- Fetches the live sitemap, following one level of sitemap index; concurrency 5; 10s timeout; 500-URL cap (:41); `redirect: manual` (:239).
- **Checks per URL:** 200 status, title, meta description, canonical points to itself (normalized), each JSON-LD block parses, no meta-robots noindex.
  - It does not check the X-Robots-Tag header.
  - It does not validate JSON-LD schema fields (INFERRED from grep).
- **Results:** one `error_logs` row per failing URL (type `sitemap_audit`; first-seen date kept; auto-resolved when fixed). Run summary goes to the `sitemap_audit_last_run` setting.
- **UI:** `SitemapHealth.tsx`.

### K. Annotations
- Table `change_log`: date, label, kind `deploy|content|campaign|note`, created_by, created_at.
- `changeLog` router has list, create and delete (adminProcedure). There is no update, and nothing creates deploy annotations automatically.
- Shown as overlays on the Daily Sessions and Daily Engaged charts (`TrendWithAnnotations.tsx`, accessible flag markers plus a list under the chart). Also read by the digest, the AI report and the investor report.

### L. Weekly digest
- `analyticsDigest.ts` plus cron (Monday 13:00 UTC) sends through Resend.
- **Recipients** (:928): the `analytics_digest_recipients` setting, otherwise every super_admin and cs_leader.
- **Content:**
  - KPIs with week-over-week change.
  - Top 7 sources.
  - AEO citation rate this week vs prior, plus an engine table that marks dead engines.
  - GSC clicks and impressions.
  - The week's annotations.
  - Sitemap health.
- **Anomaly checks** (`computeAnomalies`, :154):
  - Sessions down more than 30% (only if prior week ≥10).
  - An engine at 100% errors.
  - Citation rate down more than 30% (only if ≥4 calls).
  - Cron gaps: AEO more than 9 days, rollup or GSC more than 3 days.
  - Zero-session complete days.
  - Open sitemap failures.
  - The alarm count goes in the subject line.
- The citation-rate denominator here includes error rows (`fetchAeoWeek`, :710), unlike share of voice.
- Subject line and brand colours are hard-coded to Traildek (:389, colour constants).

### M. Reports
- **AI-ready report:** `AiReportButton` plus `buildAiReport` turns every dashboard section into markdown for pasting into an LLM.
- **Investor PDF:** `investorReport.ts`:
  - Gathers the analytics numbers.
  - Writes a summary with Claude Sonnet 4.6 (prompt-cached brand voice).
  - Renders a PDF with Puppeteer and `@sparticuz/chromium`.
  - Uploads it with `@vercel/blob` and emails the generating user.
  - Gated by superAdminProcedure.

### N. Access control
- `reportsProcedure` = admin plus `canViewReports` (`trpc.ts:142`). The server layout redirects admins without that permission.
- **Inconsistency:** spending writes (`runCitationCheck`, query CRUD, `setMonthlyBudget`) only need reports access, while the backfill needs admin.

## 4. Data model

| Table | Location / notes |
|---|---|
| `aeo_queries` | `schema/aeo.ts:26` |
| `ai_citation_log` | `schema/aeo.ts:53`. Columns: query_id, engine enum, ran_at, cited_brand, cited_url, cited_snippet, raw_answer, sentiment, cost_usd, metadata jsonb, error_message. Four indexes. |
| `sessions` | `analytics.ts:28`. Holds UTMs, source_bucket, is_bot, bot_name, bot_verified, engagement flags, country. |
| `page_views` | `analytics.ts:80` |
| `session_events` | `analytics.ts:101` |
| `content_attribution_daily` | `analytics.ts:121` |
| `gsc_daily` | `gsc.ts:29`, unique on (date, page, query) |
| `change_log` | Annotations |
| `investor_reports` | Investor PDFs |
| `ai_usage_log` | AI authoring only; not used by AEO |
| `error_logs` | Holds sitemap-audit failures |
| `site_settings` | Rows: `aeo_engine_models`, `aeo_competitor_brands`, `aeo_monthly_budget_usd`, `analytics_ad_spend`, `sitemap_audit_last_run`, `analytics_digest_recipients` |
| `orders` | Attribution columns first_touch_session_id / last_touch_session_id / first_touch_source / last_touch_source |

## 5. Environment variables (`src/env.ts`, all optional)

- **AEO engines:** `OPENAI_API_KEY`, `PERPLEXITY_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` (fallback `GEMINI_API_KEY`, read raw and not in `env.ts`), `ANTHROPIC_API_KEY` (engine, sentiment, investor report).
- **Crons:** `CRON_SECRET` (every cron returns 503 without it).
- **GSC:** `GSC_SERVICE_ACCOUNT_EMAIL`, `GSC_PRIVATE_KEY` (literal `\n` sequences converted to newlines), `GSC_PROPERTY`.
- **Email and links:** `RESEND_API_KEY`, `NEXT_PUBLIC_APP_URL` (required).
- **Deployment detection:** `VERCEL_ENV`, `NODE_ENV`.
- **Blob storage:** the Vercel Blob token. INFERRED that it is `BLOB_READ_WRITE_TOKEN`; it is not declared in `env.ts`.

## 6. Tests

**Covered:**

| Test file | Tests |
|---|---|
| `aeoCitationRunner.test.ts` | 6 (budget, key skip, parallelism, ordering, deadline) |
| `aeoCompetitors.test.ts` | 10 |
| `analyticsDigest.test.ts` | 24 |
| `gscIngest.test.ts` | 16 |
| `contentAttributionRollup.test.ts` | 15 |
| `sitemapAudit.test.ts` | 14 |
| `webVitals.test.ts` | 12 |
| `trend.test.ts` | 6 |
| `aiReport.test.ts` | 9 |
| `classifySource.test.ts` | 44 |
| `reportsProcedure.test.ts`, `admin-permission.test.ts` | RBAC |

**Not covered:**
- `detectCitation`, `classifySentiment`, and all four engine adapters' response parsing.
- The aeo router SQL (share of voice, heatmap, engine status).
- The event ingest route and `detectBot`.
- `isEngagedSession`, the beacon, and `orderAttribution`.
- Every suite mocks `@/server/db`, so the SQL itself only runs in production (plan line 75).
- There is no e2e directory in trailcards.

## 7. Known bugs and TODOs (verified unless marked)

1. The AI-crawler panel can never populate (§0.4). `bot_verified` is never written; the plan's "VERIFY IN PROD" list (line 98) admits this.
2. `sessions.user_id` is never written (§3E).
3. The monthly budget is never enforced; recorded cost leaves out sentiment and search-tool fees (§2G).
4. When the brand is mentioned but not linked, `cited_url` gets the engine's first source URL (often a competitor's) and is counted under "top cited URLs" (runner :172-177; stats filter on cited_brand, aeo.ts:401-410).
5. **A citation is a brand mention in the text only.** If our domain appears in the engine's source list but the name isn't said, it counts as not cited.
   - ChatGPT's source URLs aren't kept (:305).
   - INFERRED: Gemini grounding URIs are Google redirect URLs, so the `/traildek/` URL test never matches them.
6. Substring matching with no word boundaries. The default competitor pattern `"all trails"` matches ordinary prose ("not all trails…"), inflating AllTrails' share of voice. `@adminigloo/aeo` already uses word-bounded matching (`scaffold/packages/aeo/src/detect.ts:84-87`).
7. The heatmap includes inactive queries.
8. The digest's citation rate counts errored calls in the denominator.
9. Unregistered and dead entries in the AI/search host lists; `utm_source=chatgpt.com` is missed (INFERRED).
10. Timeouts don't abort the underlying request (possible double billing on retry).
11. The citation page still shows a stale "Vercel Pro upgrade pending" banner.
12. Owner verification is still open (plan lines 88-98): crons actually firing, GSC env vars, migrations `0013`–`0016` "NOT applied" as of the plan, the competitor list, the engine keys and the digest recipients.

## 8. Generic vs Traildek-specific

- **Generic, portable as-is:** engine adapters (except the hard-coded brand); model and competitor settings pattern; runner (ordering, parallelism, deadline); share-of-voice math; engine health; GSC ingest; sitemap audit; digest anomaly engine; web vitals; annotations and overlays; CSV/TSV table; AI-ready report pattern; cron pattern; reports RBAC.
- **Traildek-specific:**
  - `BRAND_PATTERNS` (code constant), the sentiment prompt, the seed queries, the placeholder competitors.
  - The `qr` source bucket, the deck/trail/collection slug columns and regexes, top decks/trails/collections, the `/trails`-style template filters.
  - Digest branding and colours, the `tdk_*` cookie names, Stripe attribution wiring, ad-spend unit economics tied to `products.costPrice`, investor PDF branding.
- Single-site only: no tenant id anywhere.

## 9. What a complete AEO product needs

**Trailcards has:**
- 4-engine live-search polling.
- Configurable models.
- Per-call cost recording.
- Sentiment.
- Competitor share of voice with backfill.
- A query × week heatmap.
- Per-engine and per-sentiment breakdowns.
- Dead-engine alarms in the UI and email.
- Fair rotation (oldest-checked first) under a deadline.
- Manual run plus cron.
- AI-referral traffic bucketing.
- A robots.txt AI-crawler allow-list.
- `llms.txt` / `llms-full.txt`.
- GSC ingest.
- Sitemap and on-page health audit.
- Core Web Vitals field data.
- Annotations on trend charts.
- Weekly digest with anomalies.
- AI-pasteable report.
- Investor PDF.

**Trailcards lacks:**
- Working crawler logging and verification (`@adminigloo/analytics` has it).
- Detection that separates a domain/URL citation from a brand mention.
- Word-bounded matching.
- Configurable own brand and aliases.
- Multi-tenant.
- An enforced budget and complete cost metering.
- A raw-answer drill-down and per-engine timeline.
- Repeated sampling and confidence intervals.
- Rank or position of the brand within list answers.
- Which of our pages get cited, trended over time.
- Prompt or topic discovery (suggesting queries from GSC data).
- Location or persona variants.
- Engines beyond the four (Copilot, AI Overviews, Grok, Meta AI, DeepSeek).
- Alerts on citation wins and losses per query.
- An annotation linking each query to a content change, i.e. measuring whether a change caused a citation.
- IndexNow / Bing Webmaster.
- A citation-rate chart with overlays (the component exists; it isn't wired for citations).

**Package gap:** `@adminigloo/aeo` 0.1.1 is much thinner than trailcards (234 lines total).
- It has: queries, checks, word-bounded detection, and an injected `ask()`.
- It lacks:
  - engine adapters, sentiment, competitors and share of voice, cost tracking and engine health;
  - the runner's scheduling and deadline, the cron route, and any UI;
  - storage of full raw answers (it stores a snippet only).

Bringing the trailcards feature set into the package, and then merging Riddler Go's existing port onto it under non-colliding table names, is the work this request actually needs.