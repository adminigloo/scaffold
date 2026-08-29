# @adminigloo/billing

## 0.1.0

### Minor Changes

- Subscriptions and entitlements: a local plan catalog, what a purchase grants,
  and proration.
  
  - The local catalog is the source of truth for what a plan MEANS; Stripe is the
    payment engine, not the product database.
  - `resolveEntitlements` sums limits across sources so a plan and an add-on
    stack, treats a single unlimited row as decisive, and clamps over-consumption
    at zero while still reporting it.
  - `checkEntitlement` returns a REASON, not a boolean, so the UI can say "you
    have used all 5 seats" instead of denying generically.
  - `prorateMinor` refuses to prorate across two currencies. `plans.currency` is
    per-plan by design, and netting a charge against a credit in a different
    currency produces a number that looks entirely plausible and is meaningless.
  - `mapStripeSubscriptionStatus` is total, and its default is NOT active.
    Defaulting an unknown status to active hands service to someone who has not
    paid, and Stripe adds statuses.
