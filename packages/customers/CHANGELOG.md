# @adminigloo/customers

## 0.3.0

### Minor Changes

- ed86e90: Delete a company (create-app 0.37): `forgetTenant(db, tenantId)` from `@adminigloo/customers/server` takes every row this package keeps for one company — its customer list: customers, addresses, timeline links, merges and notices — children first, each statement filtered by the company's id, on the caller's transaction. Returns the rows each table lost; refuses an empty id and the site's own ("*"). Proved per package on PGlite with `@adminigloo/testing/forget`: every table planted for two companies, the first forgotten, nothing of the second touched.
- 2de60cb: A screen's primary action can sit in its host page's header, beside the page title, like every other page's. Each screen takes `actionsInHeader` and stops drawing its own buttons; the page renders the screen's companion in its header — `<InvoicesLedgerActions>` (New invoice), `<EstimatesQueueActions>` (New estimate, "Starting…" while it starts), `<ScheduleCalendarActions>` (New visit), `<CustomersActions>` (Add customer, Import, Export), `<FeedbackEpicsActions>` (New epic) — which opens the screen's own form below. The two halves talk through DOM events, so they need no shared parent (separate client islands on a server page). `<StoreAdmin>` and `<BookingAdmin>` take `actionsInHeader` to leave "See your store" and "Open the booking page" to the page's header. Each companion takes the host's button class.
  
  invoicing-widget also: `<InvoicesLedger initialFilter="overdue">` opens on a filter (any of the chips' statuses; anything else opens All) and follows a new one, so a page can open on `?status=overdue`; and a payment's line names its method once — "$810.81 · Check #1042", not "Check · Check #1042" (`paymentWords`, exported). estimator-widget's `initialFilter` now ignores a value that isn't a filter and follows a new one. The New invoice form puts the cursor in its first field.
  
  commerce also: `<StoreAdmin>`'s own "See your store" (without `actionsInHeader`) carries ↗, "(opens in a new tab)" for screen readers and rel="noopener noreferrer", like the booking page link.

### Patch Changes

- 2de60cb: No "Something went wrong" where the cause is knowable. An answer that isn't the package's own (a platform's error page, a proxy, a timeout) is read by its status — signed out (401), no permission (403), not here any more (404), too big (413), too many tries (429), the site not answering (502, 503) or too slow (504) — instead of "Unexpected answer from the server (502)." or the generic line; the generic sentence is left for a truly unknown failure. A dropped connection on the customer's invoice page says so, and "Couldn't reach the server." tells the person to check their internet connection.
- Updated dependencies [ed86e90]
  - @adminigloo/permissions@0.3.0

## 0.2.0

### Minor Changes

- 3c427cc: The showroom: `<CustomersAdmin title={false}>` for a host page with its own header, `locale` for dates (en-US by default, never the browser's), an empty list that says what it does and offers Import, and 44px buttons and fields on the app's own radius.

## 0.1.0

### Minor Changes

- 452e94a: First release: one customer list per company. A customer's emails, phones, addresses, notes and tags; `findOrCreateCustomer` by email (lower case; Gmail's dots and +tags folded for matching only) or phone (E.164 with the business's country), never across companies, with unique partial indexes and a retry so two requests at once make one customer. `customer_links` puts every quote, visit, invoice, call, order and message on one paged timeline, once per record and action. Search by name, company, email, phone or address; merge two customers (links, addresses and contacts move; every merge kept in `customer_merges`); CSV import with a preview first (at most 5,000 rows, deduped against the list and within the file, a plain-words reason per row) and CSV export safe to open in a spreadsheet. `CustomerDirectory` with a drizzle default so an app can plug in its own customer table; `recordCustomerActivity` for the features' glue; `backfillCustomers`, chunked and idempotent. `createCustomersAdminHandlers` and `CUSTOMERS_ADMIN_ROUTES` with `customers.view` and `customers.manage` (staff and company ladders); the screens under `./admin`; `sql/customers-0.1.0.sql`.
- Public forms (estimate and visit requests, bookings, store orders) only link a record: they match by email, never change a customer's details, and offer any new details as a "New details from a form" notice with Add and Ignore (`customer_notices`). A phone-only match makes a new customer flagged "Might be the same person as …" with one-click merge. An email or phone another customer holds is never added, from any source. Every repeat of an action (each move, each send) stays on the timeline; backfill tracks each record and action; import runs in batches of 500 with progress and a Continue button; exported phones re-import cleanly; Windows-1252 files are read; phones checked per country.
