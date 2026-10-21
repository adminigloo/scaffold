# @adminigloo/aeo

## 0.3.0

### Minor Changes

- ed86e90: Delete a company (create-app 0.37): `forgetTenant(db, tenantId)` from the root takes every row this package keeps for one company — its questions, profile and AI answers — children first, each statement filtered by the company's id, on the caller's transaction. Returns the rows each table lost; refuses an empty id and the site's own ("*"). Proved per package on PGlite with `@adminigloo/testing/forget`: every table planted for two companies, the first forgotten, nothing of the second touched.

### Patch Changes

- 2de60cb: No "Something went wrong" where the cause is knowable. An answer that isn't the package's own (a platform's error page, a proxy, a timeout) is read by its status — signed out (401), no permission (403), not here any more (404), too big (413), too many tries (429), the site not answering (502, 503) or too slow (504) — instead of "Unexpected answer from the server (502)." or the generic line; the generic sentence is left for a truly unknown failure. A dropped connection on the customer's invoice page says so, and "Couldn't reach the server." tells the person to check their internet connection.

## 0.2.0

### Minor Changes

- a4d0708: AI mentions, per company (aeo 0.2.0, Tenancy 2b-4b).
  
  - **Who the business is** lives once per company (`aeo_profiles`: name, website, other names, competitors); questions are just the question. `sql/upgrade-0.1-to-0.2.sql` builds each company's profile from its newest 0.1 question and keeps every row (safe twice).
  - **Code reads the answer** (`analyzeAnswer`): named or not (word-bounded), its own website among the cited sources or not, the competitors named, the quoted words around the mention. The model is never asked any of it, and nothing it returns is obeyed.
  - **Engines are adapters** (`AnswerEngine`). `@adminigloo/aeo/anthropic`: Claude Haiku 4.5 with the web search tool (at most 3 searches, 1,024 tokens), returning only the text and the cited addresses and the provider's own counts; its worst case is held, its web searches priced at $10 per 1,000.
  - **Every check is metered** (`runMentionChecks`): held before it's asked (`spend.reserve`), settled with the provider's counts and the search fees after, released when the deadline came first; deadline-aware, 2 at a time. An engine without metering is refused at construction.
  - **Tenant leaks fixed**: `deactivateQuery(db, tenantId, id)`, `listChecks(db, tenantId, queryId)`, `recordCheck` only for the company's own question; `queriesWithLatest` reads one row per question (no full-history scan).
  - **Handlers** (`createAeoHandlers`, `AEO_ADMIN_ROUTES`, `aeoPermissions`): overview, profile, add/remove a question, one question's history, check one, check all; `admit` (plan open), `rateLimit`, `runScheduled` for a weekly job (questions not answered this week).
  - **Trend per question** (`questionTrends`): answers and mentions per week, counted in Postgres.
  - **The screen** (`@adminigloo/aeo/ui`: `<AiMentions>`): who the business is, the questions, the verdict, the quote (as text), the sources (http(s) links only), the competitors and the trend.
  - Breaking: `runCitationChecks` (unmetered) is gone; `createQuerySchema`'s brand is optional.
  - A website matches only as a whole host: ace.co never inside grace.com, place.com or ace.com (in the words or as a source); brand names and other names as whole words; positions read on the original text, so a quote is cut where the mention is.
  - A call stopped at its time limit, or never started because the deadline came, is released, not charged; a call starts only when its whole time limit fits.
  - The hold is a conservative ceiling: at most 2 searches, every step re-reading the searches before it at 25,000 tokens each (`worstCaseUsage`; about 11.5¢ at Haiku 4.5). `checkCosts` reports the measured average.
  - `questionLimit` (the plan's questions, counted under a per-company lock), `allowanceNotice` (the weekly job skips a used-up month without holding anything; the screen says so) and `automatic` (the screen says when each question is asked again).
