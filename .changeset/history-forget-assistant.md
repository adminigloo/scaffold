---
"@adminigloo/assistant": minor
---

Delete a company (create-app 0.37): `forgetTenant(db, tenantId)` from the root takes every row this package keeps for one company — what its assistant knows (sections and versions, house rules, words, pages and versions), its conversations, offered changes and checks — its page-search index when the project has one, and its `assistant_config_version` counter (keyed by the company's id) — children first, each statement filtered by the company's id, on the caller's transaction. Returns the rows each table lost; refuses an empty id and the site's own ("*"). Proved per package on PGlite with `@adminigloo/testing/forget`: every table planted for two companies, the first forgotten, nothing of the second touched.
