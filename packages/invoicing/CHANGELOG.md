# @adminigloo/invoicing

## 0.7.0

### Minor Changes

- ed86e90: Delete a company (create-app 0.37): `forgetTenant(db, tenantId)` from the root takes every row this package keeps for one company — its invoices, their lines and payments, card checkouts and card alerts — children first, each statement filtered by the company's id, on the caller's transaction. Returns the rows each table lost; refuses an empty id and the site's own ("*"). Proved per package on PGlite with `@adminigloo/testing/forget`: every table planted for two companies, the first forgotten, nothing of the second touched.
- ed86e90: Past records with their real dates (staff and server paths only; no customer route takes a date): `createInvoice(…, { issuedAt })` and `POST v1/admin/invoices` with `issuedAt` save it as issued (sent) that day — emailing nobody, numbered that year, due from that day; `recordPayment(…, { paidAt })` and `POST v1/admin/invoices/{id}/payments` with `paidAt` keep the day it was paid in `paid_at` beside the day it was entered (`created_at`, `recorded_by`). A date in the future, before 2000, or a payment before its invoice is refused (400 `invalid`, naming the field). A date alone ("2025-06-14") is that day where the company is (its time zone; noon there, never moved before the record it belongs to or past the moment it was typed in), and "today" is today there — a morning entry in Tokyo is not "in the future"; a full timestamp is the instant it names. `createInvoice` and `recordPayment` take the business's `timeZone`; the staff routes pass the `business` seam's. A past date on the staff routes needs its own key, `invoices.history` ("Enter past records", owner and admin by default) — not raising invoices or recording payments; without it, 403 in plain words. The invoice detail says what was entered later: `enteredLater` (when, and by whom) on the invoice and on each payment recorded more than an hour after it was paid. Their events carry the real day and `enteredLater: true`, and `invoicingAlertsFor` raises no alert for them. `createInvoice` and `recordPayment` take a `now`. New nullable `invoices.entered_at`/`entered_by`.
  
  **Upgrading from 0.6:** run `sql/upgrade-0.6-to-0.7.sql` (safe twice) or `pnpm db:generate`.

### Patch Changes

- Updated dependencies [ed86e90]
  - @adminigloo/comms@0.6.0

## 0.6.0

### Minor Changes

- 452e94a: `invoice.created`: staff making an invoice is an event too (after commit, awaited, contained, like `invoice.viewed` and `invoice.paid`), so the customer list can link the invoice to its customer. The event's invoice also carries `customerPhone` (optional).
  
  **Your `onEvent` listener now hears `invoice.created` as well.** If it treated every event that isn't `invoice.viewed` as a payment, check for `invoice.paid` by name before upgrading. The alerts mapper (`invoicingAlertsFor`) ignores the new type: nobody is alerted about their own new invoice.

### Patch Changes

- Updated dependencies [452e94a]
  - @adminigloo/comms@0.5.0

## 0.5.0

### Minor Changes

- 17ca6ea: Pay now: customers pay invoices and deposits by card from their invoice link. The amount is always the server's — the deposit (or what is left of it) first, then the balance — and a customer chooses another amount only when the company turned part payments on. Every press writes an `invoice_checkouts` row with the amount and currency before Stripe is asked (through the `payments` seam, `InvoiceCardPayments`), and keeps one open Checkout Session per invoice. `handleInvoiceCardEvent` records a payment only for a checkout of the company the event came from, for that checkout's invoice, when amount and currency match exactly — keyed on the PaymentIntent, so replays and the session/intent pair record once. Anything else is refused and alerted. A full refund is a reversal; a part refund or a dispute flags the payment. Voiding an invoice expires its open Sessions; a void or paid invoice can't start one.
  
  Deposits: a percent (rounded to the nearest cent) or a fixed amount per invoice (`POST v1/admin/invoices/{invoice}/deposit`), or the company's default percent and "let customers pay part" from the Invoices settings. New public route `POST v1/invoice/{token}/pay`; the public invoice carries `pay`, payments carry `flag`, the detail carries `deposit`. Run `sql/upgrade-0.4-to-0.5.sql` before deploying.
  
  Every dollar Stripe takes is recorded on the right invoice or reported to that company's owners (`onAlert`, mapped by `invoicingCardAlert` to the new `invoicing.card-payment` alert kind: the bell and email, the amount, and the payment's page in Stripe). Any staff edit (a line, the deposit, a void) closes the invoice's open Sessions, and every Session closes after an hour. Money on a stale page is recorded; if it overpays, the invoice shows it and the owner is told to refund (`recordPayment`'s new `allowOverpayment`). Money on a void invoice is never recorded. A bank payment on its way holds its amount ("A bank payment of $X is on its way") and a failed one is released; two tabs or a double click get the same Session (under the invoice row lock). Per-currency card minimums (`CARD_MINIMUMS`); below one the page asks the customer to get in touch. A part refund is a part reversal (`reversePayment`'s new `amount`; a payment's reversals add up to at most it) and a lost dispute a reversal; a won one clears the flag. Changing the company's default never reopens a passed deposit stage. `quotePaymentAction` says what an accepted quote offers by stage, and never publishes or charges staff's draft. New events: `checkout.session.async_payment_failed`, `charge.dispute.closed`.
  
  Every card problem is also KEPT for the company (`invoice_card_alerts`), with or without the app's alerts: `GET v1/admin/attention` lists what is open ("Needs your attention": the sentence, the amount, the payment's page in Stripe) and `POST v1/admin/attention/{card-alert}/resolve` marks one handled (`invoices.payments.reverse`); a repeat is stored and alerted once; `openCardAlertCount` feeds a nav badge. A part refund reads "Partly refunded $X" on the ledger (`reversedAmount` on each payment); only all of it, or a lost dispute, reads "Reversed".

## 0.4.0

### Minor Changes

- 786a643: Invoices tell the owner what happened (Tenancy 2b-1).
  
  - **Events**: `onEvent` and `onEventError` on both handler factories.
    `invoice.viewed` when a customer opens an invoice for the first time (a
    second view, a preview and a draft tell nobody) and `invoice.paid` when a
    recorded payment pays it in full (a part payment or a refused payment tells
    nobody; a reversal and a new full payment is a new event). After the change
    is saved, awaited before the answer, and contained: a failing listener
    never fails the payment or the customer's page. No link token is ever in an
    event.
  - **The overdue sweep**: `listOverdueInvoices(db, tenantId, { now, dueSince,
    timeZone, limit })` finds sent, viewed and part-paid invoices that went past
    their due date in the last 7 days (in the business's time zone), oldest
    first, so the first run after an upgrade doesn't alert once per old
    invoice.
  - **Alert kinds**: `invoicingAlertKinds` ("A customer opens an invoice", "An
    invoice is paid in full", "An invoice goes overdue", all in the "Invoices
    opened, paid or overdue" group, the owner by default) and the mappers
    `invoicingAlertsFor(event, { hrefs })` and `invoicingOverdueAlert(…)`:
    "Pat Rivera opened invoice INV-2026-0042", "$1,250.00 due Nov 2, 2026", in
    the business's currency and time zone.
  - **Photos and files on an invoice**: `invoicingFileRecords(db, { invoiceHref })`,
    the invoice as a record `@adminigloo/storage` files belong to (who can see
    invoices sees its files; who can manage invoices adds and removes them).
  - **Bodies read with a cap**: every route counts a body's bytes as they
    arrive and stops at 32 KB, so a self-hosted server is never made to hold a
    huge request.
  - **Same origin only**: a POST from another subdomain of the same domain
    (`Sec-Fetch-Site: same-site`) is refused like one from another site.
  - The optional `@adminigloo/comms` peer is now `^0.4.0`.
  
  No database change.

### Patch Changes

- Updated dependencies [786a643]
  - @adminigloo/comms@0.4.0

## 0.3.0

### Minor Changes

- 2df95e8: Invoices per company, over HTTP (Tenancy 2a).
  
  - **Handlers**: `createInvoicingAdminHandlers` (the ledger, one invoice, create
    and edit drafts, send, record or reverse a payment, void) and `createInvoicingHandlers`
    (the customer's invoice page by its link), with the wire types, the
    permissions (`invoicingPermissions`) and route tables
    (`INVOICING_ADMIN_ROUTES`, `INVOICING_PUBLIC_ROUTES`).
  - **The settings section** (`invoicing`): payment instructions, default due
    days and the invoice footer, edited in company settings.
  - **Invoice links scoped to a company**: a customer's link only ever opens an
    invoice of the company whose page it is on.
  - **`./comms`**: the invoice email, sent in the company's name with its
    reply-to, linking to its own invoice page.
  - **Checklist item** (`invoicingChecklistItems`): "Tell customers how to pay you".
  
  After review: an invoice email held back by the sending allowance says so, in
  plain words, instead of "the email didn't go".

### Patch Changes

- Updated dependencies [2df95e8]
  - @adminigloo/comms@0.3.0

## 0.2.0

### Minor Changes

- f763520: Close the gaps a sweep against the gs-glass invoices router found, and harden
  what the source never had.
  
  **Lines after creation.** New `addInvoiceItem`, `updateInvoiceItem`,
  `removeInvoiceItem` and `recalculateInvoiceTotals(db, tenantId, invoiceId)`.
  Each runs in one transaction with the invoice row locked. A line edit reads the
  line only after it has the lock, so two people editing different fields of one
  line can't write each other's old values back. Each call re-sums the live
  lines and the payment ledger, then rewrites subtotal/tax/total/amountPaid and
  the status those imply (the source recomputed the money and forgot the status).
  Lines can be edited while the invoice is `draft`, `sent` or `viewed`. Once it is
  `partial`, `paid` or `void` they are frozen and the call throws
  `InvoiceNotEditableError`.
  
  What a sent invoice once said stays on record. Removal is soft (`removed_at`).
  A draft's line is edited in place. On a `sent` or `viewed` invoice,
  `updateInvoiceItem` soft-removes the old row and inserts the edited line in the
  same position, so the returned `item` has a new id.
  
  Removing the last line is allowed, so a line can be replaced. But an invoice
  with no live lines can't be sent or take a payment: that throws
  `InvoiceHasNoLinesError`.
  
  **Estimate → invoice.** A partial unique index `(tenant_id, estimate_id)`
  allows one invoice per estimate. A second conversion throws
  `InvoiceAlreadyExistsForEstimateError`. The new pure
  `invoiceInputFromEstimate(estimate, lines)` does the mapping:
  
  - It refuses anything but an approved estimate.
  - It folds labor into the unit price and keeps the quoted line total.
  - It carries the tax rate and the discount.
  - An estimate with no lines is billed at its pre-tax subtotal. The source used
    the tax-inclusive total there, so the customer was taxed twice.
  
  The overlay's `createFromEstimate` recipe now uses it.
  
  `createInvoice` trims `estimateId` and stores a blank one as `null` (no
  estimate). Before, `""` was stored as a real link. Only one invoice per tenant
  could have it, and the next blank one failed with a raw unique-violation error.
  
  **Numbers.** Invoice numbers now have a unique index on `(tenant_id, invoice_number)`,
  and `createInvoice` retries if it loses a race for a number. The year comes from
  UTC in one place. The count now filters on a UTC date range instead of
  `extract(year …)` in the session time zone, and the highest number already
  issued with this year's prefix sets the floor. `created_at` is stamped from the
  same clock.
  
  **Payments.** `recordPayment` runs in one transaction:
  
  1. Lock the invoice row.
  2. Insert the payment.
  3. Recompute `amountPaid` from the ledger.
  
  Before, two concurrent payments could each read the old total, and one of them
  was lost. Other changes:
  
  - It reports `overpayment` and `paidAt`.
  - It takes an optional `externalRef` (a unique index on
    `(invoice_id, external_ref)`), so a retried webhook comes back as
    `duplicate: true` instead of being recorded twice.
  - New `reversePayment(db, tenantId, paymentId, reason)` appends a negative row
    that points at the original. The ledger stays append-only, and a payment can
    only be reversed once (unique index).
  - It refuses an invoice with no live lines (`InvoiceHasNoLinesError`).
    Reversals are still allowed there.
  
  **Status.** `setInvoiceStatus` follows a transition table: draft → sent|void;
  sent → viewed|void; viewed → void. Only payments and reversals move an invoice
  into or out of `partial` and `paid`. `void` is terminal. It stamps new
  `sent_at` and `viewed_at` columns. It runs in one transaction with the invoice
  row locked, the same lock payments and line edits take. So neither a payment
  nor the removal of the last line can land between the check and the write.
  Sending an invoice with no live lines throws `InvoiceHasNoLinesError`. Exported
  helpers: `nextInvoiceStatuses`, `canTransitionInvoice`, `settledStatus`.
  
  **Public view.** `getInvoiceByToken` returns `null` for a draft. Otherwise it
  returns a `PublicInvoice` projection: display fields, lines, and payments as
  `{ amount, method, paidAt }`. It leaves out references, staff ids, internal ids,
  the estimate link and contact details (email, phone and billing address). Its
  `balanceDue` is 0 on a void invoice. That comes from the new
  `outstandingBalance(invoice)`, which the admin ledger's Balance line also uses.
  New `markInvoiceViewed(db, token)` moves `sent` → `viewed`, from `sent` only.
  
  **Listing.** `listInvoices(db, tenantId, { limit, cursor, status })` pages on
  `(created_at, id)`: pass `invoiceCursor(lastRow)` to get the next page. The
  status filter runs in SQL. `overdue` means sent/viewed/partial and past its due
  date. Passing a bare number as the limit still works.
  
  **Discount.** `createInvoice` and line edits reject a discount larger than the
  subtotal (`InvoiceDiscountError`).
  
  All refusals extend `InvoicingError`, which has a `code`. The overlay maps it to
  a 4xx with the error's message.
  
  ### Breaking (0.x minor)
  
  - **Tenant scoping.** `getInvoice(db, id)` is now `getInvoice(db, tenantId, id)`.
    `recordPayment` and `setInvoiceStatus` inputs now require `tenantId`. A
    missing tenant throws; it no longer quietly matches nothing.
  - **`recordPayment`** throws `PaymentRefusedError`:
    - for a void invoice (this used to return `null`);
    - for a paid invoice;
    - for a draft, unless you pass `{ allowDraft: true }`.
  
    It also throws `InvoiceHasNoLinesError` for an invoice with no live lines.
    That includes a legacy invoice the old create left without lines: add a line
    first. It returns `{ paymentId, amountPaid, balanceDue, overpayment, status, duplicate }`.
  - **`setInvoiceStatus`** throws `InvoiceStatusTransitionError` for a move the
    table forbids. Before, any status could be set. It throws
    `InvoiceHasNoLinesError` for sending an invoice with no live lines.
  - **`updateInvoiceItem`** on a sent or viewed invoice returns the replacement
    line, which has a new id. After that, the old id returns `null`.
  - **`getInvoiceByToken`** returns `PublicInvoice | null`, no longer `InvoiceDetail`.
  - The generated overlays (router, customer page, admin ledger) are updated. A
    project that copied the old router needs the same changes. The admin ledger
    now shows the customer link as text to copy. Next to it is a `?preview=1`
    link, and the customer page doesn't report a preview open as viewed. Before,
    staff checking the link marked the invoice "viewed". The shared rule is in
    the invoicing overlay's `src/invoice-link.ts`.
  
  ### Schema: run your `db:generate` + `db:migrate`
  
  New columns (all nullable):
  
  - `invoices.sent_at`, `viewed_at`, `paid_at`
  - `invoice_items.removed_at`
  - `invoice_payments.external_ref`, `reverses_payment_id`, `reason`
  
  New indexes: `invoices_tenant_created_idx`, and the unique indexes
  `invoices_number_uidx`, `invoices_estimate_uidx` (partial),
  `invoice_payments_external_ref_uidx` (partial) and
  `invoice_payments_reverses_uidx` (partial).
  
  Before you migrate, clear blank estimate links and trim the others. A stored
  `''` means "no estimate", and a second one in a tenant would fail the new
  partial unique index:
  
  ```sql
  update invoices set estimate_id = nullif(trim(estimate_id), '')
    where estimate_id is distinct from nullif(trim(estimate_id), '');
  ```
  
  Then check for rows the new unique indexes would reject. The old numbering could
  give out a duplicate number on a non-UTC connection, and an estimate could be
  converted twice:
  
  ```sql
  select tenant_id, invoice_number, count(*) from invoices
    group by 1, 2 having count(*) > 1;
  select tenant_id, estimate_id, count(*) from invoices
    where estimate_id is not null group by 1, 2 having count(*) > 1;
  ```
  
  To fix a duplicate number, renumber the later row. To fix a double conversion,
  void the extra invoice and set its `estimate_id` to null. Nothing needs to be
  deleted. The payment indexes are on new, empty columns, so they can't conflict.
  
  Optional backfill: `update invoices set sent_at = created_at where status <> 'draft' and sent_at is null;`.
  Without it, the public view shows `issuedAt` from `created_at`, which is the same value.
