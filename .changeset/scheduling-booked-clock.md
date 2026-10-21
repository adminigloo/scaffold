---
"@adminigloo/scheduling": patch
---

`bookVisit` stamps a new visit's booked time with the clock it was given (`now`), not the database's. The "before the visit was booked" check reads that time, so a caller with its own clock (a test, an import) sees the day it said; a scheduling test that hard-coded 2026-10-20 failed from the next day on.
