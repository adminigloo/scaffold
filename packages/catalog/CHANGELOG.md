# @adminigloo/catalog

## 0.1.0

### Minor Changes

- A product catalog both commerce and billing can sell from.
  
  There was nowhere to define a product. `commerce` stores `orderItems.productRef`
  as a bare string, and `billing.plans` models recurring subscriptions only — so a
  project selling a physical thing had no catalog at all.
  
  - `products` / `product_variants` / `product_grants`. The grant is the seam that
    lets one checkout serve a deck of cards and a SaaS seat without either knowing
    about the other.
  - `planStripeSync()` is a PLANNER, not a caller, because Stripe prices are
    immutable: you cannot change an amount, currency or interval on an existing
    Price. A sync that tries to patch one silently no-ops and the customer is
    charged the old amount forever. Currency comparison is case-normalised —
    case-sensitive, a hand-typed `USD` reads as a change and archives-and-recreates
    the price on every run, orphaning subscriptions across a trail of prices.
  - `formatMinor()` never converts through `number`. JPY has no minor unit, so
    dividing by 100 is wrong, and a large bigint loses its last digit.
  - Archived is not deleted: an archived product must still render on the order
    that bought it.
