---
"@adminigloo/estimator": minor
---

`startingPrices(db, tenantId, { settings })`: the products a business shows on its website, each with "from $X" — the low end of its smallest job's price, priced by `priceProduct` with `audience: "public"` (so the minimum charge, option defaults and the never-a-public-$0 rule all apply), rounded down to whole units. No price while instant estimates are closed or for a product priced by quote.
