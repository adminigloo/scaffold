# create-adminigloo-app

## 0.11.0

### Minor Changes

- A project that sells something now ships a plan catalogue and a seed that puts it
  in the database.
  
  `@adminigloo/billing` gained a typed plan record; this wires it into the generated
  project.
  
  **`src/plans.ts` is emitted** for any `--model` other than `none`: a
  `definePlans` call with five tiers, each of which demonstrates something the shape
  has to survive — a free tier priced at zero rather than absent, two paid tiers
  whose quotas differ so an upgrade has something to reconcile, an Enterprise tier
  with no prices at all ("talk to us" is a real tier, not a missing one), and a
  retired tier that is still in the record because subscriptions reference it. Two
  currencies and two intervals, because a price matrix that has never held two of
  anything is a matrix nobody has tested.
  
  Generated rather than copied from `template/`, for the reason `src/db/schema.ts`
  is: it imports `@scope/billing`, which a `--model none` project never installs.
  Not in an overlay either, and that half is the design — the pricing page beside it
  next phase is copied source, and a runtime package cannot import from copied
  source, so a record living there would be invisible to the enforcement that has to
  honour what the page advertises.
  
  **`scripts/seed-plans.ts`** (stripe overlay) writes the record's projection into
  `plans`, upserting on `key`, and reports every row the record does not account
  for without deleting any of them. It is chained into `pnpm db:seed:demo` ahead of
  the shop seed and is separately runnable as `pnpm db:seed:plans`.
  
  Unlike the other two seeds it has no localhost gate, deliberately: it writes no
  fictional people and books no orders, only the projection of a record every
  environment already ships in its own source. Running it against production is the
  intended way to publish a price change — the alternative is editing amounts by
  hand in a table, which is the thing the record exists to stop.
- The marketing half: a landing page, a pricing page generated from the plan
  record, legal routes with an accurate subprocessor list, and SEO in every
  project.
  
  The scaffold generated an application and no public face for it. There was no
  landing page worth showing a client, no pricing page, no privacy policy, no
  terms, no `metadataBase`, no sitemap and no `robots.txt` — so every generated
  project shared as a link rendered a grey box, and every staging deployment was
  crawlable.
  
  **A new answer, `--marketing` / `--no-marketing`, defaulting to off.** It selects
  copied source and nothing else, exactly as `--admin` does. It is its own
  question because nothing already asked answers it: a project that sells is not
  necessarily one anybody markets, and a project that sells nothing still has a
  landing page. It defaults to off because every string on a landing page is a
  claim only the client can make, and placeholder claims at `/` of an internal
  tool are worse than no landing page.
  
  **Three overlays, three conditions.**
  
  - `marketing` — the landing page and its five section components. Selected by
    `--marketing`.
  - `marketing-pricing` — the public pricing page. Needs BOTH `--marketing` and a
    business model, exactly as `catalog-admin` needs both an admin shell and
    something to sell: the page imports `src/plans.ts`, which a `--model none`
    project never gets.
  - `legal` — `/privacy` and `/terms`. Selected by `--marketing` **or** a business
    model, because Stripe will not activate an account without a public privacy
    policy and terms of service whether or not there is a marketing site in front
    of them.
  
  **`app/(site)/page.tsx` moves.** With `--marketing`, the landing page owns `/`
  and the developer's orientation page — the health check and the file map — is
  written to `/setup/start` instead, beside the other developer surface and linked
  from `FOOTER_LINKS`. Without it, nothing changes.
  
  **The pricing page reads the plan record and nothing else.** Names,
  descriptions, prices, the monthly/annual toggle, the currency switch, every
  bullet and every comparison cell come out of the same `definePlans` object
  `grantsForPlan` turns into entitlement rows — so a tier cannot advertise
  something the enforcement will not grant. The toggle is a set of links rather
  than a client component, so the state is in the URL, the page stays a server
  component, and it works with no JavaScript. Retired tiers are filtered out;
  unpriced tiers render a contact action; a tier not sold on the selected cadence
  says so rather than rendering blank. On a project whose `plans` table has not
  been seeded the prices are still correct — they are source — and the page says
  plainly that nothing can be subscribed to yet.
  
  **The legal pages are accurate about the software.** `src/legal.ts` is
  generated: the subprocessor list names Stripe only in a project that takes
  money, Resend only in one that sends mail, Anthropic only in one with `--ai`,
  and marks Sentry and Upstash as active only once their credential is set. The
  data categories and the extra terms clauses are generated arrays, so a service
  with no subscriptions has no renewal clause rather than one hedged with "if
  applicable". Both pages carry a rendered notice saying they are a starting point
  for a lawyer, and the company's own facts are obvious placeholders in
  `src/legal-publisher.ts`.
  
  **SEO is unconditional.** `src/seo.ts`, `app/robots.ts` and `app/sitemap.ts` are
  written for every project, including `--no-marketing` ones, because the two
  failures they prevent are harms rather than features: without `metadataBase`
  every relative Open Graph URL resolves against localhost and a shared link
  renders as a grey box, and a crawled preview deployment outranks the client's
  real site for their own brand terms. Indexing is allowed only where
  `resolveAppEnv()` is `production` — not `isDeployed()`, because an unlabelled
  production artefact resolves to `staging` and reports itself as not deployed,
  which is exactly the environment that must not be crawled. The decision is one
  constant, imported by both the metadata and `/robots.txt`, so they cannot
  disagree. The root layout now takes its metadata from `src/seo.ts` and sets no
  canonical, since a canonical in the root is inherited by every page beneath it.
  
  `SITE_LINKS` gains `/pricing`, `FOOTER_LINKS` gains `/privacy`, `/terms` and
  `/setup/start`, each only in the configurations that emit the route.
  `capabilitiesFor` gains `seo.metadata` (every project), `marketing.landing`,
  `marketing.pricing` and `legal.policies`, each with a row in
  `CAPABILITY_EVIDENCE`. The exhaustive configuration sweep gained the marketing
  axis, so every claim above is checked in both states.
- Subscriptions now do something. A subscription product took money and granted
  nothing; this closes that.
  
  Four things were missing and each made the next one pointless: no webhook
  mirrored `customer.subscription.*` into the local table, so nothing applied a
  plan's grants, so `/account/billing` rendered an empty state, and none of it
  could be exercised at all without Stripe keys.
  
  **One writer, five callers.** `src/server/subscription.ts` holds
  `applySubscription`, and nothing else may write `subscriptions`. The webhook
  calls it, the simulated path calls it, cancel and resume call it, and the staff
  re-sync calls it — the same shared-call-site design `fulfilPurchase` is built
  on, and for the same reason: a deployment with no Stripe keys exercises the real
  mirroring path every day, so the first real webhook runs code that has already
  worked a hundred times. It never imports Stripe; `subscriptionSnapshot` is the
  adapter and lives on the other side of the line.
  
  **The mirror.** `customer.subscription.created`, `.updated`, `.deleted`,
  `invoice.paid` and `invoice.payment_failed`, through the existing leased-claim
  ledger rather than a second idempotency mechanism. The invoice handlers re-read
  the subscription and go through the same writer rather than writing the period
  themselves — an invoice knows its own period and nothing else, so a handler
  writing from it would be a second writer with a partial view. `event.created` is
  carried as the watermark and a stale delivery is a no-op that answers 200.
  `payment_intent.succeeded` gained one guard: an intent carrying NONE of our
  metadata is a renewal Stripe collected, and is recorded and skipped rather than
  throwing — every renewal of every subscription would otherwise fail that handler
  for three days and take the endpoint down.
  
  **The grants.** Every mirror write reconciles the tenant's entitlements through
  `planGrantDiff`, so an upgrade UPDATEs the rows the tenant already holds and
  `used_value` survives — 400 of 500 exports spent is still 400 spent on the tier
  above — and only `plan`-sourced rows are ever removed, so a seat pack bought as
  a product survives a downgrade. A separate sweep writes the expiry window, which
  is what lets a past-due tenant be suspended without their usage counters being
  thrown away.
  
  **The screen.** `/account/billing` gets one state banner and ONE primary action,
  both chosen on the server by pure functions with their own tests —
  `describeSubscription` for the sentence, the new `primaryActionFor` for the
  button. Cancel schedules for the period end and never cuts access immediately;
  resume undoes it; both go through the one writer. Invoices are read live from
  Stripe and answer with an empty list on every path where there is nothing to
  show. A plan chooser renders the record's own tiers, so the page works with no
  marketing site behind it.
  
  **The simulated path covers subscriptions.** `billing.simulateSubscription`
  respects `checkoutMode()` — the same single predicate, called first — and writes
  through the same `applySubscription` a real webhook does, differing only in the
  reference and the audit action. It can put a subscription into any of the six
  states, so all five banners and both actions can be seen on a laptop with no
  Stripe account.
  
  **A staff re-sync.** `/admin/billing` (catalog-admin) shows the plan record
  against the `plans` table against Stripe, and offers two buttons: publish the
  record's prices to Stripe, and re-pull every subscription through the same
  writer. This matters more here than it would in another kit precisely because
  the firm owns the billing tables — a missed webhook leaves them authoritative
  and wrong with nothing to reconcile against. Gated on a new
  `staff.billing.resync` key and audited as sensitive.
  
  **Real subscriptions can now be started at all.** `billing.subscribeToPlan`
  opens a hosted Stripe Checkout session in subscription mode, publishing the
  plan's Price on demand. Hosted rather than a Payment Element because a
  subscription needs tax, VAT numbers, coupons and a saved payment method — every
  one of which is a form this firm would otherwise restyle per client — and
  because `withTenantMetadata` then stamps the tenant onto the Subscription, which
  is the only reason a later `customer.subscription.updated` can be attributed to
  anybody.
  
  `PACKAGE_VERSIONS.stripe` moves to `0.2.0`: the emitted webhook imports
  `subscriptionSnapshot`, `subscriptionIdFromInvoice` and
  `SUBSCRIPTION_EVENT_TYPES`, and the billing router imports `ensurePlanPrice`.

## 0.10.0

### Minor Changes

- A customer could buy something and had nowhere to see it. New `account` overlay.
  
  **Every surface in the scaffold was an operator surface.** `fulfilPurchase`
  writes `orders`, `order_items`, `order_shipments` and `entitlements`, and mints
  a Crockford-base32 licence key inside the transaction that books the order — and
  the only reader in the entire project was `readOrderByReference`, called by one
  page, keyed on a reference in a URL the buyer is about to navigate away from. A
  customer who closed the tab after `/checkout/success` had permanently lost a key
  no page, no admin screen and no support tool could retrieve. `checkEntitlement`,
  `resolveEntitlements` and `createBillingPortalSession` had zero callers between
  them. The machine was built; there was no dial.
  
  **Four routes, in a new strictly-additive overlay selected on exactly the
  condition the stripe overlay is.** `/account` is what you hold — licence keys
  first, then allowances, then deliveries, then recent orders, because somebody
  arriving here wants the key rather than the receipt. `/account/orders` is the
  full history, with a refunded total struck through. `/account/orders/
  [orderNumber]` is one order with the money ladder the `orders` table has always
  stored as five separate columns and never rendered — subtotal, discount,
  shipping, tax, total — plus its licence keys, what it granted, and where the
  parcel is. `/account/billing` is the subscription state and one button into
  Stripe's hosted portal. `app/(site)/account/**` is a path the base template owns
  nothing under, so `assertOverlaysAreAdditive` passes by construction.
  
  **The scoping decision, which had to be settled before any of it could be
  written.** A storefront order is booked with `orders.tenant_id =
  STOREFRONT_TENANT_ID`, which is `FIRM_WIDE`, and `orders.user_id` = the buyer.
  Every customer of the shop therefore shares one tenant id. Reading an order list
  by tenant hands each buyer the whole shop's history; reading it by the buyer's
  own organisation returns nothing, because their order was never booked there.
  So `listOrdersForUser` and `readOrderForUser` filter on `user_id`, with the
  tenant as a narrowing second predicate, and the ownership predicate is in the
  WHERE clause rather than in an `if` after the read — the early return that
  compares `order.userId` is exactly the line a later refactor deletes as
  redundant.
  
  The same argument applies harder to entitlements, which `applyGrant` also writes
  at `FIRM_WIDE`: that table is not a per-customer bucket and must never be read
  as one. The account area reaches a grant only THROUGH the order that paid for
  it, joining on the `source_ref` provenance column that already existed —
  `split_part(source_ref, ':', 1)`, never a LIKE pattern, because `_` is a
  single-character wildcard and a Stripe reference is `pi_3ABC…`, so the pattern
  form would silently match other customers' grants. Subscriptions are the one
  thing that genuinely is per tenant, so `/account/billing` resolves the viewer's
  own organisation and checks the tenant permission ladder against it.
  
  **Permissions: two existing TENANT keys, and no new ones.** `subscriptions.view`
  from `@adminigloo/billing` gates the billing state and `billing.portal.open`
  from `@adminigloo/stripe` gates the portal — both already spread into the tenant
  catalog, both checked with `requireTenant`. `/account` and `/account/orders`
  check no key at all, deliberately: the buyer is not a member of the tenant their
  own order lives in, so `requireTenant("orders.view")` there would deny every
  customer their own receipt and error nowhere, which is the exact failure the
  scope rules exist to prevent. Ownership is the authorisation on those pages, and
  a permission on them would be theatre. Where a key IS missing the control is
  rendered disabled with the reason beside it rather than hidden; a pure
  disclosure with nothing to act on is hidden instead.
  
  **The billing portal degrades honestly rather than throwing.** The button
  renders only when `STRIPE_SECRET_KEY` is present — the same condition
  `SimulatePurchase` keys off, which flips by itself the moment the keys are
  pasted in — and `account.billingPortal` enforces the same condition server-side,
  returning a three-way discriminated union so "this deployment cannot reach
  Stripe" and "you have never been charged" get different sentences and neither
  gets an error boundary. `ensureCustomer` in the checkout router is split so the
  portal can look a Stripe customer up without creating one: a session opened
  against a Customer created seconds earlier shows no invoices and no cards, which
  reads as lost billing history. Opening the portal writes one audit row, marked
  sensitive, because the act itself then happens at Stripe where this application
  sees nothing — so without it "who cancelled our subscription" has no answer.
  
  **Three new readers beside `readOrderByReference`**, in `fulfilment.ts` so one
  module still knows how an order is read: `listOrdersForUser`,
  `readOrderForUser` and `referenceOfKey`, sharing one column list and one
  line-loading query. `FulfilledOrderView` gains the four money columns and the
  fulfilment reference. `/account` appears in `APP_LINKS` for any project that
  sells something, and the account tab strip is now read by the reachability
  guard, so `/account/orders` and `/account/billing` are proved linked rather than
  excused.
  
  The overlay's decisions — what a subscription's five nullable columns mean, how
  an unlimited allowance reads, when a shipment row is a parcel — live in
  `src/account.ts` with no `@/db` import, and run as a third vitest project
  against workspace source. The queries live in `src/server/account.ts` and are
  deliberately not unit-tested: a mocked database would assert the mock's opinion
  of a WHERE clause, which is the one thing about them that matters and the one
  thing a mock cannot check.
- One predicate decides which checkout is live, it is stated positively, and a
  tenant owner is given their role at creation.
  
  **The page and the procedure disagreed, in the dangerous direction.**
  `app/(site)/checkout/page.tsx` carried a comment promising that "the page and
  the procedure cannot disagree about which checkout is live". They did. The page
  branched on `!stripe`, the storefront notice on `stripe === null`, the Simulate
  button on nothing at all, and only `checkout.simulate` also asked what
  environment it was on. Grepping `resolveAppEnv` across `checkout/page.tsx`,
  `products/page.tsx` and `SimulatePurchase.tsx` returned nothing: none of the
  three customer-facing surfaces knew where it was running, so a production
  deployment with no Stripe key rendered "payments are not configured, so buying
  is simulated" to every visitor and drew a button the server then refused.
  
  **`src/server/checkout-mode.ts` is now the one predicate.** `checkoutMode()`
  returns `{ kind: "stripe" | "simulated" | "unavailable", reason }`. The checkout
  page calls it, the storefront notice calls it, `checkout.simulate` calls it, and
  `SimulatePurchase` is handed its result as a prop with a type-only import — so
  the browser renders the server's decision instead of forming a fourth opinion.
  `reason` is written once and is what the page prints, what the notice prints and
  what the mutation refuses with, so the customer-facing sentence and the API
  error cannot drift apart either.
  
  **The gate is positive now.** It used to be
  `!stripe && resolveAppEnv() !== "production"` — a negative gate, which grants a
  dangerous capability unless it can name a reason not to. Every negative gate
  fails the same way: something the author did not enumerate arrives, matches no
  exclusion, and is allowed. That is exactly what happened. `resolveAppEnv()` read
  `VERCEL_ENV` and nothing else, a self-hosted production shop was therefore not
  `"production"` by that reading, and a verifier minted licence key
  `SSHFF-281V7-CJQMQ-1A4KJ` against a £29 product for free on a real host.
  
  `simulated` is now granted by two named cases and nothing else:
  
  - a **positively identified local environment** — a dev server, a test run, or
    `APP_ENV=local`. No opt-in, because that is the whole promise: a shop you can
    buy from twenty minutes after generating it, with no Stripe account. Note that
    `local` is now an affirmative identification rather than the fall-through
    default it used to be, which is what makes it usable as proof at all.
  - **staging with `ALLOW_SIMULATED_CHECKOUT=true`.** A preview deployment is
    where this gets demoed, and "somebody is going to demo this" is a fact only a
    person knows — so a person says it, once, in the deployment's own
    configuration. New variable, declared in the generated `src/env.ts` as
    `z.enum(["true", "false"]).default("false")`: unset means off, and a value
    that is neither fails at boot rather than being read as one of them.
  
  Everything else — production, and any environment nobody labelled, and any
  `AppEnv` value added in future — falls through to `unavailable` without anyone
  having had to think of it. `/checkout` renders that state explicitly instead of
  falling through to a card form with no publishable key behind it.
  
  **A tenant owner is given a role row when the workspace is created.**
  `ensurePersonalWorkspace` wrote the `tenants` row and the `tenant_members` row
  and stopped, which left every customer holding zero permissions in the only
  tenant they belonged to — see `@adminigloo/tenancy` for the whole story. It now
  calls `grantTenantOwnerRole` after the membership, and `scripts/seed-roles.ts`
  calls `backfillTenantOwnerRoles` after seeding the templates, which is what
  repairs the accounts that already exist: the creation path only ever runs on a
  user's first sign-in.
  
  **`scripts/migrate.ts` reads `VERCEL_ENV` directly** where it used to call
  `isDeployed()`. The two used to be the same thing; `isDeployed()` is now also
  true when `APP_ENV` names a deployment, which is exactly what a self-hosted
  release pipeline sets — so the guard would have refused to run the migration it
  exists to run, and blamed Vercel while doing it.
  
  `.env.local` and `.env.example` now document `APP_ENV` and
  `ALLOW_SIMULATED_CHECKOUT`. `APP_ENV` is deliberately *not* written into
  `.env.local`: a value there would follow a `next start` run to check the
  production build, and the security property worth keeping is that nothing on
  disk can make a server look like a laptop.
- The product builder could never publish anything. Fixed, with the rules that
  made it reachable moved into the validator.
  
  **No product could be published, so the storefront could never have anything on
  it, so checkout could never be exercised.** `handleSave` awaited
  `catalog.upsertVariant`, used the returned id for the `setGrant` call on the
  very next line, and then dropped it. `setRows` was never called after a save, so
  `row.id` stayed `null` for the lifetime of the component — and `row.id` is what
  the Publish button, the "has not been written yet" line under it, the
  `· unsaved` marker on the row header and the Stripe plan's "not in this plan"
  note all read. The variant WAS in `product_variants`. Nothing threw. The form
  simply went on insisting the row did not exist, and saving again re-upserted and
  changed nothing, so the only way out was a page reload that nothing on screen
  suggested.
  
  The save chain now adopts every id the server hands back, on the row that
  produced the write, before the next call. That is a stronger fix than re-seeding
  the form from a refetch: `rows` is `useState` seeded from props, and an effect
  syncing it from props would overwrite whatever the admin was typing on any
  `router.refresh()`. Adopting ids as they arrive is also what makes a
  half-finished save recoverable — on the next press the product has an id so it
  is updated rather than created a second time, and each written row has an id so
  it is updated rather than duplicated.
  
  **`validateProduct` gains the rules the write procedures already enforced.** A
  blank variant name validated clean, so the form offered Save, created the
  product, and only then had `upsertVariant` refuse it — leaving a draft product
  with no variants and a stringified list of zod issues on the page. `path:
  ["name"]` does not say whether it means the product or one of six variant rows.
  Four new problem codes close it: `product-name-missing`,
  `product-name-too-long`, `variant-name-missing` and `variant-name-too-long`,
  capped at the 200 characters the columns and the procedures already used. A
  blank variant name is now `variants[0].name` before anything is written, and the
  form refuses to start the chain rather than half-writing the product.
  
  `validateProduct` also stops treating a blank name as a name. `variant.name ??
  variant.sku` reported every OTHER problem on a nameless row as
  `"" has no billing interval` — a message identifying nothing on a form holding
  six of them. It falls through to the SKU and then to the row's position, as it
  always meant to.
  
  **A refusal that does get through is now a sentence.** Anything a zod schema
  rejects is mapped back to the field label printed above the input — "“Name” on
  variant 2 (“Deluxe”) cannot be empty." — rendered under that input, with the
  cursor moved to it. Messages the server wrote for a human, such as a taken slug
  or the publish validator's list, pass through untouched. A dropped connection
  says so instead of "Failed to fetch". And "1 change were already saved" is now
  "1 change was already written before this failed", with advice to press the
  button again rather than to reload a create page that has nothing to reload.
  
  The chain, the draft review and the error mapping moved out of `ProductForm.tsx`
  into plain `.ts` modules, because `jsx: "preserve"` keeps vitest out of a `.tsx`
  entirely — every one of these defects was invisible reading the code and obvious
  the first time the sequence could be run by a test. Those tests now execute:
  `packages/create-app` gained a second vitest project that runs the
  `catalog-admin` overlay's suite against workspace source, with `__SCOPE__` and
  `@/` aliased the way the generator renders them. They previously ran nowhere at
  all, which is why the whole monorepo suite was green while this shipped.
  
  `PACKAGE_VERSIONS.catalog` moves to `0.2.0` with it. A generated project
  resolving `^0.1.x` would get a validator with no opinion about a blank variant
  name, which is precisely the hole the form used to fall through.
- The simulated purchase is reachable, the admin dashboard counts something, and
  `Company` pluralises.
  
  **The simulated checkout was not missing, the road to it was.** `fulfilPurchase`
  books an order, applies every grant and mints a licence key with no Stripe
  account, `checkout.simulate` calls it, and both are tested — but
  `scripts/seed-demo.ts` seeded people, a tenant, roles, an audit trail and an
  error queue, and no catalogue. With an empty `products` table `/products` is an
  empty page, `/products/[slug]` has no slug to resolve, `/checkout` has nothing
  to price, and the button therefore could not be clicked by anybody. A new
  `scripts/seed-shop.ts` in the stripe overlay seeds one active product per grant
  kind — `entitlement`, `license_key`, `ship`, `none` — plus a draft, an archived
  product, a zero-inventory variant and a null-inventory one, so
  `assertPurchasable`'s `not_for_sale` and `sold_out` refusals have something to
  refuse. Every seeded order goes through `fulfilPurchase({ source: "simulated" })`
  under a fixed `sim_` reference; there is no second writer, and re-running
  restores the fixture instead of multiplying it. `pnpm db:seed:demo` chains it,
  `pnpm db:seed:shop` re-runs it alone, and the seed prints the storefront URL of
  each product, the two refusal URLs, and the audit filter that lists the lot.
  
  **A second gate on the simulated path, and one fewer excuse for not reaching
  it.** `checkout.simulate` still refuses the moment `STRIPE_SECRET_KEY` is set,
  and now also refuses outright when `resolveAppEnv()` is `production` — the hole
  the Stripe check alone leaves is a production deployment whose keys have not
  been pasted in yet, which is a real shop with a real catalogue giving everything
  away. `VERCEL_ENV` is set by the platform and cannot be forged from a dashboard,
  so there is no variable that turns this back on. Against that, the procedure
  moved from `protectedProcedure` to `publicProcedure` with the attribution rule
  written out in its handler: a deployment with no Clerk keys has no sessions at
  all, so the old rung refused everybody on exactly the configuration the feature
  exists for. Sign-in is now required wherever anybody CAN sign in, and the order
  is booked as a guest purchase — `orders.user_id` is nullable by design — where
  nobody can. `/checkout/success` reads a guest order back on the same condition
  and stops the day Clerk is configured. The audit row is unchanged:
  `commerce.order.simulated`, still flagged sensitive.
  
  **The admin dashboard was a debug view.** "Signed in as", and eighteen
  permission chips, as the first screen every client sees. `app/admin/page.tsx` is
  now generated — like `AdminNav.tsx`, because a panel that counts orders cannot
  exist in a project with no orders table — and carries counts of rows this
  scaffold actually writes: unresolved `error_log` rows, `order_shipments` with a
  null `shipped_at`, open invitations, orders paid in the last 30 days with
  simulated ones excluded, simulated orders all-time as a number that should go to
  zero at launch, takings summed per currency (never across them), customer
  tenants, people, and active products. Numbers with somewhere to go are links.
  Zero everywhere says so in words and names the command that fixes it. A viewer
  missing a key sees the key printed where the number would be, and the query does
  not run. No MRR, no churn, no invented trend percentages. The permission chips
  moved to `/admin/access` with a sidebar entry, because they answer a real
  support question and a page nothing links to is a page nobody finds.
  
  **`Companys`.** The plural was `${tenantLabel(answers)}s`, which was on screen in
  the admin sidebar, the `/admin/tenants` heading, its empty state and two
  permission categories. It is a `Record<TenantNoun, string>` lookup now, so a
  sixth noun is a type error rather than a guess, with a
  `__TENANT_LABEL_PLURAL_LOWER__` token so no template file has to spell one
  itself, and a test over all five nouns.
  
  **`pnpm dev` no longer forwards Stripe events into the void.** The old script
  wrote the port down twice — `next dev` with no `--port` moves to 3001 when 3000
  is taken while the listener keeps forwarding to 3000, so Stripe reports every
  delivery as delivered and no order is ever written — and `concurrently -k` took
  the dev server down with it on any machine without the Stripe CLI installed.
  `scripts/dev.ts` resolves the port once from `NEXT_PUBLIC_APP_URL`, passes it to
  both halves, and treats the listener as the optional half it is. `concurrently`
  is no longer a dependency.
- Two integration tests that contradicted the shipped code, the pipeline that let
  them, and a receipt that now names the account area.
  
  **Both tests were wrong, and both had been since the commit that introduced
  them.** They lived in `template/` and `overlays/`, which `pnpm -r test` skips as
  data, and they needed a `DATABASE_URL` that no pipeline set — so they had never
  executed anywhere, in any run, ever.
  
  `ledger.integration.test.ts` asserted that `decideClaim`, handed the strings a
  raw `db.execute` returns for a timestamptz, throws `TypeError: getTime is not a
  function`. It used to. `@adminigloo/stripe` 0.1.2 widened `ClaimInput` to
  `Date | string | null` and normalises through `asDate`, and the throw it pinned
  was the bug — inside a webhook, on the retry path, which is the least observed
  code in the system. Nothing depended on it: the generated webhook route reads
  through Drizzle's `select()` and never saw a string, and the only other mention
  of `decideClaim` outside the package is a comment in `@adminigloo/commerce`. The
  test is now the half the package's own unit suite cannot do — the string comes
  from Postgres rather than from a literal somebody typed, and the two paths are
  asserted to AGREE rather than merely not to throw. A lease boundary measured
  against the Date the ORM produced for the same column is what would catch a
  normalisation that mis-parsed the real `+00` offset, which turns a five-minute
  lease into a five-hour one and says nothing.
  
  `permissions.integration.test.ts` asserted that a staff row filed under a real
  tenant id instead of the `'*'` sentinel resolves to an EMPTY SET rather than
  NULL. NULL is right. Every caller reads a non-null return as ADMISSION —
  `staffProcedure` throws `notStaff()` on null and otherwise runs the handler,
  `app/admin/layout.tsx` renders the shell on anything else — so the old behaviour
  bought entry to the staff surface on the strength of a row from which
  `resolveFor`, pinned to `FIRM_WIDE`, can never resolve a single permission. It
  also disagreed with the rest of the app: `admin.people` joins
  `principal_role` on `scope = 'staff' AND tenant_id = FIRM_WIDE`, so the same
  principal was listed as holding no staff role on the very page an operator would
  open to find out why their panel was empty. Pinning the gate makes both queries
  ask one question and gives the empty set back its meaning — a firm-wide role
  that grants nothing yet, which is what every newly created role looks like, and
  which the misfiled row was previously indistinguishable from. Both states now
  have a test.
  
  **Every test file this package ships now runs somewhere, and a new one that
  would not is a failing test.** `emitted-tests.test.ts` reads the include globs
  out of `vitest.config.ts` and `template/vitest.config.ts` — never a copy of them
  — and insists each of the seventeen `.test.ts` files under `template/` and
  `overlays/` is both emitted into a generated project and matched by a glob that
  collects it. It fails in the other direction too, on a vitest project whose
  include matches nothing. The stripe overlay's `storefront.ts` gets a workspace
  project of its own beside `catalog-admin` and `account`; its server suites
  cannot run there, because they import a `_app.ts` the generator renders and no
  alias can invent, and they run in a generated project instead.
  
  **CI runs that project's suite.** The `generate` job typechecked and built and
  never tested; it now runs the unit project before the build and the integration
  project after it, against a `postgres:17` service container. `REQUIRE_DATABASE=1`
  is what makes that real: `describeIntegration` refuses to skip under it and each
  suite becomes one failing test naming itself, so a run whose database failed to
  appear cannot report success. Without the variable — on a laptop — the skip
  prints a line per suite saying what did not run, because "12 skipped" beside a
  green tick is how this survived.
  
  `DATABASE_WS_PROXY` is what lets any of that reach a database that is not Neon.
  The driver carries the wire protocol over a WebSocket, which is the only
  transport on which a serverless function can hold an interactive transaction,
  and it therefore cannot dial a plain listener at all. Set the variable and
  `src/db/index.ts` points the driver at a bridge; `.github/scripts/ws-proxy.mjs`
  is thirty lines of one, and DEPLOYMENT.md has the two commands. Unset — every
  deployment, and every laptop pointed at Neon — it does nothing.
  
  `bootstrap.integration.test.ts` stopped depending on rows it did not write. One
  test read whatever staff assignments the shared staging branch happened to be
  seeded with and asserted there was at least one, which passes on a developer's
  database and fails on a fresh one. It seeds its own incumbent now, deliberately
  on a non-admin template, since the guard is `WHERE NOT EXISTS (… scope =
  'staff')` and a fixture built on `staff:admin` could not tell that from a guard
  that only looks for admins.
  
  **`/checkout/success` points at the account area.** Its only way out was "Browse
  products". It is a return URL: nothing links to it, its address carries a client
  secret or a fulfilment reference that stops resolving, and the customer closes
  the tab a minute after arriving — so a licence key rendered there and named
  nowhere else is a key lost by closing a tab. Both paths now end in a block
  linking the order in the buyer's account, their order history and their account
  overview, with `accountOrderHref` imported from the overlay that owns the rule
  rather than rebuilt. The Stripe path has no order number yet when the webhook
  has not landed, which is the common case and not an error, so it links the list.
  Where nobody can sign in the block does not render at all, because `/account`
  could only answer "sign in to see what you have".
  
  **The generator can produce every configuration, and CI asserts it on every
  commit.** A verifier found a twenty-five minute window in which no project with
  an admin panel could be generated at all — `CAPABILITY_EVIDENCE` named a file
  that was mid-move — and although `capabilities.test.ts` would have been red
  throughout, its sweep is a hand-written array that fixes `tenantNoun` at two of
  its five values. The option sets moved into `answers.ts` as tuples the types are
  derived from, `cli.ts` validates against those same tuples, and
  `every-configuration.test.ts` takes the cartesian product: all 240 are planned,
  all 240 are checked to be reachable through the flags with nothing left to a
  prompt, and the two corners are written to disk. A new option value is swept the
  day it exists rather than the day somebody remembers. The nightly matrix keeps
  the questions that genuinely need a package manager, and now runs each
  combination's unit suite as well.
  
  **A generated project with a real DATABASE_URL could not build at all, and
  that is what pointing one at a database found.** `src/db/index.ts` handed
  `createDb` the `src/db/schema.ts` module namespace. Under Turbopack a module
  whose exports are all re-exports compiles to a namespace backed by a Proxy over
  a non-extensible target, and `Object.keys` on one of those throws — which is
  precisely what drizzle does, in `extractTablesRelationalConfig`, the moment a
  connection string means it builds the relational query API instead of the
  unconfigured stand-in. So the failure was invisible without a database and total
  with one: `next build` exits on page-data collection with `TypeError: 'ownKeys'
  on proxy: trap returned extra keys but proxy target is non-extensible`, thrown
  from inside a driver and naming nothing. `src/db/schema.ts` now also exports the
  tables as one plain object, spread from each package's own namespace, and the
  handle is built from that. The `export *` lines stay exactly as they were, since
  they are what drizzle-kit reads. Every configuration in the sweep asserts both
  halves.
  
  `PACKAGE_VERSIONS` moves `env` and `tenancy` to `0.3.0` for the pending minors,
  under the existing effective-version rule.

## 0.9.0

### Minor Changes

- Five things the generator emitted were wrong in ways nothing in this repository
  could see, because no workspace package typechecks the template.
  
  - **The admin sidebar shipped live 404s, and stranded two pages doing it.**
    `AdminNav.tsx` was a hand-written list inside the `admin-minimal` overlay, so
    it could see neither the `admin-full` pages layered on top of it nor the
    `catalog-admin` pages beside it. It argued that permission gating made a
    hardcoded list safe — true of `catalog.products.view`, which exists only once
    the catalog package is installed, and false of `staff.people.view` and
    `staff.roles.view`, which every project declares and `seed-roles.ts` grants to
    `admin` and `cs_lead`. A seeded administrator on an `--admin minimal` project
    saw People and Roles & permissions and got a 404 from both. Avoiding that trap
    is why `/admin/errors` and `/admin/support` had no entry at all: real pages, in
    every `--admin full` project, reachable only by typing the URL. The sidebar is
    now generated from `answers`, like `src/nav.ts`. Which items exist is settled
    at generation; who sees them is still settled at runtime by the permission
    filter, which is doing different work and is not a substitute.
  - **The dangling-link test had a hole the shape of the pattern it recommends.**
    It scanned `href="/…"` in every emitted file and `href: "…"` only inside
    `src/nav.ts`, so a const array of link objects in any other file fell between
    the two — which is exactly what `AdminNav.tsx` was. The `href:` scan now covers
    every emitted `.ts` and `.tsx`, and fails four configurations against the old
    sidebar.
  - **Commerce and billing permissions were spread into the wrong catalog.** Both
    fragments are written for the tenant ladder — every `defaultFor` in them names
    `owner`, `admin`, `member` or `viewer` — and both were pushed into the staff
    catalog, which has none of those but `admin`. So twelve keys quietly granted to
    the admin of the wrong ladder, and `plans.manage` and `subscriptions.manage`,
    being owner-only, reached no role at all. Which catalog a fragment goes into is
    now a column in one table, `renderPermissionsCatalog` groups by it, and
    `assertPermissionScopes` re-reads the emitted file on every generation to check
    each spread landed in its declared scope. A new test opens each package on disk
    and requires its defaults to name the ladder its row claims.
  - **`/products` returned a 500 on a project with no credentials.** It is linked
    from the header and the footer of every page, so on a fresh clone it was the
    first thing anyone clicked. It did try to handle a missing database — it caught
    the read and matched the error's name against `DatabaseNotConfiguredError` —
    but the read goes through `api()`, and a tRPC caller wraps whatever a procedure
    throws in a `TRPCError` and hangs the original off `.cause`. The name never
    arrived, the rethrow fired. `/products/[slug]` and `/checkout` had the same
    hole; the admin product pages had the same dead check behind a real guard.
    Every page now asks `isDbConfigured(db)` before it reads, which is what the
    other admin pages already did.
  - **`pino` was an undeclared peer.** It belongs to `@adminigloo/observability`,
    which every project installs, and `createLogger` imports it at the top of the
    module. It resolved only because pnpm and npm auto-install peers by default;
    with `auto-install-peers=false` a generated project did not build. A new test
    walks every package a project can install, in every configuration, and requires
    each of their peers to be named in the generated manifest.
  - **`src/versions.ts` pinned versions that predate the exports the template
    uses.** The drift test compared each pin against the version currently in the
    workspace manifest — which under changesets is the version already published,
    and therefore always one release behind the code the template is written
    against. `@adminigloo/observability` sat pinned at `^0.1.1` with a pending
    minor for `createErrorReporter`, an export every generated project imports, so
    a project generated against the registry resolved a release without it and did
    not compile. The pin is now checked against the version each package will carry
    once the pending changesets are applied, and it is a range check rather than an
    equality check: a patch needs no edit because a caret already admits it, and a
    minor below 1.0.0 forces one because a caret does not. A second assertion
    requires create-app to be released alongside any package whose minor it now
    depends on. `@adminigloo/testing` was the one range written out inline, where
    no drift test looked; it goes through the same table now.
- The nav existed on one page, and the one link it hardcoded was a 404.
  
  - **`AuthHeader` linked to `/admin` unconditionally.** A project generated with
    `--admin none` emits no `app/admin` route at all, so every signed-in user in
    that configuration saw a link to a 404 — the exact bug `SITE_LINKS` was
    introduced to kill, in the file that introduced it. `src/nav.ts` now also
    emits `APP_LINKS`, which carries the admin entry only in projects that have
    one and is empty otherwise. No flag, no null, no `if` in an emitted file.
  - **The header was mounted inside `app/page.tsx` and nowhere else.** The
    storefront, product pages, the checkout, `/setup` and the Clerk pages all
    rendered with no navigation — arrive at a product from a link and there was no
    route to the rest of the site. New `app/(site)/layout.tsx` carries a real
    header and footer for every public page; a route group, so no URL changes.
    `app/admin` stays outside it, because the admin shell is already a full-height
    sidebar layout and a second header would push it off screen.
  - **`FOOTER_LINKS` is generated the same way.** The primary nav stays short;
    `/setup` is a diagnostics page rather than somewhere a customer goes, but it
    is the page you need after something else has broken, so it has to be
    reachable from everywhere. Every entry is justified in a comment in the
    generated file.
  - **The storefront built product URLs by hand** while `src/storefront.ts`
    documented itself as the single place that knows the route. Now routed through
    `productHref`, so a slug needing an escape cannot resolve in the admin and 404
    in the shop.
  
  A new test walks every href in a generated `nav.ts` and every literal `href` in
  every emitted page, and fails unless the route is in the same `planEmit` plan —
  the general form of all three, so it catches the next one.
- A generated project could not add a second person to a tenant. Now it can, and
  the two packages that existed to make that possible have a caller.
  
  - **An invitations router, on the right rungs.** `send`, `list`, `resend` and
    `revoke` are `requireTenant("members.invite")` — inviting somebody into an
    organisation is that organisation's business, not the firm's, and the key was
    already declared in `@adminigloo/tenancy`'s tenant fragment, so nothing new
    was added to the catalog. `accept` is one rung LOWER, on `protectedProcedure`,
    because an invitee is by definition not a member yet: built from
    `requireTenant` it would deny every invitee who ever followed a link, and the
    message would be "Not a member of tenant …". The token is the authorisation
    there, and that is stated at the procedure rather than implied.
  - **`accept` returns a discriminated union, and never throws.** Six outcomes —
    accepted, expired, revoked, already-a-member, wrong-email, unknown — each with
    its own screen and its own next step. A thrown error collapses all of them
    into one red box offering the same non-advice to somebody who has expired,
    somebody who is already in, and somebody signed in as the wrong person. The
    union is re-mapped at the router rather than returned raw: the invited
    address, the inviter and the invitation id all stay server-side, because
    whoever holds the link may not be who it was sent to.
  - **`/invite/[token]` resolves nothing before sign-in.** A GET carrying a bearer
    token is fetched by prefetchers, mail scanners and preview bots. Looking the
    token up on render would tell any of them that an invitation exists and who it
    is from; accepting on render would let a corporate mail scanner join the
    organisation on the invitee's behalf. So the signed-out screen says only that
    an invitation exists at this URL, which the visitor already knew, and an
    unknown token is indistinguishable from a real one until somebody presses a
    button. Sign-up and sign-in now honour `?redirect_url=`, through a
    `safeReturnPath` guard that refuses anything that could leave the site —
    without it a new account lands on the home page and the only copy of the token
    is gone, because only its hash was ever stored.
  - **Resend mints a NEW link, and the UI says why.** There is no old one: the
    database holds a SHA-256 and the plaintext exists only in the mail that was
    sent. Re-issuing rotates the hash and pushes the expiry out on the same row,
    which is what the schema's partial unique index was designed for.
  - **The invitation URL comes back to the inviter only when nothing was posted.**
    With no Resend key the send is recorded as `skipped` and the members page
    offers the link to copy, so the whole feature works on a laptop with no
    credentials. Once a provider accepts the message the link is withheld — the
    invitee has it, and there is no reason to put a bearer credential for somebody
    else's account in the inviter's browser history.
  - **A rank guard on who may be invited as what.** `members.invite` says you may
    invite; it does not say you may invite your equal or your superior. An admin
    who could issue an owner invitation would mail it to an address they control
    and collect `tenant.transfer`, which the catalog seals precisely so it cannot
    be handed to one person quietly. `canManageTemplateKey` is strictly greater,
    so admin-invites-admin fails too, and an actor with no role template at all
    fails closed.
  - **`revoke(id)` is bound to the tenant before it runs.** The service signature
    takes no tenant, so an id alone would cancel a stranger's invitation from
    inside your own organisation — an IDOR the procedure ladder cannot catch,
    because the caller really does hold `members.invite`, just somewhere else.
    Every id is resolved through `listForTenant(ctx.tenantId)` first.
  - **`src/server/audit.ts` is now generated, and there is one registry.** The
    admin router declared its own and the catalog router declared another; two
    registries cannot detect a collision between them, and `admin.recentAudit`
    could only label the keys it held — so catalog actions rendered in the audit
    viewer as raw strings. The fragments are composed with `contributedBy`, which
    throws at boot on a duplicate. `invitation.accepted` is the only one of the
    three new keys marked sensitive: sending grants nothing, accepting is the
    instant the data becomes readable to a stranger.
  - **`src/server/invitation-mail.ts` is generated in two variants with one
    signature**, so no emitted file holds an `if` asking whether `@adminigloo/email`
    was installed. With `--email` it renders the template, sends through
    `createEmailSender` and writes the row to `email_events` — including the
    skipped ones, which are exactly the rows somebody debugging "why did they not
    get the email" needs and the ones a provider dashboard by definition lacks.
    Without it, every send is a real `skipped` outcome and the link is handed
    back. `EMAIL_FROM` is deferred until deployment and `createEmailSender` throws
    at construction on a From it cannot parse, so the fallback is an RFC 2606
    reserved address rather than a module-scope crash on every laptop.
  - **A new `email` overlay** carries the invitation template and `/setup/email`,
    a preview rendered from sample data that reads no database, no session and no
    query parameters. An email template is the one piece of UI with no way to look
    at it; without a preview the loop is edit, deploy, invite somebody, wait, and
    the copy stays as first written. Linked from the footer exactly in the
    projects that have the page.
  - **`app/(site)/members/page.tsx`**, the surface all of this hangs off, with the
    roster, the invite form and the pending list. `src/server/tenant.ts` decides
    which tenant a page is looking at — the seam to replace with a subdomain, a
    slug segment or a switcher, and deliberately the dullest implementation that
    works, because the alternative was every page inventing its own answer.
  
  A new test walks the other way round the nav: every emitted page route must be
  reachable from a generated nav array or the admin sidebar, or be listed with the
  reason it is reached another way. That list is short and it is checked for stale
  entries. `/invite/[token]` is on it — the URL is a one-time secret, so there is
  nothing to put in a header — which is the whole point of writing the reason
  down rather than leaving the page quietly stranded.
- Three things were true only because somebody remembered them. Now they are
  mechanical.
  
  - **`adminigloo.json`, written into every generated project.** The answers, the
    installed packages with their ranges, the overlays applied, the capabilities
    the project expects to have, and which environment variables block boot as
    against which merely change documented behaviour. Until now "what is enabled
    here?" was answerable only by reading `package.json` and walking the directory
    tree, so every tool that needed to know re-derived it and they drifted — the
    hardcoded `/admin` link in a `--admin none` project was that drift reaching a
    customer. The manifest is the prerequisite for the generator matrix, for a
    `doctor` command, and for the component registry when it lands.
  
    It says in its own `//` key that nobody maintains it by hand, because JSON has
    no comments and people open this file. Every field is DERIVED, and that is the
    load-bearing property rather than a simplification: a manifest that is purely
    a function of the answers can be rebuilt and compared against the copy on
    disk, which is the only way drift becomes something a tool can find. One
    hand-written field anywhere would end that for the whole file. It is therefore
    also why there is nowhere in the manifest to record a forked module — forking
    is real, no tool can infer it, and it belongs somewhere that says plainly
    which part a person owns.
  
  - **`SCAFFOLD.md` is now generated FROM the manifest, not alongside it.** Both
    files state the same facts. Deriving each separately from `answers` is two
    implementations of one truth, and the day somebody adds a question and updates
    one renderer, the human-readable copy is the one people believe.
    `renderScaffoldRecord` takes a `ProjectManifest` rather than `Answers`, which
    is a breaking change for anyone calling it directly. It gained an overlay list
    and a capability list, and the fork section is now explicitly marked as the
    one section a person maintains.
  
  - **A nightly generator matrix.** `OverlayCollisionError` proves no two overlays
    write the same path, which is a far weaker statement than it sounds: it says
    the file sets are disjoint and says nothing about whether a combination
    typechecks or builds. Six combinations now go through
    `pnpm install && typecheck && build` against the real registry, chosen to
    cover six DISTINCT overlay sets rather than six plausible-looking products —
    including the degenerate corners nobody generates by hand, which is exactly
    where an additive-overlay system fails. Each run asserts the overlay set it
    actually produced against the one the matrix claims, so a combination cannot
    quietly stop covering what its comment says it covers.
  
  - **`capabilitiesFor` and `overlayNamesFor`** are exported from `answers.js`.
    Overlay selection used to live inside the emitter, where the manifest could
    not see it; it is an answers-derived structural decision like `packagesFor`
    and now sits beside it.
  
  - **A missing overlay directory is an error rather than a silent skip.** It was
    survivable while the only record of what a project had was the project. It is
    not now that `adminigloo.json` states it: a skipped overlay would make the
    manifest claim a capability nothing on disk provides.
  
  - **`@trpc/client`, `@trpc/react-query` and `@trpc/server` are pinned to
    `^11.18.0`** in a generated project rather than to `@adminigloo/trpc`'s peer
    floor of `^11.0.0`. The floor says what still works; the pin says what was
    actually tested. A new test binds these and every other shared dependency to
    the workspace catalog, because the generated project is not a workspace member
    and nothing else would notice it falling behind.
  
  - **The governing rules are in `README.md`**, with the failure each one prevents
    attached — including the restatement that earned its own heading, that
    conditionals are allowed in the generator and forbidden in the artifact, and
    the explicit prohibition on Clerk's `has()`, Clerk Plans and Clerk Billing.
- The observability work had shipped as two parallel implementations of the same
  thing, and the manifest claimed a capability no generated file provided.
  
  **Rate limiting: the package's implementation survives, the template's is
  deleted.** `src/server/rate-limit.ts` held its own Upstash REST adapter — the
  same two commands, the same `PEXPIRE … NX` reasoning, the same fallback to an
  in-process Map — written out beside the one already published in
  `createRateLimiter`. Two copies of a limiter is the arrangement where a fix to
  the timeout, the pipeline body or the malformed-reply guard lands in one of them
  and the endpoint protected by the other keeps the bug. The file is now two
  `createRateLimiter` calls and nothing else: `limiter`, which fails open, and
  `failClosedLimiter`, which does not. The "dependency-free" argument for the
  local copy did not apply — it imported `@adminigloo/observability` and `@/env`
  already, so it could never have run on the edge.
  
  **The ladder is actually limited now.** `createProcedures(t, loaders)` was
  called with two arguments, so the `rateLimit` option, `RATE_LIMIT_POLICIES` and
  `enforceRateLimit` were shipped, tested and installed on nothing. Every
  procedure in every generated project was unmeasured. It takes the third
  argument now; the 61st anonymous call to `health` is refused, which is the
  documented budget of 60.
  
  **Both webhook routes and the error-report endpoint are bounded.** Webhooks are
  keyed by provider — Stripe and Clerk deliver from a pool of addresses, so a
  per-address limit bounds nothing — and the check runs **after** signature
  verification, because limiting first would let anyone on the internet spend the
  budget and have genuine payment events refused. The error-report endpoint moves
  from `checkRateLimit` plus a hand-written try/catch to `failClosedLimiter`,
  which carries the fail-closed decision as a construction argument. One
  behavioural narrowing, stated plainly: an unreachable store now answers 429
  rather than 503, because nothing the client could do differs between "you are
  over budget" and "we cannot tell", and the distinction is in the warning the
  limiter logs.
  
  **Request id: the package's implementation survives here too, and
  `src/request-id.ts` is deleted.** That copy existed because the barrel drags
  `pino` into an edge bundle; the answer is the new
  `@adminigloo/observability/request` subpath, which imports nothing, rather than
  a second implementation. The local copy never validated the inbound header — a
  newline in `x-request-id` went straight into every log line for that request.
  
  **The loop closes.** `createScaffoldContext` was called with no headers, so
  `ctx.requestId` was a fresh UUID per request rather than the one the proxy
  stamped, `ctx.ipAddress` was always null (which also left every anonymous
  procedure unlimited, since the key is the address), and no emitted file read
  either. `createContext` now takes the request's headers — from `req.headers` in
  the fetch handler and from `headers()` in the RSC caller — and the tRPC
  `onError` reads `ctx.requestId` for both the log line and the `error_log` row.
  A new `src/server/logger.ts` gives the project the `createLogger` it never had,
  with `requestLog(id)` as the child that puts the id on every line. Verified
  live: one id in the response header, in `procedure failed`, and in the reporter.
  
  **`ai.streaming` is now true.** `--ai` contributed `aiServer()` to the
  environment, `aiPermissions` to the catalog and `ai_usage` to the schema, and
  nothing that ever called a model, while `adminigloo.json` told the matrix CI the
  project could stream. A new `ai` overlay ships `app/api/ai/chat/route.ts`, built
  on `createStreamRoute` so authorization cannot drift below the first flushed
  byte, metered through `meterStream` so a cancelled request still costs what it
  cost, and rate-limited per minute **and** per day against `failClosedLimiter` —
  an unthrottled model route is the one omission that produces a same-day invoice.
  With no key it answers 503 with the empty provider list. The `ai_usage` rows it
  writes are readable through `ai.spend`, priced in integer micros from a rate
  table the app owns.
  
  **And the manifest is self-checking.** `CAPABILITY_EVIDENCE` names, for every
  key `capabilitiesFor` can emit, the file in the generated project that provides
  it; `assertCapabilitiesAreProvable` runs at the end of every `planEmit` against
  the files actually written, and refuses to produce a project whose manifest
  claims something absent. Reading the output rather than the answers is the
  load-bearing half — a predicate over `answers` would restate `capabilitiesFor`
  and pass for ever. Two honest findings are recorded rather than papered over in
  `UNDISTINGUISHED_CAPABILITIES`: `--tenant none` and `--tenant Workspace` emit
  identical bytes, and so do all three money-taking models — so a `--model
  one-time` project ships every line of the subscription path and merely declines
  to claim it.
- Generated projects had no error boundaries and nothing that recorded a failure.
  
  - **No `error.tsx`, `global-error.tsx`, `not-found.tsx` or `loading.tsx`
    anywhere.** An unhandled render error reached a client's customer as
    "Application error: a client-side exception has occurred" on a blank page with
    no way back, and a throw in the root layout was caught by nothing at all. The
    boundaries are now placed by what fails and how it recovers, rather than one
    of each at the root: `app/global-error.tsx` renders its own `<html>` and
    `<body>` because it replaces the root layout; `app/error.tsx` catches a
    segment LAYOUT throwing, which no boundary beside that layout can;
    `app/(site)/error.tsx` sits inside the route group so the header and footer
    stay on screen; `app/admin/*` gets its own set so the sidebar survives; and
    the storefront gets two, because `/checkout/success` is reached only after
    Stripe has taken the money and must never inherit "nothing was charged".
  - **Every boundary offers a route that exists.** The way back is `/`, `/setup`,
    or a route from the overlay that owns the boundary — never a link a
    configuration may not have installed. The 404 reads its map from the generated
    `src/nav.ts` rather than writing one out.
  - **Nothing reported.** `createErrorReporter` is now wired at every producer:
    both webhook routes, the tRPC handler's `onError` (internal faults only — a
    FORBIDDEN is the permission ladder working), and the React boundaries through
    a new rate-limited `POST /api/error-report`, since a client component cannot
    reach the database. The request id is attached everywhere; `proxy.ts` mints
    one so a page, its tRPC call and the error either produces share a value.
    Next's `digest` is carried from the boundary and kept out of the normalised
    message, so digest-bearing reports do not all collapse into one row.
  - **`observabilityServer()` was never spread into the generated `src/env.ts`.**
    It was the one installed package whose fragment was missing, so `SENTRY_DSN`,
    `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` existed in no
    project's contract: `/setup` could not report on them and the rate limiter had
    no way to be pointed at a shared store. Now spread unconditionally, surfaced
    on `/setup` from `OBSERVABILITY_ENV_GROUPS`, and listed in `.env.example`
    under a new optional section — a variable absent from that file is one nobody
    discovers exists.
  - **A new `src/server/rate-limit.ts`** picks Upstash when both variables are
    set and an in-process store when they are not, so the app still boots with no
    credentials. `DEPLOYMENT.md` says plainly that the fallback multiplies the
    limit by the instance count.
  
  Requires the `@adminigloo/observability` release that adds `createErrorReporter`
  — bump `PACKAGE_VERSIONS` in `emit.ts` when it lands, which
  `versions.test.ts` will insist on anyway.
- `next.config.ts` is generated, and a `--email` project keeps its email renderer
  out of the React Server Component graph on purpose rather than by luck.
  
  **The setting.** `@adminigloo/email/emails` renders the message bodies with
  React Email, so it imports `react-dom/server` — and React ships a `react-server`
  export condition for that module whose entire body is
  `throw new Error("react-dom/server is not supported in React Server
  Components")`. Everything a bundler pulls into the RSC graph resolves under that
  condition, route handlers included, so the renderer cannot be in the graph. In a
  `--email` project it is reached from `src/emails/invitation.ts` through
  `src/server/invitation-mail.ts`, the invitations router and `_app.ts` into
  `src/trpc/server.ts`, which every server component that calls `api()` imports:
  one template, and the trace covers the application. Naming the package in
  `serverExternalPackages` moves the module out of the bundle and into a runtime
  `require`, where node conditions apply and `react-dom/server` is the real
  renderer. Nothing about where the render happens changes — composing an email is
  server work, it stays on the server, and it stays synchronous.
  
  **Why the config file is now emitted rather than copied.** The list depends on
  which packages were installed, and a static `template/next.config.ts` could only
  carry that as an `if`. Conditionals belong in the generator; the artifact states
  its answer as a literal array, with the reasoning above written above it.
  
  **What was actually happening, measured rather than assumed.** Without the
  setting, a `--email` project installed normally still builds: Turbopack does not
  apply its `react-dom/server` rule to files under `node_modules`, bundles the
  real Node build of the renderer into the RSC chunks, and everything works. That
  is a heuristic about a path, not a contract, and it is the definition of passing
  because the bundler declined to look. With the setting, `renderToStaticMarkup`
  is absent from `.next/server` entirely and the module is loaded by Node at
  request time — the same behaviour, obtained on purpose.
  
  The one topology it cannot rescue is a package **linked** rather than installed.
  Next matches an external on a resolved path containing `node_modules/<name>/`,
  so a `link:` dependency pointing at a checkout is bundled regardless, is treated
  as project source, and fails the build with "You're importing a component that
  imports react-dom/server". `transpilePackages` does not help either, because
  transpiling is bundling. That is the topology a local `link:`-based harness
  produces and no configuration fixes it; `scripts/verify-generated.mjs` now packs
  and installs instead, which is what both CI jobs already did.
  
  **A test that tested nothing, and the guard for the class.** The email overlay's
  `expect(source).toContain("escapeHtml")` was meant to prove the invitation body
  escapes what it interpolates. The only `escapeHtml` left in that file is inside
  the comment recording that the helper was deleted, so the assertion passed on
  its subject's obituary and would have gone on passing had the body been replaced
  with raw string concatenation. It is now three assertions about the emitted
  code: the three composition calls that make the file a seam, the absence of any
  markup or entity to escape, and the synchronous signature the mailer depends on.
  The Clerk header's `toContain("<SignedIn>")` was the same shape — satisfied by
  the warning telling you never to use one — and now reads the comment through
  `commentsIn` while asserting the code does not contain it.
  
  Because this is a suite whose whole method is grepping generated source, the
  failure is systemic: a new describe block reads the suite's own text and fails
  if any `toContain` literal is satisfied only by comments in the emitted project,
  with a two-row allowlist for the assertions whose subject genuinely is prose.
  
  **And the check that would have caught a project that cannot serve a page.**
  `.github/scripts/route-sweep.sh` boots a generated project and requests every
  page the build emitted, reading the route list off `app/**/page.tsx` so an
  overlay's pages are covered the day they are added. A 3xx passes — with no
  credentials every `/admin` route redirects to sign-in — and a 4xx or 5xx does
  not. The nightly generator matrix sweeps `next start`; the per-PR `generate` job
  sweeps `next start` and `next dev`, which compile by different paths. `tsc
  --noEmit` and `vitest run` were both green on a configuration where every route
  but `/` answered 500, because neither one crosses Next's RSC boundary.

## 0.8.0

### Minor Changes

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

## 0.7.0

### Minor Changes

- A product catalog both commerce and billing can sell from.
  
  There was nowhere to define a product. `commerce` stores `orderItems.productRef`
  as a bare string, and `billing.plans` models recurring subscriptions only — so a
  project selling a physical thing had no catalog at all.
  
  - `products` / `product_variants` / `product_grants`. The grant is the seam that
    lets one checkout serve a deck of cards and a SaaS seat without either knowing
    about the other.
  - `planStripeSync()` is a PLANNER, not a caller, because Stripe prices are
    immutable: you cannot change an amount, currency or interval on an existing
    Price. A sync that tries to patch one silently no-ops and the customer is
    charged the old amount forever. Currency comparison is case-normalised —
    case-sensitive, a hand-typed `USD` reads as a change and archives-and-recreates
    the price on every run, orphaning subscriptions across a trail of prices.
  - `formatMinor()` never converts through `number`. JPY has no minor unit, so
    dividing by 100 is wrong, and a large bigint loses its last digit.
  - Archived is not deleted: an archived product must still render on the order
    that bought it.

## 0.6.0

### Minor Changes

- Sign-in actually exists now.
  
  - Adds `/sign-in` and `/sign-up` as Clerk catch-all routes. The `[[...sign-in]]`
    segment is required, not decorative: Clerk routes verification, second factor
    and reset as sub-paths, so a plain `sign-in/page.tsx` renders the first screen
    and 404s the moment anyone needs a second step. Previously there was no
    sign-in page at all — `/sign-in` was a 404.
  - Adds a header with sign-in / user button / admin link, written as a SERVER
    component reading `auth()`. Clerk Core 3 removed `<SignedIn>` / `<SignedOut>`,
    and they throw at render rather than at build — the code looks correct until
    the page 500s.
  - `drizzle.config.ts` loads `.env.local` itself. drizzle-kit is a standalone
    binary and does not read it the way Next does, so `pnpm db:migrate` failed
    with "url: ''" while the app connected fine — which reads as a broken config
    rather than an unloaded file. `db:seed` gets `--env-file` for the same reason.

## 0.5.2

### Patch Changes

- A generated project now boots with no credentials at all.
  
  Three separate places threw before anything could render, each of them before
  the setup page that would explain what was missing:
  
  - `proxy.ts` called `clerkMiddleware()` unconditionally. It runs on the EDGE,
    before layout and before any page, so a project with no Clerk account 500s on
    every request — the first thing you see after generating is a stack trace.
  - The Clerk webhook route assumed a signing secret. It now answers 503, not 200:
    a 200 would make Clerk record the delivery as successful and never retry it
    once the secret is set.
  - The setup page reported "Everything is configured" while nothing was, because
    `report.ok` means "valid for the environment you are in" and locally these are
    deferred. It now counts what is still outstanding for a deployment.
  
  Verified with an empty `.env.local`: home 200, /setup 200, and tRPC returns
  `{"ok":true}` through the full client-server chain.

## 0.5.1

### Patch Changes

- Generated projects install the CURRENT package versions.
  
  Every dependency was pinned at `^0.1.0`. A caret range on a 0.x version means
  `>=0.1.0 <0.2.0`, so the moment `@adminigloo/env` shipped 0.2.0 a freshly
  generated project quietly installed the old one — everything resolved,
  everything built, and the feature the release added simply was not there.
  
  Versions are now explicit and a test reads the workspace manifests, so the build
  fails if the list drifts.

## 0.5.0

### Minor Changes

- A generated project now runs before its credentials exist.
  
  Requiring Neon, Clerk and Stripe accounts before `pnpm dev` works once is
  backwards for a scaffold whose point is starting fast. Strictness now scales
  with environment instead.
  
  - `defineEnv({ optionalUntilDeployed })` relaxes a variable ONLY when it is
    absent and only on a laptop. A value that is present but malformed still fails
    at boot everywhere — a mistyped connection string is not a deferred
    credential. Deployments relax nothing.
  - The relaxed keys widen to `| undefined` in the type, so a consumer cannot read
    one as a definite string and get undefined at runtime.
  - `describeEnv()` returns a serialisable report of what is configured, what is
    missing, and which feature each gap disables. It never returns a value — a
    setup page that echoes a secret is worse than no setup page.
  - `createDb()` accepts an absent connection string and returns a handle that
    throws a typed error naming `DATABASE_URL` and `.env.local` on first query,
    rather than crashing at import with "cannot read property select of null".
  - The generator writes a ready-to-run `.env.local`, mounts ClerkProvider only
    when Clerk is configured, and ships a `/setup` page reading the same schemas
    boot validation uses — so it cannot drift the first time a package is added.
  
  The key-mode assertion is untouched. A live key still refuses to run outside
  production, in every environment, and neither `SKIP_ENV_VALIDATION` nor listing
  that key as deferrable can switch it off.

## 0.4.0

### Minor Changes

- A signed-in user now always has a local row, so local development works.
  
  The `users` row is created by the Clerk webhook, and a webhook needs a public
  URL — which localhost is not. On a laptop you signed in successfully, no row was
  ever written, every `currentPrincipal()` returned null, and the app treated you
  as a stranger while Clerk's UI showed you as signed in. There was no error to
  search for.
  
  `currentPrincipal` now mirrors the user from the session it already holds, and
  mints their personal workspace. Deliberately NOT gated on NODE_ENV: webhook
  delivery is best-effort everywhere, and a dropped delivery in production leaves
  a paying customer permanently locked out of a product they can see. The webhook
  still keeps the row fresh; this only guarantees it exists. The unique index on
  (identity_provider, external_id) makes the two safe to race, and a soft-deleted
  row is never resurrected.

## 0.3.1

### Patch Changes

- A clean first build.
  
  - `middleware.ts` becomes `proxy.ts`, Next 16's rename. The old name still works
    and warns on every single build, which is exactly the kind of noise you learn
    to scroll past — and then miss the warning that matters.
  - Pins `turbopack.root` to the generated project. Next walks up looking for a
    lockfile, so a project created below another one infers the wrong workspace
    root and warns forever.

## 0.3.0

### Minor Changes

- The generated app can now actually call its own API.
  
  - Adds `src/trpc/client.tsx` (typed React client + provider, wired into the root
    layout) and `src/trpc/server.ts` (RSC caller). Without these the server route
    existed and no component could reach it — `@trpc/react-query` was a dependency
    with nothing importing it.
  - Both clients are created inside `useState` initialisers. A module-level
    QueryClient is shared across every request the server handles, so one user's
    cached data can render for the next.
  - Authorization failures are never retried: the answer will not change, and
    retrying turns one 403 into four in the log.
  - Adds `tsx` (the seed script is run, not built) and `server-only`, plus a
    `db:seed` script — `scripts/seed-roles.ts` told you to run `pnpm tsx` with tsx
    absent from devDependencies.

## 0.2.0

### Minor Changes

- The generator now wires the whole base.
  
  - Re-exports a schema for EVERY installed package that owns a table. It omitted
    `ai`, `email` and `observability`; `drizzle.config` points at that one file, so
    their tables were absent from every migration — the app compiled, booted, and
    failed on the first insert against a table nobody created.
  - Composes an env fragment per installed package, and asks only for variables
    those packages declare. It listed `RESEND_FROM_EMAIL`, which nothing reads,
    while `EMAIL_FROM`, which is required, went unmentioned and the app refused to
    boot.
  - Admin shell as copied source, layered additively. Overlays collide loudly
    rather than overwriting a base file. The permission checklist has three states
    per row — inherit / allow / deny — because a checkbox cannot distinguish
    "inherited from the template" from "set for this person", and sealed rows say
    so instead of silently refusing to stick.
  - Stripe webhook route implementing the full claim protocol, including
    release-on-failure — the step whose absence wedges an event forever.
  - `--model`, `--admin`, `--tenant-noun`, `--ai`, `--email` make it scriptable,
    and reject an unknown value rather than silently defaulting.
  - Seeds role templates idempotently, and never rewrites a template someone has
    customised.

## 0.1.0

### Minor Changes

- The generator. `npx create-adminigloo-app <name>` emits a Next.js project with
  auth, tenancy, permissions, tRPC and the environment contract already wired.
  
  - Answers resolve at generation time into a different set of files and
    dependencies. Nothing becomes a conditional in the emitted app.
  - Plans every file before writing any, so a failure leaves an empty directory
    rather than a half-generated project that looks complete.
  - Non-interactive whenever stdin is not a TTY, so it cannot hang inside CI
    waiting on a prompt nobody can answer.
  - Only depends on packages that are actually published — a generated project
    whose first `pnpm install` 404s is worse than one missing a feature.
  - Writes `SCAFFOLD.md` recording every answer and the packages installed, so a
    later fork can be diffed against the version that produced it.
