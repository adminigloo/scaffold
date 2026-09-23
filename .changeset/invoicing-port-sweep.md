---
"@adminigloo/invoicing": minor
---

Close the gaps a sweep against the gs-glass invoices router found, and harden
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
