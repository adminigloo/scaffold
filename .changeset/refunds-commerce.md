---
"@adminigloo/commerce": minor
---

`shopOrderPermissions`: `shop.orders.view`, the site's own shop's orders on the STAFF ladder (admin, cs_lead and cs_agent hold it by default). The tenant `orders.*` keys are a company's own store's, and nobody on the staff ladder can hold a tenant key, so a staff orders page needs a staff key of its own. Exported with its type, `ShopOrderPermission`.
