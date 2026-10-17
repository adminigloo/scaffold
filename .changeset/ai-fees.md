---
"@adminigloo/ai": minor
---

A call's fees beyond tokens (ai 0.3.0): `AiCallUsage.feesMicros` — web searches, priced by the caller from the provider's own count — is added to the token cost by `aiCallCostMicros`, so `recordAiUsage` and `settleAiReservation` charge it. A negative fee is ignored. AI mentions (aeo 0.2) settles every check with it.

Also: `operationsDailyCents` — a feature's own share of the site's day across every company (refusal `feature_day`), so one feature can't switch off the others; and `sweepStaleReservations` — holds nobody settled, released after a set time, not charged.
