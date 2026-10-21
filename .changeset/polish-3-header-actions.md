---
"@adminigloo/invoicing-widget": minor
"@adminigloo/estimator-widget": minor
"@adminigloo/scheduling-widget": minor
"@adminigloo/customers": minor
"@adminigloo/feedback": minor
"@adminigloo/commerce": minor
"@adminigloo/booking-widget": minor
---

A screen's primary action can sit in its host page's header, beside the page title, like every other page's. Each screen takes `actionsInHeader` and stops drawing its own buttons; the page renders the screen's companion in its header — `<InvoicesLedgerActions>` (New invoice), `<EstimatesQueueActions>` (New estimate, "Starting…" while it starts), `<ScheduleCalendarActions>` (New visit), `<CustomersActions>` (Add customer, Import, Export), `<FeedbackEpicsActions>` (New epic) — which opens the screen's own form below. The two halves talk through DOM events, so they need no shared parent (separate client islands on a server page). `<StoreAdmin>` and `<BookingAdmin>` take `actionsInHeader` to leave "See your store" and "Open the booking page" to the page's header. Each companion takes the host's button class.

invoicing-widget also: `<InvoicesLedger initialFilter="overdue">` opens on a filter (any of the chips' statuses; anything else opens All) and follows a new one, so a page can open on `?status=overdue`; and a payment's line names its method once — "$810.81 · Check #1042", not "Check · Check #1042" (`paymentWords`, exported). estimator-widget's `initialFilter` now ignores a value that isn't a filter and follows a new one. The New invoice form puts the cursor in its first field.

commerce also: `<StoreAdmin>`'s own "See your store" (without `actionsInHeader`) carries ↗, "(opens in a new tab)" for screen readers and rel="noopener noreferrer", like the booking page link.
