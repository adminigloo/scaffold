---
"@adminigloo/create-app": minor
---

Website reports per company (create-app 0.31.0, Tenancy 2b-4b): the search check (`--seo-reports`) and AI mentions (`--aeo`).

- **Companies mode**: `/app/website` gains "Search check" (`seo_reports.view`; Check now on `seo_reports.run`) and "AI mentions" (`aeo.view`; questions and Check now on `aeo.manage`), over `/api/app/{id}/search-check` and `/api/app/{id}/ai-mentions` through the company seams. The Website page is generated with the sections the project has (it exists with any of `--analytics`, `--seo-reports`, `--aeo`). A check reads only the company's own pages here and its websites from the analytics register.
- **This site's own** at `/admin/seo` and `/admin/aeo` on new staff keys (`staff.seo_reports.view/.run`, `staff.aeo.view/.manage`), over `/api/admin/search-check` and `/api/admin/ai-mentions`, in both modes. The tRPC `seo` and `aeo` routers and `src/server/aeo-asker.ts` are gone.
- **With `--ai`**: checks ask Claude Haiku 4.5 with web search, every answer held and settled on the AI ledger as `aeo_check` (web searches priced in), inside the company's month, its share of the day and `AI_SITE_DAILY_CENTS`; rate limited. Without `--ai` questions are kept and Check now says checking isn't switched on.
- **Plans**: "search checks a month" (`site_checks`, 4 / 20 / unlimited) and, with `--ai`, "AI mention checks a month" (`ai_mention_checks`, 50 / 250 / unlimited), through `planLimit` (`siteCheckLimit`, `aiMentionCheckLimit`); `companyPlanOpen` keeps a closed plan from starting paid work, from routes and crons alike.
- **Crons** (vercel.json, CRON_SECRET): `/api/cron/search-check` and `/api/cron/ai-mentions`, daily, each address and question re-checked once a week inside a time budget.
- The isolation proof drives `SEO_REPORTS_ADMIN_ROUTES` (on a stand-in network) and `AEO_ADMIN_ROUTES` (on a scripted engine with `--ai`) as another company, with a check, a profile, a question and an answer planted for each.
- Single-business mode: the site's own only, on staff keys.
- Versions: seo-reports 0.2.0, aeo 0.2.0, ai 0.3.0. Upgrade notes for 0.31: the two upgrade SQL files, moving 0.1's fixed-business questions to the site's own.
- Review fixes: both crons are timed from their start and end by 50 seconds (an item starts only when a whole one fits); AI mentions holds dead reservations released; the weekly search check is free ("Check now presses a month (a weekly search check is included)"); plans sell "questions tracked by AI mentions" (5 / 15 / 25) beside "AI mention checks a month" (40 / 100 / unlimited); AI mentions has its own day, AI_MENTIONS_DAILY_CENTS ($1.50, at most half of AI_SITE_DAILY_CENTS); a website is checked only once its visits line has counted a visit; /admin/aeo shows the measured average cost per check.
