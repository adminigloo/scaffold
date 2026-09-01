# @adminigloo/stripe

## 0.2.0

### Minor Changes

- Reading a Stripe subscription, and publishing a plan's price to Stripe.
  
  Two things a subscription mirror cannot be written without, and both are here
  rather than in the generated project because both encode knowledge about a
  pinned API version that a project copy would carry forward silently and wrongly.
  
  **`subscriptionSnapshot(subscription)`** flattens a `Stripe.Subscription` into a
  record with no Stripe types in it. It exists because two of the five fields a
  mirror needs have MOVED, and reading the old spelling yields `undefined` rather
  than an error — so the subscription mirrors with no period at all, and the
  billing page tells the customer their renewal date is "a date we do not hold"
  while their card is charged every month. Against `2026-08-26.dahlia`:
  
  - `subscription.current_period_start` / `current_period_end` are gone. The
    period is per ITEM now (`items.data[0].current_period_*`), because one
    subscription can bill several items on different cycles. This scaffold sells
    one item per subscription, and that assumption is stated here once instead of
    in the webhook, the resync and whatever comes third.
  - The status is deliberately NOT narrowed. `mapStripeSubscriptionStatus` in
    `@adminigloo/billing` is the one place that decides what an unrecognised
    status means, and it takes `string` precisely so a value Stripe invents next
    year has an answer — narrowing here would make its default branch look dead.
  
  **`subscriptionIdFromInvoice(invoice)`** reads
  `parent.subscription_details.subscription`, which is where the link went when
  `invoice.subscription` was removed. It returns NULL for a one-off invoice rather
  than throwing: a handler that threw would answer 500 to an ordinary event,
  Stripe would retry for three days, and the endpoint would be disabled with every
  other event on it.
  
  **`SUBSCRIPTION_EVENT_TYPES`** is the list a mirror must cover, exported so a
  route can assert it against its own registry at module load. An event enabled on
  the endpoint with no handler is delivered, ledgered and discarded in silence.
  
  **`ensurePlanPrice(client, input)`** creates the Stripe Product and Price a plan
  row bills against and reports the ids to cache. Nothing created them before,
  which is why a complete plan catalogue had nothing to charge with. It is
  idempotent three ways over — the cached id is VERIFIED against the record rather
  than trusted, the Price `lookup_key` is `plans.key` so a cleared cache
  re-attaches instead of duplicating, and the creates carry idempotency keys for
  the double-click window. A Stripe Price is immutable, so a repriced tier
  produces a NEW Price and `transfer_lookup_key` moves the name onto it: the old
  Price keeps billing the subscribers already on it, which is the only behaviour
  that does not silently restate what somebody agreed to pay.

## 0.1.3

### Patch Changes

- Updated dependencies
  - @adminigloo/env@0.3.0
  - @adminigloo/db@0.2.2

## 0.1.2

### Patch Changes

- Shared dependency versions moved to pnpm's `catalog:` protocol.
  
  `drizzle-orm` was written out in eleven manifests and `zod` in nine, so bumping
  either was a bulk edit nobody could review — and the failure mode of a missed
  line is silent: two packages built against two different minors of drizzle emit
  .d.ts files whose column types are structurally incompatible, and the error
  surfaces in a generated project as an unreadable mismatch between two packages
  that each look correct on their own. `pnpm-workspace.yaml` now names each
  version once.
  
  **Nothing changes in the published tarballs.** pnpm rewrites `catalog:` to the
  literal range when a package is packed, and the packed manifests were compared
  against the previous ones to confirm it: every dependency, devDependency and
  peerDependency range is byte-for-byte what it was. This is recorded because the
  manifests changed and because the replacement is a publish-time behaviour worth
  being able to find in a changelog, not because a consumer will see anything.
  
  There are TWO catalogs on purpose. The default names the single version this
  workspace builds and tests against; the `peers` catalog names the wider range
  published packages promise their consumers — `drizzle-orm` is built against
  `^0.45.2` and accepts `^0.45.0`, `zod` is built against v4 and still accepts
  v3.25+. Collapsing them into one entry would silently narrow every published
  peer range, which is a breaking change for every consumer one patch behind.
  
  A new test in `@adminigloo/create-app` fails if any workspace manifest goes back
  to spelling a catalogued range out, and if the ranges the generator writes into
  a new project drift from the catalog.
- Updated dependencies
  - @adminigloo/db@0.2.1
  - @adminigloo/env@0.2.1
  - @adminigloo/permissions@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies
  - @adminigloo/env@0.2.0
  - @adminigloo/db@0.2.0
  - @adminigloo/permissions@0.1.1

## 0.1.0

### Minor Changes

- The Stripe primitive: sessions, signature verification, an event ledger with
  leased two-phase idempotency, and a typed handler registry.
  
  - The ledger fixes both source repos. riddler-go tracks "did I just insert
    this" in a process-local `Set`, which returns the wrong answer on the first
    delivery to a cold instance and still answers 200, so the event is dropped
    permanently. trailcards has no ledger and lets both
    `checkout.session.completed` and `payment_intent.succeeded` create orders.
  - Claims are LEASED. Without that, a handler that throws leaves the row
    existing-but-unprocessed forever, every retry defers, and Stripe disables the
    endpoint after three days — the ledger reintroducing the loss it prevents. A
    thrown handler releases its claim immediately; a dead process ages out.
  - `attempts` and `last_error` are written by the documented statements, so a row
    stuck at attempts 12 is an alert that can actually fire.
  - Owns the whole `billing.*` permission namespace, including its defaults.
    `billing.refund.issue` is sealed and seeded to nobody.
