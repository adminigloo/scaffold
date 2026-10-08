# Traildek (C:\Users\dalli\trailcards) classic SEO inventory, for porting into AdminIgloo and then Riddler Go

## Bottom line

Traildek has a wide SEO surface, and some of it is ahead of a typical Next.js site:
- 13 schema.org builders.
- Database-driven pages for every trail, with real data on them.
- Generated social images per deck and collection.
- A weekly crawl of its own sitemap.
- Google Search Console data pulled in nightly, with no extra libraries.
- Real-visitor speed data (Core Web Vitals).
- AI copywriting tools with answer-engine rules built in.

The basics have real bugs, though. I confirmed these in a production build on disk (`.next/`, built 2026-10-06 with `NEXT_PUBLIC_APP_URL=localhost:3000`) rather than reading the code alone. The port should copy the ideas, not the code as it stands.

Scope: classic SEO only. The AI citation tracker belongs to the other agent, and I did not look at riddler-go.

---

## 1. Page titles, descriptions and canonical links

**1.1 `src/utils/seo.ts` `generateMetadata(config)`** (seo.ts:48-94)
- Builds title, description, `metadataBase`, canonical, the full Open Graph block (1200×630 image, locale, article times), the Twitter large-image card, and a `noIndex` switch.
- Generic. Only "Traildek", the default description and `/og-image.jpg` are hard-coded (seo.ts:29-31, 55).
- Only 2 pages use it: `subscribe/page.tsx:4` and `account/subscription/page.tsx:4`. Every other page writes its metadata by hand.
- **Bug (confirmed):** when no `url` is passed, the canonical falls back to the homepage (seo.ts:54). `/subscribe` ships `<link rel="canonical" href=".../">`, which tells Google it is a copy of the homepage.
- Base URL comes from an environment variable and logs an error if it is missing in production (seo.ts:14-28). However, `sitemap.ts:13` and `layout.tsx:18` each define their own base URL that falls back to `traildek.com`. That is three definitions of the same value.

**1.2 Root layout defaults** (`src/app/layout.tsx:20-93`)
- Title template `%s | Traildek`, keywords, authors/creator/publisher, `formatDetection` off, site-wide Open Graph and Twitter tags.
- Tells Google to allow large image previews and full-length snippets (layout.tsx:71-81).
- `verification` codes are commented out (layout.tsx:82-86).
- `themeColor` is set in the viewport, and `<html lang="en">` is set.

**1.3 Per-page metadata.** Every public route sets a title and description, and most set a canonical (trails, decks, collections, legal, contact, support, wholesale, go, our-story, blog index, bundles, orders/lookup). `/qr-info`, `/shipping-returns`, `/cart` and `/checkout` have no canonical.

**Two site-wide bugs, both confirmed in the built HTML:**
- **The brand name appears twice in titles.** Pages put "| Traildek" in their own title, and the root template adds it again. Built examples: "All Trail Decks | Traildek | Traildek", "Our Story — Traildek | Traildek", "Subscribe | Traildek | Traildek". The home page is "Traildek — The Trail Atlas Series | Traildek". The cause is code like `trails/[slug]/page.tsx:171` and `decks/[slug]/page.tsx:127` combined with the template at layout.tsx:24. The admin form says a meta title of about 60 characters is ideal, but at runtime the suffix is added twice.
- **Social tags come from the root layout on most pages.** Pages that set a canonical but no Open Graph block inherit the root's tags. In the build, /decks, /collections, /our-story, /go, /contact, /privacy, /blog and /cart all have `og:title` = "Traildek - Premium Hiking Trail Card Decks" and `og:url` = the homepage. Pages that set their own Open Graph block without an image (`/trails`, trails/page.tsx:19-25) lose the default image. INFERRED: that last point follows from Next's merge rules; I did not render it.

**1.4 Language alternates (hreflang):** none. The site is single-locale en-US.

## 2. Social sharing images

**2.1 Generated per-page images**
- Files: `src/app/(shop)/decks/[slug]/opengraph-image.tsx` and `src/app/(shop)/collections/[slug]/opengraph-image.tsx`.
- Built with `next/og` on the edge runtime at 1200×630. Data comes from the Neon HTTP driver (`dbEdge`, `src/server/db/edge.ts`).
- The EB Garamond font is fetched once per server instance and reused; if the fetch fails it falls back to a serif (decks:40-51).
- The deck image shows the collection name, a trail-count badge, a short description, the URL and the hero image. If there is no hero image it draws a pattern with the first letter.
- How generic: the layout is generic; the brand colours (decks:32-37) and the "TRAILDEK" wordmark are Traildek-specific.
- The plan called for a trail-page version (SITE-REWORK-PLAN.md:570). **It was not built.**
- INFERRED: the generated file wins over the hero image named in `generateMetadata` (decks:143-151), so Twitter and Open Graph may show different images.

**2.2** A static `public/og-image.jpg` and `public/logo.png` exist and serve as the defaults.

## 3. Structured data (schema.org JSON-LD)

**3.1 Builders in seo.ts.** Each returns a JSON string.
- Used: Organization (117), Product with Offer and optional AggregateRating (153), WebPage with isPartOf and breadcrumb (242), BreadcrumbList (280), FAQPage (300), Speakable (333), Person for author credibility (363), TouristAttraction with location, address and booking page (457), Place for landform features (500), ItemList (550).
- Built but **unused**: Article (200), LocalBusiness (405), `getJsonLdScriptProps` (577).
- Default organization data (588-599) has an empty `sameAs`, so the built HTML ships `"sameAs":[]`.

**3.2 Written inline in pages:**
- CollectionPage with ItemList, plus Place/PostalAddress for geographic collections (collections/[slug]/page.tsx:112-146).
- ContactPage, made by retyping the WebPage output (contact/page.tsx:17-34).
- A second TouristAttraction node carrying AggregateRating and ImageObject (trails/[slug]/page.tsx:275-301).

**3.3 Where each type is used**

| Page | Structured data |
|---|---|
| Every page | Organization (layout.tsx:133) |
| Trail | Breadcrumb, TouristAttraction, Place (when coordinates exist), extra TouristAttraction for ratings/photos |
| Deck | Product/Offer, Breadcrumb, FAQPage |
| Collection | Breadcrumb, CollectionPage/ItemList, Place |
| /trails | Breadcrumb, ItemList |
| /decks, /collections | Breadcrumb |
| /our-story | WebPage, Speakable, Person |
| /go | WebPage, Speakable |
| Privacy / terms / cookies | Breadcrumb, WebPage with dateModified |
| Contact, support, wholesale, vote-next-state | WebPage / ContactPage |
| Home | Organization only |
| Blog posts | Nothing |

**3.4 `JsonLdScript`** (`src/components/JsonLd.tsx:1-8`) injects the raw JSON **without escaping `<`**. User-uploaded photo captions (`uploadthing/core.ts:130`, up to 280 characters, no character filter) go into the trail-page structured data (trails/[slug]/page.tsx:295). INFERRED low risk because a caption must be approved and featured by an admin first. The package version must escape `<` as `\u003c`.

**3.5 Validation**
- The only check is that each JSON-LD block parses, inside the weekly sitemap audit (sitemapAudit.ts:205-216).
- There is no typed schema library, no Rich Results Test in CI (planned at SITE-REWORK-PLAN.md:198, not built), and **no unit tests for any seo.ts builder**.

**3.6 Schema problems**
- Two separate TouristAttraction nodes for the same trail with no `@id` linking them (trails:245, 277).
- Organization, Person and WebPage are not linked into one `@graph` (our-story/page.tsx:33-60 emits two separate WebPage nodes).
- `additionalType: https://schema.org/LandformFeature` (seo.ts:512): INFERRED invalid, because schema.org has `Landform` but no `LandformFeature`.
- `isAccessibleForFree: true` is hard-coded (trails:252), which is wrong for fee areas.
- Deck Product data never passes a rating even though approved reviews are loaded (decks:197-205 against 267-282). Item 4 on the plan's own highlights list ("AggregateRating on every deck", SITE-REWORK-PLAN.md:1342) was not delivered.
- Stock status says out-of-stock when inventory isn't tracked and quantity is 0 (decks:276-280; INFERRED, depends on data).
- The Offer has no `shippingDetails`, `hasMerchantReturnPolicy` or `priceValidUntil`, so it is incomplete for Google merchant listings.
- On deck pages the structured breadcrumb says "Collections" while the visible one says "Decks" (decks:284-295 against 320-322).
- No WebSite node anywhere, so Google has no structured site name, and there is no SearchAction (the site has no search page).
- Background, not verified in code: Google limited FAQ rich results to government and health sites in 2023, removed HowTo results, and Speakable is a news-only beta. Those markups mostly help AI answer engines now, not Google results.

## 4. Crawler control

**4.1 `src/app/robots.ts`**
- Everyone may crawl, with private paths blocked: `/admin/ /api/ /account/ /checkout/ /cart /_next/ /sign-in /sign-up` (robots.ts:41-50).
- Facebook and Twitter preview bots are explicitly allowed (63-64).
- 10 AI bots are explicitly allowed, each repeating the private-path blocks (28-39, 71-75): GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-Web, Google-Extended, PerplexityBot, CCBot, Applebot-Extended, Bytespider.
- Includes the sitemap URL and a `host` line. The policy is written up in a comment (robots.ts:4-26).
- How generic: very; only the path list is app-specific. It is served as a fixed file built at deploy time.
- **Bugs:**
  - `Disallow: /_next/` (robots.ts:47) blocks `/_next/image`, which is where every optimised image is served from. That blocks Google Images from the whole site and blocks the CSS/JS Google needs to render pages. Confirmed in `.next/server/app/robots.txt.body`.
  - `/checkout/` with a trailing slash does not block `/checkout` itself.
  - `Claude-Web` is a retired name. Missing newer bots: Claude-SearchBot, Claude-User, Perplexity-User, Meta-ExternalAgent, Amazonbot, DuckAssistBot, MistralAI-User.

**4.2 `src/app/sitemap.ts`**
- Built from the database. Includes:
  - 10 static pages with priority and change frequency (19-83).
  - Active collections (89-103).
  - Published decks, but only those with an active product, so the sitemap never lists a page that would 404 (106-135).
  - Every trail card in a published deck (138-158).
  - Blog posts, published and not future-dated (164-181).
  - `/blog` and `/bundles` only when they have content, to avoid listing thin pages (183-207).
- Comments explain why redirect URLs are left out (27-29, 85-86).
- **Defects (confirmed in the build):**
  - It is a fixed snapshot taken at build time (`/sitemap.xml` has no revalidation). New trails, decks and posts don't appear until the next deploy. `/trails` has the same problem.
  - Static pages use the current time as `lastmod`, so every page always looks freshly modified.
  - Missing indexable pages: `/go`, `/wholesale`, `/vote-next-state`, `/shipping-returns`.
  - No images in the sitemap and no splitting into multiple sitemap files.
- Local data snapshot: 68 California trail pages are listed while the California deck (no active product) is not. INFERRED: those deck pages 404 (decks:85-106), so 68 "Buy the deck" links and booking-page references point at a 404.

**4.3 `llms.txt`** (`src/app/llms.txt/route.ts`)
- Refreshed hourly (19), with an HTTP cache header (131-136).
- A curated Markdown index: site summary, collections, decks with trail counts, every trail, key pages.

**4.4 `llms-full.txt`** (`src/app/llms-full.txt/route.ts`)
- The full content dump: About, QR, privacy, terms and cookies text, every collection and deck description, and for every trail its stats, coordinates, elevation, best season, description and trail notes (207-297). It is 75 KB in the build.
- How generic: the format is generic; the queries are Traildek-specific.
- **Content drift:** the static text is hard-coded (28-89). It says QR codes give "live conditions, GPX download, turn-by-turn", while the real `/qr-info` page says "Coming Soon" (qr-info/page.tsx:18-25). That feeds AI engines claims the site doesn't make.
- `llms.txt` doesn't link to `llms-full.txt`.
- No `ai.txt`.

**4.5 Pages hidden from search (noindex)**
- Only `account/subscription` (through seo.ts) and the investor-report preview (`admin/analytics/report-preview/[reportId]/layout.tsx:12-18`).
- Cart, checkout, checkout/success, orders/lookup, support/[ticketNumber], the empty `/qr-info` and all of `/admin` are indexable (confirmed for cart). Robots.txt blocking doesn't stop a URL from being indexed.
- `/admin` has no search-hiding tag; it relies on the login wall.

**4.6 Redirects, trailing slashes and 404s**
- `next.config.ts:36-59` sets permanent redirects: /regions→/collections, /regions/:slug→/collections/:slug, /about→/our-story, /hiking-prep→/go.
- `/products` permanently redirects to `/decks` (products/page.tsx:9-11).
- `/products/[slug]` looks up the product's deck and permanently redirects to `/decks/{deckSlug}`, or returns 404 rather than dumping old URLs onto the catalog page (products/[slug]/page.tsx:10-36).
- Trailing slashes use the Next default.
- No custom `not-found.tsx` (Next's default 404, which marks itself noindex).
- No table recording old slugs, so renaming a slug breaks its old links.

## 5. Pages built for search

**5.1 Trail pages** (`/trails/[slug]`, 563 lines). This is the core of the programmatic SEO.
- Only shows a trail if it is a trail card in a published deck (54-61).
- Title "{Trail} Trail | {Deck}"; description is the trail description cut at 155 characters (164-201).
- Content:
  - Stats in a semantic `<dl>`: duration, distance, elevation, route type (400-421).
  - Best season.
  - "About this Trail".
  - Trail notes as a bullet list, marked in the code as an "AEO citation surface" (459-471).
  - **Live conditions** from NOAA weather and NPS park alerts, rendered on the server (ConditionsPanel; trailConditions.ts uses a database cache, falls back gracefully and rate-limits; a cron refreshes it every 30 minutes, vercel.json:9).
  - Hiker check-ins (CompletionButton).
  - Ratings averaged only once there are at least 3, to keep the data credible (115-118).
  - Featured approved photos in the structured data (121-135).
  - A "Buy the deck — see all N trails" call to action.
  - 3 related trails, same section first, then same deck (86-93).
- Traildek-specific data; generic pattern.
- Weak spots:
  - The photo gallery loads in the browser, so it isn't in the server HTML (PhotoGallery.tsx:1, 30).
  - The trails table has no meta-description field.
  - `loadTrail` runs in both `generateMetadata` and the page without `cache()`, so the database queries and conditions lookup run twice per request (166, 205; INFERRED).
  - Detail pages are fully dynamic, rendered fresh on every request.

**5.2 Deck pages** (`/decks/[slug]`)
- Admin-editable meta title, description and FAQ items.
- FAQs use native `<details>` so the answers are in the HTML (DeckDisclosures.tsx:73).
- Long description kept below the fold "for SEO" (455-465).
- Approved reviews and related decks from the same collection.
- A per-deck QR code (`/api/qr/decks/[slug]`) tagged `utm_source=qr&utm_medium=physical&utm_content=slug`. The canonical tag keeps those tagged visits from looking like duplicate pages.

**5.3 Collection pages** (`/collections/[slug]`): geographic collections carry `geoState` and `geoCountry`, a long description, and the deck grid.

**5.4 Index pages:** `/trails` (ItemList of every trail), `/decks`, `/collections`.

**5.5 Trust and expertise pages**
- `/our-story`: founder Person data, Speakable, and image alt text that describes the scene.
- `/go`: a prep checklist plus links out to trusted resources.
- Legal pages carry a `dateModified`.
- **Nested `<main>`:** the shop layout already has `<main>` (layout.tsx:20), and our-story:65 and go:60 add another, which also breaks the Speakable selector `main p:first-of-type`.

**5.6 Blog**
- Content loads in the browser through `trpc...useQuery` (BlogPostContent.tsx:1, 24), so it is not in the server HTML.
- Post pages have no canonical and no Article data, even though a builder exists (blog/[slug]/page.tsx:13-43).
- It is the weakest page type.

## 6. Internal linking and breadcrumbs

- Visible `<nav aria-label="Breadcrumb">` on trail, deck, collection and trail-index pages.
- Related trails and related decks.
- **Gap:** the header and footer never link to `/trails` or `/collections` (Header.tsx:26-44, Footer.tsx:21-119). No deck page or home section links to any trail page. TrailCard is used only on `/trails` and in related trails, so 128 trail pages are found only through the sitemap and llms.txt.
- No hub-and-spoke structure, no "trails near here", no collection pages that list trails.

## 7. Image SEO

- 35 shop files use `next/image` with `sizes`; hero images load with `priority`, and the home hero sets `fetchPriority` (AtlasHero.tsx:99-100).
- Allowed remote image hosts are set (next.config.ts:25-33), and connections to image hosts are warmed early (layout.tsx:124-132).
- Admin alt text:
  - An editable `altText` on product media, with a gold "needs description" marker (ImageUploader.tsx:556, 795).
  - The deck carousel uses `altText`, falling back to the deck name (decks:256).
  - An AI alt-text suggestion exists but is never shown in any screen (AISuggestButton.tsx:25-26; only intro, meta description and FAQs are wired).
- **Gaps:**
  - `TrailCard` uses a raw `<img>` with no width, height or lazy loading (TrailCard.tsx:37-42), which risks layout shift.
  - There is no image sitemap.
  - The robots.txt `/_next/` rule above blocks Google Images entirely.

## 8. Page speed (Core Web Vitals)

**Real-visitor data**
- `WebVitalsReporter` (shop layout:26; WebVitalsReporter.tsx:37-44) sends LCP, CLS and INP through the consent-gated analytics beacon as `session_events` rows.
- `analytics.getWebVitals` computes the 75th percentile in SQL for the whole range, per day, and optionally per path (routers/analytics.ts ~1037).
- Google's thresholds live in `src/lib/analytics/webVitals.ts:21-28`.
- Admin card: `CoreWebVitals.tsx` (AnalyticsDashboard.tsx:871).
- 12 tests (`webVitals.test.ts`). Generic.

**Lab checks and budgets**
- Lighthouse CI fails a PR below SEO 95, Performance 85, Accessibility 90, Best Practices 85 (`.lighthouserc.json:18-24`; `.github/workflows/pr.yml:38-42`).
- It runs against **live traildek.com**, not the PR preview, and includes `/about`, which redirects. Deck, trail and collection pages were planned (SITE-REWORK-PLAN.md:202) but are not in the list.
- Bundle size budgets: main 250 kB, framework 200 kB gzipped (bundlesize.config.json; `BUNDLE_BUDGETS.md`).
- The accessibility check (pa11y) and schema check planned for CI were not built (planned at SITE-REWORK-PLAN.md:196-198).

**Phase 8 performance work** (`docs/baselines/PHASE8-CHANGES.md`): next/image migration, fonts via next/font with `swap`, below-the-fold `next/dynamic` imports that still render on the server, explicit image sizes to prevent layout shift. The doc says "Claude cannot run Lighthouse", so **the before/after scores were never measured**.

## 9. Measurement and maintenance (the strongest part)

**9.1 Google Search Console ingest** (`src/server/services/gscIngest.ts`)
- Signs the Google service-account login itself with Node's built-in crypto, so no Google library is needed (112-133).
- Pulls one day at a time by page and query, including provisional data, 25k rows per page with an 8-page cap (218-259). Replaces the day's rows each run, so re-runs are safe; `?date=` backfills a past day.
- Table: `gsc_daily` (schema/gsc.ts).
- Router (`routers/gsc.ts`): status, daily trend with click-through computed from totals and position weighted by impressions, top queries, top pages.
- Admin card `SearchPerformance.tsx` shows an empty state naming the missing env vars when not configured.
- Cron daily at 06:00 (`api/cron/gsc-pull`). 16 tests. **Fully generic.**

**9.2 Sitemap health audit** (`src/server/services/sitemapAudit.ts`)
- Fetches the live sitemap, following one level of sitemap index.
- Checks up to 500 URLs, 5 at a time, 10-second timeout each.
- Does not follow redirects, so a redirecting sitemap URL is itself flagged (230-265).
- Per page: HTTP 200, a title, a meta description, canonical matches the sitemap URL (normalised; query strings count), every JSON-LD block parses, no noindex.
- Failures are written to `error_logs` with first-seen dates, updated in place on repeat, and auto-resolved when the URL recovers or leaves the sitemap (282-441). Each row includes a ready-made `claudeContext`.
- Admin card `SitemapHealth.tsx`. Weekly cron (vercel.json:13). 14 tests. **Generic.**
- It does not check internal links (the California 404s would not show up).

**9.3 Weekly digest and annotations**
- The weekly digest includes a sitemap line and a Search Console week-over-week comparison (analyticsDigest.ts:277-280, 502-508).
- The `change_log` annotations table (the planned `seoChangeLog`, schema/change-log.ts:24-44) draws markers on charts (TrendWithAnnotations).

**9.4 Traffic sources and attribution**
- `classifySource` sorts visits into organic, AI assistant, QR and other buckets (classifySource.ts:1-17, 35-75). The file says it was "ported from Riddler's classifier".
- A daily rollup attributes revenue to the landing content.
- AI crawler hits are counted only from crawlers that run JavaScript; the code admits this undercounts (aiReport.ts:99). There is no server-side crawler log.

## 10. Admin authoring tools for search copy

- Deck settings "Storefront Copy · SEO + AEO" panel (`admin/card-builder/decks/[id]/settings/page.tsx:500-580`):
  - Short description with character and word counts.
  - Meta title with a "/ 60 chars ideal" hint.
  - Meta description targeting 140-160 characters.
  - A FAQ editor with AI-generated FAQs (252-286).
- Meta fields also exist for collections (`CollectionModal.tsx`), products and blog posts.
- AI writer (`aiAuthor.ts`):

| Function | Line | Shown in admin? |
|---|---|---|
| Deck meta description (`proposeDeckMetaDescription`) | 241 | Yes |
| Deck intro, 60-100 words in direct-answer style (`proposeDeckIntro`) | 280 | Yes |
| Deck FAQs, 4-6 via Sonnet (`proposeDeckFAQs`) | 322 | Yes |
| Trail meta description (`proposeTrailMetaDescription`) | 388 | No |
| Image alt text (`proposeImageAltText`) | 432 | No |
| Collection description (`proposeCollectionDescription`) | 471 | No |

- All outputs are schema-checked and cost-tracked.
- Brand voice guide with **answer-engine formatting rules** (aiAuthor.brandVoice.ts:59-72): the first sentence must stand alone as the answer, and the first 40-60 words must be fact-rich.
- Bulk writer `/admin/ai-author` fills missing deck meta descriptions one after another.
- **Missing:** a preview of how the page looks in Google results, a slug and redirect manager, a broken-link checker, per-trail meta fields, and an SEO audit page (the AdminIgloo `@adminigloo/seo-reports` package and its create-app `seo-admin` add-on cover part of this).

## 11. Not present at all

IndexNow or any search-engine ping on publish, cache refresh on publish (`revalidatePath`), RSS or Atom feeds, WebSite/SearchAction data, Article and LocalBusiness data on any page, HowTo, sitemap splitting, hreflang, a web app manifest or apple-icon (only `icon.svg` and `favicon.ico`), a custom 404, verified AI-crawler logging (`@adminigloo/analytics` already has `crawlers.ts`), structured-data tests or validation in CI.

## 12. What carries over to any project, and what to change for Riddler Go

**Generic, port as is:**
- The metadata builder, after fixing the canonical fallback and the template double-suffix.
- All 13 schema.org builders, with `@id`/`@graph` linking and escaping added.
- The robots policy, made configurable per site.
- The sitemap builder pattern, rebuilt as a function apps pass their own data to.
- The generic llms.txt / llms-full.txt generator, fed by a content registry rather than hard-coded text.
- The generated social image template.
- Search Console ingest with its router and card.
- The sitemap audit with its open/resolve lifecycle.
- Core Web Vitals collection with the 75th-percentile SQL and card.
- The Lighthouse and bundle budgets.
- The AI writer service with the answer-engine voice rules, made per-brand.

**Traildek-specific, re-implement per app:**
- Trail, deck and collection queries.
- TouristAttraction and Place mappings. For Riddler Go these become Place/Event/Game types (INFERRED).
- NOAA and NPS conditions.
- The QR tracking tags.
- Brand colours and fonts.

**Already partly overlapping in scaffold** (seen only from file listings):
- `@adminigloo/seo-reports` (sitemap crawl audit with page and site checks for title, h1, canonical, Open Graph, robots, image alt, headings, robots.txt and llms.txt).
- `@adminigloo/analytics` `crawlers.ts`.
- **There is no `@adminigloo/seo` package for metadata, structured data, sitemap, robots and llms.txt.** That is the missing package.

**Cross-reference:** `ANALYTICS-AEO-V2-PLAN.md:4` says `riddler-go/docs/plans/22-admin-monitoring-and-reporting/PLAN.md` phases 22.f-22.h are "the same capability set" and are being kept in sync. SITE-REWORK-PLAN.md §8 also cites "Riddler lessons".

## 13. What makes it better than a typical Next.js site, ranked

1. **Every trail is its own page built from real data.** 128 trail pages in the local snapshot, with stats in semantic markup, coordinates, best season, trail notes, live NOAA and NPS conditions, check-ins and a rating shown only once it is credible. Most sites have nothing like this, and it compounds as data grows.
2. **The site checks itself.** A weekly crawl of its own sitemap tracks failures with first-seen dates and auto-resolves them, feeds the errors page and the weekly digest, and tells you about SEO regressions without you looking.
3. **Search Console data lives in the app's own database.** Nightly, with no extra libraries, aggregated correctly (click-through from totals, position weighted by impressions), shown in admin and in the digest.
4. **More structured data than usual.** TouristAttraction, Place, FAQPage, Product, CollectionPage/ItemList, Person, Speakable and Breadcrumb on most public pages. It also has the quality problems listed in §3.6.
5. **AI search basics in place.** llms.txt plus a 75 KB llms-full.txt built from the database, and an explicit allow-list for AI crawlers (with the `/_next/` bug).
6. **AI copywriting with answer-engine rules built into the brand voice.** Meta descriptions, direct-answer intros and FAQs, schema-checked and cost-tracked, with a bulk mode.
7. **Real-visitor Core Web Vitals,** computed at the 75th percentile in SQL, plus Lighthouse SEO ≥95 and bundle budgets enforced in CI. The Lighthouse step points at the wrong URLs.
8. **Generated social images per deck and collection** on the edge runtime with a database read, a cached font and a fallback design.
9. **Careful URL handling.** Redirects that look up the database, avoidance of soft-404s, and only canonical, live URLs in the sitemap.
10. **Change markers on charts** (the change_log), so you can see which release moved the numbers.

**Not "the best" yet — the fixes to bake into the package from day one:**
1. Titles get the brand name twice.
2. Open Graph tags are inherited from the root on most pages.
3. `/subscribe` points its canonical at the homepage.
4. Robots.txt blocks `/_next/`, which hides every optimised image.
5. Sitemap and `/trails` are frozen at build time.
6. Trail pages have almost no inbound links.
7. The blog renders in the browser with no canonical or Article data.
8. Structured data isn't escaped, linked with `@id`, or tested.
9. The text in llms-full.txt has drifted from the real pages.
10. No IndexNow or refresh on publish.
11. No WebSite data.