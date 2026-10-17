# @adminigloo/seo-reports

## 0.2.0

### Minor Changes

- a4d0708: The search check, per company (seo-reports 0.2.0, Tenancy 2b-4b).
  
  - **Every report is one company's** (`tenant_id`; `"*"` is the site's own). Every read and write names it; another company's report id is "not found". `sql/upgrade-0.1-to-0.2.sql` gives 0.1's reports to the site's own (safe twice); `sql/seo-reports-0.2.0.sql` for hosts without drizzle-kit.
  - **robots.txt read the way crawlers read it** (`parseRobots`, `robotsVerdict`): user-agent groups (two agents sharing one group — 0.1's false pass), an agent's own group over `*`, longest rule wins and Allow on a tie, `*` and `$`. `robotsBlocks(txt, agent, path?)` keeps its name.
  - **New checks**: the page names itself as its main address (canonical), `X-Robots-Tag`, noindex (now a fail), structured data's `@type`, duplicate titles and summaries, broken links between pages, Google and Bing let in, llms.txt (an HTML catch-all page no longer passes), pages that move to another site.
  - **A whole check** (`runSiteCheck({ targets })`): only the company's own addresses — its websites and its pages under a path on a shared site — home, sitemap and linked pages, 3 at a time, at most 50 pages, 2 MB a page, 8 seconds a page and 45 seconds a check; a cap reached is said in the report.
  - **SSRF-safe fetcher** (`createSafeFetcher`, `isBlockedAddress`): http/https on standard ports only, no credentials in the address, the company's own hosts only, every name resolved and refused if any address is private, loopback, link-local, carrier-grade, documentation, multicast or metadata (IPv4 and IPv6, mapped forms included), every redirect re-checked, the connection pinned to the checked address, our own User-Agent.
  - **Handlers** (`createSeoReportsHandlers`, `SEO_REPORTS_ADMIN_ROUTES`, `seoReportsPermissions`): the overview, one report, Check now; the month's limit, a running check and a closed plan (`admit`) refused in one lock before any page is read; `rateLimit`; `runScheduled` for a weekly job.
  - **The screen** (`@adminigloo/seo-reports/ui`: `<SearchCheck>`, `createSearchCheckTransport`): the latest report as a worklist in plain words, what's already good, past checks, Check now.
  - Breaking: `saveSeoReport`, `listSeoReports` and `getSeoReport` take the company id; `runSeoReport` no longer takes `fetchImpl` (pass `resolve`/`transport`); `getReportSchema` is gone.
  - Only "Check now" presses count against `monthlyLimit`; the weekly check (`runScheduled`) is free, and a check that died with its process neither counts nor blocks. `runScheduled(tenantId, limits)` takes the time the caller has left.
  - On a host a company shares, only its own path (and the host's robots.txt, llms.txt and sitemap) is read — a redirect to /admin or another company's pages is refused (`allowUrl`, refusal `outside_pages`). Name lookups have a time limit. IPv6: only global unicast (2000::/3, minus its special ranges); mapped, translated and NAT64 forms are refused.
  - An address can wait (`CheckTarget.pending`): it is never read, and the screen says why. The overview says what's read as a sentence (`addressSentence`), what's waiting, and when the next automatic check runs.
  - Plain words: "the short summary Google shows", "the page's main address", "image descriptions", "ChatGPT's reader (GPTBot)"; "1 character". The 0.1 upgrade works out old reports' pass/warn/fail counts from their stored verdicts.

## 0.1.0

### Minor Changes

- First release: SEO and AEO audits as a business operation. `runSeoReport`
  crawls the site's own sitemap (same-origin, capped, and the cap is reported
  rather than silent) and scores two halves with evidence on every check —
  the search-engine half (titles, descriptions, canonicals, social cards,
  alt coverage, indexability, a sitemap-listed page that 404s) and the
  answer-engine half (llms.txt, JSON-LD validity, sectioned content, and
  whether GPTBot/ClaudeBot/PerplexityBot/Google-Extended/CCBot are allowed
  in by robots.txt). Reports persist in the app's own `seo_reports` table
  via `saveSeoReport`/`listSeoReports`/`getSeoReport` — the receipts, not
  just the grade. Storage-free, network-injected, React-free: the parser is
  honest regex over served HTML and fails toward "warn", never a false pass.
