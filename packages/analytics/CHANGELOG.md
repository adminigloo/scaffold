# @adminigloo/analytics

## 0.2.0

### Minor Changes

- Staff, testers, automation and named people no longer count. Polluted numbers can be cleaned through `@adminigloo/audience`. The package also gains table prefixes, AI traffic by engine and configurable limits.

  **An instance instead of module globals**
  - `createAnalytics({ db, tables?, audience?, limits?, license?, excludeBots?, crawlerVerifier?, onError? })` returns the whole API without the `db` argument. That covers the handler, conversions, the crawler log, maintenance, every report, `reclassifySources` and `getExcludedBreakdown`.
  - Each instance has its own caches: the daily salts, "tracking started" and an optional crawler-range verifier. 0.1 kept the first two at module level, so two table sets in one process shared them. That was also why a rolled-back test needed a fresh tenant.
  - `defineAnalyticsTables({ prefix })` builds every table, index, primary-key and foreign-key name from a prefix.
  - The default prefix, `analytics_`, reproduces 0.1's names exactly. A test pins every name against the founder site's migration 0025, and drizzle-kit 0.31 generates only the three column additions below.
  - Under a long prefix (`aig_analytics_`), a foreign-key name Drizzle would derive past Postgres' 63-character limit gets a short form (`aig_analytics_page_views_session_fk`).
  - `audienceSessionsSource({ tenantId, tables })` is the sessions table as `createAudience({ sessions })` should count it. Under a prefix, pass `tables`: without it the source names the default `analytics_sessions`.

  **The internal audience, out of every report**
  - With `audience` (the instance `createAudience(...)` returns, or a function from tenant id to one), every read of sessions, page views and events applies the audience's `NOT EXISTS` predicate.
    - The session reports apply it in `sessionWindow`.
    - Top pages, clicks, event visits and Web Vitals apply it through an `EXISTS` on the visit, using the visit's visitor key, start time and id.
    - So do the AI traffic report and the public snapshot.
    - Analytics rows are never rewritten. Adding a rule cleans history at once, and removing it restores the numbers exactly.
  - `includeInternal: true` on a `ReportQuery` counts everyone, for that call only. Nothing stores it.
  - `getPublicSnapshot` always leaves the internal audience out, whatever the caller passes.
  - Without an audience nothing is filtered, so reports return 0.1's numbers.
  - `getExcludedBreakdown({ tenantId, from, to })` asks the audience for "Excluded: N (by reason)" over this instance's sessions and tenant. It returns exactly the difference between a report with and without `includeInternal`, or null without an audience.
  - `getPipelineHealth` stays unfiltered on purpose: it checks liveness.
  - The audience is held to one tenant. When it says it belongs to another tenant (`audience.tenantId`), a report throws `AnalyticsError("invalid_config")` rather than apply marks that could never match. The founder's site has `"site"` in production and `"site:local"` locally.
  - Three guard layers:
    - per file, `@adminigloo/audience/testing`'s `assertCountedReads` over the package's own source;
    - per function, over every non-exempt source file, catching reads through `ctx.t`, the 0.1 named exports or a destructuring;
    - per SQL statement, every statement every report sends under two prefixes. Each read of sessions must carry visitor marks, session marks and the "only from" date, and each read of page views or events a tenant-scoped counted `EXISTS`.

  **A signed-out device, about 48 hours back: `markVisitorInternal`**
  - On the cookieless key a device's key changes daily, and the audience's `markVisitor` refuses rotating ids. So a device nobody signed in on that day could not be left out at all.
  - `analytics.markVisitorInternal({ tenantId, ip, userAgent, by?, timeZone?, at? })` marks the device's keys for today and yesterday through the audience's `mark` (reason `device`). Its signed-out visits of about the last 48 hours, and the rest of today, stop counting at once.
  - It returns `{ visitorIds, subjectsChanged }`, is idempotent, and is undone with the audience's `unmark`.
  - It needs an audience (`invalid_config` otherwise). Call it from a staff-only "These are my visits" button on that device.
  - The README now says plainly what a mark on a daily key covers. It covers everyone sharing that IP and user agent that day. It does not cover the device's signed-out visits on other days. A device never signed in to is left out only by a network or user-agent rule, or dropped by the beacon's `?analytics=off`.

  **Intake: the `onSession` hook**
  - The handler takes `onSession(visit)`, called once per recorded page view. The visit carries `sessionId`, `visitorId` (the visit's stored visitor key), `isNewSession`, `path`, `host`, `userAgent`, `headers`, `req` and `ip`. That is everything `audience.observe(...)` needs.
  - The IP is passed in memory only. Analytics never stores it.
  - The hook can never fail or hold a beacon:
    - It is awaited for at most `onSessionTimeoutMs` (default 3000, `DEFAULT_ON_SESSION_TIMEOUT_MS`). A hung hook is reported and the request answers 204 with the page view recorded. A failure after the deadline is reported too.
    - An error goes to `onError`. A reporter that throws is itself ignored, so the request still answers 204.
    - A failed verdict write is reported as `onSession:write`, not as a lost beacon.
  - Its answer, a reason or `{ reason, actorKey }`, is recorded on the session; the first non-null answer wins. A session whose answer is already recorded is not written again, so a staff member's every page view no longer costs a no-op `UPDATE`.
  - What it returns is checked before it is stored:
    - a reason must be one word (`[A-Za-z0-9_.:-]`, at most 64);
    - an actor key must look like a keyed digest (40 to 128 characters of hex or base64url, like the audience's `userKey`). A Clerk id, a UUID or an email is refused and reported (`onSession:actorKey`) without echoing it;
    - an actor key is never stored for a request carrying GPC or DNT (`honorPrivacySignals: false`).
  - Not called for dropped requests, events or leaves.
  - `recordConversion` on the instance returns `{ sessionId, visitorId }` or null, ready for `audience.classifyActor`. It takes the request's `headers` (or `privacyOptOut`). An opted-out request records nothing and returns null, as the beacon drops it (`honorPrivacySignals: false` to count it anyway). The 0.1 `recordConversion(db, …)` takes the same fields.

  **The beacon body is capped in bytes.** A declared `Content-Length` over `maxBodyBytes` is dropped without reading a byte, and a longer stream stops being read at the cap. 0.1 read the whole body and compared its length in characters.

  **Sessions gain three nullable columns.** Regenerate your migration. drizzle-kit produces:

  ```sql
  ALTER TABLE "analytics_sessions" ADD COLUMN "internal_reason" text;
  ALTER TABLE "analytics_sessions" ADD COLUMN "actor_key" text;
  ALTER TABLE "analytics_sessions" ADD COLUMN "classifier_version" integer;
  ```

  - `internal_reason` is the intake verdict, kept as a record and never used as a filter.
  - `actor_key` is written only when your hook returns one, and nothing in 0.2 reads it.
  - `classifier_version` is the source classifier that bucketed the session: 2 from now on, null for 0.1 rows.

  **AI assistants by name**
  - `aiEngineOf(referrer | utm | { referrerHost, utmSource })` returns `chatgpt`, `perplexity`, `claude`, `gemini`, `copilot`, `you`, `phind`, `poe`, `meta`, `mistral`, `deepseek`, `grok`, `duckai`, `qwen`, `kimi`, `pi`, or null.
  - It matches hostnames, Android app packages and exact utm sources (`utm_source=chatgpt.com`). It never reads a path.
  - `AI_ENGINES` and `AI_ENGINE_LABELS` are exported. `AI_ASSISTANT_DOMAINS` and `AI_ASSISTANT_UTM_SOURCES` are now derived from `AI_ENGINES`.
    - **Type change:** both are readonly arrays (0.1: fixed tuples). Their element type is still the literal union (`AiAssistantDomain`, `AiAssistantUtmSource`), so `(typeof AI_ASSISTANT_DOMAINS)[number]` keeps working.
    - Code that relied on a tuple's length or positions does not compile.
  - New AI-assistant sources:
    - hosts: Microsoft 365 Copilot (`copilot.cloud.microsoft`), AI Studio, NotebookLM, Duck.ai, Qwen, Kimi and Pi
    - Android apps: Claude, Perplexity, Gemini and Copilot
    - utm sources: `perplexity.ai`, `claude.ai`, `gemini.google.com` and `copilot.microsoft.com`
  - **Two hosts narrowed.** Every subdomain of a listed host matches, so 0.1 counted OpenAI's forum, help centre and API platform as ChatGPT, and DeepSeek's developer pages as DeepSeek.
    - `openai.com` is now only `chatgpt.com` and `chat.openai.com`.
    - `deepseek.com` is now `chat.deepseek.com`.
    - `m365.cloud.microsoft` is deliberately not listed. It is the Microsoft 365 app hub, where Copilot Chat is only a path, and the path is never read.
  - These changes make this classifier version 2 (`SOURCE_CLASSIFIER_VERSION`).
  - `getAiAssistantTraffic(query)` reports visits, engaged rate, conversions and landing pages per engine. Each page sits beside the live fetches of that engine's assistant bot (ChatGPT-User, Claude-User and others).
    - Fetches are User-Agent claims. `assistantFetchesVerified` (per engine and per page) and `verifiedHits` (per bot) count those inside the operator's published ranges.
  - `reclassifySources({ tenantId, from?, to? }, { force?, dryRun?, batchSize?, maxBatches? })` re-runs the classifier over stored sessions below the current version (`force`: up to it). It never touches a session a newer classifier stored. It is batched by id and idempotent, and reports each move ("referral → aiAssistant: 12").

  **The site's own SEO audit**
  - `adminigloo-seo-reports` was already never a visitor: it is a crawler, so its beacon is dropped.
  - Its crawler rows are now left out of the crawler reports (bot list, kinds, top paths, AI reads and coverage, the trend's crawler line) unless `includeInternal`. The public window never shows them.
  - The rows are still recorded.
  - `excludeBots` replaces the list. `SEO_AUDIT_BOT_NAME` and `DEFAULT_EXCLUDED_BOTS` are exported.

  **Limits are configuration**
  - `limits: { maxHitsPerNetworkHour, maxSessionsPerNetworkHour, maxPageViewsPerSession, maxDurationDeltaMs, maxBodyBytes, maxUtmLength, maxLabelLength, crawlerBucketMs, retentionDays }`. Each defaults to 0.1's value (`DEFAULT_LIMITS`).
  - A limit that is not a positive whole number, or one the package does not know, throws `AnalyticsError("invalid_config")`.
  - `runMaintenance({ crawlersOnly: true })` serves an install that migrated only the crawler half (`crawlerHits` and `sites`).

  **License gate**
  - `license: { key, publicKey, mode }` checks feature `"analytics"` with `@adminigloo/license`. It is a new dependency, already published, and the founder's site already installs it.
  - It guards the reports (every `get…` but `getPipelineHealth`, and `reclassifySources`), which throw `AnalyticsError("unlicensed")` (402). That includes `getPublicSnapshot`: a public page must catch `isAnalyticsError`.
  - It never guards the ingest, the crawler log, conversions, maintenance, `markVisitorInternal`, annotations or the pipeline health. A lapsed license loses no visit, retention keeps deleting, and the health strip still shows data arriving.
  - Mode `"off"` (the default) never denies. `"warn"` never denies, and tells `onError` once per instance (`where: "license"`) that the license is not valid.

  **Packaging**
  - `require` resolves to the CommonJS types (`.d.cts`) and `import` to the ESM types (`.d.ts`). 0.1 gave CommonJS consumers the ESM types.
  - `@adminigloo/audience ^0.1.0` is an optional peer dependency (never a dependency).
  - The audience's shape (`AnalyticsAudience`) uses property syntax, so a mismatched audience release fails to compile.
  - `onError` defaults to `console.warn` at most once a minute for the same failure. A deploy with a broken database logs a line a minute, not one per beacon.

  **Compatibility (read before upgrading)**
  - **The 0.1 functions still work and are deprecated.** `createAnalyticsHandler(options)`, `recordConversion(db, …)` (still a boolean), `recordCrawlerHit`, `runAnalyticsMaintenance`, `resolveVisitorKeys` and every `get…(db, …)` are thin wrappers over a default instance per `db` object. That instance has the 0.1 tables, the default limits, no audience and no license.
  - The wrappers and the `MAX_*` / `CRAWLER_BUCKET_MS` constants (now `DEFAULT_LIMITS`) will be removed in 1.0. A test makes the founder site's 0.1 calls, in the same shapes, against 0.2.
  - **The wrappers never see an instance you build.** In an app with `createAnalytics({ db, audience, license })`, `getOverview(db, q)` still counts staff and is never gated. Move every call to the instance in the change that wires the audience.
  - Behaviour changes for 0.1 callers:
    - The SEO audit bot leaves the crawler reports.
    - New sessions record `classifier_version`, and the new AI hosts bucket as "AI assistants" for new visits. `openai.com` subdomains other than `chat.openai.com`, and `deepseek.com` other than `chat.deepseek.com`, become "Referral". Run `reclassifySources` once to move history.
    - A failure the beacon swallows is now passed to `onError` (default `console.warn`, once a minute per failure) instead of vanishing.
    - A beacon body is capped in bytes, not characters.
    - Caches are per `db` object, not per process.
    - `AI_ASSISTANT_DOMAINS` / `AI_ASSISTANT_UTM_SOURCES` are readonly arrays of the literal union, not tuples, without `"openai.com"` and `"deepseek.com"`.
  - `PipelineHealth` moved to its own module (the type is still exported from the root).
  - The README is new: install recipes, what is not included, and exactly what is stored.

## 0.1.0

### Minor Changes

- First release: first-party, cookieless traffic analytics for an app's own site, kept in the app's own Postgres.
  - A beacon (`./client`) and its endpoint: page views, clicks, outbound links, conversions, Web Vitals and foreground time.
    - The endpoint always answers 204. It throttles per network in Postgres and honours Global Privacy Control and Do Not Track.
    - It stores no IP, user agent, cookie or query string.
    - The visitor key is an HMAC under a daily salt that is deleted the day after next.
  - Attribution: one source bucket per visit (offline, paid, email, AI assistant, search, social, referral, direct), UTM tags, and which ad click id was present, never its value.
  - The crawler log (`./crawlers`, `recordCrawlerHit`): AI assistants, AI search, AI training, search, link previews and SEO tools, by user agent, optionally verified against the operators' published IP ranges.
  - Reports:
    - overview with honest comparisons
    - daily trend
    - sources, referrers and campaigns
    - device, browser and country breakdowns
    - engagement by source and an activity heatmap
    - top and landing pages, clicks and event funnels
    - Web Vitals p75 per page load
    - crawlers, AI reads and AI coverage
    - pipeline health and annotations
    - a public snapshot safe for a homepage
  - `./dashboard`: the report components.
  - Daily maintenance: salts, throttle windows, 13-month retention.
