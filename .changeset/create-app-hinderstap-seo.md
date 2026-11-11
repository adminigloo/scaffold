---
"@adminigloo/create-app": minor
---

Keep one address in search, verify the site and announce new pages with IndexNow, and give a fan site its disclaimer (found building Hinderstap).

- With `--seo`, a production page read on any other host (www., the `*.vercel.app` aliases) gets a 308 to `NEXT_PUBLIC_APP_URL`'s host, and `INDEXABLE` also needs a real public app URL, so a site never has two indexable copies.
- With `--seo`, `GOOGLE_SITE_VERIFICATION` and `BING_SITE_VERIFICATION` write the engines' verification meta tags. `INDEXNOW_KEY` is served at `/indexnow-key.txt`, and `pnpm seo:indexnow --origin https://your-domain` announces every page the live sitemap lists.
- Every project's `src/seo.ts` has `SITE_DISCLAIMER`, shown in the footer (and, with `--seo`, in both llms files).
- `docs/content-for-answer-engines.md` (with `--seo`) has the writing habits that get pages quoted.
- CI's build step sets a placeholder `NEXT_PUBLIC_APP_URL`, so a new project's first CI run no longer fails with "Invalid URL".
- `app/globals.css` says how to bring in an existing stylesheet without it overriding Tailwind's utilities.
