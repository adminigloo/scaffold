# @adminigloo/invoicing-widget

## 0.4.0

### Minor Changes

- 2de60cb: A screen's primary action can sit in its host page's header, beside the page title, like every other page's. Each screen takes `actionsInHeader` and stops drawing its own buttons; the page renders the screen's companion in its header — `<InvoicesLedgerActions>` (New invoice), `<EstimatesQueueActions>` (New estimate, "Starting…" while it starts), `<ScheduleCalendarActions>` (New visit), `<CustomersActions>` (Add customer, Import, Export), `<FeedbackEpicsActions>` (New epic) — which opens the screen's own form below. The two halves talk through DOM events, so they need no shared parent (separate client islands on a server page). `<StoreAdmin>` and `<BookingAdmin>` take `actionsInHeader` to leave "See your store" and "Open the booking page" to the page's header. Each companion takes the host's button class.
  
  invoicing-widget also: `<InvoicesLedger initialFilter="overdue">` opens on a filter (any of the chips' statuses; anything else opens All) and follows a new one, so a page can open on `?status=overdue`; and a payment's line names its method once — "$810.81 · Check #1042", not "Check · Check #1042" (`paymentWords`, exported). estimator-widget's `initialFilter` now ignores a value that isn't a filter and follows a new one. The New invoice form puts the cursor in its first field.
  
  commerce also: `<StoreAdmin>`'s own "See your store" (without `actionsInHeader`) carries ↗, "(opens in a new tab)" for screen readers and rel="noopener noreferrer", like the booking page link.

### Patch Changes

- ed86e90: Past records say so (invoicing 0.7, scheduling 0.7): an invoice, a payment or a visit typed in later from the business's records shows "Entered from past records on {day}" — on the invoice under its title, beside the payment, and in the visit's panel (the company's own calendar day) — read from the server's `enteredLater`, and parsed (a malformed one is dropped).
- 2de60cb: No "Something went wrong" where the cause is knowable. An answer that isn't the package's own (a platform's error page, a proxy, a timeout) is read by its status — signed out (401), no permission (403), not here any more (404), too big (413), too many tries (429), the site not answering (502, 503) or too slow (504) — instead of "Unexpected answer from the server (502)." or the generic line; the generic sentence is left for a truly unknown failure. A dropped connection on the customer's invoice page says so, and "Couldn't reach the server." tells the person to check their internet connection.
- Updated dependencies [ed86e90]
- Updated dependencies [ed86e90]
  - @adminigloo/invoicing@0.7.0

## 0.3.0

### Minor Changes

- 3c427cc: The showroom: the ledger's notices are one "things to finish" card (`SetupCard`, exported), email off reads as the operator's job in plain words (`showTechnical` for the reason). `title={false}` drops the ledger's heading for a host page with its own. An empty ledger says what it's for and offers "Raise your first invoice".

## 0.2.1

### Patch Changes

- Updated dependencies [452e94a]
  - @adminigloo/invoicing@0.6.0

## 0.2.0

### Minor Changes

- 17ca6ea: The customer's invoice page shows "Pay the deposit" or "Pay $X now" when the business takes card payments (an amount box only when it allows part payments), sends the customer to Stripe's secure page, and says thank you when they come back (`returned`). The ledger's invoice screen sets the deposit (the usual, none, a percent or a fixed amount) and marks a card payment that was disputed or partly refunded. Needs @adminigloo/invoicing 0.5.
  
  It also says "A bank payment of $X is on its way (started …)", offers only what's left, asks the customer to contact the business below the card minimum, and marks a lost dispute.
  
  A part refund shows "Partly refunded $X", only a full refund or a lost dispute "Reversed"; the admin transport gains `attention` and `resolveAttention`.

### Patch Changes

- Updated dependencies [17ca6ea]
  - @adminigloo/invoicing@0.5.0

## 0.1.1

### Patch Changes

- 786a643: Released with `@adminigloo/invoicing` 0.4 (Tenancy 2b-1): the optional peer is
  now `^0.4.0`. No screen or wire change.
- Updated dependencies [786a643]
  - @adminigloo/invoicing@0.4.0

## 0.1.0

### Minor Changes

- 2df95e8: First release: the invoice screens. `InvoicesLedger` (every invoice, filtered
  by status, with what's owed), `InvoiceEditor` (lines, due date, notes; send,
  record a payment, void) and `InvoiceView` (the customer's invoice page: what's
  owed and how to pay, in the company's colour). Talks to `@adminigloo/invoicing`'s
  handlers; React is its only peer. `InvoicesLedger` takes `canManage={false}`
  for someone who may look but not raise invoices (no "New invoice").

### Patch Changes

- Updated dependencies [2df95e8]
  - @adminigloo/invoicing@0.3.0
