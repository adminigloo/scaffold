---
"@adminigloo/scheduling": minor
---

Delete a company (create-app 0.37): `forgetTenant(db, tenantId)` from the root takes every row this package keeps for one company — its visits and their links, crews and their hours, and its settings, and every cached drive time that starts or ends within about 110 m of one of its visits or crews' home bases (the cache has no company column, but its points are job addresses rounded to about 11 m) — children first, each statement filtered by the company's id, on the caller's transaction. Returns the rows each table lost; refuses an empty id and the site's own ("*"). Proved per package on PGlite with `@adminigloo/testing/forget`: every table planted for two companies, the first forgotten, nothing of the second touched.
