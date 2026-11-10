---
"@adminigloo/create-app": patch
---

Fixes from building Hinderstap (a consumer one-time shop with AI, SEO and the assistant):

- AI costs: `src/server/ai.ts`'s `ModelSpend` carries cache-write tokens and fees, `spendFromUsage` copies everything the provider bills (cache reads and writes, web searches at $10 per 1,000), and the chat route uses it. With ai 0.4.2 the row's reported snapshot (`claude-haiku-4-5-20251001`) is priced from the alias's row instead of written with a null cost.
- `--audience consumers`: the generated `permissions.integration.test.ts` seeds the member's own personal account, which every membership gate admits. Its company fixture failed five tests in every consumers project.
- `/sign-out` is disallowed in robots.txt and private in `src/seo-paths.ts`.
- `next dev` opened as `http://127.0.0.1` hydrates: `next.config.ts` lists it in `allowedDevOrigins`, and DEPLOYMENT.md's troubleshooting table names the localhost Clerk-cookie clash that sends you there.
