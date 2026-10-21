---
"@adminigloo/ai": minor
---

Delete a company (create-app 0.37): `forgetTenant(db, tenantId)` from `@adminigloo/ai/server` takes every row this package keeps for one company — every AI call it made — children first, each statement filtered by the company's id, on the caller's transaction. Returns the rows each table lost; refuses an empty id and the site's own ("*"). Proved per package on PGlite with `@adminigloo/testing/forget`: every table planted for two companies, the first forgotten, nothing of the second touched.
