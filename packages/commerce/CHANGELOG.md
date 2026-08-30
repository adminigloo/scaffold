# @adminigloo/commerce

## 0.1.2

### Patch Changes

- Tailwind, the product builder, in-app checkout — and three bugs that made the
  whole thing unusable.
  
  - **commerce could never create its tables.** `minSubtotalMinor.default(0n)`
    crashed drizzle-kit with "Do not know how to serialize a BigInt" during
    `generate` — while still leaving a journal behind, so the next `migrate`
    reported "applied successfully" having applied nothing. Now `sql\`0\``.
  - **The generated schema barrel omitted commerce and billing.** Orders, plans,
    subscriptions and entitlements were absent from every migration.
  - **catalog's permissions were tenant-scoped but gated with `requireStaff`.**
    Defining what is for sale is an operator activity; declared under "tenant"
    those keys could never match, so the whole Products section was invisible with
    no error anywhere. Now staff-scoped with staff defaults, and a test asserts no
    key names a non-staff template.
  
  Also: Tailwind v4 with a token set both themes share, a real admin shell, the
  product builder with a Stripe sync plan shown before you publish, embedded
  Payment Element checkout, and `src/permissions/catalog.ts` is now generated so
  package fragments land in the scope their callers actually read.

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
