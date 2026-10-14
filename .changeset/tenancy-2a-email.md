---
"@adminigloo/email": minor
---

Per-message sender name and reply-to (Tenancy 2a).

- `fromName` on a message puts the business's name on the site's one verified
  sending address ("Summit Window Co. <hello@yoursite.com>"), so customers see
  who wrote to them without each company verifying a domain.
- `replyTo` on a message sends the customer's reply to the business (a bad
  address is refused with `EmailMessageInvalidError`).
- `sanitizeDisplayName(value)`: the cleaning the sender name goes through
  (no line breaks, quotes or angle brackets; at most 64 characters).
- The send log records the From actually used.

After review: dates in emails are written the way the app writes them
("March 8, 2026").
