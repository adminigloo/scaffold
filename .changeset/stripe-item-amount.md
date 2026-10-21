---
"@adminigloo/stripe": minor
---

`subscriptionSnapshot` carries what each item is actually charged: `items[].amountMinor`, its Price's `unit_amount` times its quantity (null for a price with no whole unit amount, never 0). A Price from before a repricing still bills the people on it at the old amount, which a plan record's price no longer says — create-app 0.39's mirror writes it to `subscriptions.price_minor` so the founder's MRR counts what really comes in.
