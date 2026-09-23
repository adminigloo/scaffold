---
"@adminigloo/estimator": minor
---

Money and tenancy fixes from a sweep of the estimator against its SG Glass source.
**Breaking within 0.x** — see "Upgrading" below.

**Security / money**

- **The public submit no longer trusts the browser's prices.** New
  `publicSubmitSchema` + `createPublicEstimate(db, input, { tenantId, taxRateBp })`.
  A line names only `productId`, `description`, `measurement`, `quantity` and
  `optionValueIds`. The server prices each line, labor is 0, the discount is 0,
  the tax rate comes from the tenant config you pass (not the body), and there is
  no `photoUrl`. A lead needs `customerName` plus an email or a phone. The embed's
  `/v1/submit` and the generated app's `estimator.submit` both use it. Before,
  `unitPrice: 1` in the request body saved a $0.01 line. `createEstimate` is now
  documented as the staff-only path; its old comment claimed the opposite.
- **The public can't lower a price through the measurement.** On the public
  path (`createPublicEstimate`, `calculateEstimate` with `audience: "public"`,
  and the embed's `/v1/calculate` and `/v1/submit`), `measurement.units` is
  ignored and the line is priced with units = 1. Before, `units: 0` dropped
  every `per_unit` material from the quote, and `units: 0.0001` passed the
  unit-mode check and billed a sliver of them. The key is stripped, not
  refused. So estimator-widget 0.1.0 embeds already on customers' sites, which
  send `units: quantity`, keep working and are no longer billed per-unit
  materials quantity² times. A public area product needs `widthIn` and
  `heightIn` > 0. A bare `sqFt` is refused (`invalid_measurement`), and a
  `sqFt` or `linearFt` sent beside width × height is ignored: a bare area
  priced the perimeter at 0, so every per-linear-ft rate and material (a
  frame, a seal) fell out of the quote. The saved public line records the
  measurement that was priced. New: `publicCalculateEstimateSchema`, the public
  live-range input (it drops `units`), for a host that validates the body
  itself.
- **Every by-id call is tenant-scoped.** Affected: `getEstimate`,
  `getProductDetail`, `updateProduct`, `deactivateProduct`,
  `setEstimateStatus` and `markEstimateConverted`. The catalog writes are
  scoped too. They used to take any id, so one workspace could change
  another's public prices or revoke its embed key:
  - `createOption` and `attachComponent` check the product. `attachComponent`
    also checks that the material is the tenant's.
  - `createOptionValue` (and its option lock) and `setDefaultOptionValue` check
    through option → product.
  - `detachComponent` checks through the assignment's product.
  - `deactivateComponent` and `revokeClientKey` check the row directly.

  An id that isn't the tenant's changes nothing. The creates throw
  `EstimatorInputError` (`product_unavailable`, `option_unavailable` or
  `component_unavailable`). `detachComponent`, `deactivateComponent` and
  `revokeClientKey` return `false`; `revokeClientKey` used to return `void`.
  `calculateEstimate` takes an optional `{ tenantId, audience }` scope. A
  material from another workspace is never priced.

**Correctness**

- **The saved line is the price the customer was shown.** A server-priced line
  is priced once, at its real quantity, and its total is the midpoint of that
  range. It was priced at quantity 1 and multiplied, which is a different number
  when a minimum charge or a per-unit material is involved: three $50 posts under
  a $200 minimum saved as $615 instead of $205.
- **`per_unit` components now scale by `measurement.units`** (the sub-units in
  one of the product, default 1), and quantity multiplies the line once.
  Previously they scaled by quantity and then by quantity again (qty²).
  `resolveMeasurement` no longer drops width×height when `units` is also given.
- **Measurements are checked against the product's mode.** Area needs
  width×height or `sqFt` > 0 (only width×height from the public). Linear needs
  `linearFt` > 0. `units` must be a whole number ≥ 1 (default 1) wherever it is
  read, so a unit product always has one. There are upper bounds too
  (`MEASUREMENT_LIMITS`). A measurement that doesn't fit the mode gets `null`
  from `calculateEstimate`, and the create functions refuse it. A staff
  `units` that isn't a whole number ≥ 1 fails the schema.
- **Unavailable products are refused, not saved at $0.** That covers inactive
  products, another tenant's products, products the public can't see, and
  quote-only products on a staff line with no `unitPrice`. The public tool's
  "request a quote" path still works: a quote-only product becomes a $0 line
  carrying `QUOTE_REQUEST_NOTE`.
- **Option selections are resolved and snapshotted.** `selectedOptions` is
  rebuilt from `optionValueIds` against the product's own options. The
  caller's map is ignored (and deprecated). New `optionSnapshot` stores
  `{ optionName, valueLabel, priceModifier }` for each choice. Two values of one
  option are refused.
- **Estimate numbers are unique per tenant.** There is a unique index on
  `(tenantId, estimateNumber)`. The next number is one past the highest this
  year, not the row count, and a 23505 collision is retried. The estimate and
  its lines are inserted in one transaction.
- **A discount larger than the subtotal is refused.** `createEstimate` throws
  `discount_exceeds_subtotal`, and `calculateTotals` throws `RangeError`. It
  used to produce a negative total.
- **`updateProduct` validates its patch** with the new `updateProductSchema`: no
  `tenantId`, no defaults (under zod 4, `createProductSchema.omit().partial()`
  refilled every defaulted field a patch left out), and `estimateLowBp` must be
  ≤ `estimateHighBp`, even when the patch changes only one end.
  `createProduct` checks the range too.
- **One default per option.** Creating a default value clears the other defaults
  on that option in a transaction. New: `setDefaultOptionValue(db, tenantId, valueId)`.
- **Status transitions are enforced** (`ESTIMATE_STATUS_TRANSITIONS`,
  `allowedNextStatuses`): draft → sent → viewed → approved/rejected/expired,
  approved → converted, and rejected/expired → draft. `converted` is terminal.
  The check runs inside the UPDATE, so it is atomic.
- **Only invoicing converts an estimate.** New:
  `markEstimateConverted(db, tenantId, id)` claims an estimate for invoicing
  exactly once. It is the only way to reach `converted`, and it claims only an
  `approved` estimate. It returns null when the estimate is not approved (a
  draft, rejected or expired quote the customer never accepted), is already
  converted, or is not the tenant's. `setEstimateStatus` returns `false` for
  `converted`. Before, the admin offered "converted" as a manual move from
  approved. That marked the estimate invoiced with no invoice, and because the
  invoicing bridge refuses a converted estimate, it could never be billed. The
  generated admin no longer offers the move.
- **Options can be staff-only** (`showInEstimator`, default true). They are left
  out of `listPublicOptions` and `/v1/options`, and public pricing ignores them.
  A staff-only product is not priced for the public.

Refusals throw `EstimatorInputError` with a `code`. The embed answers
`400 { error: code }`, and the generated router maps it to `BAD_REQUEST`.

**Upgrading**

- Add `tenantId` as the second argument to `getEstimate`, `getProductDetail`,
  `updateProduct`, `deactivateProduct`, `setEstimateStatus`, `createOption`,
  `createOptionValue`, `attachComponent`, `detachComponent`,
  `deactivateComponent` and `revokeClientKey`. The generated app's estimator
  router and demo seed already pass it.
- Public submits go through `createPublicEstimate`, and public option reads go
  through `listPublicOptions`. If you validate a public live-range body
  yourself, use `publicCalculateEstimateSchema`, not `calculateEstimateSchema`.
  Pass your tax rate to `createEstimatorHandlers({ taxRateBp })`
  (a number, or a `(tenantId) => rate` lookup). If you leave it out,
  `DEFAULT_TAX_RATE_BP` (8.25%) applies.
- In unit mode, send the count as `quantity`. The public path ignores
  `measurement.units`, and a staff `units` must be a whole number ≥ 1.
- When you offer staff their next status moves, leave `converted` out of
  `allowedNextStatuses(status)`. Convert only through `markEstimateConverted`,
  and treat its null as "do not invoice".
- Wrap `createEstimate`, `createPublicEstimate`, `createOption`,
  `createOptionValue` and `attachComponent` so an `EstimatorInputError`
  becomes a 400.

**Schema — run your `db:generate` + `db:migrate`**

- `estimator_options.show_in_estimator` — boolean, not null, default true.
- `estimator_estimate_items.option_snapshot` — jsonb, nullable.
- `estimator_estimates`: the index `estimator_estimates_number_idx` is replaced
  by the UNIQUE index `estimator_estimates_tenant_number_uniq` on
  `(tenant_id, estimate_number)`. If you already have duplicate numbers, the
  migration will fail. Check first:

  ```sql
  select tenant_id, estimate_number, count(*)
  from estimator_estimates
  group by 1, 2
  having count(*) > 1;
  ```

  To fix duplicates, renumber every copy except the oldest (for example, append
  `-2`, `-3`), then migrate.
