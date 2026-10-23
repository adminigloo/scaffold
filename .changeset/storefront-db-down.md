---
"@adminigloo/create-app": patch
---

The storefront (`/products`) no longer answers 500 when the database is set
but doesn't answer (an outage, a wrong password). It says "The products can't
be shown right now" and reports the error; a project with no database still
gets "The shop isn't open yet". CI's route sweep found it: its placeholder
DATABASE_URL is configured and refused, and this was the one public page
that read the database.
