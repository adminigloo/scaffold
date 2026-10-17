---
"@adminigloo/ai": minor
---

The ledger and an allowance, in the package (0.2.0).

- **`@adminigloo/ai/server`** (new entry): `recordAiUsage(db, rates, input)` — one `ai_usage` row per call, priced in integer micros from the PROVIDER's token counts (cache writes included), cost null when unknown, never throws; `aiSpendSince(db, { tenantId?, since, operations? })` — one company's or the whole site's spend, cents rounded once on the total; and **`checkAiAllowance(db, { tenantId, operations, allowance: { monthlyMessages, monthlyCents }, siteDailyCents })`** — a company's month (calls and/or cents, starting again on the 1st, UTC) and the site's day, counted from the rows themselves, refusing in a plain sentence and **failing closed** when the ledger can't be read. Before 0.2 every project carried its own copy of the first two in src/server/ai.ts.
- **`reserveAiAllowance`** (after an independent review): check AND hold, inside one lock — a "reserved" `ai_usage` row at the call's worst case, counted by every allowance — so calls in flight can't all slip through (40 at once on a 3-question month: 3 pass). `settleAiReservation` writes the real, priced cost (keeping the worst case when the cost is unknown: never null), `releaseAiReservation` frees an unused one. Messages count only ANSWERED calls (`answered` on `aiSpendSince`; a failed one still counts as money). `allowance.dailyCents`: one company's share of the site's day. The site ceiling's sentence says it's the whole site and resets at midnight UTC, with `limitedBy` and `siteResetsAt`, and `onSiteCeiling` tells the site owner.
- **`DEFAULT_AI_MODEL`** = `"claude-haiku-4-5"` (both entries): the cheapest capable model, the founder's default for every AI feature.
