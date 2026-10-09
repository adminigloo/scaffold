# @adminigloo/seo

Everything a search engine and an answer engine read from your site, built from one site definition and one path list, with no database.

- **Page metadata** whose canonical is always the page itself, with the brand in the title exactly once and a complete share card on every page.
- **Structured data** (schema.org JSON-LD) from 18 typed builders, linked by `@id` into one `@graph`, escaped so a value can never close the script tag. By default each builder refuses what Google's rich result for its type would report as invalid.
- **robots.txt** from the path list and the same AI-bot list `@adminigloo/analytics` counts crawlers with: allow or refuse AI training, AI search and assistants separately. Everything is blocked off production.
- **Sitemaps** with real last-modified dates (never "now"), images and language alternates. They split into a sitemap index past 50,000 URLs or 50 MB.
- **llms.txt and llms-full.txt** from your own content registry (pages, pricing, how it works, FAQ), with byte budgets.
- **IndexNow**, so Bing and the other participating engines hear about a page the moment it is published.
- **A share-image template** for `next/og`.

The path list is the one source for robots.txt, the noindex header and meta tag, the sitemap, llms.txt and IndexNow. A path the list calls private or noindex is never listed, never announced and never blocked by accident somewhere else.

No tables, so nothing can clash with an app's own (Riddler Go already has `aeo_queries`, `analytics_sessions` and the rest).

| Entry | What it is | Runs |
| --- | --- | --- |
| `@adminigloo/seo` | Every builder. No React, no Next, no Node APIs: pure functions that return plain objects and strings | Server or edge |
| `@adminigloo/seo/react` | `<JsonLd data={…} />`. Server-safe: no hooks, no `"use client"` | Server Component (or client) |
| `@adminigloo/seo/og` | `ShareImage`, `shareImageResponse`, `loadFont`. Imports `next/og` | Edge or Node route |

## What each install gets you

| You install / import | You get | You wire yourself |
| --- | --- | --- |
| `@adminigloo/seo` | `defineSite`, `definePaths`, `isIndexable`; `pageMetadata` / `siteMetadata`; the JSON-LD builders, `graph`, `serializeJsonLd`, `unresolvedRefs`; `robotsPolicy` / `robotsTxt` / `robotsHeader`; `sitemapEntries`, `toNextSitemap`, `buildSitemaps`; `llmsTxt` / `llmsFullTxt`; `submitUrls` / `indexNowKeyFile` | One `site.ts` (your URL, name, share image, path list, `indexable`). Then one line per Next metadata file: `app/robots.ts`, `app/sitemap.ts`, `generateMetadata` on each page, `app/llms.txt/route.ts`, `app/llms-full.txt/route.ts`. One `X-Robots-Tag` line in your proxy. The content registry (from the lists your pages already render). `INDEXNOW_KEY`, the key-file route and a `submitUrls` call where you publish |
| `+ @adminigloo/analytics` (if the app runs it) | robots.txt that follows the installed analytics' bot list exactly | Pass analytics' list as `robotsPolicy(site, { crawlers })` (section 3) |
| `+ ./react` | `<JsonLd/>` | Put it in your layout (Organization, WebSite) and on each page (that page's graph) |
| `+ ./og` | A 1200×630 share card with brand, eyebrow, title, description, badge, footer, an optional hero image and an optional gradient background; fonts fetched once (or passed as bytes), falling back to the default font | `app/opengraph-image.tsx` (and `twitter-image.tsx` re-exporting it), with your colours and font |

### Not included

- **Audits.** Crawling your sitemap and scoring titles, canonicals, robots and llms.txt is `@adminigloo/seo-reports`.
- **Search Console.** The nightly import of clicks, impressions and positions will be `@adminigloo/search-console` (planned, not built yet).
- **Citation tracking.** Asking ChatGPT, Claude, Perplexity and Gemini whether they cite you is `@adminigloo/aeo`.
- **Content writing.** The package writes structure: titles, tags, links, headings. Every sentence (descriptions, summaries, answers, plan copy) comes from your app. It writes no prose about your product.
- **Crawler logging.** Counting which bots read which pages is `@adminigloo/analytics` (its `./crawlers` list is the one this package's robots.txt is built from).
- **Redirects.** www → bare domain, old slugs and permanent redirects are your host's and your router's.
- **A web app manifest, icons and verification tags.** Use Next's own `manifest.ts`, `icon.tsx` and `metadata.verification`.
- **Routes, cron or a database.** Every function is called from your own route handlers, proxy and publish code.
- **A promise of rich results.** By default the builders refuse what Google would report as an invalid item. Whether Google then shows a rich result is Google's call (FAQ results are limited to government and health sites, HowTo results are gone, the sitelinks search box is retired, Speakable is a news beta). Answer engines read all of it.

## Install

The package is private, published to GitHub Packages. Add the scope to your project's `.npmrc` (commit this line, it holds no secret):

```
@adminigloo:registry=https://npm.pkg.github.com
```

Your token goes in your **user-level** `~/.npmrc`, never in the repo:

```
//npm.pkg.github.com/:_authToken=<a GitHub token with read:packages>
```

```bash
npm install @adminigloo/seo@0.1.0   # pin exactly
```

Peer dependencies, both optional: `react ^18 || ^19` for `./react` and `./og`; `next ^14 || ^15 || ^16` for `./og`. The core entry needs neither, and the package has no runtime dependencies at all. It is vendorable as a tarball (`pnpm pack`).

Environment: `INDEXNOW_KEY` (8 to 128 letters, digits or dashes, e.g. `openssl rand -hex 16`), only if you use IndexNow.

## Wiring it into a Next app

### 1. The site, once

Riddler Go's real lists, from its own `lib/seo/marketing-paths.ts`:

```ts
// src/seo/site.ts
import { defineSite, definePaths, isIndexable } from "@adminigloo/seo";
import { MARKETING_PATHS, NOINDEX_PREFIXES } from "@/lib/seo/marketing-paths";

const SIGN_IN = ["/sign-in", "/sign-up"];

export const paths = definePaths({
  // Pages you want found: /, /how-it-works, /pricing, /templates, /join and the rest of
  // MARKETING_PATHS. Add `lastModified` where the content's date is known.
  public: MARKETING_PATHS,
  // No crawler should fetch or index these: disallowed in robots.txt AND sent noindex.
  // /admin, /dashboard, /events, /staff, /setup, /play, /e, /api, /sso-callback, /qr,
  // /invite, /dev, /settings, /event-builder, /shared. The "/x/" and "/x" pairs are fine.
  private: NOINDEX_PREFIXES.filter((path) => !SIGN_IN.includes(path)),
  // A crawler may fetch these but should not list them. NOT disallowed, so the noindex is seen.
  noindex: SIGN_IN,
});

export const site = defineSite({
  // A build without the variable (CI) still loads; isIndexable() refuses it.
  url: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  name: "Riddler Go",
  description: "Host puzzle events for any occasion. Guests join with a QR code and race the leaderboard on their phones.",
  image: { url: "/opengraph-image", width: 1200, height: 630, alt: "Riddler Go" },
  twitter: { site: "@riddlergo" },
  paths,
  // PRODUCTION ONLY. Never NODE_ENV: it is "production" in every build, previews included.
  indexable: isIndexable({
    env: process.env.VERCEL_ENV,
    host: process.env.NEXT_PUBLIC_APP_URL,
    productionHosts: ["riddlergo.com"],
  }),
});
```

- **`indexable` is required**, so the decision is always made on purpose. It is the one value behind the robots meta tag, the `X-Robots-Tag` header, robots.txt, the sitemap, llms.txt and IndexNow, so they can never disagree. With `productionHosts`, `www.riddlergo.com` serving a duplicate of the real site refuses crawlers until the www redirect is in place.
- **`url` is required.** A missing one throws at load with the fallback above in the message; the AdminIgloo site builds in CI without `NEXT_PUBLIC_APP_URL`.
- **Matching is by whole segment.** `/e` covers `/e`, `/e/ABC123` and `/e?code=x`, never `/elm-street-church/spring-hunt`. robots.txt says exactly the same (section 3).

### 2. Metadata

```tsx
// app/layout.tsx
import { siteMetadata, graph, organization, webSite } from "@adminigloo/seo";
import { JsonLd } from "@adminigloo/seo/react";
import { site } from "@/seo/site";

export const metadata = siteMetadata(site, { homeTitle: "Riddler Go: puzzle events for any occasion" });

// inside <body>:
<JsonLd
  data={graph(
    organization(site, { logo: "/marketing/logos/riddler-go-mark.png", sameAs: [instagramUrl, facebookUrl] }),
    webSite(site),
  )}
/>
```

```tsx
// app/pricing/page.tsx
import { pageMetadata, graph, webPage, breadcrumbList, product } from "@adminigloo/seo";

export const metadata = pageMetadata(site, {
  path: "/pricing",
  title: "Pricing",
  description: "Plans for every event, from a free first hunt to unlimited events.",
});
// title → { absolute: "Pricing | Riddler Go" }; canonical → https://riddlergo.com/pricing;
// openGraph and twitter complete, with the site's share image.

<JsonLd
  data={graph(
    webPage(site, { path: "/pricing", name: "Pricing", breadcrumb: true }),
    breadcrumbList(site, { path: "/pricing", items: [{ name: "Home", path: "/" }, { name: "Pricing" }] }),
    PLANS.map((plan) =>
      plan.monthly === null
        ? // "Contact us": described, not eligible for a rich result.
          product(site, { path: "/pricing", id: `plan-${plan.key}`, name: plan.name, richResult: false })
        : product(site, {
            path: "/pricing",
            id: `plan-${plan.key}`,
            name: plan.name,
            image: "/opengraph-image",
            offers: { price: plan.monthly, currency: "USD", billing: "month" },
          }),
    ),
  )}
/>
```

The rules `pageMetadata` enforces:

- **The canonical is the page itself.** `path` is required and there is no homepage fallback. Campaign parameters (`utm_*`, `gclid`, `fbclid`…) and the fragment are dropped, the trailing slash follows `site.trailingSlash`, and a URL on another host is refused.
- **The brand is in the title once.** The title is written as `{ absolute: "Pricing | Riddler Go" }`, so the layout's `%s | Riddler Go` template cannot add it again. A title that already names the brand (as a whole word, any case; a hyphenated word like "Go-Kart" does not name "Go") gets no suffix, and `"X | Brand | Brand"` and `"Brand — Tagline | Brand"` are collapsed. Pass `brand: false` for a title that should stand alone.
- **Open Graph and Twitter are always complete.** Next replaces a layout's `openGraph` wholesale when a page sets one, so every page's block re-states the site name, locale and URL and carries an image: the page's own, else the site default.
- **noindex is decided in one place.** `noindex: true` on the page, a `noindex` or `private` path in the list, or `indexable: false` on the site. Off production the page also asks Bing to keep no cached copy (`nocache`; Google ignores it).
- **The layout sets no canonical and no `og:url`.** A layout's values are inherited by every page that does not set its own, so either one would point those pages at the homepage.
- **Bad data throws.** An empty title, or an article time with no time zone, is a `SeoError`. In a `generateMetadata` fed by database rows, catch it and fall back, or one bad row is a 500.

### 3. robots.txt and the noindex header

```ts
// app/robots.ts
import { robotsPolicy } from "@adminigloo/seo";
// The app runs @adminigloo/analytics too: robots.txt follows the installed analytics' bot list exactly.
import { KNOWN_CRAWLERS, ROBOTS_CONTROL_TOKENS } from "@adminigloo/analytics/crawlers";
export default function robots() {
  return robotsPolicy(site, { crawlers: [...KNOWN_CRAWLERS, ...ROBOTS_CONTROL_TOKENS] });
}
// Without analytics: robotsPolicy(site), with the list compiled into this package.
```

```ts
// proxy.ts (or middleware.ts)
import { robotsHeader } from "@adminigloo/seo";
const tag = robotsHeader(site, req.nextUrl.pathname, { extra: ["noarchive", "nosnippet"] });
if (tag) response.headers.set("X-Robots-Tag", tag);
```

What `robotsPolicy` writes:

- **Off production:** `User-agent: *` / `Disallow: /` and nothing else, not even a sitemap line naming the staging origin. The trade-off: a crawler that may not fetch a page never sees its noindex, so a staging host that is already in an index cannot drop out while it is disallowed. For that host, serve `robotsTxt({ rules: { userAgent: "*", allow: "/" } })` until it has dropped out; every page there already carries `noindex, nofollow`.
- **A `*` group:** `Allow: /`, then each private path as three rules, `Disallow: /e$`, `Disallow: /e/` and `Disallow: /e?`. That blocks `/e`, everything under it and its query strings, and never a page that merely starts with the same letters (`/elm-street-church/spring-hunt`, `/admin-guide`). A bare `Disallow: /e`, which Riddler Go writes today, blocks every org whose slug starts with "e". `$` is RFC 9309, read by Google and Bing.
  - `/_next/` is never disallowed; `definePaths` refuses it. Blocking it hides every optimised image, and the CSS and JS Google renders pages with.
  - noindex paths are not disallowed, so a crawler can fetch them and see the noindex.
- **One group per AI bot token:** allowed or refused by what the bot does.
  - `training`: GPTBot, ClaudeBot, CCBot, Google-Extended, Applebot-Extended, Meta-ExternalAgent, FacebookBot, Bytespider, Amazonbot, cohere-ai, Diffbot, AI2Bot, Timpibot, PanguBot, TikTokSpider. **Three of these also feed answers:** Google-Extended also controls grounding in Gemini Apps, Meta-ExternalAgent also indexes for Meta AI, and Amazonbot also feeds Alexa. To refuse training but keep those answers: `{ ai: { training: "deny" }, bots: { "Google-Extended": "allow", "Meta-ExternalAgent": "allow", Amazonbot: "allow" } }`.
  - `search`: OAI-SearchBot, Claude-SearchBot, PerplexityBot, YouBot, Amzn-SearchBot, Meta-WebIndexer, Google-CloudVertexBot.
  - `userFetch`: ChatGPT-User, Claude-User, Perplexity-User, MistralAI-User, DuckAssistBot, Meta-ExternalFetcher, Amzn-User. These fetch because a person asked an assistant about you. **A deny here is mostly a request:** OpenAI says robots.txt may not apply to ChatGPT-User, Perplexity says Perplexity-User generally ignores it, Meta says Meta-ExternalFetcher may bypass it, and Amazon says Amzn-User may not follow it. It binds Claude-User and DuckAssistBot.

  A bot named in its own group ignores the `*` group, so an allowed bot's group repeats every private rule. Each token gets its own group, so even a parser that mishandles several `User-agent` lines in one group reads it right. Pass `combine: true` for the compact form. `nameAiBots: false` leaves allowed bots unnamed.
- **Per bot:** `bots: { GPTBot: "deny", "Google-Extended": "deny" }`, by analytics name or robots token. This beats the bot's class. A token the list does not know gets its own group (letters, digits, `_` and `-` only). A bot the list knows that has no token (WhatsApp, "Other bot") is refused, since nothing could be written for it.
- **Classic crawlers:** `searchEngines`, `social` and `seoTools` work the same way. Allowed (the default), they are covered by `*`. GoogleOther, Google's general research fetcher, is "other": no group, covered by `*`.
- **Sitemap:** `Sitemap: https://…/sitemap.xml`, or `sitemaps: [...]`, or `false`.

**The bot list is `@adminigloo/analytics`' list.** It is compiled in from analytics (`KNOWN_CRAWLERS` plus `ROBOTS_CONTROL_TOKENS`), so the bots a site lets in and the bots its crawler log counts are one list. The retired `Claude-Web` is never written.

- **An app with analytics installed** passes analytics' own list as `crawlers` (above), and robots.txt follows whatever analytics version is installed.
- **Without analytics,** the compiled-in list applies. `ROBOTS_BOTS_SOURCE` says which analytics version and list a build carries (`{ analytics: "0.2.0", fingerprint }`). `botListFingerprint(list)` gives the same fingerprint for any list, to compare.
- **In this repo,** a change to analytics' list fails this package's tests until a changeset for `@adminigloo/seo` is queued, so the published robots.txt never falls behind. `pnpm --filter @adminigloo/seo stamp:bots` records the list once that release is out.

`isAllowedByRobots(robotsTxt, token, path)` answers what a crawler would do with any robots.txt, per RFC 9309: groups merged per agent, the longest rule wins, `Allow` wins a tie, `*` and `$` honoured. A crawler that obeys several tokens passes them most specific first: `["Googlebot-Image", "Googlebot"]` follows the `Googlebot` group when there is no `Googlebot-Image` group. Use it in a test of your own robots.txt.

`robotsHeader(site, path, { extra })` adds `noarchive`, `nosnippet`, `noimageindex` or `notranslate` to every header it sends.

### 4. The sitemap

```ts
// app/sitemap.ts
import { sitemapEntries, pathEntries, toNextSitemap } from "@adminigloo/seo";
export default async function sitemap() {
  const templates = await listBrowsableTemplates();
  return toNextSitemap(
    sitemapEntries(
      site,
      [
        ...pathEntries(site),
        ...templates.map((t) => ({ url: `/templates/${t.slug}`, lastModified: t.updatedAt, images: [t.heroUrl] })),
      ],
      // One bad row is skipped and reported, not a broken sitemap.
      { onInvalid: ({ url, issues }) => console.warn("sitemap: skipped", url, issues) },
    ),
  );
}
```

- **`lastModified` is a required key.** Pass the date the content changed, or `null` when you do not know it. A `null` entry is written with no `<lastmod>`; nothing ever writes "now".
- **Checked dates.** A date more than a day in the future, a calendar day that does not exist (`2026-02-30`), a date-time with no time zone (`2026-10-01T19:00`, which each server would read in its own zone), or something that is not a date is refused. A `Date` is written in UTC; a string with an offset (`2026-10-01T19:00:00-06:00`, Postgres' `2026-10-01 19:00:00+00`) keeps it.
- **The path list decides.** A URL under a private or noindex path is refused, rows from a database included (Search Console reports those as "Submitted URL marked noindex" or "blocked by robots.txt").
- **Every URL is on the site's own origin.** A www or staging URL is refused. With `onInvalid`, a bad row is skipped and reported instead of thrown. A URL listed twice keeps its newest date.
- **Priority** is written as a plain decimal (`0.85`, `1.0`), never in exponent notation.
- **Off production, `sitemapEntries` returns nothing.**

**Past 50,000 URLs or 50 MB**, serve raw XML: `buildSitemaps` splits the entries and writes the index. The files are served from the root (`/sitemap-0.xml`, `/sitemap-1.xml`), because under the sitemaps protocol a file in `/sitemaps/` may only list URLs under `/sitemaps/`.

```ts
// app/sitemap.xml/route.ts (instead of app/sitemap.ts)
import { buildSitemaps, sitemapResponse } from "@adminigloo/seo";
export async function GET() {
  return sitemapResponse(buildSitemaps(site, await allEntries()).root);   // the index, or the only file
}

// app/sitemap-file/[id]/route.ts, reached from the root through a rewrite in next.config:
//   rewrites: async () => [{ source: "/sitemap-:id.xml", destination: "/sitemap-file/:id" }]
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const file = buildSitemaps(site, await allEntries()).files[Number((await params).id)];
  return file ? sitemapResponse(file.xml) : new Response("Not found", { status: 404 });
}
```

Each file in the index carries its newest entry's date. `filePath(id)` changes where the files are said to be.

### 5. llms.txt and llms-full.txt

```ts
// src/seo/llms.ts: the registry, from the SAME sources your pages render
import type { LlmsRegistry } from "@adminigloo/seo";
export function llmsRegistry(): LlmsRegistry {
  return {
    summary: HOME_SUMMARY,
    sections: [
      { title: "Product", items: PRODUCT_PAGES },
      { title: "Templates", items: templates.map((t) => ({ title: t.name, path: `/templates/${t.slug}`, summary: t.tagline, body: t.description })) },
      // Content with no page of its own: items without a path, or a section of Markdown text.
      { title: "Puzzle types", items: SELECTABLE_TYPE_SUMMARIES.map((t) => ({ title: t.label, summary: t.hint })) },
      { title: "Event modes", text: EVENT_MODES_MARKDOWN },
    ],
    howItWorks: { path: "/how-it-works", steps: HOW_IT_WORKS_STEPS },
    pricing: { path: "/pricing", currency: "USD", plans: PLANS.map((p) => ({ name: p.name, price: p.monthly, interval: "month", description: p.blurb, features: p.features })) },
    faqs: { path: "/#faq", items: FAQ },
    contact: { email: "hello@riddlergo.com", links: [{ title: "Book a call", path: "/book" }] },
  };
}

// app/llms.txt/route.ts
export function GET() { return llmsResponse(llmsTxt(site, llmsRegistry())); }
// app/llms-full.txt/route.ts
export function GET() { return llmsResponse(llmsFullTxt(site, llmsRegistry())); }
// A site that serves only llms.txt: llmsTxt(site, registry, { fullPath: false }).
```

- **llms.txt is the index:** title, summary, links to llms-full.txt and the sitemap, then each section's links. Every line under a `##` heading is `- [name](url): notes`, the one shape llmstxt.org's parser reads: the how-it-works steps on one linked line, each plan linked to the pricing page with its price as the note, the FAQ as one link (or one per question that has its own `path`), contact as `mailto:` and page links, and `optional` sections under `## Optional`. An item with no page links to llms-full.txt, where its text is.
- **llms-full.txt is the text:** every page's body (else its summary), every section's Markdown, every step, every plan with its features, every answer.
- **The path list decides.** A link under a private or noindex path is refused.
- **Budgets:** 50,000 bytes for the index and 200,000 for the full file by default (`maxBytes`). Over budget, text goes in this order:
  1. Optional sections.
  2. In the full file, bodies shortened to their summaries.
  3. Items from the end of the longest list first, so a 400-template list gives way before a five-page product list. Each list then says `…and N more` with where to find them.

  Only if the essentials alone do not fit is the tail cut at a line boundary. The result says what it did (`trimmed`, `shortened`, `omitted`, `cut`) and never exceeds the budget.
- **Serving:** `llmsResponse` sets browser caching only, with no `s-maxage` (a CDN copy would hide the crawler fetches your crawler log counts), and `X-Robots-Tag: noindex`, which keeps the file out of search results without keeping answer engines from reading it (`noindex: false` drops it).
- **Off production** both files are empty and `llmsResponse` answers 404.

### 6. IndexNow

```ts
// proxy.ts: serve the key file
const key = indexNowKeyFile(process.env.INDEXNOW_KEY!);
if (req.nextUrl.pathname === key.path) return new Response(key.body, { headers: { "content-type": key.contentType } });

// where an event, template or post is published
await submitUrls(site, [`/templates/${slug}`], { key: process.env.INDEXNOW_KEY! });
```

- **Production only:** off production it sends nothing and says so (`skipped: "not-indexable"`).
- **The path list decides:** a URL under a private path throws; one under a noindex path is left out and listed in `excluded`.
- **Batches:** URLs are de-duplicated, made absolute and checked to be on your host, then sent in batches of up to 10,000 (the protocol's limit) to `api.indexnow.org`. Every participating engine shares that endpoint.
- **`keyLocation`** must be on your own origin, and every URL must be under its folder (a key at `/catalog/key.txt` covers `/catalog/…` only), checked before anything is sent.
- **Answers:** each batch reports its answer. 200 and 202 mean accepted; 403 means the key file does not match; 422 means a URL is off-host; 429 means too often. It never throws for an engine's answer.
- **Testing:** `fetch` is injectable, for tests.

### 7. The share image

```tsx
// app/opengraph-image.tsx
import { shareImageResponse, SHARE_IMAGE_SIZE } from "@adminigloo/seo/og";
export const size = SHARE_IMAGE_SIZE;
export const contentType = "image/png";
export const alt = "Riddler Go: puzzle events for any occasion";
export default async function Image() {
  const display = await fetch(new URL("./fonts/display-700.otf", import.meta.url)).then((r) => r.arrayBuffer());
  return shareImageResponse(
    {
      brand: "Riddler Go",
      title: "Puzzle events for any occasion",
      footer: "riddlergo.com",
      theme: { background: "#101418", backgroundImage: "linear-gradient(135deg, #101418 0%, #1d2a33 100%)", accent: "#ffb703" },
    },
    { fonts: [{ name: "Display", data: display, weight: 700 }] },
  );
}
// app/twitter-image.tsx: export { default, size, contentType, alt } from "./opengraph-image";
```

- **Per-page cards:** a page-level `opengraph-image.tsx` (per template, per deck) passes `eyebrow`, `badge`, `description` and `image` (an absolute hero URL; `null` draws a lettered panel).
- **Fonts:** bytes you already have (`{ name, data }`), or a URL (`{ name, url }`) fetched once per server instance. A failed or slow fetch renders in the default font and is retried on the next image, not cached as a failure.
- **Background:** `theme.backgroundImage` takes a CSS gradient (or `url(…)`) over `theme.background`.
- **Layout:** every box with several children is `display: flex`, as satori requires.

## Structured data reference

Every builder takes `(site, input)`, checks its input and throws one `SeoError` listing every problem. Empty values never reach the output (no `"sameAs": []`). Nothing that is a fact about the business is defaulted: not `isAccessibleForFree`, not stock status, not a country.

**Rich results.** `product`, `softwareApplication` and `event` check by default everything Google's rich result for the type requires, so a node never reaches Search Console as an invalid item by accident. `richResult: false` is the deliberate other choice: the node describes the thing for answer engines and the knowledge graph, and is not eligible for a rich result. Use it for a plan with no public price, an app with no ratings yet, an event with no date yet.

| Builder | `@id` | Checks |
| --- | --- | --- |
| `organization` | `{origin}/#organization` | type from a closed list; `logo` a raster image, never `.ico`; `sameAs` URLs on other sites only (falsy entries dropped); email shape |
| `webSite` | `{origin}/#website` | `searchUrlTemplate` contains `{search_term_string}` (writes a SearchAction; Google retired the sitelinks search box in 2024, so it draws nothing there); publisher → organization |
| `webPage`, `collectionPage` | `{page}#webpage` | path, name, page type from a closed list; `isPartOf` → website, `breadcrumb: true` → `{page}#breadcrumb`, `speakable`. `faq: [...]` makes the page node also an FAQPage, with the questions as its `mainEntity` |
| `speakable` | (part of a page) | exactly one of `cssSelector` / `xpath` |
| `breadcrumbList` | `{page}#breadcrumb` | at least one item; only the last may omit its path (it becomes the page) |
| `product` | `{page}#product` (or `id`) | needs offers, a rating or rated reviews; with offers, an `image` (an Offer makes it a merchant listing; `shipping` and `returnPolicy` are recommended there). Offers take the price in major units (formatted per currency), an ISO 4217 currency, `billing` for subscriptions (`unitCode` plus `billingIncrement: 1`), shipping (one DefinedRegion per country) and a return policy. Seller → organization. `richResult: false` lifts the offer, image and rating requirements |
| `softwareApplication` | `{page}#software` or `{origin}/#software` | Google's `applicationCategory` list; a price (0 for free) AND `aggregateRating` or `reviews`. `richResult: false` lifts both |
| `event` | `{page}#event` | a start date (`richResult: false` lifts it); a date-time with a time zone, kept as written; end after start; a location matching `attendance` (a virtual location defaults to the page); `status: "rescheduled"` needs `previousStartDate`; `"moved-online"` needs online or mixed attendance |
| `howTo` | `{page}#howto` | at least one step, ISO 8601 `totalTime` |
| `faqPage` | `{page}#faq` | question and answer each, no repeated question. For a page with no `webPage()` node; otherwise use `webPage({ faq })` |
| `article`, `blogPosting` | `{page}#article` | at least one author, publish date, modified not before published; `mainEntityOfPage` → `{page}#webpage`, publisher → organization |
| `itemList` | `{page}#itemlist` | each item links to its own page |
| `person` | `{origin}/#person-{key}` | name; `sameAs` on other sites only; `worksFor` → organization |
| `place` | `{page}#place` or `{origin}/#place-{name}` | type and `additionalType` from a closed list of real types; coordinates in range |
| `touristAttraction` | `{page}#attraction` | as `place`, plus rating and reviews on the same node: one node per attraction |
| `localBusiness` | `{origin}/#localbusiness` | a business type from a closed list, an address, hours from 00:00 to 23:59 (open all day is 00:00 to 23:59, never 24:00); `logo` and `sameAs` as for `organization`. **No rating:** this is the site's own business, and Google ignores (and may act on) ratings a business publishes about itself |

- **Ratings:** reviews and `aggregateRating` (value within best/worst, count at least 1) are accepted by `product`, `softwareApplication` and `touristAttraction`. A review on a product or app needs a rating and an author's name. `aggregateRatingFrom(ratings, { min: 3 })` averages raw ratings and returns nothing below a credibility threshold.
- **Dates:** every date is checked as section 4 says: a real calendar day, and a time zone on a date-time.
- **Ids for references:** `organizationId`, `webSiteId`, `webPageId`, `breadcrumbId` and `personId` give you a node's id without building it, so `ref(personId(site, "dallin"))` links an article to an author defined elsewhere.
- **`graph(...nodes)`** writes one `@graph`. It skips `null`/`false`, flattens arrays, drops an exact duplicate, and throws when two different nodes claim one `@id` (two plans on one pricing page need their own `id`) or when two page nodes describe one URL (a `webPage()` beside a `faqPage()` is two pages: use `webPage({ faq })`).
- **`unresolvedRefs(...blocks)`** lists the `@id` references no rendered node defines. Pass the layout's block and the page's: `expect(unresolvedRefs(layoutGraph, pageGraph)).toEqual([])` in a test of each page template catches an article whose author `person()` node nobody renders.
- **`tryNode(() => …, onError)`** builds from data that may be bad without failing the page: it returns null and reports (`console.error` unless you pass your logger, or `() => {}` where a dropped node is expected), and `graph()` skips the null. Incomplete data has a better answer: an undated event is `event(site, { …, richResult: false })`, a node without the date.
- **`serializeJsonLd(data)`** escapes `<`, `>`, `&`, U+2028 and U+2029 (`<` becomes `<`). `JSON.parse` returns exactly the input, and a `</script>` inside a review or a caption stays inside the element. `<JsonLd/>`, `jsonLdScript(data)` (the element as HTML) and `jsonLdScriptProps(data)` all use it.

## Replacing Riddler Go's own SEO code

Riddler Go keeps its pages and data. These pieces move onto the package; no migration, no new table, one new variable (`INDEXNOW_KEY`) only if IndexNow is wanted.

| Riddler Go today | With the package |
| --- | --- |
| `components/seo/schemas.ts`: `organizationSchema()`, `softwareApplicationSchema()`, `breadcrumbListSchema()`, `faqPageSchema()`, `eventSchema()`, `howToSchema()`, each with `@context` and no `@id`, the brand and URLs hard-coded | `organization(site, { logo: "/marketing/logos/riddler-go-mark.png", contactPoints: [{ contactType: "customer support", email: "hello@riddlergo.com" }] })`; `softwareApplication(site, { name: "Riddler Go", applicationCategory: "GameApplication", operatingSystem: "Any (web browser)", offers: { price: 0, currency: "USD", availability: "InStock" }, richResult: false })` (no ratings yet, so not a rich result); `breadcrumbList(site, { path, items })`; `faqPage(site, { path: "/", items: FAQ })`; `event(site, { path, name, description, startDate, endDate, attendance: "online", location: { type: "virtual" }, organizer: { name: orgName, url: orgUrl, type: "Organization" }, isAccessibleForFree: true, richResult: Boolean(startDate) })`; `howTo(site, { path, name, description, steps })`. Then one `graph(...)` per page |
| `components/seo/schemas.test.ts` | Its position and ISO-date assertions carry over. Two change: "omits date fields when not provided" becomes `event(site, { …, startDate: null, richResult: false })`, which has no date fields, and "handles an empty items array" becomes "build no breadcrumb": `breadcrumbList` with no items throws, so render it only when there are items. The snapshots here pin the rest |
| `components/seo/JsonLd.tsx` (`JSON.stringify` into `dangerouslySetInnerHTML`, unescaped) | `import { JsonLd } from "@adminigloo/seo/react"`, same `data` prop, escaped |
| `app/robots.ts` with `MARKETING_PATHS`, `NOINDEX_PREFIXES` and `AI_CRAWLER_USER_AGENTS` (8 bots, `Claude-Web` among them, `OAI-SearchBot`, `Claude-SearchBot`, `Claude-User`, `Perplexity-User` missing), `isProductionOrigin` | `definePaths` with those same constants (section 1); `defineSite({ …, indexable: isIndexable({ env: process.env.VERCEL_ENV, host: env.NEXT_PUBLIC_APP_URL, productionHosts: ["riddlergo.com"] }) })`; `app/robots.ts` becomes `return robotsPolicy(site, { crawlers })` (section 3), which also stops blocking the event pages of every org whose slug starts with a private prefix; `proxy.ts`'s `shouldNoIndex` becomes `robotsHeader(site, pathname, { extra: ["noarchive", "nosnippet"] })`, the header it sends today (sign-in and sign-up, now noindex rather than private, drop `nofollow`); `app/sitemap.ts` uses `pathEntries(site)` plus the template, use-case and event rows with their `updatedAt` and `onInvalid`, never `now`. `marketing-paths.test.ts`'s collision test is built into `definePaths`. robots.txt loses its `Host:` line, which Google and Bing ignore |
| `lib/seo/llms-content.ts` (`llmsShort()` / `llmsFull()`, hand-written Markdown missing pricing, how-it-works, templates, use-cases and the FAQ) | An `llmsRegistry()` built from the same sources the pages render: the puzzle-type registry (items without a path), the event modes and who-it's-for lists (text sections), the plan list, the how-it-works steps, the FAQ file, `listBrowsableTemplates()` and the use-cases. The two routes return `llmsResponse(llmsTxt(site, registry))` and `llmsResponse(llmsFullTxt(site, registry))`; the D19 200 KB cap is the full file's default budget, enforced rather than logged. Keep `captureAiCrawlerHit` in the routes |
| `app/opengraph-image.tsx` (a `linear-gradient` card) | `shareImageResponse` with `theme.backgroundImage` for the gradient |

The title fixes (the doubled "— Riddler Go" on pricing, templates and use-case pages) come from `pageMetadata` with the plain title. The missing share image on `/pricing` and `/how-it-works` comes from the site default.

## Replacing the AdminIgloo site's own SEO code

| The site today (`src/seo.ts` and friends) | With the package |
| --- | --- |
| `INDEXABLE = resolveAppEnv() === "production"` | `indexable: isIndexable({ env: resolveAppEnv(), host: env.NEXT_PUBLIC_APP_URL, productionHosts: ["adminigloo.com"] })`, with `url: env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"` so CI builds without the variable |
| `metadataBase` guard, `%s · adminigloo` template | `siteMetadata(site)` with `titleSeparator: " · "` |
| robots.txt's `DISALLOWED` list | the `private` list |
| `featureJsonLd` (a SoftwareApplication with a priceless Offer, prices still to be set) | `softwareApplication(site, { path: featurePath, name, applicationCategory: "BusinessApplication", operatingSystem: "Web", richResult: false })` until there is a price and a rating, plus `breadcrumbList` |
| llms.txt only | `llmsTxt(site, registry, { fullPath: false })`, with "Book a call" in `contact.links` |

## Smaller helpers

| Function | What it does |
| --- | --- |
| `pageUrl(site, path)` | The canonical rule on its own: absolute, own origin, campaign parameters and fragment dropped, trailing slash per the site |
| `absoluteUrl(site, pathOrUrl)` | A path resolved against the site; an absolute URL on another host (a CDN image) kept |
| `brandTitle(site, title)` | The title with the brand exactly once, as `pageMetadata` writes it |
| `pathRule(paths, pathname)` | `"private"`, `"noindex"`, `"public"` or `"unlisted"`; the most specific entry wins |
| `normalizePath(path)`, `pathCovers(prefix, path)` | `"/checkout/"` → `"/checkout"`; whole-segment matching (`/admin` covers `/admin/x`, not `/admin-guide`) |
| `hostnameOf(value)` | A hostname from a URL, a host with a port, or a Host header |
| `sitemapXml(entries)`, `sitemapIndexXml(files)`, `splitSitemap(entries, { maxUrls, maxBytes })` | The pieces `buildSitemaps` is made of |
| `isIndexNowKey(key)` | Whether a key is one IndexNow accepts |
| `botListFingerprint(list)` | A short fingerprint of what robots.txt is built from, to compare with `ROBOTS_BOTS_SOURCE` |

## Errors

`SeoError` has `code` (`invalid_config` for the site, path list or policy; `invalid_input` for one call's data), `where` (the function) and `issues` (every problem found, not just the first). Builders throw on bad data on purpose, so a mistake shows in a test rather than in Search Console. Where data comes from a database at request time, catch: `tryNode` for JSON-LD, `onInvalid` for the sitemap, a try/catch around `pageMetadata`.
