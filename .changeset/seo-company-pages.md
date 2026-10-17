---
"@adminigloo/seo": minor
---

Every company's public pages on one site (0.2.0).

- A `private` or `noindex` path may use `*` as one whole segment (`/t/*/quote`): every company's token pages under their web addresses, blocked in robots.txt (`Disallow: /t/*/quote/`), sent noindex and refused by the sitemap, never `/t/green-acres` itself. `normalizePattern` is the rule on its own. A `*` inside a segment, first, or in a public path is still refused.
- `localBusiness({ richResult: false })` names a business that has no address yet, for answer engines, without claiming a local result. `id` and `url` give a company's page its own node.
