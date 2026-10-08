**AdminIgloo SEO/AEO inventory and how much of it can go into Riddler Go**

**The premise is wrong.** Riddler Go already has a large SEO/AEO stack, ported from trailcards as "Section 22". I checked that the files exist; how deep each one goes is for the Riddler Go piece of this review to confirm.
- **Pages and files:** `app/sitemap.ts`, `app/robots.ts` (one group per AI crawler, line 41), `app/llms.txt`, `app/llms-full.txt`, plus share images for the site, each event and each participant.
- **Libraries:**
  - `lib/aeo/*` (1,863 lines): four engines (chatgpt, perplexity, gemini, claude) with live web search (`engines.ts:432`), sentiment, cost per call, a monthly budget, competitors and query categories.
  - Also `lib/gsc/*` (Google Search Console import), `lib/audit/sitemap-audit.ts` and `lib/tracking/*`.
- **Tables:** `aeo_queries`, `ai_citation_log`, `ai_crawler_hits`, `analytics_sessions`, `page_views`, `session_events`, `analytics_annotations`, `gsc_daily`, `audit_findings`, `platform_settings`.
- **Scheduled jobs** (`vercel.json`): `aeo-citations` weekly, `gsc-pull` daily, `site-audit` weekly, `analytics-digest` weekly.
- **Already uses AdminIgloo:** `@adminigloo/feedback` 0.9.1, display-only. It imports `/board` with an adapter over its own tables (`app/admin/tickets/board/board-view.ts`). That is the pattern to reuse here.

So for AEO in particular, AdminIgloo's package would be a step down for Riddler Go, not a step up.

## 1. `@adminigloo/aeo` (local 0.1.1; registry has 0.1.0 and 0.1.1)

**What it does:**
- `detectCitation` (`detect.ts:48-69`) matches the brand name and aliases as whole words (`:43-46`) and the domain as a substring.
- `createQuery`, `deactivateQuery`, `listQueries`, `recordCheck`, `listChecks`, `queriesWithLatest` (`index.ts:24-93`).
- `runCitationChecks(db, tenantId, ask, engine)` (`index.ts:101-124`). The app supplies the `ask(query)` function, which returns text or null.

**What it does not do:**
- No web search, no cited URL, no sentiment, no cost or budget, no competitors, no categories.
- No trend function, even though `package.json:4` claims "trends it over time".
- No scheduled job anywhere.

**Defects:**
- `deactivateQuery` and `listChecks` ignore the tenant (`index.ts:30-37`, `:66-73`).
- `queriesWithLatest` reads every check the tenant has ever recorded (`:83-87`).

**Tables:** `aeo_queries` (`schema.ts:10-23`) and `aeo_checks` (`:25-41`).

**Integration:**
- Database calls take a db argument (`PgDatabase<any,any,any>`).
- Dependencies: `@adminigloo/db` (which pulls in the Neon driver and `ws`), `drizzle-orm ^0.45`, `zod ^3.25||^4`.
- No migrations ship with it; the app's drizzle-kit generates them.
- No README, CHANGELOG or license-key check.

**Tests:** 7 unit tests, all on `detectCitation`. None cover the database functions.

**Testbed wiring:**
- `src/server/aeo-asker.ts:11-46` calls Anthropic with no web-search tool. So it measures what the model remembers from training, not live AI search.
- Router at `routers/aeo.ts:21-44`, page at `app/admin/aeo/page.tsx`. There is no scheduled job; checks only run when someone clicks.

## 2. `@adminigloo/seo-reports` (0.1.0, published)

**`auditPage`** (`index.ts:87-264`) checks each page with regex over the HTML:
- SEO: title length, meta description, exactly one h1, canonical present, og:title and og:image, noindex, image alt text.
- AEO: JSON-LD parses, h2 sections.

**`runSeoReport`** (`:329-469`):
- Site checks: robots.txt, AI crawler access for GPTBot, ClaudeBot, PerplexityBot, Google-Extended and CCBot (`:274`), llms.txt, sitemap.xml.
- Crawls the sitemap (same origin only, capped, and the cap is reported), flags pages that 404, and produces SEO, AEO and combined scores.

**Saving:** `saveSeoReport`, `listSeoReports`, `getSeoReport` (`:475-526`). The table is `seo_reports` (`schema.ts:19`), with no tenant column.

**Confirmed bugs** (I ran them against the built package):
- `robotsBlocks` (`:277-295`) says GPTBot is allowed when it shares a blocking group with another bot (`User-agent: GPTBot` / `User-agent: ClaudeBot` / `Disallow: /`). That is a false pass. Next's `robots.ts` writes exactly this shape whenever `userAgent` is an array.
- It also says allowed when a GPTBot block is followed by a wildcard `Allow: /`. Another false pass.
- It says blocked when GPTBot is explicitly allowed under a wildcard block. A false warning.

**Gaps:**
- `listSeoReports` has no base-URL filter; the testbed works around it in `seo-matrix.ts:14-45`.
- Canonical is only checked for presence. No check that it points at the page itself.
- No checks for: X-Robots-Tag header, llms-full.txt, JSON-LD `@type`, FAQ or Speakable markup, duplicate titles or descriptions, `lang`, hreflang, orphan pages.
- Fetches pages one at a time.
- No record of findings between runs, unlike Riddler Go's `audit_findings`.

**Tests:** 9 unit tests with a fake fetch.

## 3. `@adminigloo/analytics` (0.1.0) — NOT published

`npm view` returns E404. The only copy is the testbed's `vendor/adminigloo-analytics-0.1.0.tgz`. It is committed in scaffold (0544dff), has no changeset, no README and no CHANGELOG.

**Entry points:**
- `.` (server), `./schema`, `./crawlers` (no dependencies, safe to use in `proxy.ts`), `./client` (the visitor beacon), `./dashboard` (display components).

**Visits (no cookies):**
- Collector: `createAnalyticsHandler` (`ingest.ts:139-311`). Always answers 204, checks the request comes from the site's own hosts, honours GPC/DNT, ignores bots, rate-limits per network in Postgres, keys visitors with an HMAC under a salt that changes daily, and strips secret-looking path segments and email/token-shaped labels and UTM values.
- `recordConversion` (`:524`).
- `runAnalyticsMaintenance` (`:615`): deletes old salts, cleans rate rows, enforces 395-day retention.

**Where visitors came from:** `classifySource` (`sources.ts:189`) sorts each visit into offline, paid, email, AI assistant (15 domains plus UTM sources), search, social, referral or direct. Ad click IDs are recorded only by type, never value.

**Crawlers:**
- `classifyCrawler` (`crawlers.ts:44-103`) knows about 40 bots and labels each as ai-assistant, ai-search, ai-training, search, social or seo-tool.
- `createCrawlerVerifier` (`verify.ts:119`) checks the request IP against the IP ranges OpenAI, Perplexity, Google, Bing and Apple publish. Only the yes/no is stored.
- `recordCrawlerHit` (`ingest.ts:572`) groups hits into 10-minute buckets with a counter, so fake bot floods cannot grow the table.

**Reports** (`reports.ts:142-835`):
- Traffic: overview, daily trend, sources, referrers, campaigns, breakdowns, engagement by source, activity heatmap, top and landing pages, clicks, event funnel.
- Speed: Core Web Vitals at the 75th percentile (`vitals.ts`).
- AI crawlers: `getCrawlers`, `getRecentAiReads`, `getAiCoverage`.
- Housekeeping: `getPipelineHealth`, annotations, and `getPublicSnapshot`, a public summary that only names allowed pages.

**Display components:** `dashboard.tsx:221-785`. They take plain data and fetch nothing, so they would work in Riddler Go's server-action setup.

**Tables:**
- `analytics_sessions` (`schema.ts:19`), `analytics_page_views` (`:69`), `analytics_events` (`:92`), `analytics_crawler_hits` (`:127`)
- `analytics_salts` (`:155`), `analytics_rate` (`:166`), `analytics_sites` (`:179`), `analytics_annotations` (`:188`)

**Tests:** about 30 unit tests in `pure.test.ts`, plus 6 against Postgres in the testbed (`src/server/__tests__/analytics.integration.test.ts`).

## 4. Table collisions with Riddler Go (checked against its schema)

| Package table | Riddler Go table | Result |
|---|---|---|
| `aeo_queries` | `db/schema/aeo.ts:34` (different columns) | **Collides** |
| `analytics_sessions` | `db/schema/analytics.ts:12` (cookie-based) | **Collides** |
| `analytics_annotations` | `db/schema/annotations.ts:20` (`date` column vs package's `day` text + `tenant_id`) | **Collides** |
| `seo_reports`, `aeo_checks`, `analytics_page_views`, `analytics_events`, `analytics_crawler_hits`, `analytics_salts`, `analytics_rate`, `analytics_sites` | none | Free |

- The TypeScript export names collide too (`aeoQueries`, `analyticsSessions`, `analyticsAnnotations`), so `export *` of the package schemas into Riddler Go's `db/schema/index.ts` would fail.
- No index names collide.
- Riddler Go's `audit_findings`, `admin_audit_log`, `ai_citation_log`, `ai_crawler_hits` and `gsc_daily` do not clash with these three packages.

**None of the tables can be renamed or prefixed.** Every name is a fixed string (`aeo/src/schema.ts:11,26`; `seo-reports/src/schema.ts:19`; `analytics/src/schema.ts:20,70,93,128,155,166,179,189`), and every function imports the table objects directly (`aeo/index.ts:5`, `analytics/ingest.ts:4-12`, `reports.ts:3-10`, `seo-reports/index.ts:4`). The workarounds:
- Riddler Go renames its own tables, or
- Riddler Go exports only the non-colliding package tables (for example `analyticsCrawlerHits` and `analyticsSites`), or
- the packages get a prefix or schema-namespace option, which is a refactor.

Version fit (not install-tested): Riddler Go has `drizzle-orm ^0.45.2`, `zod ^3.25.76`, Next 16.2.12, React 19.2.4, `web-vitals ^6.2.1`. Its `.npmrc` already points `@adminigloo` at GitHub Packages.

## 5. SEO/AEO that lives only in the testbed (not packaged)

**Indexing and crawl files:**
- `src/seo.ts:13-80` decides once whether a deployment may be indexed (production only); `app/robots.ts:7` uses the same decision.
- `app/robots.ts` blocks everything outside production. It has no named AI-crawler groups.
- `app/sitemap.ts` is built from one page list (`src/public-pages.ts:17-56`) that includes the feature registry.
- `app/llms.txt/route.ts` lists one line per feature. There is no llms-full.txt.

**Structured data and page metadata:**
- JSON-LD: Organization on the homepage (`app/(site)/page.tsx:33-60`); SoftwareApplication and BreadcrumbList on feature pages (`src/features/FeatureView.tsx:177-205`). Both use raw `JSON.stringify` with no `</script>` escaping.
- `features/[slug]` pages are pre-rendered with their own metadata and canonical URL.
- Canonical URLs are set on 8 pages, but **not on the homepage** (`page.tsx:17-26`).
- Share images: `app/opengraph-image.tsx` (text-only), `twitter-image.tsx` (re-exports it), `icon.tsx`.

**Crawler logging and the scheduled job:**
- `proxy.ts:98-115` logs crawlers on every request, including robots, sitemap and llms.txt, using `waitUntil` and a lazy import (`src/server/crawler-log.ts`).
- `proxy.ts:129-138` sends `x-robots-tag: noindex` on private-link pages.
- The analytics job (`app/api/cron/analytics/route.ts:32-64`, scheduled daily in `vercel.json`) does the maintenance plus one production SEO audit a day, up to 25 pages. There is **no AEO job**.

**Analytics wiring and public window:**
- `src/server/site-analytics.ts`: the collector, server-side conversions, staff excluded from counts, a cached public snapshot.
- `src/analytics-config.ts`: production and non-production data kept apart, secret path patterns, the public funnel.
- Routes: `/api/analytics`, `/api/analytics/public`.
- The homepage "who is reading this, people and AI" panel (`live-window.tsx`, 787 lines; `live-seo-tile.tsx`; `seo-matrix.ts`; `seo-demo.ts`).
- Visitor opt-out on the privacy page (`AnalyticsOptOut.tsx`).

**Admin:** `/admin/seo`, `/admin/aeo`, `/admin/analytics`, all built on tRPC. The `routers/seo.ts:40` mutation does not check that the app URL is set.

## 6. Project generator (`create-app` 0.18.0)

**Always generated:** `src/seo.ts`, `app/llms.txt/route.ts`, `app/robots.ts`, `app/sitemap.ts` (`emit.ts:301-304`; renderers at `:4225`, `:4325`, `:4441`, `:4531`).

**Optional:**
- Flags `--seo-reports` and `--aeo` (`cli.ts:104-123`, `answers.ts:75,153`).
- Overlays: `seo-reports`, `seo-admin`, `aeo` (its model hook returns null until wired, `overlays/aeo/src/server/aeo-asker.ts:26-32`), `aeo-admin`. All tRPC.
- Pinned versions: seo-reports 0.1.0, aeo 0.1.1 (`versions.ts:100,165`).
- Capability checks at `capabilities.ts:168-178`, `315-328`, `464-475`.

**Analytics:** there is no flag or overlay at all.

**`add` command:** it needs `adminigloo.json`, which Riddler Go does not have, so it cannot add these features to Riddler Go.

## 7. What AdminIgloo can deliver to Riddler Go today

1. **`@adminigloo/seo-reports@0.1.0`, in full.** No table collision, and it adds the AEO checks Riddler Go's `audit_findings` lacks: llms.txt, AI-crawler access, sections, social cards, alt text, scores, a full saved report per run. You would need to write your own server action or scheduled job and admin page; the tRPC overlay page does not carry over. Fix the robots.txt parser first.
2. **`@adminigloo/aeo`.** Only `detectCitation` is worth using, and Riddler Go's own `lib/aeo/detect.ts` already does more (`brandPatterns`, `preferredCitedUrl`). The rest collides and is weaker.
3. **`@adminigloo/analytics`.** Nothing can be installed from the registry until it is published. Once it is:
   - The crawler half can go in with no collision: proxy-wide logging, IP verification, the bot categories, 10-minute buckets, the AI-coverage and recent-reads reports, `CrawlerPanel`. Export only `analyticsCrawlerHits` and `analyticsSites`.
   - The standalone helpers need no tables: `/crawlers`, `classifySource`, `normalizePath`, `parseUserAgent`, the Web Vitals ratings, the date-range helpers, and the dashboard components through an adapter (the same pattern as the feedback board).
   - The visitor half (no-cookie collector, sessions, annotations) is blocked by the collisions and would also mean migrating Riddler Go's cookie-based data.
4. **Patterns to copy as code, not packages:** the single indexing decision, crawler logging in the proxy, `x-robots-tag` on private links, page lists driven by one registry, separate production and non-production data, the production-only daily audit, and the public "AI read this page" panel.

## 8. Missing to match a full trailcards-class stack

1. **No JSON-LD helper package.** Trailcards' `src/utils/seo.ts` (599 lines) has 13 builders: Organization, Product, Article, WebPage, Breadcrumb, FAQ, Speakable, Person, LocalBusiness, TouristAttraction, Place, ItemList and a script helper. AdminIgloo has two one-off emitters with no escaping.
2. **No metadata helper package** (trailcards' `generateMetadata`). It exists only as the generated template.
3. **No llms.txt / llms-full.txt, sitemap, robots or share-image packages.** These are templates and hand code only. Missing within them: named AI-crawler groups in robots, lastmod, and image share cards generated per page.
4. **No Google Search Console import.** Trailcards and Riddler Go both have `gsc_daily` plus a daily job.
5. **No weekly digest email or daily rollup** (trailcards has `analytics-digest` and `analytics-rollup`, the latter feeding `content_attribution_daily`).
6. **AEO engine work is missing:** ChatGPT, Perplexity, Gemini and Claude adapters with web search, cited URL, sentiment, cost and budget, competitor tracking, query categories and seed lists, model overrides, a scheduled job, and a trend function.
7. **No failure history in audits** ("failing since", resolved).
8. **No blog or content system** (trailcards has `(shop)/blog` and `admin/content/blog`).
9. **No table prefix or namespace option** in any of the three packages, which any app with existing tables will hit.
10. **Release state:** analytics needs publishing plus a README and CHANGELOG; aeo has no README or CHANGELOG; none of the three has license-key enforcement (INFERRED: no `@adminigloo/license` dependency).
11. **Admin pages are tRPC-only.** Riddler Go uses server actions, so only the analytics display components carry over unchanged.
12. **IndexNow or Bing pings:** neither AdminIgloo nor trailcards has them (grep found nothing).