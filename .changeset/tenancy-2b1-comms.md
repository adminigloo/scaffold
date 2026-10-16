---
"@adminigloo/comms": minor
---

Somebody hears when a customer's email didn't go (Tenancy 2b-1).

- **`onFailed`** on the senders: told once a message has failed for good, with
  the company, the address, the template and the log row (`CommsFailure`).
  Every failed `sendNow` or `deliverNow` is told, and a queued message when the
  cron gives it up (a permanent failure, out of attempts, or abandoned mid-send
  and out of attempts). Never told about a message the queue will try again,
  nor about a skip. Awaited after the outcome is written; a throw is swallowed,
  so it can never fail a send or stop the cron.
- **`deliverNow`**: `sendNow` plus `retryable`, whether trying again could
  change the outcome (a held message or a provider hiccup could; a refused
  address can't). `sendNow` is unchanged.
- **`templateLabel(key)`**: each email's written name ("Visit reminder",
  "New lead (to your office)", "Team alert"), the same names the Messages
  screen shows.
- **The failed-email alert**: `commsAlertKinds` (one kind,
  `comms.message.failed`, "An email to a customer doesn't go", for the people
  who manage messages, in the app only) and `commsFailureAlert(failure, {
  href, customerTemplateKeys })`: "The visit reminder email to pat@x.com
  didn't go". Customer emails only; the same failure told twice is one alert.
- **Bodies read with a cap**: the Messages routes count a body's bytes as
  they arrive and stop at 32 KB, so a self-hosted server is never made to
  hold a huge request.
- **Same origin only**: a POST from another subdomain of the same domain
  (`Sec-Fetch-Site: same-site`) is refused like one from another site.

No database change.
