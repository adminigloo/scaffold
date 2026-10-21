---
"@adminigloo/commerce": minor
---

A sale recorded by hand (in person): `recordStoreSale(db, tenantId, { lines, method, reference, customer, sendReceipt, requestKey }, { recordedBy, onOrder })` and `POST v1/admin/sales` (`store.manage`; in `STORE_ADMIN_ROUTES`, so a companies project's isolation proof drives it). Products and quantities from the company's own catalog at the catalog's prices — a different price needs a reason, kept on the line with the catalog price; paid by cash, check, card terminal or other (`STORE_SALE_METHODS`); stock taken from free stock exactly once (a double press with the same `requestKey` is one sale); the company's next order number; on its orders list (`paidBy`, `paymentReference`, `inPerson`, `buyer` — the name and phone staff knew, kept as who paid, never as where to send it — and each line's `priceChanged`), where `<StoreAdmin>` reads it as "Paid in person · Check #1042" and offers no "Mark as sent"; and the store's `onOrder` told once (with `buyer`) (the customer's timeline, the receipt only when asked and there's an email). `createStoreAdminHandlers` takes `onOrder` and `orderPrefix`. New nullable `orders.payment_method`, `payment_reference`, `recorded_by`.

**Upgrading from 0.3:** run `sql/upgrade-0.3-to-0.4.sql` (safe twice) or `pnpm db:generate`.
