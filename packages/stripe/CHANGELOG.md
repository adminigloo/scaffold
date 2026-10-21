# @adminigloo/stripe

## 0.5.0

### Minor Changes

- ed86e90: Delete a company (create-app 0.37): `forgetTenant(db, tenantId)` from the root takes every row this package keeps for one company — its connected account's record here (the account itself stays at Stripe) and the card events recorded for it — children first, each statement filtered by the company's id, on the caller's transaction. Returns the rows each table lost; refuses an empty id and the site's own ("*"). Proved per package on PGlite with `@adminigloo/testing/forget`: every table planted for two companies, the first forgotten, nothing of the second touched.
- 2de60cb: When Stripe says no, everyone hears it in their own words. `describeStripeFailure(error)` reads a failed call — the site not signed up for Connect (Stripe's 400 "You can only create new accounts if you've signed up for Connect…") or its platform profile unfinished, a wrong (401) or restricted (403) key, no key at all (`stripeNotSetUp`), Stripe not answering (5xx, or the SDK's own dropped connection — a database that is down, "fetch failed" or ECONNREFUSED from anything but the Stripe SDK, is "something went wrong on our side", never Stripe's outage), its rate limit, any other refusal — and gives the owner one plain sentence ("Card payments aren't switched on for this site yet. We've told whoever runs it."), Stripe's own words and the link to fix it for the site's staff, and the type, code, status and request id for the log. `createConnectAdminHandlers` answers Connect Stripe with it (never "Something went wrong" again), reports every failure through `onError` with what it means (`context.stripe`), and hands Stripe's sentence and the fix link (`error.staff`) only to callers its new `staffDetail` option says are the site's staff.

### Patch Changes

- Updated dependencies [ed86e90]
  - @adminigloo/permissions@0.3.0

## 0.4.1

### Patch Changes

- f73f6cf: `createDirectCheckoutSession` takes `lines`, the store's server-priced lines (name, unit amount, quantity) for Stripe's page — their sum must be `amountMinor` exactly, or nothing is sent — and `shippingCountries`, which turns on `shipping_address_collection` for those countries. Without them, one line reading `description` and no address, as before.

## 0.4.0

### Minor Changes

- 17ca6ea: Connect for companies: each company takes card payments from its own customers on its OWN Stripe account (Standard-style through the Accounts API controller settings: the company's full Stripe dashboard, Stripe carries losses, the company pays its own Stripe fees). `startConnectOnboarding` makes or reuses the company's one account and returns an onboarding link back to /app/payments; `stripe_connected_accounts` keeps the account and its charges/payouts flags per company, updated by `applyAccountUpdate` from `account.updated`; `disconnectConnectedAccount` stops new card payments but keeps the row so refunds on earlier payments still find their company.
  
  `createDirectCheckoutSession` charges directly on the company's account (`stripeAccount`) for a server-decided amount, with this site's optional cut as `application_fee_amount` from `platformFeeMinor` (PLATFORM_FEE_BPS, default 0; rounded down to the whole cent). The Connect webhook resolves its company only from `event.account` (`companyForConnectEvent`; an unknown account is ignored), and `runLedgeredEvent` runs the two-phase ledger keyed by account + event (`connectLedgerKey`). New: `createConnectAdminHandlers` with `STRIPE_CONNECT_ADMIN_ROUTES` (status, connect, disconnect), `stripeConnectPermissions` (`payments.view`, `payments.manage`), `stripeConnectServer()` (STRIPE_CONNECT_WEBHOOK_SECRET, PLATFORM_FEE_BPS) and `stripeInvoicePaymentsServer()` (STRIPE_INVOICE_WEBHOOK_SECRET). Run `sql/upgrade-0.3-to-0.4.sql` before deploying.
  
  A company that removes this site in Stripe (deauthorized) connects a NEW account next time; every account is kept (one active per company) so refunds on an old one still find it. `account.updated` applies only when newer than the last one applied. Connect asks the country (default US). The owner screen names the connected account (business name, last 4 of its id), links that account's dashboard, says "contact {site}" instead of a setting's name, and `onDisconnect` closes the company's open payment pages. The fee text says it isn't returned on refunds.

## 0.3.0

### Minor Changes

- e3d0371: Change a company's plan on its existing subscription, never a second one. `previewPlanChange` asks Stripe what the switch costs today (prorated; a credit when moving to a cheaper plan), and `changePlan` makes exactly that change with the same proration date. The price is changed with `payment_behavior: "pending_if_incomplete"`, so a failed charge leaves the company on the plan it was paying for; the plan's name is stamped on the subscription only once the change went through.
  
  `changePlan` refuses a proration date that isn't the preview's (in the future, or older than 30 minutes), so an upgrade can't be dated to cost almost nothing and a downgrade can't credit time already used. New `prepareCompanyCheckout`: before a company's first plan checkout it finds or makes the company's ONE Stripe customer, asks Stripe whether a subscription already exists (paid but not yet mirrored, or never finished), and closes the company's other open checkouts, so two tabs, or paying and coming straight back, can never end in two subscriptions.

## 0.2.1

### Patch Changes

- Updated dependencies [cc16902]
  - @adminigloo/permissions@0.2.0

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
