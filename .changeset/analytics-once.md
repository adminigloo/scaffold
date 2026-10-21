---
"@adminigloo/analytics": minor
---

A conversion that counts once: `recordConversion({ …, once: "<key>" })` records at most one conversion per key for the tenant — a second call with a key already recorded writes no event, leaves the visit alone and returns null. Without `once` every call counts, as before. The key is kept on the event row (in `metric_id`, which only web vitals used), so no table changes. create-app 0.39 counts a sign-up and a first payment once per person with it.
