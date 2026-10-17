---
"@adminigloo/stripe": patch
---

`createDirectCheckoutSession` takes `lines`, the store's server-priced lines (name, unit amount, quantity) for Stripe's page — their sum must be `amountMinor` exactly, or nothing is sent — and `shippingCountries`, which turns on `shipping_address_collection` for those countries. Without them, one line reading `description` and no address, as before.
