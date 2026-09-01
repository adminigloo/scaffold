# @adminigloo/billing

## 0.2.0

### Minor Changes

- The two decisions a subscription mirror has to make before it writes, and the
  column that makes the first of them possible.
  
  The firm owns `subscriptions`, which is what makes both of these load-bearing
  rather than fussy. A table that merely caches a provider can be wrong for a
  while and repaired by the next read; a table that is AUTHORITATIVE is wrong
  until somebody complains, and everything downstream is wrong with it.
  
  **New: `decideSubscriptionWrite`, in `src/mirror.ts`.** Which of two
  observations is newer. Stripe delivers events concurrently and redelivers for
  three days, so a `customer.subscription.updated` describing a state the customer
  left ten seconds ago routinely arrives after the one that replaced it —
  applying it takes a live subscription back to `trialing`, or an ended one back
  to `active`. Stripe offers three candidate clocks and they are not equally
  trustworthy: `subscription.created` is identical on every event that
  subscription will ever emit and orders nothing; arrival time is the quantity
  being defended against; `event.created` is the instant the change happened and
  is fixed for a given change however many times it is redelivered. So that is the
  watermark. The residue is stated rather than hidden: one-second resolution means
  two changes inside one second fall back to arrival order, except that a
  subscription Stripe has DELETED can never be resurrected by a same-second event,
  because there is no state after deletion.
  
  **New: `subscriptionEntitlementWindow`.** What each subscription state does to
  the entitlement rows the plan granted — two answers, not one, because "which
  rows should exist" and "are they live right now" have different consequences.
  `planGrantDiff` owns the first and `expires_at` owns the second, and only the
  first ever deletes anything. That split is what stops a past-due tenant losing
  their `used_value` the moment their card is retried.
  
  - `trialing` / `active` — served, no deadline.
  - …with `cancel_at_period_end` — served TO THE PERIOD END. The deadline goes on
    the rows, so access ends on the right day BY ITSELF, without depending on a
    `customer.subscription.deleted` that may never arrive.
  - `past_due` — served for a bounded dunning window. `isEntitledStatus` refuses
    to call past_due entitled and says why: "past due entitles you" has no expiry.
    It also says where the answer belongs — "a dunning policy with an end date" —
    and `PAST_DUE_GRACE_MS` is that date, expressed on the column designed to
    carry one. It is also what makes `describeSubscription`'s existing promise
    ("access continues in the meantime") true.
  - `unpaid` — not served, from now. Rows stay, so settling the invoice restores
    the allowance AND its usage.
  - `incomplete` — not served. Nothing has been paid for.
  - `canceled` — the plan's rows go, through `planGrantDiff(current, null)`, which
    removes only rows whose source is `plan`.
  
  **New columns: `subscriptions.last_event_at` and `last_event_id`.** The
  watermark, and the delivery that justified it. Without somewhere to record which
  observation has already been applied, "which of these two events is newer"
  becomes "which arrived second", which is the one answer that is definitely
  wrong. `updated_at` cannot serve: it is stamped by our clock when the row is
  written, so a redelivery of an ancient event looks like the newest thing that
  ever happened. Both are nullable — a comped subscription an admin granted was
  never observed at Stripe, and a NULL watermark correctly reads as "nothing
  applied yet".
- The typed plan record: one object that the pricing page, the entitlement check
  and the Stripe seed all read.
  
  `plans` has always been a table of what a plan COSTS and never a description of
  what one INCLUDES, so the answer lived in three uncoordinated places — a limit
  beside the check that enforced it, a bullet list on a pricing page, a number in a
  Stripe seed. The first copy to drift is always the page, because it is the one a
  customer reads and the only one no test exercises.
  
  **New: `definePlans`, in `src/plans.ts`.** A constructor in the same shape as
  `definePermissions` and `defineAuditedActions`: a terse literal in, a validated
  and indexed catalog out. The feature vocabulary is declared once and each tier
  supplies only values, so a feature added to Pro and forgotten on Starter is a
  compile error rather than a hole in a comparison table and a `no-entitlement`
  answer that blames the customer's plan.
  
  Three kinds of feature, because client pricing is not booleans:
  
  - `quota` — a number, or `null` for unlimited. Reaches `entitlements.limit_value`
    unchanged.
  - `flag` — reaches it as 1 or 0. Zero rather than no row, so an add-on granting
    the same feature can still turn it on and the audit trail records the
    withholding.
  - `option` — an enum-restricted choice ("check every 10 minutes on Pro, every
    minute on Business"). Emits NO entitlement row: rows sum, and there is no sum
    of two frequencies. Read with `planAllows`, and restricted by the type as well
    as at construction.
  
  Prices are a map over interval and then currency, in `bigint` minor units, from
  the start — retrofitting a second currency onto a single-price record means
  touching the record, the projection, the Stripe sync and every page that prints
  a price at once.
  
  **The record is the source of truth; the `plans` table is a projection of it plus
  the two cached Stripe ids.** One row per (tier, interval, currency), because that
  is what a Stripe Price is. `entitlements.source_ref` carries the TIER key, not the
  row key, so moving from monthly to yearly does not rewrite a tenant's
  entitlements. The two are written by different events and cannot be made to agree
  by construction, so disagreement is made loud instead: `reconcilePlans` reports
  every row no tier projects and whether it is still purchasable, and proposes no
  deletions — `subscriptions.plan_id` is `on delete restrict`.
  
  **Add-ons are deliberately not modelled.** A seat pack is a product in
  `@adminigloo/catalog` with an `entitlement` grant on it, and it already has a
  price, a Stripe sync and an admin screen. What billing owes it is that a plan
  change never revokes it, which `planGrantDiff` holds.
  
  **BREAKING — `grantsForPlan` and `planGrantDiff` now take the record.** Both had
  zero call sites, so this is the last free moment to fix them.
  
  - `grantsForPlan(plan, features)` → `grantsForPlan(tier)`. The `grants_*` prefix
    and `FeatureGrants` existed only to pick features out of a flat settings bag; a
    typed record has no unrelated keys in it.
  - `planGrantDiff(current, next)` now takes `next: PlanTier | null`, where `null`
    is a cancellation. `current` is still the rows a tenant actually holds. This
    removes the inference of which sources the diff owned from whatever happened to
    be in `next`, including the empty-array special case: `grantsForPlan` only ever
    emits `plan`, so that is the only source ever removed.
  - Removed: `GRANT_PREFIX`, `FeatureGrants`, `PlanRef`, `EmptyPlanKeyError`.
  - `InvalidGrantLimitError` moved to `./plans.js` and now fires at construction,
    so a bad quota fails the deploy rather than a customer's checkout.
  - Added: `InvalidPlanKeyError`, `InvalidPlanCatalogError`.
  
  `PlanInterval` moved from `schema.ts` to `plans.ts` and is re-exported by both,
  so `@adminigloo/billing` and `@adminigloo/billing/schema` are unchanged. It was
  the one union declared in the schema rather than imported into it, and the plan
  record is now what decides which cadences a tier can be sold on.

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
  - @adminigloo/permissions@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies
  - @adminigloo/db@0.2.0
  - @adminigloo/permissions@0.1.1

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
