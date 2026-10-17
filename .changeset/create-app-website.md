---
"@adminigloo/create-app": minor
---

Website visits and search basics per company (create-app 0.30.0, Tenancy 2b-4a).

- **`--analytics`** (brings `@adminigloo/audience`) and **`--seo`**, and `create-app add analytics` / `add seo`.
- **Companies mode**: `/app/website` (`analytics.view`, in the company nav) — the company's visits to its pages here and its own website, sources with search engines and AI assistants by name, pages, AI crawlers, its websites with the one line to paste, who is left out (`audience.manage`) and "these are my visits"; routes `/api/app/{id}/website` and `/api/app/{id}/audience`; the beacon and the crawler log on every `/t/{web address}` page (`<PublicCompanyGate>`), counted for that company (`/api/t/{web address}/website`); every company's own website through `/api/w`. Its own team is left out of its numbers. A closed plan keeps the numbers readable and stops counting; a project that sells plans gets "websites of your own counted" (1 / 3 / unlimited, `websiteQuota` in src/server/plan-gate.ts).
- **This site's own numbers** at `/admin/analytics` on `staff.analytics.view`, `staff.analytics.manage` and `staff.audience.manage`, from the beacon every `(site)` page mounts (`src/components/SiteAnalyticsSlot.tsx`, two variants; signed-in screens not counted). A single business is one site.
- **`--seo`**: `src/seo.ts`, `app/robots.ts` and `app/sitemap.ts` on `@adminigloo/seo` from one path list, robots.txt naming the AI crawlers (the analytics list when installed); each company's public pages get their own title, canonical address and LocalBusiness details from its company settings and join the sitemap; token pages stay out; nothing indexed off production.
- The isolation proof drives `ANALYTICS_ADMIN_ROUTES`, `ANALYTICS_PUBLIC_ROUTES` and `AUDIENCE_ADMIN_ROUTES` as another company (with a website, a visit and a rule planted for each) and checks that a website's key pasted on another company's site counts nothing.
- `/api/cron/analytics` daily (salts, retention, each audience's rules re-applied); `AUDIENCE_SECRET` optional (made from `CLERK_SECRET_KEY`).
- Versions: analytics 0.3.0, audience 0.2.0, seo 0.2.0.
- **A company's people are its own**: who a company leaves out is looked up among its members and invitations only (`companyPeople` in src/server/website.ts), and the isolation proof checks it from the other company's side.
- **A company that isn't taking requests** — suspended, or its trial ended or no plan where plans are sold — is shut on its pages (`<PublicCompanyGate>` asks the plan's standing too): no widget, counter or crawler log, noindex, and out of the sitemap; the sitemap lists `/estimate` only once the estimator is set up.
- A company's pages-here beacon counts only `/t/{its web address}` pages; the Host header is trusted only in development; a website can't be the app's own address or (deployed) localhost.
- `openGraph.locale` is `en_US`.
- Upgrade notes for 0.30: move `@adminigloo/audience` to 0.2 together with analytics 0.3 and run `upgrade-0.2-to-0.3.sql` (adminigloo.com included).
