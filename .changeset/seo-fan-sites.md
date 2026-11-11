---
"@adminigloo/seo": minor
---

Describe the books, films and games a fan or review site is about with `creativeWork()`, carry a site-wide disclaimer, and verify the site with search engines (found building Hinderstap).

- `creativeWork(site, { type, name, authors, datePublished, isPartOf, position, … })` for `Book`, `BookSeries`, `Movie`, `TVSeries`, `VideoGame` and the rest of `CREATIVE_WORK_TYPES`, with `creativeWorkId()` so every page can `ref()` the same work. A year (`"1990"`) or a month (`"2023-07"`) is accepted when the sources give no day.
- `defineSite({ disclaimer })`: one line ("An unofficial fan site; not affiliated with …") printed under the summary in llms.txt and llms-full.txt.
- `defineSite({ verification: { google, bing, yandex } })`: `siteMetadata` writes each engine's verification meta tag. A pasted DNS value works too, and empty values are skipped.
- llms-full.txt keeps a page's summary as a standfirst above its body, instead of replacing it.
