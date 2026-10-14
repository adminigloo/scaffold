---
"@adminigloo/invoicing": minor
---

Invoices per company, over HTTP (Tenancy 2a).

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
