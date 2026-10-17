---
"@adminigloo/catalog": minor
---

`product_variants.held`: the stock open store checkouts hold, apart from `inventory` (what is on the shelf). Available is inventory − held; a payment takes the quantity off both, an unpaid checkout gives it back to `held` only, and an owner editing the shelf count never touches what carts hold. The site's own products keep `held` at 0. Run `sql/upgrade-0.2-to-0.3.sql` before deploying (adds the column at 0 and its non-negative check; safe twice).
