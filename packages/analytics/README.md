# @adminigloo/analytics

First-party, cookieless traffic analytics for an app's own site, kept in the app's own Postgres. It answers four questions:

- **Where visitors came from:** search, AI assistants by name, social, email, campaigns.
- **What they read and clicked.**
- **How fast the pages loaded:** Core Web Vitals.
- **Which crawlers read the site:** AI assistants, AI search and AI training crawlers, search engines.

With [`@adminigloo/audience`](../audience/README.md), staff, testers, automation and named people are left out of every report. Numbers they already polluted are cleaned without rewriting a row.

It ships five entry points:

| Entry | What it is | Runs |
| --- | --- | --- |
| `@adminigloo/analytics` | `createAnalytics` (the beacon endpoint, conversions, the crawler log, maintenance and every report), the source and AI-engine classifiers, `reclassifySources`, and the 0.1 free functions (deprecated) | Server |
| `@adminigloo/analytics/schema` | `defineAnalyticsTables({ prefix })` and the default tables (`analyticsSessions`, …) to add to your Drizzle schema | Server |
| `@adminigloo/analytics/crawlers` | `classifyCrawler(userAgent)`, dependency-free, so a request proxy can test a user agent without loading the database layer | Server or edge |
| `@adminigloo/analytics/client` | `<AnalyticsBeacon>`, the opt-out switch, `useAnalyticsVisit`, `describeThisVisit` | Browser (`"use client"`) |
| `@adminigloo/analytics/dashboard` | Display-only report components (KPI cards, trend chart, tables with CSV export, crawler panel, vitals, heatmap, health strip) | Browser (`"use client"`) |

## What each install gets you

| You install / import | You get | You wire yourself |
| --- | --- | --- |
| `@adminigloo/analytics` + `./schema` + `./client` | Visits, page views, clicks, conversions (client and server side), Web Vitals, sources and campaigns, AI traffic by engine, every report, the public snapshot, the crawler log, retention | The tables in your schema and a generated migration (you run it). A `POST` route that calls `handler.handle(req)`, and `<AnalyticsBeacon>` in your layout. `recordCrawlerHit` in your proxy or middleware, or from `after()` in a route if your proxy does no database work. A daily `runMaintenance()`. A page that calls the reports. |
| `+ @adminigloo/audience` | Staff, testers, automation and named people left out of every report, with `includeInternal` per call. History cleaned by rule and restored exactly when a rule is removed. "Excluded: N (staff X, automation Y)". `markVisitorInternal` for a device's signed-out visits of about the last 48 hours | The audience's four tables and its rules UI (its README). `onSession` on the handler, which calls `audience.observe(...)`. `audience` on `createAnalytics`. A "These are my visits" button that calls `markVisitorInternal`. |
| `+ ./dashboard` | The report components | The page, and its data from the reports |
| The crawler half only (Riddler Go) | Which AI and search crawlers read which pages, verified where the operator publishes its ranges. Reports: `getCrawlers`, `getRecentAiReads`, `getAiCoverage`, `getTrackingSince` (every other report reads the session tables and throws) | Two tables (`crawlerHits` and `sites`), exported by name under a prefix such as `aig_analytics_`, never `export *`. `recordCrawlerHit` with the request's IP and `crawlerVerifier: true`, from your proxy or from `after()`. `runMaintenance({ crawlersOnly: true })`. See [The crawler half alone](#the-crawler-half-alone-riddler-gos-install). |
| `./crawlers` only | `classifyCrawler` in a proxy | Nothing |

### Not included

Say these out loud before anyone assumes otherwise:

- **No cookies and no cross-day identity, unless you opt in.** A visitor is one visitor within a day: the key is an HMAC of IP, user agent and tenant under a salt deleted the day after next. "Returning visitors", cohorts and lifetime value are not possible, by design. The one exception is yours to make: if your `onSession` returns an `actorKey`, a signed-in person's visits are linkable to each other for as long as sessions are kept (see [the three session columns](#leaving-your-own-people-out)).
- **No consent banner logic.** No cookie is set, so none is needed for analytics in most places. Global Privacy Control and Do Not Track are honoured by dropping the request, at the beacon and in `recordConversion` when you pass the request's `headers`. Not legal advice.
- **No staff filter of its own, and no lasting mark for a signed-out device.** Who is internal is `@adminigloo/audience`'s job. With no audience configured nothing is filtered, and the reports give 0.1's numbers. On this package's cookieless key (the audience's `visitorIds: "rotating"`) a device's key changes every day, so:
  - a signed-in staff page view marks that device's key for that day, and its signed-out visits that day go too;
  - `markVisitorInternal` reaches back about 48 hours (today's and yesterday's keys) and covers the rest of today;
  - the audience's "Mark this browser" (`markVisitor`) and device links refuse rotating ids;
  - a device that never signs in (a tester's phone, a QA laptop with no account) can only be left out by a network or user-agent rule, or dropped in the browser by the beacon's local opt-out (`?analytics=off` on that device) or `disabled`;
  - the beacon sends no `internal` flag.
- **Crawler verification only where the operator publishes its ranges:** OpenAI (GPTBot, OAI-SearchBot, ChatGPT-User), Perplexity (PerplexityBot, Perplexity-User), Google (Googlebot, GoogleOther), Microsoft (Bingbot) and Apple (Applebot). Every other bot is always recorded unverified: ClaudeBot, Claude-User, Claude-SearchBot, Meta-ExternalFetcher, MistralAI-User, DuckAssistBot and the rest. Their counts are User-Agent claims.
- **No import of an existing crawler log.** An app that already logs crawlers in its own table keeps those rows where they are; a backfill into `crawlerHits` is a one-off script of your own. The package's kinds (`ai-assistant`, `ai-search`, `ai-training`, `search`, `social`, `seo-tool`, `other`) are its own, so map your tiers onto them, and your existing crawler queries and tests are yours to move.
- **No include-internal toggle or excluded line in `./dashboard`.** Use `@adminigloo/audience/ui`'s `IncludeInternalToggle` and `ExcludedNote` beside the panels.
- **No dashboard panel for AI engines.** `getAiAssistantTraffic` returns the data; draw it with `DataTable` or `BarList`.
- **No first- or last-touch attribution, funnels across sign-up, or sign-up sources.** The source is the visit's first touch. Analytics 0.3 adds the rest.
- **No Google Search Console, AEO citation tracking or SEO audit.** Those are separate packages. The audit's own crawler is recorded, and left out of the crawler reports by default.
- **No Google AI Overviews or AI Mode attribution.** Those visits arrive as `google.com` and count as Search; a referrer cannot tell them apart.
- **No routes, no cron, no migration files.** You call the functions from your own route, proxy and job, and generate the migration with drizzle-kit.
- **No rollups.** Every report reads raw rows (13 months by default). That is why a newly excluded person disappears from history at once.
- **No crawler history kept forever by default.** Crawler rows are deleted after `limits.retentionDays` (395) like every other row. Raise it to keep them longer.
- **No MySQL.** Postgres only (Neon, any Postgres; the tests run on PGlite).

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
npm install @adminigloo/analytics@0.2.0   # pin exactly
```

A vendored tarball works the same way (`"@adminigloo/analytics": "file:vendor/adminigloo-analytics-0.2.0.tgz"`). Build it with `pnpm pack` in `packages/analytics`; `pnpm` rewrites the workspace dependencies to real versions. Its dependencies are `@adminigloo/db`, `@adminigloo/license` and `web-vitals`, so the registry token is still needed for those two `@adminigloo` packages.

Peer dependencies are `drizzle-orm ^0.45` and `zod ^3.25 || ^4`; `./client` and `./dashboard` also need `react ^18 || ^19`. `@adminigloo/audience` is an **optional** peer (`^0.1`), never a dependency: pass its instance in, and analytics uses it by shape. That shape is checked strictly, so an audience release whose API no longer fits fails to compile instead of failing at runtime. CommonJS consumers get the `.d.cts` types, and ESM consumers the `.d.ts`.

## Upgrading from 0.1

**Code: nothing has to change.** Every 0.1 function (`createAnalyticsHandler(options)`, `recordConversion(db, …)`, `getOverview(db, query)`, …) still works. Each is a thin wrapper over a default instance per `db` object, with the 0.1 tables, the default limits, no audience and no license. They are deprecated and will be removed in 1.0. A test (`site-compat.integration.test.ts`) makes the founder site's 0.1 calls, in the same shapes, against 0.2.

**The 0.1 functions never see your instance.** Once you build `createAnalytics({ db, audience, license })`, `getOverview(db, q)` still counts staff and testers and is never license-gated, while `analytics.getOverview(q)` leaves them out and is gated. Move every call to the instance in the same change that wires the audience, or one page will show two different numbers.

**Migration: three columns.** Regenerate your migration (`drizzle-kit generate`) and run it yourself. From the 0.1 tables, drizzle-kit 0.31 produces exactly:

```sql
ALTER TABLE "analytics_sessions" ADD COLUMN "internal_reason" text;
ALTER TABLE "analytics_sessions" ADD COLUMN "actor_key" text;
ALTER TABLE "analytics_sessions" ADD COLUMN "classifier_version" integer;
```

The columns are nullable with no default, so no row is rewritten. Every other name is identical to 0.1's, and a snapshot test pins each table, column, default, key and index name against migration 0025. If you add the audience, its four `aig_audience_*` tables come in the same migration.

**What behaves differently for a 0.1 caller:**

| Change | Why |
| --- | --- |
| The site's own SEO audit (`AdminIgloo audit`) no longer appears in the crawler reports: bot list, kinds, top paths, AI reads and coverage | It inflated the `seo-tool` count and the top paths. The rows are still recorded; `includeInternal: true` shows them. |
| New sessions store `classifier_version = 2`. Microsoft 365 Copilot (`copilot.cloud.microsoft`), AI Studio, NotebookLM, Duck.ai, Qwen, Kimi and Pi, and the Claude, Perplexity, Gemini and Copilot Android apps, are now "AI assistants" (they were "Referral") | The classifier learned them. Run `reclassifySources` once to move history the same way. |
| `openai.com` and its subdomains other than `chat.openai.com` (the community forum, help centre and API platform), and `deepseek.com` other than `chat.deepseek.com`, are now "Referral" (0.1 called them "AI assistants") | Every subdomain of a listed host matches, so 0.1 counted developer forums and docs as ChatGPT and DeepSeek answers. `reclassifySources` moves history back out. |
| `AI_ASSISTANT_DOMAINS` and `AI_ASSISTANT_UTM_SOURCES` are readonly arrays (0.1: fixed tuples). Their element type is still the literal union, without `"openai.com"` and `"deepseek.com"` | They are derived from `AI_ENGINES` now. Code that used a tuple's length or position as a type breaks; `(typeof AI_ASSISTANT_DOMAINS)[number]` still works. |
| A failure the beacon swallows (it still always answers 204) goes to `onError`, which defaults to `console.warn`, at most once a minute for the same failure | 0.1 dropped it silently, so a broken database looked like no traffic |
| A beacon body is capped in **bytes** (`maxBodyBytes`, 4096). A declared `Content-Length` over the cap is never read. | 0.1 read the whole body, then compared its length in characters, so a non-ASCII body up to twice the cap got through |
| The salt and "tracking started" caches belong to the instance (per `db` object for the 0.1 functions), not to the process | Two table sets in one process no longer share them |

**Once, after upgrading:** `await analytics.reclassifySources({ tenantId })`. It is idempotent and safe to run on a large table.

## Wiring it into an app (the AdminIgloo site's shape)

### 1. Tables

```ts
// src/db/schema.ts — spread into your Drizzle schema, then `drizzle-kit generate`
export * from "@adminigloo/analytics/schema";      // analytics_* (0.1 names)
export * from "@adminigloo/audience/schema";       // aig_audience_* (if you use the audience)
```

`defineAnalyticsTables({ prefix })` builds the set under another prefix (lower-case letters, digits, underscores, at most 32 characters). Every table, index and constraint name comes from it. Two sets can live in one database, so an app that already has an `analytics_sessions` of its own uses `aig_analytics_`. A foreign-key name Drizzle would derive past Postgres' 63-character limit gets a short form instead: `aig_analytics_page_views_session_fk`. The default prefix never does this.

Under a prefix, **export the prefixed tables by name** and never `export * from "@adminigloo/analytics/schema"`: that line also exports the default set (`analyticsSessions` → `analytics_sessions`), which collides with an app's own tables of those names. Pass the same `tables` to `createAnalytics` **and** to `audienceSessionsSource`:

```ts
// db/schema/aig-analytics.ts
import { defineAnalyticsTables } from "@adminigloo/analytics/schema";
export const aigAnalytics = defineAnalyticsTables({ prefix: "aig_analytics_" });
export const aigAnalyticsSessions = aigAnalytics.sessions; // …and each other table you migrate, by name
```

| Table (`analytics_…`) | Holds |
| --- | --- |
| `sessions` | One row per visit. It holds the daily visitor key, landing path, referrer host, UTM tags and which ad click id was present. It also holds the source bucket, country, device, browser, OS, the counters, and the three 0.2 columns. |
| `page_views`, `events` | Each page and each click, outbound link, conversion or Web Vital, by session |
| `crawler_hits` | Crawler requests per (bot, path, 10 minutes), with a hit counter and whether the claim was verified |
| `salts` | Today's and yesterday's random salt |
| `rate` | The ingest's hourly throttle counters |
| `sites` | When tracking began, per tenant |
| `annotations` | Dated notes for the trend chart |

### 2. The instance

```ts
// src/server/site-analytics.ts
import "server-only";
import { createAnalytics, audienceSessionsSource } from "@adminigloo/analytics";
import { createAudience, createDrizzleAudienceStore } from "@adminigloo/audience";
import { db } from "@/db";

export const ANALYTICS_TENANT = "site";

export const audience = createAudience({
  store: createDrizzleAudienceStore({ db }),
  secret: process.env.AUDIENCE_SECRET!,
  tenantId: ANALYTICS_TENANT,
  visitorIds: "rotating",                                        // the cookieless key changes daily
  sessions: audienceSessionsSource({ tenantId: ANALYTICS_TENANT }), // count exactly the rows the reports read
  // under a prefix: audienceSessionsSource({ tenantId, tables }) — without `tables` it names analytics_sessions
  isInternal: (user) => (user.isStaff ? "staff" : false),
  getUser: (id) => loadUser(id),
});

export const analytics = createAnalytics({
  db,
  audience,                                  // leave out to filter nothing (0.1's numbers)
  license: {
    key: process.env.ADMINIGLOO_LICENSE_KEY,
    publicKey: process.env.ADMINIGLOO_LICENSE_PUBLIC_KEY,
    mode: process.env.ADMINIGLOO_LICENSE_MODE as "off" | "warn" | "enforce" | undefined,
  },
  crawlerVerifier: true,                     // check crawler claims against published IP ranges, cached per instance
});
```

| `createAnalytics` option | Default | What it does |
| --- | --- | --- |
| `db` | required | Any Drizzle Postgres handle: Neon, node-postgres, PGlite, a transaction |
| `tables` | the 0.1 names | `defineAnalyticsTables({ prefix })` |
| `audience` | none: no filter | The `createAudience(...)` instance, or `(tenantId) => instance \| null` for one per tenant |
| `limits` | `DEFAULT_LIMITS` (0.1's) | See [Limits](#limits) |
| `license` | none: ungated | See [License gate](#license-gate) |
| `excludeBots` | `["AdminIgloo audit"]` | Bot names the crawler reports leave out unless `includeInternal`. `[]` shows every bot. |
| `crawlerVerifier` | none: rows recorded unverified | Your own `createCrawlerVerifier(...)`, or `true` for one this instance owns (range lists cached 24 hours) |
| `onError` | `console.warn`, at most once a minute per failure | Told about failures the ingest swallows, `(error, where)`. `where` is `beacon`, `onSession`, `onSession:write`, `onSession:reason`, `onSession:actorKey` or `license`. A reporter that throws is ignored. |

Each instance has its own caches: the salts, "tracking started", and the range lists of a verifier it owns. `invalidate()` drops the first two (after restoring a database, or between tests).

One audience instance carries one tenant: its `tenantId` must be the reports' `tenantId` (the founder's site uses `"site"` in production and `"site:local"` locally, so build the audience with the same `ANALYTICS_TENANT`). A report for any other tenant throws `AnalyticsError("invalid_config")`, because the audience's marks could never match it and staff would quietly count again. Give a function to `audience` if one deployment serves several tenants.

### 3. The beacon endpoint, with the audience at intake

```ts
// app/api/analytics/route.ts
import { auth } from "@clerk/nextjs/server";
import { isNonProductionEnv } from "@adminigloo/audience";
import { analytics, audience, ANALYTICS_TENANT } from "@/server/site-analytics";

const handler = analytics.createHandler({
  tenantId: ANALYTICS_TENANT,
  allowedHosts: ["adminigloo.com"],
  clientIp: (req) => req.headers.get("x-real-ip"),
  resolveCountry: (req) => req.headers.get("x-vercel-ip-country"),
  timeZone: "America/Denver",
  onSession: async (visit) =>
    audience.observe({
      visitorId: visit.visitorId,   // the visit's stored visitor key: what a device mark names
      sessionId: visit.sessionId,   // the visit's row id: what a visit-only mark (automation, a network) names
      userId: (await auth()).userId,
      host: visit.host,
      userAgent: visit.userAgent,
      headers: visit.headers,       // the smoke-test header, GPC/DNT for the link rule
      ip: visit.ip,                 // matched against network rules in memory, then dropped
      nonProduction: isNonProductionEnv(),
    }),
});

export const POST = (req: Request) => handler.handle(req);
```

**What the endpoint does, exactly:**

1. It answers **204 to everything**: a bad payload, a foreign origin, a bot, a privacy signal, a throttled network and a counted page view look the same, so there is nothing to probe. A non-`POST` gets 405.
2. It drops, before reading the body:
   - a request whose `Origin` (or `Referer`) host is not in `allowedHosts`
   - a request carrying `Sec-GPC: 1` or `DNT: 1` (`honorPrivacySignals`, default true)
   - an empty user agent
   - any user agent `classifyCrawler` recognises, including the site's own SEO audit
3. It drops a body larger than `limits.maxBodyBytes`, counted in **bytes**. A declared `Content-Length` over the cap is dropped without reading a byte, and a body that turns out longer stops being read as soon as it passes the cap. Then it drops a payload that fails the schema.
4. It throttles per network per hour: `maxHitsPerNetworkHour` requests and `maxSessionsPerNetworkHour` new visits.
5. A page view opens a visit, or continues one: same document first, else the same visitor key within 30 minutes. A visit takes at most `maxPageViewsPerSession` page views.
6. **After a page view is written, it calls `onSession(visit)` and waits up to `onSessionTimeoutMs` (default 3000) for it.**
   - The hook is never called for a dropped request, an event or a leave.
   - A hook that throws, or is still pending at the deadline, is passed to `onError`. The beacon still answers 204 with the page view recorded and no verdict. A hook is not cancelled at the deadline, and a later failure is reported too. A reporter that throws is ignored.
   - The hook may return the audience's reason (`"role"`, `"automation"`…) or `{ reason, actorKey }`. Each is checked before it is stored:
     - `reason` must be one word: `[A-Za-z0-9_.:-]`, at most 64 characters.
     - `actorKey` must look like a keyed digest: 40 to 128 characters of hex or base64url, such as the audience's `userKey(userId)` (43 characters) or an HMAC-SHA256 in hex (64). A Clerk id, a UUID, a numeric id or an email fails.
     - A value that fails is reported (`onSession:reason`, `onSession:actorKey`) without echoing it, and not stored. This is a sanity check, not a proof: a raw id that happens to be 40 or more such characters passes.
   - An `actorKey` is never stored for a request carrying GPC or DNT. That can only happen with `honorPrivacySignals: false`, and it matches the audience's rule of no link for an opted-out browser.
   - The first non-null answer wins. A session whose answer is already recorded is not written again.
   - A failed verdict write is reported as `onSession:write`. The page view stands.
7. Events (clicks, outbound links, vitals) and leaves never open a visit. A vital outside its plausible range is dropped.

`visit` carries `req`, `tenantId`, `sessionId`, `visitorId`, `isNewSession`, `path` (normalized as stored), `host`, `userAgent`, `headers` and `ip`. **The IP is in memory only:** analytics never stores it, and the audience matches it against network rules and drops it.

The beacon itself: `<AnalyticsBeacon />` from `./client` in your layout. It skips GPC, DNT, `navigator.webdriver` and a local opt-out (`?analytics=off`), and its `disabled` prop drops a visit in the browser.

With the audience, **signed-in** staff no longer need `disabled={staff}`: let their visits arrive and the audience marks them, which keeps an audit trail and an "include internal" view. On a cookieless site, know what such a mark covers:

- **That device's key for that day.** Everyone sharing the IP and user agent that day is left out with it: a household, an office behind one address, a mobile carrier's shared address with the same phone build. These are the people the cookieless model already counts as one visitor, and whose visits within 30 minutes already merge into one.
- **Not the device on other days.** Its signed-out visits on a day nobody signs in on it stay counted. See [Leaving your own people out](#leaving-your-own-people-out).

If your staff browse signed in from a network your customers also use (a co-working space, a shop's Wi-Fi), keep `disabled={staff}` as well.

### 4. Server-side conversions

```ts
const visit = await analytics.recordConversion({ tenantId, ip, userAgent, name: "call_booked", headers });
// → { sessionId, visitorId } for the visit it landed on, or null when there was none (a bot, a blocked beacon)
//   or the request opted out (Sec-GPC / DNT in `headers`, or `privacyOptOut: true`)
if (visit) after(() => audience.classifyActor({ ...visit, userId, headers }));
```

Pass the request's `headers`: an opted-out request then records nothing, as the beacon drops it. Without them, its conversion could land on another browser profile's visit that shares the IP and user agent. `honorPrivacySignals: false` counts it anyway, like the handler option of the same name.

### 5. The crawler log and the daily job

```ts
// proxy.ts — only once classifyCrawler (from ./crawlers) matched the user agent.
// If your proxy does no database work, call it from after() in a route instead.
await analytics.recordCrawlerHit({ tenantId, userAgent, path, ip, country });

// the daily cron
await analytics.runMaintenance({ timeZone: "America/Denver" });
await audience.maintain();
```

`runMaintenance` does three things:

- It deletes salts older than yesterday, after which no stored key can ever be linked to anyone.
- It empties past throttle windows.
- It deletes sessions (with their page views and events) and crawler rows older than `limits.retentionDays`, in batches.

`{ crawlersOnly: true }` touches only the crawler rows, for an install without the session tables. Without it, such an install throws (the salts and sessions tables are missing).

### The crawler half alone (Riddler Go's install)

An app with visitor analytics of its own can take just the crawler log, under its own prefix:

```ts
// db/schema/aig-analytics.ts — these two tables by name; NEVER `export * from "@adminigloo/analytics/schema"`,
// which would also export analyticsSessions → "analytics_sessions" and collide with the app's own.
import { defineAnalyticsTables } from "@adminigloo/analytics/schema";
const t = defineAnalyticsTables({ prefix: "aig_analytics_" });
export const aigAnalyticsCrawlerHits = t.crawlerHits;
export const aigAnalyticsSites = t.sites;

// lib/analytics/aig.ts
export const aig = createAnalytics({ db, tables: t, crawlerVerifier: true });

// where the app already captures crawlers — inside after(), so the proxy itself does no database work.
// Read the IP before after(): without it no claim can ever be verified.
const ip = (await headers()).get("x-real-ip");
after(() => aig.recordCrawlerHit({ tenantId: "riddler-go", userAgent, path, ip, country }));

// an existing daily cron
await aig.runMaintenance({ crawlersOnly: true });
```

- **Two tables, not one.** Recording a hit also stamps "tracking since" in `sites`, a one-row table.
- **Reports that work:** `getCrawlers`, `getRecentAiReads`, `getAiCoverage` and `getTrackingSince`. Every other report (`getDailyTrend`, `getPublicSnapshot`, `getPipelineHealth`, `getAiAssistantTraffic`, `getOverview`…) reads the session tables and throws.
- **Retention:** crawler rows older than `limits.retentionDays` (395) are deleted. Pass `limits: { retentionDays }` to keep them longer.
- **Not migrated for you:** an existing crawler table's history (backfill it with your own script, or let it age out), your tier names (the package's kinds are `ai-assistant`, `ai-search`, `ai-training`…: OAI-SearchBot and PerplexityBot are `ai-search`), and the queries and end-to-end tests over your old table.

### 6. The admin page

```ts
const includeInternal = readIncludeInternal(searchParams);   // from @adminigloo/audience: the URL, never a stored setting
const query = { tenantId, ...lastDays(30, new Date(), zone), timeZone: zone, includeInternal };
const [overview, trend, ai, excluded] = await Promise.all([
  analytics.getOverview(query),
  analytics.getDailyTrend(query),
  analytics.getAiAssistantTraffic(query),
  analytics.getExcludedBreakdown(query),   // null without an audience
]);
```

## Leaving your own people out

The audience decides who does not count and writes **marks**, which are never analytics rows. Analytics applies the marks at read time with the audience's `NOT EXISTS` predicate (`countedVisitorSql`). Nothing is rewritten, so:

- adding a rule (a person, a domain, a device) removes their visits from every report at once, history included;
- removing the rule restores the numbers exactly;
- `includeInternal: true` on a `ReportQuery` counts everyone, **for that one call**. Nothing stores it.

**Which reads apply the predicate.** The guard tests prove the list below covers every read of the visitor tables, down to each SQL statement each report sends ([The guard tests](#the-guard-tests)).

| Report | How |
| --- | --- |
| `getOverview`, `getDailyTrend` (visits), `getSources`, `getReferrers`, `getCampaigns`, `getBreakdown`, `getEngagementBySource`, `getActivity`, `getLandingPages`, `getAiAssistantTraffic` | On the session: its visitor key, its start time (a rule's "only from" date) and its id (a visit-only mark) |
| `getTopPages`, `getTopClicks`, `getEventVisits`, `getWebVitals` | Through the visit each page view or event belongs to |
| `getPublicSnapshot` | **Always**, whatever the caller passes. The founder checking the homepage must never be the homepage's numbers. |
| `getCrawlers`, `getRecentAiReads`, `getAiCoverage`, the trend's crawler line | Crawlers are not people. These leave out `excludeBots` (the SEO audit) unless `includeInternal` |
| `getPipelineHealth` | **Never.** It asks whether anything is arriving at all, and a staff page view proves that. |

**With no audience, nothing is filtered:** every report gives exactly what 0.1 gave. `getExcludedBreakdown` then returns `null`, so a dashboard shows no "Excluded" line rather than a misleading "0".

**`getExcludedBreakdown({ tenantId, from, to })`** returns the audience's `{ total, byReason, unit }` over this instance's sessions table and tenant. `total` is exactly the difference between `getOverview(q).visits.current` with and without `includeInternal`, and the parts add up to the total.

**How far back a rule reaches on a cookieless site.** The visitor key changes daily, so a mark on a device covers that device for that day. A person rule reaches the days the person was signed in (through the audience's links). Their anonymous visits on other days stay counted. Set `visitorIds: "rotating"` on the audience and its preview says so. Rules about one request (automation, a network, a non-production host) mark the session, and the session key is stable.

**A device mark is a mark on everyone behind that key that day.** The key is `HMAC(IP, user agent, tenant)` for one day, so a person reason that marks a device also leaves out anyone else with that IP and user agent that day: a household, an office behind one address, a mobile carrier's shared address with the same phone build. The cookieless model already counts them as one daily visitor. Keep `disabled={staff}` where staff share a network with customers.

### "These are my visits": a signed-out device, about 48 hours back

The founder browses the site signed out, from a laptop or a phone. No sign-in happens on it that day, so no rule can name it, and the audience's "Mark this browser" refuses rotating ids. `markVisitorInternal` marks that device's keys for **today and yesterday**:

```ts
// a server action behind a staff-only "These are my visits" button, pressed ON that device
const visit = await analytics.markVisitorInternal({
  tenantId: ANALYTICS_TENANT,
  ip: clientIp,                        // the same IP your handler's clientIp returns for this browser
  userAgent: headers.get("user-agent"),
  by: me.email,                        // for the audience's run history
  timeZone: "America/Denver",          // the handler's timeZone: the day the salts rotate on
});
// → { visitorIds: [today's key, yesterday's key], subjectsChanged: 2 }
```

- **What it covers:** the device's visits under those two keys, meaning yesterday's and today's so far, and the rest of today. They stop counting at once, history included, and `getExcludedBreakdown` counts them under `device`.
- **What it does not:** tomorrow, a different IP (a phone that moved from Wi-Fi to cellular has another key), or another browser on the device.
- **How it marks:** through the audience's `mark` (reason `device`), so each call writes audience run rows and is undone with `audience.unmark({ subjectKind: "visitor", subjectId })`. Call it from that button, not from the beacon. It is idempotent.
- **Who else it catches:** like any device mark, everyone sharing that IP and user agent on those two days.
- **Needs** an audience for the tenant (`invalid_config` otherwise). It never marks a crawler.

For a device that is never signed in to at all (a tester's phone), use a network rule if it has a fixed address, or the beacon's local opt-out (`?analytics=off` opened once on that device), which drops its visits in the browser and leaves no audit trail.

**The three session columns, exactly:**

| Column | Written when | Read by |
| --- | --- | --- |
| `internal_reason` | `onSession` returns a reason that is one word (`[A-Za-z0-9_.:-]`, at most 64). The first non-null answer of the visit wins | Nothing in the reports. It records what intake said, never a filter. If the audience later clears the mark (a customer restored), the session counts again while this column still says why it was once left out. |
| `actor_key` | `onSession` returns `{ actorKey }` that looks like a keyed digest (40 to 128 characters of hex or base64url), for example the audience's `userKey(userId)`, and the request carried no GPC/DNT. **Never derived by the package**, and anything else (a raw id, an email) is refused | Nothing in 0.2. Setting it makes a person's signed-in visits linkable for as long as sessions are kept, so leave it unset to stay fully cookieless. |
| `classifier_version` | Every new session: `SOURCE_CLASSIFIER_VERSION` (2) | `reclassifySources`. It is null for 0.1 rows. |

## AI assistant traffic

`aiEngineOf(input)` names the assistant a visit came from, or returns `null`:

```ts
aiEngineOf({ referrerHost: "chatgpt.com", utmSource: null });   // "chatgpt"
aiEngineOf("https://www.perplexity.ai/search/x");                // "perplexity" (a URL: only its host is read)
aiEngineOf("claude.ai");                                         // "claude" (a host)
aiEngineOf("chatgpt");                                           // "chatgpt" (a utm_source value works too)
aiEngineOf("https://www.bing.com/chat");                         // null: Bing, whatever the path says
```

It matches **hostnames only**: a registrable suffix, so `www.` and subdomains match and lookalikes never do. Because every subdomain matches, a host is listed only where the assistant **is** that host. `chatgpt.com` is listed and `openai.com` is not, since OpenAI's subdomains are its forum, help centre and API platform. `chat.deepseek.com` is listed, not `deepseek.com`. It also matches Android app packages (`android-app://com.anthropic.claude`) and exact, lower-cased `utm_source` values. A `utm_source` that names an engine wins over the host. It never reads a path.

| Engine | Hosts | `utm_source` | Android |
| --- | --- | --- | --- |
| `chatgpt` ChatGPT | chatgpt.com, chat.openai.com | chatgpt, chatgpt.com, chat.openai.com, openai | com.openai.chatgpt |
| `perplexity` Perplexity | perplexity.ai | perplexity, perplexity.ai | ai.perplexity.app.android |
| `claude` Claude | claude.ai | claude, claude.ai, anthropic | com.anthropic.claude |
| `gemini` Gemini | gemini.google.com, bard.google.com, aistudio.google.com, notebooklm.google.com | gemini, google_gemini, gemini.google.com, bard | com.google.android.apps.bard |
| `copilot` Microsoft Copilot | copilot.microsoft.com, copilot.cloud.microsoft | copilot, bing_copilot, copilot.microsoft.com | com.microsoft.copilot |
| `you`, `phind`, `poe`, `meta`, `mistral`, `deepseek`, `grok`, `duckai`, `qwen`, `kimi`, `pi` | you.com, phind.com, poe.com, meta.ai, chat.mistral.ai, chat.deepseek.com, grok.com, duck.ai, chat.qwen.ai, kimi.com, pi.ai | the host, and the bare name where unambiguous | none |

`m365.cloud.microsoft` is **not** an AI host. It is the whole Microsoft 365 app hub, where Copilot Chat is only a path (`/chat`), and the path is never read. Those visits stay "Referral" under that host. `copilot.cloud.microsoft`, AI Studio, NotebookLM, Duck.ai, Qwen, Kimi, Pi and the Android packages come from research and have not been checked against live traffic.

**What it cannot see:** Google AI Overviews and AI Mode, and Copilot answers inside Bing, arrive from `google.com` and `bing.com` and count as Search. Assistants that send no referrer and no UTM arrive as Direct.

`getAiAssistantTraffic(query, { landingPagesPerEngine = 5, pageLimit = 20 })` covers the visits in the `aiAssistant` bucket, filtered like every other report. It returns:

- `visits`: the total.
- `engines`: per engine, its visits, engaged rate, conversions and top landing pages, plus `assistantFetches`, the live fetches by that engine's own bot (ChatGPT-User, Claude-User, Perplexity-User, MistralAI-User, DuckAssistBot, Meta-ExternalFetcher) in the range.
  - Those are User-Agent **claims**: anyone can send `ChatGPT-User`. `assistantFetchesVerified` counts the ones whose IP was inside the operator's published ranges.
  - Only OpenAI and Perplexity publish ranges for their assistant bots, so for Claude, Mistral, Duck.ai and Meta this is always 0. It also needs a crawler verifier (`crawlerVerifier: true`).
- `pages`: each landing page with its visits by engine, beside the assistant fetches of that page (`assistantFetches`, `assistantFetchesVerified`, and `fetchesByBot` with `hits` and `verifiedHits` per bot). For example: "ChatGPT-User fetched /pricing 14 times (9 verified), and 6 visits came from ChatGPT".

### Reclassifying history

```ts
await analytics.reclassifySources({ tenantId }, { dryRun: true });
// { scanned: 1840, changed: 12, changes: [{ from: "referral", to: "aiAssistant", sessions: 12 }], version: 2, dryRun: true, complete: true }
await analytics.reclassifySources({ tenantId });
```

It re-runs the classifier over the stored referrer host, UTM source and medium and click-id kind of every session in the window (`from` and `to` optional) whose `classifier_version` is null or below the current one. With `force: true` it also re-reads the current version's sessions. It never touches a session a **newer** classifier stored (a newer package, mid rolling deploy), force or not: an older classifier would downgrade it.

- It rewrites `source_bucket` and `classifier_version` and nothing else, so it is fully retroactive.
- It works in batches by id (`batchSize`, default 1000). `maxBatches` stops it early with `complete: false`; run it again to finish.
- It is idempotent: a second run scans nothing.
- It ignores the audience, because it counts nobody.

## Limits

| `limits.…` | Default | What |
| --- | --- | --- |
| `maxHitsPerNetworkHour` | 600 | Requests per network (an HMAC of the IP) per hour |
| `maxSessionsPerNetworkHour` | 30 | New visits per network per hour: a household or an office, not a script. Raise it for venue Wi-Fi. |
| `maxPageViewsPerSession` | 500 | Past this a visit is a loop, and further page views are dropped |
| `maxDurationDeltaMs` | 1 800 000 | Foreground time one beacon may add |
| `maxBodyBytes` | 4096 | A beacon body larger than this many **bytes** is dropped. A declared `Content-Length` over it is never read, and a longer stream stops being read at the cap. |
| `maxUtmLength` | 100 | A stored UTM value is cut to this |
| `maxLabelLength` | 120 | A stored click label is cut to this |
| `crawlerBucketMs` | 600 000 | Crawler rows are counted per (bot, path, bucket) |
| `retentionDays` | 395 | What `runMaintenance` keeps |

These are 0.1's constants (`DEFAULT_LIMITS`; the old `MAX_*` exports are deprecated aliases). A limit that is not a positive whole number, or one the package does not know, throws `AnalyticsError` (`invalid_config`). The payload's field shapes (path ≤ 2000 characters, event name, label ≤ 200 before scrubbing) are fixed.

## The reports

Every method takes a `ReportQuery`: `{ tenantId, from, to, timeZone?, includeInternal? }`. The range is half-open, `[from, to)`. `timeZone` is an IANA zone for day buckets; an unknown zone falls back to UTC. `lastDays(n, now, zone)` gives exactly `n` local days.

| Method | Returns |
| --- | --- |
| `getOverview(q)` | Visits, daily visitors, page views, engaged visits and conversions, each with its prior-period delta. The delta is null when there is no honest comparison. Also engaged rate, engaged time and pages per visit. |
| `getDailyTrend(q)` | Per local day: visits, daily visitors, page views, engaged visits and AI crawler hits. Days before tracking began are null. |
| `getSources(q)` | All eight buckets with prior-period deltas |
| `getReferrers(q, limit = 20)`, `getCampaigns(q, limit = 20)` | Referrer hosts with their bucket; campaigns with source, medium, engaged rate and conversions |
| `getBreakdown(q, "country" \| "device" \| "browser" \| "os", limit = 15)` | Visits per value |
| `getEngagementBySource(q)`, `getActivity(q)` | Per bucket: engaged rate, time, pages and conversion rate. The hour-by-weekday heatmap. |
| `getTopPages(q, limit = 20, onlyPaths?)`, `getLandingPages(q, limit = 20)` | Views and visits per path; landings with engagement and conversions |
| `getTopClicks(q, limit = 20)`, `getEventVisits(q, names)` | Clicks, outbound links and conversions. Distinct visits per event name or conversion label, for a funnel. |
| `getWebVitals(q, pathLimit = 10)` | p75 of LCP, INP and CLS over page loads (one sample per load), overall and per entry page |
| `getAiAssistantTraffic(q, options?)` | See [AI assistant traffic](#ai-assistant-traffic) |
| `getCrawlers(q, limit = 25)` | Bots with hits, verified hits, pages and last seen; hits by kind; top paths with AI hits |
| `getRecentAiReads({ tenantId, since, paths?, limit?, includeInternal? })`, `getAiCoverage({ tenantId, paths, since, includeInternal? })` | The latest AI reads (assistants first); which pages each AI crawler has read |
| `getPublicSnapshot({ tenantId, days, publicPaths, funnel?, now?, timeZone? })` | Aggregates safe for a public page. Paths come only from `publicPaths`, applied in SQL. Sources are buckets only. A vital's p75 is withheld under 50 loads. The audience is always left out. License-gated like every report: **a public page must catch `isAnalyticsError`** and render without it. |
| `getPipelineHealth(tenantId)` | The last page view, event, vital, conversion, crawler hit and AI crawler hit, unfiltered and never license-gated |
| `getTrackingSince(tenantId)`, `getExcludedBreakdown({ tenantId, from, to })` | When tracking began; the excluded line |
| `reclassifySources(window, options?)` | See [Reclassifying history](#reclassifying-history) |
| `listAnnotations`, `addAnnotation`, `deleteAnnotation` | Dated notes for the trend chart (not license-gated) |

Aggregates come back as JavaScript numbers whatever the driver: they are cast in SQL, because `pg` returns `int8` as a string. Dates in the public snapshot are ISO strings, so it survives a JSON cache.

## Privacy: exactly what is stored

| Stored | Never stored |
| --- | --- |
| The daily visitor key, `HMAC(salt of the day, IP ‖ user agent ‖ tenant)`, unlinkable once the salt is deleted the day after next | An IP address (used only inside the HMAC, in memory) |
| The path, normalized: query and hash dropped, token-shaped segments replaced by `:token`, your `pathPatterns` applied | A user-agent string (only coarse device, browser and OS families) |
| The referrer **host** | A referrer path or query |
| UTM values, scrubbed (an email or token-shaped value is refused) | A query string |
| **Which** ad click id was present (`gclid`) | Its value |
| A click label, scrubbed (emails, phone numbers and tokens refused) | A cookie or device id |
| Country code, device, browser, OS | |
| `internal_reason`, the audience's verdict word (anything that is not one word is refused) | |
| `actor_key`, **only if your `onSession` returns one** that looks like a keyed digest (a pseudonymous HMAC you chose), and never for a request carrying GPC/DNT | The user id behind it (a raw id or an email returned as `actorKey` is refused) |

Crawler rows hold the bot's name, kind and operator, the path, the country and whether the claim was verified against the operator's published ranges. They never hold the IP that was checked.

A suggested privacy-page line: *"We count visits without cookies. Your IP address and browser are combined into a code that changes every day and cannot be traced back to you; we keep the page you visited, the site that sent you, and your country and device type."* If you set `actor_key`, add: *"When you are signed in, your visits are linked to your account under a pseudonymous key."* Not legal advice.

## License gate

`license: { key, publicKey, mode }` checks feature `"analytics"` with `@adminigloo/license`.

- **What it guards:** the reports, meaning every `get…` except `getPipelineHealth`, plus `reclassifySources`. A denial throws `AnalyticsError` with code `unlicensed` and status 402. That includes `getPublicSnapshot`, so a public page (a homepage live window) must catch `isAnalyticsError` and render without it.
- **What it never guards:** the ingest, the crawler log, conversions, maintenance, `markVisitorInternal`, annotations and the pipeline health. A lapsed license must not lose a single visit (renewing brings the full history back), retention must keep deleting what is no longer kept, and the health strip can still show that data is arriving.
- **Modes:** `"off"` (the default) never denies. `"warn"` never denies either, and tells `onError` once per instance (`where: "license"`) when the license is missing, invalid or expired. `"enforce"` denies.

The 0.1 free functions run ungated.

## The guard tests

Three layers keep "internal never counts" true as reports are added:

1. **Per file:** `src/__tests__/guard.test.ts` runs `@adminigloo/audience/testing`'s `assertCountedReads` over this package's own source. Every file that reads the sessions, page-views or events table must apply `countedVisitorSql` or carry a written exemption:

   | Exempt file | Reason |
   | --- | --- |
   | `ingest.ts` | The writer |
   | `health.ts` | Liveness |
   | `reclassify.ts` | Rewrites buckets and counts nobody |

2. **Per function:** the per-file check passes a whole file on one use, so a second check splits every non-exempt source file into functions. Every function that reads those tables must go through `sessionWindow`, `countedSessions` or `countedThroughSession`. That holds whether it reads them through `ctx.t`, a 0.1 named export (`analyticsSessions`) or a destructuring.
3. **Per statement:** a function that calls a helper once would still pass if a second query in it forgot. `src/__tests__/sql-guard.integration.test.ts` captures every SQL statement every report sends, under two table prefixes, and requires each one to apply the predicate. Every read of the sessions table needs the visitor marks, the session marks and the rule's "only from" date. Every read of page views or events needs a counted `EXISTS` on its session, scoped to the tenant. Only `getPipelineHealth` is exempt.

Negative controls prove each layer catches what it should. In your app, put the same `assertCountedReads` over any file that reads the analytics tables directly.

## Deprecated: the 0.1 API

| 0.1 | 0.2 |
| --- | --- |
| `createAnalyticsHandler({ db, …config })` | `createAnalytics({ db }).createHandler(config)` |
| `recordConversion(db, input)` → `boolean` | `analytics.recordConversion(input)` → `{ sessionId, visitorId } \| null` |
| `recordCrawlerHit(db, input)`, `runAnalyticsMaintenance(db, input)`, `resolveVisitorKeys(db, input)` | `analytics.recordCrawlerHit(input)`, `analytics.runMaintenance(input)`, `analytics.resolveVisitorKeys(input)` |
| `getOverview(db, query)` and every other `get…(db, …)`, `listAnnotations`, `addAnnotation`, `deleteAnnotation` | The same name on the instance, without `db` |
| `MAX_HITS_PER_NETWORK_HOUR`, `MAX_SESSIONS_PER_NETWORK_HOUR`, `MAX_PAGE_VIEWS_PER_SESSION`, `MAX_DURATION_DELTA_MS`, `CRAWLER_BUCKET_MS` | `DEFAULT_LIMITS.…`, and `createAnalytics({ limits })` to change them |

The wrappers run on `defaultAnalyticsFor(db)`: one instance per `db` object, with the 0.1 tables, default limits, no audience, no license and no verifier unless a call passes one. **They never see an instance you built**, so in an app with `createAnalytics({ db, audience })` the wrappers still count staff. They are removed in 1.0.
