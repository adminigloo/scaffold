# @adminigloo/ai

Conventions for AI calls in your app: authorize before a stream opens, meter it through cancellation, record what it cost in integer micros — and, since 0.2, refuse in plain words, failing closed, once a company's month or the whole site's day is spent.

## What each install gets you

| You install | You get |
| --- | --- |
| `@adminigloo/ai` | `createStreamRoute` (resolve the person and the company, check the permission, THEN open the stream), `meterStream` / `reportUsage` (usage reported once, however the stream ended), `estimateCostMicros` / `costMinorUnits` (integer arithmetic, rounded once), `aiPermissions`, `aiServer()` / `configuredAiProviders()` (optional provider keys), and `DEFAULT_AI_MODEL` (`"claude-haiku-4-5"`, the cheapest capable model). Client-safe. |
| `@adminigloo/ai/schema` | The `ai_usage` table: one row per call — company, person, the exact model, what it was for, every kind of token, the cost in micros (null when unknown, never zero), how it ended. |
| `@adminigloo/ai/server` | The ledger (0.2.0): `recordAiUsage(db, rates, input)` (prices the PROVIDER's token counts with your rate table — cache writes included — and never throws), `aiSpendSince(db, { tenantId?, since, operations? })` (one company's or the whole site's spend), and `checkAiAllowance(db, { tenantId, operations, allowance, siteDailyCents })`. Server-only. |

## The allowance

```ts
import { checkAiAllowance } from "@adminigloo/ai/server";

const verdict = await checkAiAllowance(db, {
  tenantId: company.id,
  operations: ["assistant_chat"],
  allowance: { monthlyMessages: 300, monthlyCents: 300 }, // null = no limit of that kind
  siteDailyCents: 500, // every company spends YOUR key: this bounds your worst day
});
if (!verdict.ok) return refuse(verdict.message); // "This month's assistant allowance is used up (300 messages). It starts again on November 1."
```

- A company's month counts calls and/or cents of the operations you name, from the 1st, UTC. The site's day counts every company and every operation.
- **It fails closed**: a ledger it can't read refuses ("…can't check its allowance right now…"). An unmetered call is the one omission that makes a same-day bill.
- Counted from the rows themselves, so the number is always the real one. Two calls racing at the very edge can both get through: it's a ceiling on a month, not a lock.
- `words` overrides the sentences.

## Holding a call's place

`checkAiAllowance` is read-only — for a status screen. Before a call, use `reserveAiAllowance(db, { …same input, userId, operation, model, reserveMicros })`: inside one lock it runs the same checks — counting every call still in flight at its worst case — and writes a "reserved" row. Settle it after with `settleAiReservation(db, rates, id, { usage, status })` (the real, priced cost; the worst case stays when the cost is unknown — never null), or `releaseAiReservation` when the model was never asked. Messages count only ANSWERED calls (a failed one still counts as money). `allowance.dailyCents` holds one company to a share of the site's day.

## The rate table is yours

Prices are never baked in: you pass the table (micros per million tokens, whole numbers) for the models you call. A model missing from it is recorded with an unknown cost — and create-app's glue refuses to call a model it can't price.

## Upgrading from 0.1

Nothing breaks. A project made with create-app moves its own `recordAiUsage` and `tenantSpendSince` copies onto `@adminigloo/ai/server` (the generated `src/server/ai.ts` does it), and gets the allowance.

## Not included

- A provider SDK: install the one you call (`@anthropic-ai/sdk` for Claude).
- Billing your customers for AI: the ledger is for your own spend and limits.
- Per-person limits: use your rate limiter for those (create-app's /api/ai/chat keeps one per person as well).
