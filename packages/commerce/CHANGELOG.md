# @adminigloo/commerce

## 0.4.1

### Patch Changes

- Updated dependencies [70f7cf7]
  - @adminigloo/stripe@0.6.0

## 0.4.0

### Minor Changes

- ed86e90: A sale recorded by hand (in person): `recordStoreSale(db, tenantId, { lines, method, reference, customer, sendReceipt, requestKey }, { recordedBy, onOrder })` and `POST v1/admin/sales` (`store.manage`; in `STORE_ADMIN_ROUTES`, so a companies project's isolation proof drives it). Products and quantities from the company's own catalog at the catalog's prices — a different price needs a reason, kept on the line with the catalog price; paid by cash, check, card terminal or other (`STORE_SALE_METHODS`); stock taken from free stock exactly once (a double press with the same `requestKey` is one sale); the company's next order number; on its orders list (`paidBy`, `paymentReference`, `inPerson`, `buyer` — the name and phone staff knew, kept as who paid, never as where to send it — and each line's `priceChanged`), where `<StoreAdmin>` reads it as "Paid in person · Check #1042" and offers no "Mark as sent"; and the store's `onOrder` told once (with `buyer`) (the customer's timeline, the receipt only when asked and there's an email). `createStoreAdminHandlers` takes `onOrder` and `orderPrefix`. New nullable `orders.payment_method`, `payment_reference`, `recorded_by`.
  
  **Upgrading from 0.3:** run `sql/upgrade-0.3-to-0.4.sql` (safe twice) or `pnpm db:generate`.
- ed86e90: Delete a company (create-app 0.37): `forgetTenant(db, tenantId)` from `@adminigloo/commerce/store` takes every row this package keeps for one company — its orders with their items and shipments, checkouts, store alerts, discount codes and store settings — children first, each statement filtered by the company's id, on the caller's transaction. Returns the rows each table lost; refuses an empty id and the site's own ("*"). Proved per package on PGlite with `@adminigloo/testing/forget`: every table planted for two companies, the first forgotten, nothing of the second touched.
- 2de60cb: A screen's primary action can sit in its host page's header, beside the page title, like every other page's. Each screen takes `actionsInHeader` and stops drawing its own buttons; the page renders the screen's companion in its header — `<InvoicesLedgerActions>` (New invoice), `<EstimatesQueueActions>` (New estimate, "Starting…" while it starts), `<ScheduleCalendarActions>` (New visit), `<CustomersActions>` (Add customer, Import, Export), `<FeedbackEpicsActions>` (New epic) — which opens the screen's own form below. The two halves talk through DOM events, so they need no shared parent (separate client islands on a server page). `<StoreAdmin>` and `<BookingAdmin>` take `actionsInHeader` to leave "See your store" and "Open the booking page" to the page's header. Each companion takes the host's button class.
  
  invoicing-widget also: `<InvoicesLedger initialFilter="overdue">` opens on a filter (any of the chips' statuses; anything else opens All) and follows a new one, so a page can open on `?status=overdue`; and a payment's line names its method once — "$810.81 · Check #1042", not "Check · Check #1042" (`paymentWords`, exported). estimator-widget's `initialFilter` now ignores a value that isn't a filter and follows a new one. The New invoice form puts the cursor in its first field.
  
  commerce also: `<StoreAdmin>`'s own "See your store" (without `actionsInHeader`) carries ↗, "(opens in a new tab)" for screen readers and rel="noopener noreferrer", like the booking page link.

### Patch Changes

- 2de60cb: No "Something went wrong" where the cause is knowable. An answer that isn't the package's own (a platform's error page, a proxy, a timeout) is read by its status — signed out (401), no permission (403), not here any more (404), too big (413), too many tries (429), the site not answering (502, 503) or too slow (504) — instead of "Unexpected answer from the server (502)." or the generic line; the generic sentence is left for a truly unknown failure. A dropped connection on the customer's invoice page says so, and "Couldn't reach the server." tells the person to check their internet connection.
- Updated dependencies [ed86e90]
- Updated dependencies [ed86e90]
- Updated dependencies [ed86e90]
- Updated dependencies [2de60cb]
  - @adminigloo/catalog@0.4.0
  - @adminigloo/permissions@0.3.0
  - @adminigloo/stripe@0.5.0

## 0.3.0

### Minor Changes

- 3c427cc: The showroom: `<StoreAdmin title={false}>` for a host page with its own header and `locale` for order dates (en-US by default, never the browser's; `<StoreAttention locale>` too), empty products and orders that say what they do, and 44px buttons and fields on the app's own radius.

## 0.2.0

### Minor Changes

- f73f6cf: A store of its own for every business (getting paid, part 2). A business's products are catalog rows under its own tenant id (one default variant: price in cents, currency, an optional stock count; "*" stays the site's own plans and products). `@adminigloo/commerce/store` is the server half: `createStoreProduct`/`updateStoreProduct`/`removeStoreProduct` (a plan's product limit checked under the business's lock), `startStoreCheckout` (every line priced from the business's own product rows under their row locks — the cart names products and quantities only; stock HELD on catalog 0.3's `product_variants.held` under the variants' locks in id order — shelf minus held is what can be sold, so carts never overwrite the owner's count and an owner's edit is refused in words if sales moved it meanwhile; the same unchanged cart gets its page back before any stock check and its own hold counts as its own; holds last 30 minutes and are given back at 31; a visitor may have 3 open checkouts and open 5 an hour (callers with no address share one), and an order at most `maxPerOrder` (default 5) of a product; the hold is reserved and committed before Stripe is called, and given back in its own transaction if Stripe fails; shipping ("I ship it" with a flat price and the owner's countries, or pickup/digital only) is a server line in the exact amount and the address is kept on the order), `handleStoreEvent` for the webhook (an order only for a checkout of the business the account belongs to, in exactly its amount and currency, once — keyed on the Checkout Session; bank payments held then cleared or released; refunds in part or in full onto `orders.refunded_minor`, in the order's currency only; disputes flagged, oversold kept apart in `orders.oversold_at`; the order's emails sent once each and retried until they go), holds given back exactly once when a page expires, fails, is replaced or a product in it changes price (THE EDIT RULE) or the owner presses "Release held items", store settings in `store_settings`, and "Needs your attention" in `store_alerts`. `createStoreAdminHandlers` and `createStorePublicHandlers` serve `STORE_ADMIN_ROUTES` and `STORE_PUBLIC_ROUTES` (in the root, with `storePermissions` and `storeCompanyPermissions`: `store.view`, `store.manage`); `storeOrderEmails` sends "{business} via {app}" with replies to the owner. `@adminigloo/commerce/widget` has the screens: `<StoreAdmin>`, `<StoreAttention>`, `<Storefront>` (the cart) and `<StoreThanks>`. Run `sql/upgrade-0.1-to-0.2.sql` before deploying: it adds `orders.refunded_minor`, the order flags and email marks, `store_checkouts`, `store_alerts` and `store_settings`, and keeps every existing order. Product photos are a storage purpose (`STORE_PHOTO_PURPOSE`): public, counted in the business's allowance. The screens take their colours from the app's theme tokens, light and dark.

### Patch Changes

- Updated dependencies [f73f6cf]
- Updated dependencies [f73f6cf]
  - @adminigloo/catalog@0.3.0
  - @adminigloo/stripe@0.4.1

## 0.1.7

### Patch Changes

- Updated dependencies [17ca6ea]
  - @adminigloo/stripe@0.4.0

## 0.1.6

### Patch Changes

- Updated dependencies [e3d0371]
  - @adminigloo/stripe@0.3.0

## 0.1.5

### Patch Changes

- Updated dependencies [cc16902]
  - @adminigloo/permissions@0.2.0
  - @adminigloo/stripe@0.2.1

## 0.1.4

### Patch Changes

- Updated dependencies
  - @adminigloo/stripe@0.2.0

## 0.1.3

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
  - @adminigloo/stripe@0.1.2

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
