# @adminigloo/invoicing-widget

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
