**Riddler Go SEO/AEO inventory (2026-10-08, branch `staging`, code also present on `main`)**

The founder's belief is wrong. Riddler Go already has a large SEO + AEO + analytics suite. It is a port of trailcards, and in places it goes beyond trailcards. The real problems are three:
- **Operationally dead in production:** `CRON_SECRET` is not set on Vercel, so every SEO/AEO cron returns 503. I checked this live.
- **Credentials missing:** only 1 of 4 AEO engine keys is set, and none of the 3 Search Console vars.
- **Content and technical gaps,** listed in section 8.

The `@adminigloo/aeo` 0.1.1 package is less capable than what Riddler Go already runs in-repo.

---

### 0. Plan status vs code
- `docs/plans/INDEX.md:27`: Section 12 is marked done. `INDEX.md:36`: Section 21 is in testing. `INDEX.md:37`: Section 22 is in testing (22.a–h and 22.j shipped 2026-08-26; 22.i held).
- `12-seo-and-metadata-mvp/PLAN.md` is out of date. Its front-matter says `status: draft` (line 5), and every phase checkbox 12.a–12.n is unchecked (lines 82–232), even though the code exists. Decision D15 is still open (line 72). Trust the code, not the checkboxes.
- `22-.../PLAN.md`: all phases are checked except 22.i, A/B experiments (lines 146–148), which the owner held under D2 (line 51).
- `22-.../PLAYBOOK.md` already exists. It is a portable C1–C12 spec for standing this suite up in any project, with file maps for both Riddler Go and trailcards. It is directly reusable for package work.

### 1. Technical SEO

| Capability | Status | Refs |
|---|---|---|
| robots.txt, driven by an allowlist | BUILT, live | `app/robots.ts:14-46`; `lib/seo/marketing-paths.ts:21-34`. Off production it returns `Disallow: /` (`robots.ts:29-31`, `env.ts:71,85-91`, `PRODUCTION_ORIGIN = https://riddlergo.com`). |
| AI bots named in robots | BUILT, live | 8 user agents at `marketing-paths.ts:37-46`: GPTBot, ChatGPT-User, CCBot, ClaudeBot, Claude-Web, PerplexityBot, Google-Extended, Applebot-Extended. Live robots.txt has 9 groups plus `Host:` and `Sitemap:` lines. |
| Noindex for private routes, header layer | BUILT, live | `proxy.ts:28-33,56-58` sets `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet` for `NOINDEX_PREFIXES` (`marketing-paths.ts:49-92`). Confirmed live on /play, /admin, /e, /event-builder, /dashboard. |
| Noindex for private routes, meta layer | BUILT | Layout metadata in `(app)/layout.tsx:16`, `play/layout.tsx:8`, `admin/layout.tsx:9`, `event-builder/layout.tsx:29`, `(app)/settings/layout.tsx:6`, plus per-page `robots:{index:false}` on about 40 pages. |
| Noindex regression test | BUILT | `e2e/seo/noindex-regression.spec.ts` |
| sitemap.xml | BUILT, live | `app/sitemap.ts:18-81`: marketing paths + platform templates + `is_publicly_listed` events (column-scoped select), empty off production. Live it has 13 URLs: 7 static + 6 `/templates/*`, and 0 events. |
| Canonicals | PARTIAL | Present on /, /how-it-works, /pricing, /templates, /templates/[slug], /use-cases/[slug], /privacy, event pages. Missing on /join (live check shows no canonical and the default title/description). |
| Title template | BUILT, but misused | `app/layout.tsx:62-86` sets `"%s \| Riddler Go"`. Four pages already end their titles in "— Riddler Go", so the suffix doubles live: "Pricing — Riddler Go \| Riddler Go", and the same on /templates, /templates/[slug] and /use-cases/[slug] (`pricing/page.tsx:47`, `templates/page.tsx:27`, `templates/[slug]/page.tsx:31`, `use-cases/[slug]/page.tsx:30`). |
| OG/Twitter metadata | PARTIAL | Root defaults in `layout.tsx:62-86`. /pricing and /how-it-works set their own `openGraph`, which drops the inherited image: live, they have no `og:image`, `twitter:image`, `og:site_name` or `og:locale`. |
| Dynamic OG images (`next/og`) | PARTIAL | Root `app/opengraph-image.tsx` (live: 200, PNG, 51 KB); per-event `app/[orgSlug]/[eventSlug]/opengraph-image.tsx`; result-share `app/r/[participantRowId]/opengraph-image.tsx`. No per-page OG for pricing, how-it-works, templates or use-cases. |
| Icons | BUILT | `app/icon.png`, `apple-icon.png`, `favicon.ico` |
| Web manifest | MISSING | /manifest.webmanifest and /manifest.json both 404 live |
| Slug-history redirect for renamed events | PARTIAL | `app/[orgSlug]/[eventSlug]/page.tsx:100-138,180` looks up `slug_history`. It uses `redirect()`, which sends a temporary 307, not a permanent 301/308. The planned 5-minute Redis cache was not built. Not wired for template or use-case slugs. |
| Public event landing pages | PARTIAL | The route, `eventSchema`, breadcrumb and OG are all built. Nothing in app/components/lib writes `isPubliclyListed` (grep found reads only), so no host can list an event. Decision D12.1 is unresolved, and the live sitemap has 0 events. |
| Org landing page `/{orgSlug}` | MISSING | `app/[orgSlug]` contains only `[eventSlug]`. The event JSON-LD organizer URL and breadcrumb (`page.tsx:183,201-207`) point at it, so they link to a 404 (inferred). |
| Use-case pages | BUILT but not in sitemap | `app/use-cases/[slug]/page.tsx` is live with 6 slugs (birthday, celebration, conventions, corporate, education, showers). They are absent from `sitemap.ts` and `MARKETING_PATHS`. They are crawlable because no rule disallows them. |
| Template SEO pages | PARTIAL | `app/templates/[slug]/page.tsx` is in the sitemap, but has no JSON-LD beyond Organization and no own OG image. |
| www → apex redirect | MISSING | `https://www.riddlergo.com/` returns 200 with a full duplicate site and the full-allow robots.txt. The canonical tag points at the apex, which mitigates it. http → https is a 308 and works. |
| Staging protection | PARTIAL (inferred) | Off production, robots says `Disallow: /` and the sitemap is empty, but marketing pages carry no noindex header or meta. |

### 2. Structured data (JSON-LD)
- Renderer: `components/seo/JsonLd.tsx:11-18`. Builders: `components/seo/schemas.ts`, with a test in `schemas.test.ts`.
- **Organization** (`schemas.ts:10-28`): rendered on every page from `app/layout.tsx:96`. It has `@id`, logo PNG and contactPoint. It has no `sameAs`, because every social link in `components/marketing/footer.tsx:23-28` is `null`.
- **SoftwareApplication** (`schemas.ts:30-47`): on / only (`page.tsx:71`), price "0". It has no `aggregateRating` or `review`; I believe Google requires one of these for the software-app rich result (inferred). The Section 25 `reviews` table already exists and could feed it.
- **FAQPage**: on / (`page.tsx:72`), 8 Q&As, single-sourced from `lib/marketing/faq.ts`. There is no standalone `/faq` URL; the footer links `/#faq`.
- **HowTo**: on / (`page.tsx:73-80`) and /how-it-works (`how-it-works/page.tsx:43-49`).
- **Product + Offer**: /pricing emits 18 Product blocks (`pricing/page.tsx:256,262-282`). Names repeat between monthly and yearly, and none has brand or image.
- **Event + BreadcrumbList**: on public event pages only (`[eventSlug]/page.tsx:190-207`).
- **Not built:**
  - WebSite (site name, SearchAction)
  - BreadcrumbList on marketing pages (planned site-wide, built on event pages only)
  - ItemList, CollectionPage or WebPage on /templates and /use-cases
  - Any schema on /templates/[slug] and /use-cases/[slug]
  - Article/BlogPosting (there is no blog)
  - VideoObject
  - Review/AggregateRating

  Live parse of /, /pricing, /how-it-works, /templates, /templates/birthday-party-scavenger-hunt, /use-cases/birthday, /join and /privacy found every block valid JSON.

### 3. AEO surface
- **llms.txt** (BUILT, live): `app/llms.txt/route.ts:13-24`, content from `lib/seo/llms-content.ts:29-47`. Puzzle-type count and list come from the registry. It links only Home, /join, /privacy and /terms. It is **missing** /pricing, /how-it-works, /templates, the template slugs and /use-cases.
- **llms-full.txt** (BUILT, live, 3.9 KB): `app/llms-full.txt/route.ts:9-26` warns past 200 KB; content at `llms-content.ts:53-121`. It has no pricing, FAQ, template, use-case or comparison content.
- Both llms routes are dynamic (`max-age=300`, no `s-maxage`) so AI-crawler hits get logged.
- **AI-crawler capture** (BUILT): table `ai_crawler_hits` (`db/schema/analytics.ts:81`).
  - Matcher in `lib/tracking/ai-crawler.ts:27-44`:
    - fetch-on-citation tier: ChatGPT-User, OAI-SearchBot, PerplexityBot, Claude-Web
    - index-building tier: GPTBot, ClaudeBot, CCBot, Google-Extended, Applebot-Extended
  - Capture in `lib/tracking/ai-crawler-capture.ts` runs via `after()`.
  - Instrumented: llms routes, /, /how-it-works, /pricing, /join, event pages.
  - **Not instrumented:** /templates, /templates/[slug], /use-cases/[slug] (the long-tail pages), /privacy, /terms, robots.txt, sitemap.xml.
  - **Not in the bot lists:** Claude-User, Claude-SearchBot, Perplexity-User, Meta-ExternalAgent, Bytespider, Amazonbot, DuckAssistBot, MistralAI-User. I am flagging these from my own knowledge of current bot names; I did not verify against vendor docs. Googlebot and Bingbot hits are not logged at all.
- **AI referral attribution** (PARTIAL): `lib/tracking/classify.ts:54-58` sends AI hosts to the **organic** bucket; there is no separate `ai` source. A wider AI-host list (`lib/analytics/queries.ts:164-174`) drives only a badge in the referrer table.

### 4. AEO citation tracking (trailcards port, Section 22.d/22.h)
- **Tables:**
  - `aeo_queries` (`db/schema/aeo.ts:34`): query, category brand|niche|product, is_active, notes, created_by
  - `ai_citation_log` (`aeo.ts:62`): engine, ran_at, cited_brand, cited_url, snippet, raw_answer, sentiment, cost_usd, metadata jsonb, error_message
  - `platform_settings` (`aeo.ts:110`)
- **Engines** (`lib/aeo/engines.ts:66-91`): ChatGPT `gpt-4o` with web_search, Perplexity `sonar`, Gemini `gemini-3.7-flash` with grounding, Claude `claude-sonnet-4-6` with `web_search_20260209`. Sentiment uses `claude-haiku-4-5`. Model IDs can be overridden through the `aeo_engine_models` setting.
- **Seed queries:** 15 in `lib/aeo/seed.ts:30-105` (5 brand, 5 niche, 5 product).
- **Detection:** `lib/aeo/detect.ts` (brand patterns plus host).
- **Runner** (`lib/aeo/runner.ts`): monthly budget guard (`aeo_monthly_budget_usd`, default $30), skips cleanly with no keys, writes error rows instead of throwing.
- **Share of voice** (`lib/aeo/competitors.ts:51-53`): the competitor list is a **placeholder** (GooseChase, Scavify, Let's Roam) until Rachel confirms it. Overridable via the `aeo_competitor_brands` setting. Staff-only backfill.
- **UI:** `/admin/analytics/citations` — query CRUD, run history, query × week heatmap, "us vs them" column, stats, budget editor, engine-health strip, missing-key banner and dialog, "Run now".
- **Weekly cron:** `app/api/cron/aeo-citations`, Saturdays 14:00 UTC.
- **Live state:**
  - The cron returns 503 ("CRON_SECRET is not configured").
  - `OPENAI_API_KEY` is set in Production and Preview, so "Run now" would query **ChatGPT only**.
  - The Perplexity, Gemini and Anthropic keys are unset, so sentiment is always "neutral".

### 5. Analytics, reporting and Search Console (Section 12 write side + Section 22 read side)
- **First-party beacon** (BUILT):
  - `lib/tracking/beacon.ts` excludes automation and localhost.
  - `BeaconClient.tsx` (skip list) and `WebVitalsReporter.tsx` are mounted in `app/layout.tsx`.
  - `app/api/beacon/route.ts` writes **directly to the DB**. The planned Upstash queue and drain cron were not built (superseded, per INDEX). There is **no rate limiting** on the beacon.
  - `rg_visitor` cookie lasts 2 years. Traffic classifier: `classify.ts` (qr > email > paid > social > organic > referral > direct > unknown).
- **Dashboard** `/admin/analytics` (`app/admin/analytics/page.tsx`): sections at lines 307–728 cover KPIs with prior-period deltas, traffic sources, annotations, funnel, session timing, referrers (AI badge), landing pages, AI crawlers, Core Web Vitals, Search Console, site health, UTM campaigns and engagement. "Copy AI-ready report" uses `lib/analytics/ai-report.ts`.
- **Funnel:** `lib/tracking/events.ts` (builder_entered → sketch_claimed → event_published → checkout_completed), written server-side by `server-events.ts`.
- **Core Web Vitals:** `web-vitals@6`; LCP/INP/CLS p75 via `PERCENTILE_CONT`, stored as `session_events` with name `web_vital`.
- **Search Console ingest:**
  - Code: `lib/gsc/{config,ingest,queries}.ts`, table `gsc_daily`.
  - Cron `gsc-pull` daily at 06:00 UTC, with `?date=` backfill. It returns 503 live, and the 3 GSC env vars are unset.
  - The URL Inspection / index-coverage table is **deferred**.
- **Weekly digest:** `lib/analytics/digest.ts` and `digest-send.ts`; cron Mondays 13:00 UTC, returns 503 live. The content list still needs Rachel's sign-off. Resend is configured in production.
- **Change annotations:** `analytics_annotations` table with staff CRUD; markers appear on every sparkline.
- **Sitemap health audit:** `lib/audit/sitemap-audit.ts`, table `audit_findings`, `sitemap_audit_last_run` setting; cron Mondays 07:00 UTC, returns 503 live.
- **Analytics-only role:** the `analytics` platform role is enforced in `lib/staff/auth.ts` `decideStaffAccess`/`requireStaff({allow})`.
- **Tests:** `e2e/admin/{analytics-dashboard,analytics-crawler-capture,aeo-citations,analytics-role}.spec.ts`; vitest suites in `lib/{analytics,aeo,gsc,audit,tracking}/__tests__`.
- **Results share page:** `app/r/[participantRowId]` has a dynamic OG image and `robots: index false, follow true` (`page.tsx:66-80`).

### 6. Table names and collisions with AdminIgloo packages

**Hard collisions — same name, incompatible shape:**

| Table | Riddler Go | AdminIgloo package |
|---|---|---|
| `aeo_queries` | `db/schema/aeo.ts:34`: category, no tenant | `@adminigloo/aeo`, `scaffold/packages/aeo/src/schema.ts:10`: `tenant_id NOT NULL`, brand, domain, aliases |
| `analytics_sessions` | `db/schema/analytics.ts:12`: visitor_id, source, physical created_at | `@adminigloo/analytics`, `schema.ts:19`: `tenant_id NOT NULL`, visitor_key, source_bucket, started_at, landing_path, device/geo, counters |
| `analytics_annotations` | `db/schema/annotations.ts:19`: date DATE, kind deploy\|content\|campaign\|note | `@adminigloo/analytics`, `schema.ts:188`: tenant_id, day text |

**Parallel concepts, no name clash:**

| Riddler Go | AdminIgloo package |
|---|---|
| `page_views` | `analytics_page_views` |
| `session_events` | `analytics_events` |
| `ai_crawler_hits` | `analytics_crawler_hits` |
| `ai_citation_log` | `aeo_checks` |
| `audit_findings` | `seo_reports` (`@adminigloo/seo-reports`) |
| `gsc_daily`, `platform_settings`, `slug_history`, `reserved_slugs` | no package equivalent |

Other Riddler Go tables that clash with non-SEO packages: `email_events`, `feedback_tickets`, `orders`, `order_items`, `products`, `users`.

**Existing pattern to follow:** Riddler Go already uses `@adminigloo/feedback` 0.9.1 (`package.json:39`). It imports only the UI subpath `@adminigloo/feedback/board` and adapts it over Riddler Go's own tables (`app/admin/tickets/board/board-view.ts:1`, `TicketBoard.tsx:5`). `.npmrc` scopes `@adminigloo` to GitHub Packages, and `NPM_RC` was added on Vercel 2–3 hours ago.

**Package parity (inferred from a keyword scan of `scaffold/packages`):** `@adminigloo/aeo` 0.1.1 has no Gemini, no cost/budget, no sentiment, no competitor share-of-voice and no cron. Riddler Go's in-repo AEO is a superset, so moving Riddler Go onto the current package would be a downgrade unless the package absorbs Riddler Go's implementation first.

### 7. Env vars and settings
`vercel env ls` lists names only; I did not read values.

| Env var | Declared at | Production | Effect |
|---|---|---|---|
| `NEXT_PUBLIC_APP_URL` | `env.ts` | set | — |
| `CRON_SECRET` | `env.ts:216`, min 32 chars | **not set** | All 4 SEO/AEO crons return 503 live. `lib/cron/auth.ts:42-45` returns false without it, so start-live, complete-live and send-starting-soon are also refused (inferred). There is a trial on 2026-10-09 per the last commit. |
| `OPENAI_API_KEY` | `env.ts:228` | set (Production + Preview; also in `.env.local`) | ChatGPT engine works via "Run now" |
| `PERPLEXITY_API_KEY` | `env.ts:229` | unset | engine off |
| `GOOGLE_GENERATIVE_AI_API_KEY` (alias `GEMINI_API_KEY`) | `env.ts:230,361-362` | unset | engine off |
| `ANTHROPIC_API_KEY` | `env.ts:231` | unset | Claude engine and sentiment classifier off |
| `GSC_SERVICE_ACCOUNT_EMAIL`, `GSC_PRIVATE_KEY`, `GSC_PROPERTY` | `env.ts:264-266` | all unset | GSC ingest off |
| `RESEND_API_KEY` | `env.ts:162` | set (Production + Preview) | digest would send if the cron ran |
| `UPSTASH_REDIS_REST_URL`/`TOKEN` | `env.ts:293-294` | unset | not used by analytics |
| `NEXT_PUBLIC_DEMO_EVENT_CODE` | `env.ts:327` | unset | — |

DB settings keys: `aeo_monthly_budget_usd`, `aeo_engine_models`, `aeo_competitor_brands`, `sitemap_audit_last_run`. I could not check prod DB row counts or migrations 0016–0021 on prod; the docs say they are on staging.

### 8. What Riddler Go is missing

**A. Operations (code exists, switched off):**
1. `CRON_SECRET` on Vercel.
2. GSC service account + the 3 env vars.
3. Perplexity, Gemini and Anthropic keys.
4. The real competitor list.
5. Digest sign-off.
6. A way for hosts to set `is_publicly_listed`.

**B. Technical SEO:**
1. www → apex 301.
2. Web manifest.
3. Use-case pages in the sitemap.
4. Real `lastModified` dates in the sitemap (live, every URL shows the request time).
5. Fix the doubled title suffix on 4 page types.
6. og:image on /pricing and /how-it-works.
7. /join metadata and canonical.
8. Permanent (308) slug redirects, also for templates and use-cases.
9. An `/{orgSlug}` page.
10. Noindex on staging marketing pages.
11. IndexNow / Bing Webmaster submission (none in code).
12. Search Console verification in code (none in code; DNS verification unknown).
13. Beacon rate limiting.
14. Per-page OG images for templates and use-cases.

**C. Structured data:**
1. WebSite.
2. BreadcrumbList on marketing pages.
3. ItemList/CollectionPage for /templates and /use-cases.
4. Schema on /templates/[slug] and /use-cases/[slug].
5. AggregateRating/Review fed from the existing `reviews` table.
6. Organization `sameAs` (social URLs pending from Rachel).
7. VideoObject.
8. Article/BlogPosting.
9. Dedupe the 18 Product blocks on /pricing.

**D. AEO:**
1. llms.txt and llms-full.txt should cover pricing, how-it-works, templates, use-cases and FAQ.
2. Crawler capture on templates and use-cases.
3. Current AI bot names in the robots and capture lists.
4. A separate `ai` traffic source bucket.
5. Answer pages for the seeded queries. For example, "Riddler Go vs GooseChase" is tracked as a query but no page answers it.

**E. Content:**
1. Blog/CMS.
2. Comparison and alternatives pages.
3. Standalone /faq, /about, /contact, help center.
4. Programmatic long-tail pages beyond the 6 use-cases and 6 templates.
5. Changelog and RSS.

Trailcards has a blog with admin content management (`src/app/(shop)/blog`, `admin/content/blog`), plus regions, trails and decks pages. I only saw directory names there, not the code.

**F. Reporting that trailcards has and Riddler Go lacks:** investor reports (`investorReport.ts`), content attribution rollup (`contentAttributionRollup.ts`), ad-spend tracking (`admin/analytics/ad-spend`) — all inferred from file and directory names. Also missing: index coverage via the URL Inspection API (deferred) and A/B experiments (22.i, held).

Scratch files with the live captures (robots, sitemap, llms, homepage HTML, head parser) are in `C:\Users\dalli\AppData\Local\Temp\claude\C--Users-dalli-adminIgloo\9cc2b6ac-70a9-4b80-8e17-075e131b0b61\scratchpad\`.