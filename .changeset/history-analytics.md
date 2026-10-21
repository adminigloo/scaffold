---
"@adminigloo/analytics": minor
---

Past visits brought in from records: `analytics.importVisits({ tenantId, visits })` (server-side only, no route). Each visit once by the importer's own `key` (unique per company; a new `import_key` column and index on sessions), filed under a visitor key hashed from the old tool's visitor id with the company (the raw id is never stored), its source classified by the live rules, its pages in order. Tracking-since moves back to the earliest visit, never forward. The audience still decides what counts: reports leave an imported visit out exactly as a live one, and with `userId` the audience's people rules are applied to it. A date in the future, before 2000 or older than `limits.retentionDays`, another company's website, or a missing key, visitor or page is refused per visit, in words; at most 1000 a call.

Delete a company (create-app 0.37): `forgetTenant(db, tenantId, { tables })` takes every visit, page view, event, crawler visit, rate counter, website, chart note and the tracking-since row of one company, children first (the day salts are no company's).

**Upgrading from 0.3:** run `sql/upgrade-0.3-to-0.4.sql` (one nullable column and its index; safe twice) or `pnpm db:generate`. A fresh install without drizzle-kit runs `sql/analytics-0.4.0.sql`.
