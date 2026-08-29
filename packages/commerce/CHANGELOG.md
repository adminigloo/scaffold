# @adminigloo/commerce

## 0.1.1

### Patch Changes

- Updated dependencies
  - @adminigloo/db@0.2.0
  - @adminigloo/stripe@0.1.1
  - @adminigloo/permissions@0.1.1

## 0.1.0

### Minor Changes

- One-time purchases: cart, orders, shipping, tax and fulfilment on top of the
  Stripe primitive.
  
  - All money is bigint minor units end to end, with rounding done once. Percent
    discounts round half up on integers; a fixed discount can never take a total
    below zero.
  - ONE canonical order-creating event. trailcards creates orders from both
    `checkout.session.completed` and `payment_intent.succeeded`, each checking
    whether the other ran — two writers to one invariant, and the interleaving
    that produces two orders is rare enough to reach production.
  - Discounts are Stripe coupons, not negative line items. Product images are
    filtered to absolute URLs, because Stripe rejects relative paths with an
    unhelpful "Not a valid URL".
  - Session metadata is copied onto the PaymentIntent, since a Session's metadata
    does not propagate to the PaymentIntent it creates — and the ledger reads the
    tenant back out of it.
