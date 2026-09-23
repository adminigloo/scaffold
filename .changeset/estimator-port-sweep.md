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
- **Every by-id call is tenant-scoped.** Affected: `getEstimate`,
  `getProductDetail`, `updateProduct`, `deactivateProduct` and
  `setEstimateStatus`. `calculateEstimate` takes an optional
  `{ tenantId, audience }` scope. A material from another workspace is never
  priced.

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
  width×height or `sqFt` > 0, linear needs `linearFt` > 0, and unit needs
  `units` > 0 (default 1). There are upper bounds too (`MEASUREMENT_LIMITS`). A
  failing measurement gets `null` from `calculateEstimate`, and the create
  functions refuse it.
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
  The check runs inside the UPDATE, so it is atomic. New:
  `markEstimateConverted(db, tenantId, id)` claims an estimate for invoicing
  exactly once (null if it is already converted).
- **Options can be staff-only** (`showInEstimator`, default true). They are left
  out of `listPublicOptions` and `/v1/options`, and public pricing ignores them.
  A staff-only product is not priced for the public.

Refusals throw `EstimatorInputError` with a `code`. The embed answers
`400 { error: code }`, and the generated router maps it to `BAD_REQUEST`.

**Upgrading**

- Add `tenantId` as the second argument to `getEstimate`, `getProductDetail`,
  `updateProduct`, `deactivateProduct` and `setEstimateStatus`.
- Public submits go through `createPublicEstimate`, and public option reads go
  through `listPublicOptions`. Pass your tax rate to `createEstimatorHandlers({ taxRateBp })`
  (a number, or a `(tenantId) => rate` lookup). If you leave it out,
  `DEFAULT_TAX_RATE_BP` (8.25%) applies.
- In unit mode, send the count as `quantity`, not also as `measurement.units`.
- Wrap `createEstimate` / `createPublicEstimate` so an `EstimatorInputError`
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
