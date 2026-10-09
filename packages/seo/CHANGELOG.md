# @adminigloo/seo

## 0.1.0

### Minor Changes

- First release: search and answer-engine plumbing for an app's own site, with no database. It is lifted from trailcards (13 JSON-LD builders, the robots and sitemap files, the llms routes, the per-deck share image), Riddler Go (`components/seo/schemas.ts` and its test, `JsonLd.tsx`, the one path list behind robots and noindex, the llms content) and the AdminIgloo site (the production-only indexing rule). It keeps the best of each and fixes the defects found in all three.

  **The site and its one path list**
  - `defineSite({ url, name, indexable, description, image, twitter, paths, trailingSlash })`. `indexable` is required: one decision behind the robots meta tag, the `X-Robots-Tag` header, robots.txt, the sitemap, llms.txt and IndexNow. A missing `url` throws with the CI fallback in its message.
  - `isIndexable({ env, host, productionHosts })` is production only and fails closed. It refuses a missing env or host, localhost, IP addresses and platform preview hosts. With `productionHosts`, only those hosts qualify, so a www duplicate refuses crawlers until it redirects.
  - `definePaths({ public, private, noindex })`. Matching is by whole segment and trailing slashes are ignored, so Riddler Go's `NOINDEX_PREFIXES` ("/x/" and "/x" pairs) goes in as written. It refuses `/_next/`, `/` as private, a path in two lists, and a public page inside a private or noindex area.
  - The path list decides everywhere: robots.txt, the header and meta tag, the sitemap, llms.txt and IndexNow never list, announce or block a path differently.
  - `robotsHeader(site, pathname, { extra })` gives the proxy's `X-Robots-Tag` value; `extra` adds `noarchive`, `nosnippet`, `noimageindex` or `notranslate`.

  **Metadata**
  - `pageMetadata(site, page)` returns an object Next's `Metadata` type accepts, with no runtime dependency on Next.
  - The canonical is always the page itself. `path` is required, with no homepage fallback. Campaign parameters are dropped, and another host is refused.
  - The brand is in the title once. The title is written as `{ absolute }`, so a layout template cannot double it, and a title that already names the brand gets no suffix (`brandTitle`; a hyphenated word such as "Go-Kart" does not name "Go").
  - Open Graph and Twitter are always complete: site name, locale, URL and a share image (the page's, else the site default).
  - noindex is one switch, and a noindex or private path or an off-production site forces it.
  - Language and type alternates are written as absolute URLs.
  - `siteMetadata(site)` gives the root layout's defaults, deliberately without a canonical or `og:url`.

  **Dates**
  - Every date is a real calendar day (`2026-02-30` is refused, not rolled into March) and every date-time carries a time zone. A string with an offset keeps it as written; a date-time without one is refused, because `new Date()` would read it in each server's own zone. A `Date` is written in UTC.

  **Structured data**
  - 18 builders: `organization` (with `sameAs`), `webSite` (with an optional SearchAction), `webPage` (with an optional `faq`), `collectionPage`, `speakable`, `breadcrumbList`, `product` (Offer with subscription billing, shipping and returns, AggregateRating, Review), `softwareApplication`, `event`, `howTo`, `faqPage`, `article`, `blogPosting`, `itemList`, `person`, `place`, `touristAttraction` and `localBusiness`.
  - `product`, `softwareApplication` and `event` check by default what Google's rich result for the type requires: a Product's offer, rating or rated review, and an image once it has offers (a merchant listing); a Software App's price and rating or review; an Event's start date; a rating on every product or app review. `richResult: false` describes the thing without those (a plan with no public price, an app with no ratings yet, an undated event) and is not eligible for a rich result.
  - Events: `previousStartDate` for a rescheduled event (required), and moved-online needs online or mixed attendance.
  - `localBusiness` takes no rating: it is the site's own business, and Google ignores ratings a business publishes about itself. Opening hours run 00:00 to 23:59.
  - A logo is never an `.ico`, and `sameAs` never points at the site itself.
  - Subscription billing is a UnitPriceSpecification with `billingIncrement`, never `referenceQuantity` (which merchant listings read as unit pricing). Shipping writes one DefinedRegion per country.
  - Every node has a stable `@id` (`{origin}/#organization`, `{page}#webpage`…) and links by reference.
  - `graph()` emits ONE `@graph`. It drops an exact duplicate and throws when two different nodes share an `@id`, or when two page nodes describe one URL (an FAQ on a page goes in `webPage({ faq })`, one node typed WebPage and FAQPage).
  - `unresolvedRefs(...blocks)` lists the references a page's JSON-LD makes that no rendered node defines.
  - Every `@type` comes from a closed list of real schema.org types, so no "LandformFeature".
  - No business fact is defaulted: `isAccessibleForFree`, stock status and country are never filled in for you.
  - Empty values never reach the output, so no `"sameAs": []`.
  - Each builder throws one `SeoError` listing every problem with its input. `tryNode()` builds from bad data without failing the page.
  - `aggregateRatingFrom(ratings, { min })` averages raw ratings and returns nothing below a credibility threshold.
  - `serializeJsonLd` escapes `<`, `>`, `&`, U+2028 and U+2029, so `</script>` in a value cannot close the element. `jsonLdScript` and `jsonLdScriptProps` use it, and so does `<JsonLd/>` (`./react`), which is server-safe with no `"use client"`.

  **robots.txt**
  - `robotsPolicy(site, options)` returns Next's `MetadataRoute.Robots` shape; `robotsTxt()` writes the text.
  - Each private path is written as `Disallow: /e$`, `/e/` and `/e?`: the path, everything under it and its query strings, never a page that only starts with the same letters (Riddler Go's org-slug event pages). robots.txt agrees with the noindex header on every path, and a test holds it to that. noindex paths stay crawlable, and `/_next/` is never blocked.
  - The AI-bot list is `@adminigloo/analytics`' crawler list, compiled in (`KNOWN_CRAWLERS` plus `ROBOTS_CONTROL_TOKENS`). It carries the current names (OAI-SearchBot, Claude-SearchBot, Claude-User, Perplexity-User, Amzn-SearchBot, Meta-WebIndexer…) and never the retired Claude-Web. An app running analytics passes its own list as `crawlers`. `ROBOTS_BOTS_SOURCE` says which analytics version and list a build carries, and `botListFingerprint` compares lists. A change to analytics' list fails this package's tests until a release of this package is queued.
  - AI bots are allowed or refused by what they do: `training`, `search` or `userFetch`. Classic search, link previews and SEO tools are set by class, and any bot by name or token. An override that robots.txt cannot express (a bot with no token, a token with spaces) is refused.
  - Each allowed AI bot gets its own group repeating the private rules (`combine: true` for the compact form).
  - Off production the file is `Disallow: /` and nothing else.
  - `isAllowedByRobots(text, token, path)` evaluates any robots.txt per RFC 9309, with a crawler's fallback tokens (`["Googlebot-Image", "Googlebot"]`).

  **Sitemaps**
  - `lastModified` is a required key: the date from your data, or `null`, which writes no `<lastmod>`. Nothing ever writes "now", and future or invalid dates are refused.
  - URLs must be on the site's own origin and outside every private and noindex path. A URL listed twice keeps its newest date. `onInvalid` skips and reports a bad row instead of throwing.
  - Images and hreflang alternates. Priority is a plain decimal. Off production there are no entries.
  - `toNextSitemap` gives the `app/sitemap.ts` shape; `sitemapXml` and `sitemapIndexXml` give raw XML.
  - `buildSitemaps` splits past 50,000 URLs or 50 MB into files under an index, served from the root (`/sitemap-0.xml`). Each file's `<lastmod>` in the index is its newest entry's.

  **llms.txt and llms-full.txt**
  - `llmsTxt` and `llmsFullTxt` are built from a content registry the app supplies: sections of pages (or of items with no page, or of Markdown text), how it works, pricing plans, the FAQ and contact. The package writes structure, never prose.
  - Every line under a heading of llms.txt is a `- [name](url): notes` link, the shape llmstxt.org's parser reads. The FAQ is one link, or one per question with its own `path`.
  - The index links the full file (`fullPath: false` when the site has none) and the sitemap. No link goes under a private or noindex path.
  - Byte budgets: 50 KB and 200 KB by default. Optional sections go first, then (full file) bodies are shortened to summaries, then items from the end of the longest list, each list saying how many it left out and where. The result never exceeds the budget.
  - `llmsResponse` sets browser-only caching and `X-Robots-Tag: noindex`. Off production both files are empty and the response is a 404.

  **IndexNow**
  - `indexNowKeyFile(key)` gives the key file to serve.
  - `submitUrls(site, urls, { key })` checks the URLs are on your host and inside the key file's folder, refuses a private path, leaves out a noindex one (`excluded`), de-duplicates, batches at 10,000 per POST and reports each batch's status without throwing. It takes an injected `fetch` and a timeout, and sends nothing off production.

  **Share image (`./og`)**
  - `ShareImage` / `shareImageResponse` are a generic 1200×630 card for `next/og` (an optional peer). Brand, eyebrow, title, badge, description and footer, an optional hero image or a lettered panel, and a `theme` with an optional gradient `backgroundImage`.
  - Fonts are bytes you already have, or a URL `loadFont` fetches once per instance, falling back to the default font on failure or timeout without caching the failure.
