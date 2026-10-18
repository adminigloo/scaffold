---
"@adminigloo/invoicing": minor
---

`invoice.created`: staff making an invoice is an event too (after commit, awaited, contained, like `invoice.viewed` and `invoice.paid`), so the customer list can link the invoice to its customer. The event's invoice also carries `customerPhone` (optional).

**Your `onEvent` listener now hears `invoice.created` as well.** If it treated every event that isn't `invoice.viewed` as a payment, check for `invoice.paid` by name before upgrading. The alerts mapper (`invoicingAlertsFor`) ignores the new type: nobody is alerted about their own new invoice.
