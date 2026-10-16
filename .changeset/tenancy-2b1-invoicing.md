---
"@adminigloo/invoicing": minor
---

Invoices tell the owner what happened (Tenancy 2b-1).

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
