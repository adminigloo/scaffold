---
"@adminigloo/create-app": minor
---

The customer list (`--customers`, on by default with any field feature; `--no-customers` turns it off): each company's customers at /app/customers (one business's at /admin/customers) through `@adminigloo/customers`, with every quote, visit, invoice, call, order and message on one timeline. Generated glue (`src/server/customer-activity.ts`) on each feature's own seam — the estimator's and scheduling's LISTENERS, invoicing's `onEvent` (and the card webhook's), booking's `onEvent`, the store's `onOrder`, comms' `onSent` — finds or creates the customer inside the company and links the record. "Customer: Mrs Lee →" on a company's estimate and invoice pages and one business's invoice page. `pnpm customers:backfill` links what each company already has. The isolation proof drives `CUSTOMERS_ADMIN_ROUTES`; customers.view and customers.manage on both ladders.
