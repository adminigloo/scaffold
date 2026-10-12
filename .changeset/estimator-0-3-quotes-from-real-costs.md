---
"@adminigloo/estimator": minor
---

Make the estimator something a ramp company (or any measured trade) can sell
from: customers answer what they know, the price comes from the business's own
supplies, the AI only counts what it sees, and a lead becomes a quote the
customer accepts online.

**Customers answer what they know.** Each product has a measurement recipe —
steps up to a door (a ramp), width × length, a length, a count — that asks
questions a customer can answer with their eyes or a tape ("How many steps go
up to the door?", "Height of one step (optional)") and works out what is
priced in named, tested functions (`riseFromSteps`, `rampLengthFt`,
`restingLandings`, `areaSqFt`, …). The server sends the fields and the
sentences that explain the result ("3 steps × 7–8 in each (estimated) = 21–24
in rise → ADA 1:12 slope (1 ft of ramp per inch of rise) → 21–24 ft of ramp");
the widget shows them as they are. Without a measured height the owner's
typical step height is used and said plainly next to the price. The owner
words every question and sets the assumptions in the price book, with a live
preview.

**Prices from the owner's supplies.** A supplies library (cost per supplier
unit, supplier, SKU, note); each supply on a product says how much per what
(per foot of ramp, per resting landing, per item, once per job); labor hours
per unit plus setup hours at the product's or the business's rate; waste on
what is bought by length or area; markup or a target margin; a minimum.
`buildPrice` prices the low, point and high quantities and explains itself to
staff (a cost breakdown and the margin); `previewProductPrice` is the "test a
quote" panel. Customers only ever see prices.

**The range is the measurement's own uncertainty.** A step height of 7–8 in is
21–24 ft of ramp, priced at both ends: $6,472.62 – $7,145.88 for the sample
ramp, where 0.2's flat band showed about $1,600 of spread; the line itself is
priced at the owner's typical step, the middle of the band (7.5 in: $6,921.46). A measured height
gives one number. An owner can add a contingency %. The percentage band stays,
opt-in per product, and the admin says why a range is wide.

**Photos: kept, and read for counts only.** A customer's photo is stored
through an injected `EstimatorPhotoStore` and linked to their estimate. The
model (Claude Haiku 4.5 by default, `./anthropic`) returns a tiny strict JSON
of what it sees — the number of risers, a height range, a confidence — never a
measurement or a price; `normalizeObservation` checks it and the code does the
rest. One call per photo: an identical photo is read once (the cache), no
reading when the customer already measured, a daily budget and a per-person
cap that fail closed, every call recorded with its tokens and cost
(`recordUsage`). About a tenth of a cent a photo; `eval/takeoff/` measures it.

**Settings in the database.** `estimator_settings`: business name, contact,
lead alert addresses, currency, locale, time zone, tax rate, quote validity,
follow-up days, quote footer, default labor rate, contingency, instant
estimates and photos on/off, the AI budget, brand colour.

**Leads, staff estimates and quotes.** The lead keeps the inputs, the
derivation, the photo reading and the customer's corrections. Staff search and
filter a queue (with counts and paging), edit any draft — every edit one
transaction under the row lock, totals recomputed from the lines — duplicate,
archive, and send a formal quote: a link (hashed tokens, several per estimate)
to a page with the lines, the total with tax and the date it's good until, and
Accept / Decline with a note. Revise, resend, expiry (`expireQuotes`, one
statement, `SKIP LOCKED`), and seams to book the visit and turn an accepted
quote into an invoice.

**Events and emails.** Eight events after commit (`lead.received`,
`quote.sent`, `quote.viewed`, `quote.accepted`, `quote.declined`,
`quote.expired`, `quote.revised`, `estimate.converted`), awaited, contained,
with no secrets. `@adminigloo/estimator/comms`: the customer's copy, the
office's new-lead email (with why it's a range, the reading and the
corrections), the quote, a follow-up queued for the cron and withdrawn on any
answer, the accepted and expired emails, and office notices; no quote link is
left in the delivery log.

**HTTP.** `createEstimatorHandlers` serves the business's own pages
(same-origin, cross-site POSTs refused) and the embed on its own website (a key
with allowed websites, CORS for that page), with rate-limit buckets, a
honeypot and a minimum fill time. `createEstimatorAdminHandlers` covers the
price book, supplies, the sample catalog (on request only), estimates, quotes,
photos, settings, usage and website keys, asks `authorize` for one permission
per route, and strips costs without `estimator.costs.view`. Five permission
keys (`estimatorPermissions`).

### Breaking (0.x minor)

- `buildTakeoffPrompt` and `TAKEOFF_SYSTEM_PROMPT` now ask the model for
  observations, not measurements. `parseTakeoff` and `TakeoffResult` are
  removed (use `normalizeObservation`).
- `createEstimatorHandlers`' `runTakeoff` option is removed: pass
  `takeoff: { model }` (for example `createAnthropicTakeoffRunner`), and the
  package runs the reading itself, with the cache, budget and limits.
- The embed's error body is now `{ error: { code, message, issues? } }` (was
  `{ error: "product_unavailable" }`), and a server fault is a 500 (was 400).
  A submit answers 201 (was 200). Another business's product on `calculate`
  is a 400 `product_unavailable` (was `{ result: null }`); a measurement the
  product can't be priced from answers `status: "needs_inputs"`.
- `ESTIMATE_STATUS_TRANSITIONS` gains sent / viewed → draft (revise).
- `createEstimateSchema.items` may be empty (a blank "New estimate"); sending
  refuses an empty estimate.
- `getEstimate`'s answer type is renamed `EstimateWithItems`; `EstimateDetail`
  is now the admin's view of an estimate (the wire type).
- `createProduct` defaults a new product to the measured range and no "How
  many?" (`rangeMode: "measured"`, `allowMultiple: false`); a 0.2 call that
  names only `measurementMode` gets the matching recipe.
- Nothing is public until the business is set up: the public estimator, the
  embed, the photo reading and `createPublicEstimate` answer
  `estimates_closed` until the settings are saved with the business's name;
  `sendQuote` and `resendQuote` refuse `settings_incomplete`. The handler's
  deprecated `taxRateBp` option is no longer consulted.
- `loadSampleCatalog` loads the products OFF the website
  (`showInEstimator: false`; pass `{ showInEstimator: true }` for a demo).
- A public price that works out to $0 answers `quote_only`.
- Accepting or declining a quote takes the `version` the customer saw
  (`PublicQuote.version`; `AcceptQuoteBody` / `DeclineQuoteBody` require it),
  an answer to an older version is refused `quote_changed`, and a link from
  before the latest send no longer opens the quote.
- `expireQuotes` answers `{ expired, estimateIds, announced }` and also
  announces earlier expiries no run had announced.
- The public submit ignores an item's `description` (the line is always the
  product's name).
- Without `estimator.costs.view`: `AdminProduct.wasteBp`, `markupBp`,
  `marginBp` and the settings' `defaultLaborRateCents` are null, and a
  preview of an unsaved draft that changes a cost is refused.
- The `zod` peer is `^4.0.0` (the published types always were zod 4's), and
  `@adminigloo/db` is no longer a dependency (nothing database-driver-shaped
  loads with the package).

### Deliberate pricing changes

1. An option's price is added after markup: a "+$60" option at 25% markup
   added $75; now it adds $60, the price the customer was shown.
2. The low end of a range is never below the minimum charge (it showed $180
   for a $200 minimum). `calculateEstimatePrice` gets the same fix.
3. A measured-range line is saved at its point price (the owner's typical
   step, by default the middle of the band), not a band midpoint.
   Percentage-band lines (every product from before 0.3) keep 0.2's midpoint.
4. A supply attached "each" (a post, a bracket) is rounded up to whole units
   per item — 5.25 posts are priced as 6 — with no waste on top of it.

### Schema: run your db:generate + db:migrate

New tables: `estimator_settings`, `estimator_quote_tokens` (with the
`quote_sequence` each link was sent for), `estimator_photos` (with the hashed
`requester_hash` and its index), `estimator_takeoffs`.

New columns:

- `estimator_products`: `recipe`, `recipe_config`, `allow_multiple` (default
  true), `multiple_label`, `max_quantity` (10), `labor_hours_per_unit_milli`,
  `labor_setup_hours_milli`, `labor_rate_cents`, `pricing_basis` ('markup'),
  `margin_bp`, `range_mode` ('percent'), `contingency_bp`.
- `estimator_components`: `supplier`, `sku`, `note`, `external_ref`,
  `managed_externally` (false), `updated_at`; unique index
  `estimator_components_tenant_ref_uniq` on (`tenant_id`, `external_ref`).
- `estimator_product_components`: `per`, `round_up` (false: an existing
  attachment keeps its fractional quantity), `sort_order`.
- `estimator_estimates`: `range_low`, `range_high`, `range_reasons`,
  `currency`, `cost`, `quote_message`, `quote_sequence`, `valid_until`,
  `sent_at`, `viewed_at`, `responded_at`, `approved_at`, `rejected_at`,
  `expired_at`, `converted_at`, `archived_at`, `expiry_notified_at`, `response_name`,
  `response_note`; indexes `estimator_estimates_tenant_created_idx` and
  `estimator_estimates_tenant_valid_idx`.
- `estimator_estimate_items`: `low_total`, `high_total`, `price_overridden`,
  `cost`, `recipe`, `inputs`, `derived`, `takeoff_id`, `corrections`.
- `estimator_client_keys`: `allowed_origins` (default `[]`: any website, as
  before).

Every new column is nullable or has a default whose value reproduces 0.2 for
existing rows. Then backfill the ranges of estimates made before 0.3:

```sql
UPDATE estimator_estimate_items SET low_total = total, high_total = total
WHERE low_total = 0 AND high_total = 0;
UPDATE estimator_estimates SET range_low = subtotal, range_high = subtotal
WHERE range_low = 0 AND range_high = 0;
UPDATE estimator_estimates SET expiry_notified_at = COALESCE(expired_at, updated_at)
WHERE status = 'expired' AND expiry_notified_at IS NULL;
```

The last line marks expiries from before 0.3 as already announced, or the
first cron run would email every customer whose quote ever lapsed. Then open
the admin's Settings and save the business's name and tax rate: until then the
website estimator says it isn't available.

A host whose migrations belong to Prisma, Rails or Knex: the README has the
full CREATE script and how to keep the tables in their own Postgres schema.

The README's "Upgrading from 0.2" lists every statement, and how to move a 0.2
ramp product to the steps recipe and the measured range.
