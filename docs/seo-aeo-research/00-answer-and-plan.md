## The short answer

**You're partly wrong about Riddler Go.** It already has a large SEO, AEO and analytics suite. It was ported from Traildek as plan Sections 12 and 22, and in places it is better than Traildek. You won't get Traildek-class SEO/AEO by copying Traildek in. You'll get it in three ways:
1. **Switch on what's already built.** Every SEO/AEO scheduled job in production is failing today, and most of the API keys are missing.
2. **Fix about 20 content and technical gaps.** These are cheap and specific to Riddler Go.
3. **Give AdminIgloo the packages it doesn't have yet.**

**AdminIgloo doesn't have what it needs today.** On SEO and AEO it is the weakest of the three codebases:
- `@adminigloo/aeo` 0.1.1 is a step down from what Riddler Go runs in its own code.
- `@adminigloo/analytics` 0.1.0 is not published.
- There is no package at all for metadata, structured data, robots, sitemap or llms.txt, and none for Google Search Console.
- None of the three packages lets you rename its tables, so three of their table names clash with tables Riddler Go already has.

**The best source for the AdminIgloo packages is Riddler Go's own code, not Traildek's.** Riddler Go's version already enforces the monthly spend cap, uses the current Claude web-search tool, and checks citations against the domain as well as the brand name.

**Urgent, and not about SEO.** `CRON_SECRET` is missing from Riddler Go's production environment. I confirmed this with `vercel env ls production`, which lists `OPENAI_API_KEY` and the Resend variables but not `CRON_SECRET`. Without it, `lib/cron/auth.ts:42-45` rejects every scheduled job. The live-event jobs `start-live` and `complete-live` return 401 (`start-live/route.ts:35-36`, `complete-live/route.ts:37-38`). So scheduled events cannot start or finish automatically in production, and the client trial is tomorrow, 2026-10-09. I haven't checked whether the trial depends on that automatic start (INFERRED). Set the secret today (at least 32 characters, `env.ts:216`) and redeploy. That one step also turns on all four SEO/AEO jobs.

---

## 1. Capability matrix

How to read it:
- **Traildek:** ✓ good, ~ has it with defects, ✗ none.
- **AdminIgloo:** the package and version, "testbed" if it only exists in the AdminIgloo site, or NONE.
- **Riddler Go:** BUILT, PARTIAL, PLANNED or MISSING.

### Classic SEO

| Capability | Traildek | AdminIgloo | Riddler Go |
|---|---|---|---|
| Shared page-metadata helper | ~ `seo.ts:48-94`. Missing canonical falls back to the homepage; only 2 pages use it | NONE (create-app template only) | PARTIAL: written by hand on each page |
| Site-wide title template | ~ brand appears twice in titles | testbed | PARTIAL: same doubling, verified at `layout.tsx:66` combined with `pricing:47`, `templates:27`, `templates/[slug]:31`, `use-cases/[slug]:30` |
| Canonical links on every page | ~ missing on 4 pages; `/subscribe` points at the homepage | testbed (homepage missing) | PARTIAL: `/join` has none |
| Social-share tags (Open Graph / Twitter) on each page | ~ most pages inherit the root's tags | testbed | PARTIAL: `/pricing` and `/how-it-works` lose the share image |
| Generated share images | ✓ per deck and collection, on the edge, with a cached font | testbed (text only) | PARTIAL: site, event and result pages; none for templates or use-cases |
| Icons and web app manifest | ~ no manifest | testbed `icon.tsx` | PARTIAL: icons yes; manifest returns 404 (per the inventory's live check) |
| robots.txt | ~ blocks `/_next/` (hides every optimised image), `/checkout/` trailing-slash miss | testbed: production-only rule | BUILT: driven by one path list (`marketing-paths.ts`); blocks everything off production |
| AI bots named in robots.txt | ~ 10 bots; `Claude-Web` is retired | NONE named in testbed robots | PARTIAL: 8 bots (`marketing-paths.ts:37-46`); missing `OAI-SearchBot`, `Claude-SearchBot`, `Claude-User`, `Perplexity-User`, others |
| sitemap.xml | ~ built from the database but frozen at build time; `lastmod` is always "now" | testbed, from one page list | PARTIAL: `lastModified: now` (`sitemap.ts:30,75`); use-case pages missing (verified); 0 events listed |
| Image sitemap or split sitemaps | ✗ | NONE | MISSING |
| Hiding private pages from search (noindex) | ~ cart, checkout and admin are indexable | testbed: `x-robots-tag` on private links | BUILT: response header in `proxy.ts` plus page metadata, with an end-to-end regression test |
| Hiding staging from search | ✗ | testbed ✓ | PARTIAL: robots.txt only; no noindex on staging marketing pages |
| Permanent redirects and old-slug history | ✓ redirects backed by a database lookup | NONE | PARTIAL: `slug_history` exists but sends a temporary 307 (`[eventSlug]/page.tsx:180`, `redirect()`) |
| www → bare-domain redirect | n/a | n/a | MISSING (the www site serves a full duplicate, per the live check) |
| Custom 404 page | ✗ | ? | BUILT (`app/not-found.tsx`) |
| Language alternates (hreflang) | ✗ | NONE | MISSING (not needed; single locale) |
| IndexNow / Bing ping on publish | ✗ | NONE | MISSING (grep finds nothing anywhere) |
| Search Console site verification | commented out | NONE | MISSING in code; DNS status unknown |

### Structured data (schema.org JSON-LD)

| Capability | Traildek | AdminIgloo | Riddler Go |
|---|---|---|---|
| Builder library | ✓ 13 builders, but no tests, no `@id`/`@graph` linking, no escaping | NONE (2 one-off emitters in testbed) | PARTIAL: `components/seo/schemas.ts` with a test |
| Escaping `<` inside the script tag | ✗ (`JsonLd.tsx`, verified) | ✗ | ✗ (`JsonLd.tsx`, plain `JSON.stringify`, verified) |
| Organization | ✓ (`sameAs` is an empty list) | testbed | BUILT (no `sameAs`; social links are null) |
| WebSite and site search | ✗ | NONE | MISSING |
| Breadcrumbs | ✓ most pages | testbed (feature pages) | PARTIAL: event pages only |
| Product with price (Offer) | ~ no rating, shipping or returns | NONE | PARTIAL: 18 duplicate blocks on `/pricing` |
| FAQ | ✓ decks | NONE | BUILT on `/`, from one source file |
| HowTo | ✗ | NONE | BUILT (`/`, `/how-it-works`) |
| SoftwareApplication | n/a | testbed | BUILT on `/` (no rating) |
| Event | n/a | NONE | BUILT on event pages |
| Lists and collection pages (ItemList / CollectionPage) | ✓ | NONE | MISSING (`/templates`, `/use-cases`) |
| Person, Speakable, WebPage | ✓ | NONE | MISSING |
| Ratings and reviews | ✗ (promised in plan, not built) | NONE | MISSING (the `reviews` table exists to feed it) |
| Article / BlogPosting | built but unused | NONE | MISSING (there is no blog) |
| Validation | parse check only, in the audit | `seo-reports` parse check | parse check in the audit plus `schemas.test.ts` |

### Answer engines (AI search)

| Capability | Traildek | AdminIgloo | Riddler Go |
|---|---|---|---|
| llms.txt | ✓ refreshed hourly, built from the database | testbed (one line per feature) | PARTIAL: misses pricing, how-it-works, templates and use-cases |
| llms-full.txt | ~ 75 KB, but the hard-coded text has drifted from the real pages | NONE | PARTIAL: 3.9 KB; no pricing, FAQ, templates or use-cases |
| Copy written for answer engines (direct-answer intros, FAQs) | ✓ AI writer with answer-engine voice rules | NONE | MISSING |
| Comparison and answer pages for tracked questions | ✗ | NONE | MISSING (e.g. "vs GooseChase" is tracked, but no page answers it) |
| List of tracked questions, editable | ✓ lazy seed, 15 questions | `aeo` 0.1.1 (has tenant bugs) | BUILT: 15 seeded questions plus editor |
| ChatGPT check with live web search | ✓ | NONE (testbed asks Anthropic with no search, so it tests memory, not live search) | BUILT, and the only engine with a key in production |
| Perplexity / Gemini / Claude checks | ✓ / ✓ / ~ (older search tool `webSearch_20250305`, `aeoEngines.ts:486`) | NONE | BUILT but switched off (no keys); Claude uses the current `web_search_20260209` (`engines.ts:432`) |
| Model overrides without a redeploy | ✓ | NONE | BUILT |
| Detecting a citation | ~ substring match, hard-coded brand, mention-only | `aeo` ✓ whole-word name and aliases plus domain | BUILT: brand patterns plus domain |
| Sentiment of the mention | ✓ Haiku | NONE | BUILT but off (no Anthropic key) |
| Cost per check | ~ misses sentiment and search-tool fees | NONE | BUILT (search fees INFERRED missing) |
| Monthly spend cap | ✗ stored but never enforced | NONE | BUILT and enforced (`runner.ts:234`) |
| Competitor share of voice, with backfill | ✓ | NONE | BUILT (competitor list is a placeholder) |
| Engine health and dead-engine alarm | ✓ | NONE | BUILT |
| Question × week heatmap | ~ includes inactive questions | NONE | BUILT |
| Drill-down to the raw AI answer | ✗ (stored, never shown) | NONE | INFERRED missing |
| Weekly scheduled run plus "Run now" | ✓ | NONE (click only) | BUILT, but the job returns 503 in production |
| Logging AI crawler visits | ✗ (the browser beacon can never see bots) | `analytics` 0.1.0 ✓ server-side, about 40 bots, IP verification, 10-minute buckets (**unpublished**) | PARTIAL: `ai_crawler_hits` on selected routes; long-tail pages, robots and sitemap not covered; no IP verification |
| Separate "AI assistant" traffic source | ✓ (misses `utm_source=chatgpt.com`) | `analytics` ✓ | MISSING: AI sites counted as organic (`classify.ts:54-58`, verified) |

### Measurement, audits and reporting

| Capability | Traildek | AdminIgloo | Riddler Go |
|---|---|---|---|
| Google Search Console import, nightly | ✓ no extra libraries, 16 tests | NONE | BUILT, but the job returns 503 and the 3 Search Console variables are unset |
| Search Console URL Inspection / Sitemaps APIs, Bing Webmaster | ✗ | NONE | PLANNED (deferred) |
| Sitemap and on-page audit | ✓ weekly, failure history kept | `seo-reports` 0.1.0: more checks (llms.txt, AI crawler access, scores), but the robots parser is broken and it keeps no failure history | BUILT (`audit_findings`); job returns 503 |
| Real-visitor page speed (Core Web Vitals, 75th percentile) | ✓ | `analytics` ✓ | BUILT |
| Lighthouse and bundle-size checks in CI | ~ runs against live production, includes a redirecting URL | NONE | MISSING (INFERRED from the inventories; not checked) |
| First-party visitor analytics | ~ (`user_id` never written) | `analytics` ✓ no cookies (unpublished) | BUILT with a cookie; no rate limit on the beacon |
| Change markers on charts | ✓ | `analytics` ✓ | BUILT |
| Weekly digest with anomaly alerts | ✓ | NONE | BUILT; job returns 503; content waiting on Rachel's sign-off |
| AI-ready copy-paste report | ✓ | NONE | BUILT |
| Revenue attributed to content | ✓ | NONE | MISSING |
| Investor PDF / ad-spend tracking | ✓ | NONE | MISSING (not needed for a client) |
| Admin screens | ✓ tRPC | tRPC only, testbed | BUILT with server actions |
| Analytics-only staff role | ✓ | NONE | BUILT |
| A/B experiments | ✗ | NONE | PLANNED (22.i, on hold) |

## 2. Your premise, corrected

**What Riddler Go has:**
- Everything marked BUILT above.
- Four SEO/AEO scheduled jobs in `vercel.json` (verified): `aeo-citations` Saturdays 14:00 UTC, `gsc-pull` daily 06:00, `analytics-digest` Mondays 13:00, `site-audit` Mondays 07:00.
- Ten tables. The schema files are verified: `db/schema/aeo.ts:34,62,110`, `analytics.ts:12,48,58,81`, `annotations.ts:19`, `gsc.ts:37`.
- `docs/plans/INDEX.md` marks Section 12 done and Section 22 in testing. The Section 12 plan file still shows `status: draft` with every box unchecked; trust the code.
- `22-admin-monitoring-and-reporting/PLAYBOOK.md` is a portable spec for setting this suite up in any project. Use it as the spec for the AdminIgloo packages.

**What it truly lacks:**
- **Switched off, code already exists:**
  - `CRON_SECRET`, so all jobs fail.
  - Anthropic, Perplexity and Gemini keys.
  - The 3 Search Console variables.
  - The real competitor list and sign-off on the digest (both from Rachel).
  - Any way for a host to list an event publicly (`isPubliclyListed` is never written; grep confirms).
- **Technical SEO:**
  - www → bare-domain redirect.
  - Web app manifest.
  - Use-case pages in the sitemap.
  - Real `lastModified` dates.
  - The doubled title suffix on 4 page types.
  - Share images on `/pricing` and `/how-it-works`.
  - Metadata on `/join`.
  - Permanent (308) slug redirects.
  - An `/{orgSlug}` page (the event pages link to it, so those links 404).
  - Noindex on staging.
  - IndexNow.
  - A rate limit on the beacon.
- **Structured data:** WebSite, breadcrumbs, ItemList, schema on the template and use-case pages, ratings, `sameAs`, deduplicating the pricing blocks, and escaping.
- **AEO:**
  - Fuller llms files.
  - Crawler logging on the long-tail pages.
  - Current bot names.
  - An "AI" traffic source.
  - Pages that answer the tracked questions.
- **Content:** blog, comparison pages, `/faq`, help pages, more programmatic long-tail pages.

## 3. What AdminIgloo must add

**A new `@adminigloo/seo` package with no database tables, so nothing can clash:**
- A metadata builder that sets the canonical to the page itself, never adds the brand twice, and always merges the share image.
- A JSON-LD library: all of Traildek's 13 builders plus WebSite, SoftwareApplication, Event, HowTo and Review/AggregateRating. Every node gets an `@id`, everything goes in one `@graph`, `<` is escaped as `\u003c`, and each builder has tests.
- A robots policy builder. Its AI-bot list should come from the same list `analytics/crawlers.ts` uses, so the two can't drift.
- A sitemap helper with real `lastmod`, image entries and splitting.
- An llms.txt and llms-full.txt generator fed by a content registry, never hard-coded text.
- A share-image template.
- IndexNow on publish, and the "is this production?" indexing decision.

**`@adminigloo/seo-reports` 0.2:**
- Rewrite `robotsBlocks` (`index.ts:277-295`, verified). Its group handling is wrong: a `User-agent: GPTBot` line followed by `User-agent: ClaudeBot` turns `applies` off before the `Disallow` line, so it reports GPTBot as allowed when it is blocked.
- Add checks:
  - the canonical points at the page itself;
  - the `X-Robots-Tag` header;
  - llms-full.txt;
  - JSON-LD `@type`;
  - duplicate titles and descriptions;
  - orphan pages;
  - broken internal links.
- Fetch pages in parallel.
- Keep failure history ("failing since", resolved), Traildek-style.
- Add a base-URL filter and a tenant column.

**`@adminigloo/aeo` 0.2: rebuild it from Riddler Go's `lib/aeo`, about 1,860 lines:**
- From Riddler Go: the 4 web-search engines, the model overrides, the enforced spending cap, the deadline-aware runner, sentiment, competitors and share of voice, the backfill, engine health, the heatmap, and question categories with seed lists.
- From Traildek's ideas: the share-of-voice SQL and the engine-health and dashboard parts.
- New:
  - cost tracking that includes the sentiment call and search fees;
  - stopping timed-out requests (AbortController);
  - telling a domain citation apart from a brand mention, plus the brand's rank inside list answers;
  - a raw-answer drill-down;
  - a trend function;
  - a scheduled-job handler.
- Fix the tenant leaks (`index.ts:30-37, 66-73`) and the full-history scan in `queriesWithLatest`.

**New `@adminigloo/search-console` package:**
- Traildek's and Riddler Go's Search Console import (signs its own login, no Google library), with the impressions-weighted reports.
- Later: device and country breakdowns, URL Inspection, Bing Webmaster.

**`@adminigloo/analytics`:**
- Publish it, with a README and CHANGELOG.
- Add the AI hosts that are missing and `utm_source=chatgpt.com`.
- Add a digest and anomaly engine (Traildek's `computeAnomalies`). This could be its own `@adminigloo/digest` package.

**Every package:**
- Admin UI as display components that take plain data and fetch nothing, so they work with Riddler Go's server actions. Today the admin pages are tRPC-only.
- License-key enforcement.
- Exact version pins and tarballs that can be vendored into a repo, because of the handoff below.

### The table-name clash

The three clashes, all verified:

| Table | Riddler Go | Package |
|---|---|---|
| `aeo_queries` | `db/schema/aeo.ts:34-35` | `aeo/src/schema.ts:10-11`, adds a required `tenant_id` |
| `analytics_sessions` | `analytics.ts:12` | `analytics/schema.ts:19` |
| `analytics_annotations` | `annotations.ts:19` | `analytics/schema.ts:188` |

The TypeScript export names clash too (`aeoQueries`, `analyticsSessions`, `analyticsAnnotations`).

| Option | Upside | Downside |
|---|---|---|
| a. Package option to rename or namespace tables | Fixes the problem for every future app | Refactor of every package function (each one imports its tables directly). Riddler Go would still need a data migration to move onto the package's tables. |
| **b. Adapters (packages define a storage interface; the app supplies its own tables)** | No migration and no risk to Riddler Go's data. Riddler Go already does this with the feedback board (`board-view.ts`). | The package has to be designed this way. |
| c. Migrate Riddler Go's data into the package tables | One way of storing data | Risky data migration on client work just before a trial and a handoff. The visitor half would also mean switching from a cookie to no cookies. |

**Recommendation: b now, plus a in the same refactor.**
- Each package's core becomes pure logic plus a storage interface (`AeoStore`, `AuditStore`, `GscStore`).
- Each package also ships a default Drizzle store built by a factory, for example `defineAeoTables({ prefix: "aig_" })`, with names you can configure.
- New apps (create-app, the AdminIgloo site) use the default store. Riddler Go writes about 100-line adapters over `aeo_queries`, `ai_citation_log`, `gsc_daily`, `audit_findings` and `ai_crawler_hits`.
- Riddler Go never imports the clashing tables, so it never runs a migration.

## 4. Porting plan

### Phase 0: today, before the 2026-10-09 trial. Settings only, no code.

1. Set `CRON_SECRET` (at least 32 characters) on Riddler Go's Production and Preview environments, then redeploy. This is critical for the trial; see the short answer.
2. Deploy no SEO or AEO code to Riddler Go until the trial is over.

### Phase 1: the week after the trial. Fixes in Riddler Go itself. Biggest lift, least risk.

These are specific to the app; a package cannot fix a title string.

1. **Keys** (put them on the client's accounts, not yours, for the handoff):
   - `ANTHROPIC_API_KEY`, `PERPLEXITY_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`.
   - Search Console: create a service account, add its email as a user on the Search Console property, then set `GSC_SERVICE_ACCOUNT_EMAIL`, `GSC_PRIVATE_KEY` and `GSC_PROPERTY`.
   - Verify the Search Console property by DNS.
   - Get the real competitor list from Rachel (and her digest sign-off).
2. **Domain and pages:**
   - www → bare domain, a 308 set in Vercel's domain settings.
   - Remove "— Riddler Go" from the 4 page titles.
   - Add the share image back on `/pricing` and `/how-it-works`.
   - Metadata and canonical on `/join`.
   - Use-case pages into the sitemap and `MARKETING_PATHS`.
   - Real `lastModified` dates.
   - `permanentRedirect` for slug history.
   - Noindex on staging marketing pages.
   - A web app manifest.
3. **AEO content:**
   - Fill llms.txt and llms-full.txt with pricing, how-it-works, templates, use-cases and the FAQ.
   - Update the AI bot lists in robots.txt and crawler logging.
   - Log crawler visits on templates, use-cases, robots.txt and the sitemap.
   - Add an `ai` traffic source.
4. **Structured data:** escaping, WebSite, breadcrumbs, ItemList on `/templates` and `/use-cases`, Product/HowTo on template pages, and one Product per plan on `/pricing`.

Riddler Go's plan workflow puts these in Section 12/22 follow-ups. No migrations except the traffic-source value, if `source` is an enum (INFERRED).

### Phase 2: AdminIgloo builds `@adminigloo/seo` 0.1 (no tables)

- Test it in the AdminIgloo site, then on Riddler Go's staging.
- Riddler Go then swaps `components/seo/schemas.ts`, `JsonLd.tsx`, its robots builder and `llms-content` over to the package.
- No migration and no new environment variables, except `INDEXNOW_KEY` once IndexNow lands. The key file is served at `/{key}.txt`.

### Phase 3: `@adminigloo/aeo` 0.2 and `seo-reports` 0.2, built storage-interface-first

- Riddler Go replaces `lib/aeo/*` and the audit logic with package imports plus adapters over its existing tables.
- No migration. Its existing end-to-end tests (`e2e/admin/aeo-citations`, the vitest suites in `lib/aeo/__tests__`) are the acceptance gate.

### Phase 4: publish `@adminigloo/analytics` and build `search-console`

- Riddler Go adopts only the crawler half: logging across the whole proxy, IP verification and the AI-coverage reports.
- Write either to `analytics_crawler_hits`, a free table name and the only new migration in this plan, or to `ai_crawler_hits` through an adapter.
- Keep Riddler Go's own visitor analytics.
- Move `lib/gsc` onto the package through an adapter over `gsc_daily`.

### Phase 5: digest and anomaly engine, display components, content

- Then content work in Riddler Go: comparison pages ("Riddler Go vs GooseChase / Scavify / Let's Roam"), `/faq`, `/{orgSlug}` pages, a host control for listing events publicly, and programmatic long-tail pages.
- This is where answer-engine citations actually come from.

### Risks

- **Handoff.** ADR-0014 already blocks the handoff on one package (`ADR-0014.md`, Consequences, verified). Every extra package Riddler Go depends on makes that worse.
- Before each one is adopted, decide which handoff route it takes: a license plus a token the client owns, or vendored tarballs. Keep exact pins, and keep any package that Riddler Go adopts vendorable.
- If a token rotates, every build stops at the install step.
- Package upgrades must re-run Riddler Go's end-to-end tests and its colour-contrast and tap-target checks.

**Biggest lift for least risk:** Phase 0, then Phase 1 items 1 and 2. Of that, the keys, the redirects and the titles are done in under a day.

## 5. Traildek (and AdminIgloo) defects not to copy

### Traildek SEO

1. The brand is added to titles twice.
2. Pages without their own Open Graph block inherit the root's share tags.
3. The canonical falls back to the homepage when no URL is passed (`seo.ts:54`).
4. `Disallow: /_next/` hides every optimised image, and `/checkout/` doesn't block `/checkout` (`robots.ts:44-49`, verified).
5. `Claude-Web` is a retired bot name.
6. The sitemap and `/trails` are frozen at build time, and `lastmod` is always "now".
7. JSON-LD isn't escaped (`JsonLd.tsx`, verified), is split into unlinked nodes, uses `LandformFeature` (not a real schema.org type), and hard-codes `isAccessibleForFree`.
8. llms-full.txt's hard-coded text drifts from the real pages.
9. Cart and checkout are indexable.
10. The blog renders in the browser, so it isn't in the server HTML.
11. Lighthouse runs against live production and a redirecting URL.
12. Three separate definitions of the base URL.

### Traildek AEO and analytics

13. The AI-crawler panel can never fill, because it relies on the browser beacon, which bots don't run.
14. `bot_verified` and `sessions.user_id` are never written.
15. Sessions split every 30 minutes because the window is measured from `startedAt` (INFERRED).
16. The monthly budget is never enforced.
17. Cost misses the sentiment call and search fees.
18. Timeouts use `Promise.race` without aborting the request, so a retry can double-bill.
19. When the brand is mentioned but not linked, `cited_url` falls back to the engine's first source, often a competitor's.
20. A citation counts only when the name appears in the text.
21. Substring matching with no word boundaries: the "all trails" pattern matches ordinary prose.
22. The heatmap includes inactive questions.
23. The digest's citation rate counts failed calls in the denominator.
24. Two entries in the AI/search host lists can never match: `bing.com/copilot` and `brave.com/search` are paths, not hostnames.
25. `utm_source=chatgpt.com` is missed.
26. A stale "Vercel Pro" banner on the citation page.
27. Inconsistent permissions: running checks costs money but only needs reports access, while the backfill needs admin.
28. The Search Console query dimension undercounts totals (INFERRED).
29. Date ranges are built in browser-local time but bucketed in UTC.

### Model IDs: no hard retirements, but some stale choices

- Both Traildek (`aeoEngines.ts:84-89`) and Riddler Go (`engines.ts:84-87`) default to `gpt-4o`, `sonar`, `gemini-3.7-flash` and `claude-sonnet-4-6`.
  - `claude-sonnet-4-6` is still served, but it is the previous generation; `claude-sonnet-5` is current.
  - `gemini-3.7-flash` and `gpt-4o` are not verified (INFERRED).
- Traildek's sentiment check uses the dated id `claude-haiku-4-5-20251001`. Use the alias `claude-haiku-4-5`, as Riddler Go does (`engines.ts:91`).
- Traildek's Claude engine uses the older search tool `webSearch_20250305` (`:483-486`, verified). Use `web_search_20260209`, as Riddler Go does (`engines.ts:432`).
- Store prices per model, not per engine, so an overridden model doesn't throw off cost figures.

### Riddler Go and AdminIgloo

- Riddler Go and the AdminIgloo site also inject unescaped JSON-LD.
- Riddler Go counts AI sites as organic traffic.
- AdminIgloo's `robotsBlocks` gives false passes.
- `aeo` 0.1.1 leaks across tenants.
- The AdminIgloo site's AEO asker has no web search, so it measures what the model remembers from training, not live AI search.

Most of the Riddler Go facts above (environment variables, cron routes, table collisions, titles, sitemap, slug redirects, robots files) I re-checked myself. These came from the inventories' live checks and I did not repeat them:
- the www duplicate site;
- the manifest 404;
- the missing share images on `/pricing` and `/how-it-works`;
- the sitemap URL counts.