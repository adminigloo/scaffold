---
"@adminigloo/feedback": minor
---

Three reporter-flow fixes ported back from the source, plus a rate-limit seam:

- A reply to a CLOSED (terminal) ticket now answers 409 instead of landing
  silently in a column no one watches — the reporter is told the ticket is
  finished and to file a new report, rather than believing they re-raised it.
- A new ticket seeds the reporter's own submission as the first thread message,
  so opening "My reports → thread" shows their words instead of an empty
  conversation that reads as "never received".
- A new ticket lands in the board's first non-terminal column (resolved from the
  configured statuses), not a hardcoded `"open"` a buyer may have renamed or
  removed — which would leave the ticket in no column at all.

And an optional injected `rateLimit` on the write endpoints (submit/upload/reply).
A no-op when omitted, so existing installs are unchanged; wired to a per-key/IP
counter it answers 429. The client key authenticates a whole tenant's anonymous
visitors, so without a limit one loop or one hostile visitor can flood tickets
and blob uploads on the buyer's bill.
