# @adminigloo/seo-reports

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
