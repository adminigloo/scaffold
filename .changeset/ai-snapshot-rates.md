---
"@adminigloo/ai": patch
---

Price the model id the provider reports. Requests name an alias (`claude-haiku-4-5`) and Anthropic reports the dated snapshot that answered (`claude-haiku-4-5-20251001`), so a rate table keyed by the alias, as every generated project's is, priced nothing: every `ai_usage` row for the default model was written with a null cost, and a settled reservation kept its worst case.

- New `rateFor(rates, model)`: the exact id first, then the alias a trailing eight-digit date belongs to. A snapshot with a row of its own still wins, and own properties only (an id like "constructor" can't find a price on Object's prototype).
- `aiCallCostMicros`, and so `recordAiUsage` and `settleAiReservation`, look rates up through it. Rows still record the exact id reported.
- Found building Hinderstap (a reply that cost about 0.6¢ was recorded at its 1.0¢ worst case).
