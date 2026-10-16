# @adminigloo/estimator

## 0.5.0

### Minor Changes

- 786a643: Alerts and files (Tenancy 2b-1): a company hears about its leads in the app,
  and keeps its estimate photos privately with the estimate.
  
  - **Alert kinds and mapper**: `estimatorAlertKinds` (someone asks for an
    estimate; a customer accepts or declines a quote; a quote lapses; one "New
    estimate requests and quote answers" group) and `estimatorAlertsFor`
    ("New estimate request: Pat Rivera, $480 – $620 + tax (EST-2026-0001)":
    the price and number the office email and the customer were given),
    written exactly when the office email goes, under the same kind and key.
    Staff-made changes alert nobody.
  - **Office emails through the one alert setting**: `officeRecipients` and
    `officeSent` on the comms listener, office emails through comms'
    `deliverNow`, as scheduling's. Without them, 0.4's behaviour exactly.
  - **`alertsHref`** on the staff handlers: the Lead alerts panel points to Alert
    settings (`EstimatorSettingsWire.alertRecipients`), and a save drops the old
    list.
  - **File records**: `estimatorFileRecords`, the estimate as something files
    belong to, its permissions deciding who sees them.
  - **The photo purpose**: `estimatorPhotoPurpose`, a customer's estimate photo
    kept privately, counted but never refused because the company is full, and
    never more than a fifth of the company's storage.
  - **Staff's own photos kept apart**: `estimatorStaffPhotoPurpose` and the
    admin handlers' `staffPhotoStore`, so a share filled by strangers' leads
    never refuses the business's own estimate photos. Without it, 0.4's single
    store.
  - **Customers' photos count toward the day's caps once sent**: the per
    visitor and per business caps count every customer photo of the last 24
    hours, on a lead or not, so junk leads can't refill the store each day.
  - **Photos named in plain words**: "Customer photo.jpg", "Estimate
    photo.jpg", never a hash.
  - **Bodies read with a cap**: every route counts a body's bytes as they
    arrive and stops at its limit, so a self-hosted server is never made to
    hold a huge request.
  - **Same origin only**: a POST from another subdomain of the same domain
    (`Sec-Fetch-Site: same-site`) is refused like one from another site.
  - **Photos attached to their estimate**: the photo store's optional `attach`
    is called once a lead with photos is saved and when staff add a photo; a
    refusal is reported and changes nothing.
  - **A full store answered in the estimator's own words**: a storage refusal
    becomes "You've added as many photos as we can take today…" (or the right
    sentence for a wrong type, a file too big, or storage switched off), never
    an error page. Staff are told where room can be made: estimates' photos
    when the share is full, the Files screen or estimates when the company
    is. A photo reading keeps going without the copy, and the lead still goes
    in.
  - The comms peer is now `^0.4.0`.

### Patch Changes

- Updated dependencies [786a643]
  - @adminigloo/comms@0.4.0

## 0.4.0

### Minor Changes

- 2df95e8: Company features (Tenancy 2a): one deployment quotes for many companies.
  
  - **`company(tenantId)`**: the business's name, contact details, time zone,
    logo and colour come from the host's company profile;
    `resolveEstimatorSettings` overlays them and the settings screen shows them
    as managed in company settings.
  - **`admit(tenantId, req)`** on both public paths, the web address AND the
    website embed key: a suspended company's estimate tool answers 409
    `estimates_closed` with how to reach the business.
  - **A ceiling on photo-reading spend** (`aiBudgetCeilingCents`): each
    company's daily budget is the lower of its own setting and the site's
    ceiling, applied before any photo is read, so no company can spend the
    platform's AI budget.
  - **Per-company links and inbox**: quote links may be async (built from the
    company's web address); new-estimate notices go to the company's own people.
  - **Route tables** (`ESTIMATOR_ADMIN_ROUTES`, `ESTIMATOR_PUBLIC_ROUTES`) and
    **checklist items** (`estimatorChecklistItems`).
  - Attaching a supply or adding an option to a product that isn't this
    company's now answers 404 instead of 400.
  - With a company, the staff notice for a closed estimate page asks only for
    the tax rate in Estimate settings, not for a business name the screen shows
    read-only.
  - The comms peer is now `^0.3.0`.
  
  After review:
  
  - **`invoiceAccess`**: "Turn into an invoice" asks the host's invoice
    permission as well as the estimator's, and an estimate's page shows the
    invoice it became only to someone who may see invoices.
  - **The web address decides**: a keyed request under another company's web
    address is "not found" (`verifyClientKey(db, key, { tenantId })`).
  - **`aiSiteBudgetCents`**: a daily ceiling on photo reading for the whole
    site, every business together, beside each business's own.
  - **`siteNotices: "company"`**: the site's setup gaps (no AI key, no file
    storage) in a company's words, never a setting it can't change.
  - **Sample price books by trade**: lawn care, cleaning or ramps
    (`SAMPLE_CATALOGS`, `loadSampleCatalog(db, tenantId, { trade })`, the
    route's `{ trade }` body).
  - The accepted-quote email offers to "see or print" the quote, not to accept
    it again; a reply to an office notice reaches the customer; the tax notice
    no longer quotes a default the form doesn't show; the website checklist item
    is "Add an estimate button to your website", and says to dismiss it once
    the button is up (a pasted button leaves no key to tick it).

### Patch Changes

- Updated dependencies [2df95e8]
  - @adminigloo/comms@0.3.0

## 0.3.0

### Minor Changes

- 7226d06: Make the estimator something a ramp company (or any measured trade) can sell
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
- 7226d06: Fixes from the 0.3 review (2026-10-12): what an owner told "it works" would
  otherwise have found out from a customer.
  
  - **Closed until set up.** No estimate page, no customer email, no quote
    before the business has saved its name and tax rate (`estimatorReady`,
    `publicEstimatesOpen`, `settings_incomplete`). A product that prices at $0 is
    answered as "priced by a person", never as $0, and the admin names it
    (`products_unpriced`), as it names labor hours at a $0 rate
    (`labor_rate_zero`) and a price book with nothing on the website
    (`nothing_public`).
  - **The sample arrives off the website**, so its made-up prices reach no
    customer until the owner turns each product on.
  - **Unmeasured jobs are priced in the middle of their range**: the default
    typical step is 7.5 in (the band is still 7–8). The quote's line says what it
    is priced at ("3 steps, 7.5 in each (estimated), 23 ft of ramp"), and the
    estimate's `sendWarnings` say it BEFORE the send, with the range in dollars.
    The customer's email asks them to reply with one step's height.
  - **The step count and the porch.** The reading says what it counted ("We
    counted 3 steps up, including the last one onto the porch or landing"), the
    help says "2 steps and the porch is 3", and a customer who lowers the photo's
    count is asked about it (`TakeoffReading.fewerCheck`). Staff get the reading
    without customer instructions. No sentence says "below".
  - **A total height that can't be the steps given** (under 4.5 or over 9 in a
    step: "3" meant as 3 ft) is questioned on its field, never priced.
  - **The photo's step height is the owner's call**: kept inside their own
    From–To, said plainly when the photo looked outside it, and switchable off
    per product (`usePhotoStepHeight`).
  - **Bought whole**: a supply can round up to whole units per item
    (`roundUp`, on by default for one sold each): 5.25 posts are priced as 6.
  - **Quotes have versions.** An accept or decline names the version the
    customer saw; a re-sent quote's old links stop working, so a quote emailed to
    the wrong address can be cut off by sending it again.
  - **Every expiry is announced**, at least once: announced, then stamped, and a
    cron cut off part-way leaves the rest for the next run (`timeBudgetMs`).
  - **Photo storage has limits**: at most 12 unsent photos per visitor and 500
    per business a day (`photoLimits`), counted in the database; the clean-up
    runs to a time budget instead of 100 a day.
  - **The AI budget counts readings in progress** at their most, under one
    advisory lock with the per-visitor count, so a burst can't overrun it; a
    reading gives up after 12 s with no retry.
  - **Nothing a visitor typed is a link** in any email, the office's included,
    and the public submit ignores a line description.
  - **Costs stay with those who may see them**: waste, markup, margin and the
    default labor rate are stripped for staff without `estimator.costs.view`,
    who can't preview unsaved cost changes either.
  - **An existing price list can feed the supplies**: `upsertComponentByRef` and
    `getComponentByRef` (one row per `externalRef`, the cost "managed outside"
    and refused in the price book), and `onPriceBookChange` on the staff handler
    for a host that mirrors changes back.
  - **Behind proxies**: `createClientIpKey({ trustProxy, cloudflare })`, and the
    README's table of setups.
  - **Installs anywhere**: no `@adminigloo/db` dependency (nothing loads a
    database driver), the zod peer says `^4.0.0` like the types, and the README
    has the full CREATE script for a database whose migrations belong to Prisma,
    Rails or Knex (kept in its own Postgres schema), one install block with
    Docker, the cron route with its secret and a GitHub Actions schedule, and
    what happens without `rateLimit`.
  - The accuracy eval refuses to run without `sharp` (now a dev dependency) and
    says when it found no real photo to score.

### Patch Changes

- Updated dependencies [7226d06]
  - @adminigloo/comms@0.2.2

## 0.2.0

### Minor Changes

- abf588e: Money and tenancy fixes from a sweep of the estimator against its SG Glass source.
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
