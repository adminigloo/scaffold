---
"@adminigloo/catalog": minor
---

A `credits` grant kind: `{ unit, amount }` (a lower-case unit slug and a whole amount per unit bought), validated by `grantConfigSchemas.credits`, for a product that puts a spendable balance in the buyer's account (held by @adminigloo/wallet). `GRANT_KINDS`, every kind in product-builder order, so a router's input enum can't fall a kind behind the `GrantKind` union.
