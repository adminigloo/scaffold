# @adminigloo/invoicing-widget

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
